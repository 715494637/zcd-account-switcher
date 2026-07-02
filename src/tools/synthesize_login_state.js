"use strict";

/**
 * 把一个账号（accounts.json 里的 zcode_client_state / 现有字段）合成官方 ZCode 客户端
 * 的两份登录态文件（credentials.json + config.json），用机器绑定密钥加密。
 *
 * 这是「非反代」切号工具的核心：客户机器本地把裸 JWT 合成成官方客户端认可的登录态。
 *
 * 用法：
 *   node src/tools/synthesize_login_state.js --id zai-134 --dry-run        # 只生成到 ./.verify_out，不碰真实文件
 *   node src/tools/synthesize_login_state.js --id zai-134                  # 写入 ~/.zcode/v2（需先关 ZCode）
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// ---- enc:v1 加解密（复刻 switcher zcodeCrypto.js，机器绑定密钥）----
const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const NONCE_SIZE = 12;

function defaultCredentialSecret(env = process.env) {
  if (env.ZCODE_CREDENTIAL_SECRET) return env.ZCODE_CREDENTIAL_SECRET;
  let username = "unknown";
  try { username = os.userInfo().username; } catch (_) {}
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}
function deriveKey(secret = defaultCredentialSecret()) {
  return crypto.createHash("sha256").update(secret).digest();
}
function encrypt(plainText, secret = defaultCredentialSecret()) {
  const nonce = crypto.randomBytes(NONCE_SIZE);
  const cipher = crypto.createCipheriv(ALGO, deriveKey(secret), nonce);
  const ct = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (b) => Buffer.from(b).toString("base64url");
  return [PREFIX, b64(nonce), ".", b64(tag), ".", b64(ct)].join("");
}

// ---- 从账号对象提取登录态原料（优先 zcode_client_state，回退散落字段）----
function extractState(account) {
  const cs = account.zcode_client_state || {};
  const jwt = cs.zcode_jwt_token || account.authorization?.token || "";
  const access = cs.zai_access_token || account.oauth?.access_token || "";
  const ui = cs.user_info || {};
  const accUi = account.user_info || {};
  return {
    activeProvider: cs.active_provider || "zai",
    zcodeJwt: jwt,
    zaiAccessToken: access,
    zaiRefreshToken: cs.zai_refresh_token || account.oauth?.refresh_token || "",
    userInfo: {
      user_id: ui.user_id || accUi.id || "",
      email: ui.email || accUi.email || account.register?.email || "",
      name: ui.name || accUi.displayName || accUi.username || "",
      avatar: ui.avatar || accUi.avatarUrl || "",
    },
    providerIds: cs.provider_ids || ["builtin:zai-start-plan", "builtin:zai-coding-plan", "builtin:zai"],
  };
}

function synthesizeCredentials(baseCredentials, state) {
  // 保留原文件里的非 oauth 字段（如 zcodefeedbackclientid）
  const out = { ...(baseCredentials || {}) };
  const p = state.activeProvider;
  out["oauth:active_provider"] = encrypt(p);
  if (state.zaiAccessToken) out[`oauth:${p}:access_token`] = encrypt(state.zaiAccessToken);
  if (state.zaiRefreshToken) out[`oauth:${p}:refresh_token`] = encrypt(state.zaiRefreshToken);
  if (state.zcodeJwt) out.zcodejwttoken = encrypt(state.zcodeJwt);
  out[`oauth:${p}:user_info`] = encrypt(JSON.stringify(state.userInfo || {}));
  return out;
}

function synthesizeConfig(baseConfig, state) {
  // 基于现有 config.json（保留 schema + 所有 provider 定义/models），只填 apiKey + 启用 zai 槽位
  const out = baseConfig && typeof baseConfig === "object" ? JSON.parse(JSON.stringify(baseConfig)) : { $schema: "https://opencode.ai/config.json", provider: {} };
  if (!out.provider || typeof out.provider !== "object") out.provider = {};
  // 清掉非官方(builtin:)的第三方 provider —— 真实客户导入时不该带这些，且它们会污染模型选择。
  for (const id of Object.keys(out.provider)) {
    if (!id.startsWith("builtin:")) delete out.provider[id];
  }
  for (const id of state.providerIds) {
    if (!out.provider[id] || typeof out.provider[id] !== "object") {
      out.provider[id] = { enabled: true, options: {} };
    }
    if (!out.provider[id].options || typeof out.provider[id].options !== "object") out.provider[id].options = {};
    out.provider[id].enabled = true;
    out.provider[id].options.apiKey = state.zcodeJwt;
  }
  return out;
}

function readJsonIfExists(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (_) { return fallback; }
}

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function main() {
  const argv = process.argv.slice(2);
  let id = "", dryRun = false, accountsFile = path.resolve(__dirname, "..", "..", "accounts.json");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--id") id = argv[++i];
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--accounts") accountsFile = path.resolve(argv[++i]);
  }
  if (!id) throw new Error("Missing --id");

  const data = JSON.parse(fs.readFileSync(accountsFile, "utf8"));
  const account = data.accounts.find((a) => a.id === id);
  if (!account) throw new Error("Account not found: " + id);

  const state = extractState(account);
  if (!state.zcodeJwt) throw new Error("Account has no zcode JWT");

  const v2dir = path.join(os.homedir(), ".zcode", "v2");
  const credFile = path.join(v2dir, "credentials.json");
  const cfgFile = path.join(v2dir, "config.json");

  const baseCred = readJsonIfExists(credFile, {});
  const baseCfg = readJsonIfExists(cfgFile, {});

  const newCred = synthesizeCredentials(baseCred, state);
  const newCfg = synthesizeConfig(baseCfg, state);

  const outDir = dryRun ? path.resolve(__dirname, "..", "..", ".verify_out") : v2dir;
  const credOut = path.join(outDir, "credentials.json");
  const cfgOut = path.join(outDir, "config.json");
  atomicWrite(credOut, newCred);
  atomicWrite(cfgOut, newCfg);

  // 自检：解密 user_info 验证机器密钥可逆
  const decipherCheck = (() => {
    try {
      const v = newCred[`oauth:${state.activeProvider}:user_info`];
      const body = v.slice(PREFIX.length).split(".");
      const dec = crypto.createDecipheriv(ALGO, deriveKey(), Buffer.from(body[0], "base64url"));
      dec.setAuthTag(Buffer.from(body[1], "base64url"));
      const plain = Buffer.concat([dec.update(Buffer.from(body[2], "base64url")), dec.final()]).toString("utf8");
      return JSON.parse(plain);
    } catch (e) { return { error: e.message }; }
  })();

  console.log(JSON.stringify({
    ok: true,
    id,
    dry_run: dryRun,
    out_dir: outDir,
    state_user: state.userInfo,
    jwt_len: state.zcodeJwt.length,
    access_token_present: Boolean(state.zaiAccessToken),
    enabled_providers: state.providerIds,
    self_check_decrypt_user_info: decipherCheck,
  }, null, 2));
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); }
}

module.exports = { extractState, synthesizeCredentials, synthesizeConfig, encrypt, defaultCredentialSecret };
