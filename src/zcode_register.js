"use strict";

/**
 * z.ai (chat.z.ai) 账号注册 —— 纯 HTTP，无浏览器。
 *
 * 后端契约（Open WebUI 改版，见 .zcode_analysis/reverse-records/zai-register.md）：
 *   POST /api/v1/auths/signup        { name, email, password, profile_image_url, sso_redirect, captcha_verify_param }
 *   POST /api/v1/auths/verify_email  { username, email, token }            // token 来自验证邮件
 *   POST /api/v1/auths/finish_signup { username, email, token, password, profile_image_url, sso_redirect }
 *   POST /api/v1/auths/signin        { email, password, captcha_verify_param }
 *
 * captcha_verify_param 由外部过阿里云滑块后传入（admin.html 内嵌 AliyunCaptcha）。
 * 其余步骤纯请求。注册成功返回 { token (JWT, 无过期), user }。
 *
 * 依赖：./mail_tempmail（建临时邮箱 + 收 z.ai 验证邮件）。
 */

const mail = require("./mail_tempmail");
const { upstreamFetch } = require("./upstream_transport");

const API_BASE = "https://chat.z.ai/api/v1";
const AUTH = `${API_BASE}/auths`;
const ORIGIN = "https://chat.z.ai";
// UA 必须与 captcha 完成时的浏览器一致（用户在 admin.html 用 Edge 149 过滑块）。
// 阿里云 captcha 服务端 VerifyIntelligentCaptcha 会校验设备指纹/UA 一致性，
// UA 不符（之前用 Chrome 147）→ z.ai 后端 400: captcha verification failed（2026-06-15 实测）。
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0";

function jsonHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": UA,
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    // chat.z.ai 前端所有请求都带 x-region: overseas（海外路由标记），后端据此路由 captcha 验证。
    "x-region": "overseas",
  };
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function readErr(res) {
  const body = await safeText(res);
  let detail = body;
  try {
    const j = JSON.parse(body);
    detail = j.detail || j.message || body;
  } catch {
    /* keep raw */
  }
  return new Error(`HTTP ${res.status}: ${String(detail).slice(0, 300)}`);
}

/* ---------- 原子动作 ---------- */

/** 注册第一步。captchaVerifyParam 必填（实测不传 → 400 captcha failed）。 */
async function signup({ name, email, password, captchaVerifyParam }) {
  const body = { name, email, password, profile_image_url: "", sso_redirect: "" };
  if (captchaVerifyParam) body.captcha_verify_param = captchaVerifyParam;
  const res = await upstreamFetch(`${AUTH}/signup`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // 完整记录响应体，定位 captcha 验证失败的真实原因（过期/环境/风控）
    const raw = await safeText(res);
    throw new Error(`HTTP ${res.status} (signup): ${raw.slice(0, 600)}`);
  }
  return res.json();
}

/**
 * 邮箱验证（纯验证步骤）。token 来自验证邮件魔法链接（形如 verify-xxxx）。
 * 返回 {success:true}，**不返回 JWT**（2026-06-16 chat.z.ai 前端 _page-BDxOmmuh.js Dit 实测）。
 * 必须先调它成功，finish_signup 才认这个 token，否则 invalid verification token。
 */
async function verifyEmail({ username, email, token }) {
  console.log("[zcode_register] verify_email 请求:", JSON.stringify({ username, email, token }));
  const res = await upstreamFetch(`${AUTH}/verify_email`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ username, email, token }),
  });
  if (!res.ok) {
    const raw = await safeText(res);
    console.log("[zcode_register] verify_email 失败:", res.status, raw.slice(0, 400));
    throw new Error(`HTTP ${res.status} (verify_email): ${raw.slice(0, 400)}`);
  }
  const j = await res.json();
  console.log("[zcode_register] verify_email 响应:", JSON.stringify(j));
  return j;
}

/**
 * 完成注册（设置密码 + 拿 JWT）。
 * 必须在 verify_email 成功之后调用。返回 {success:true, user:{token, expires_at:null, ...}}。
 * JWT 在 user.token，顶层无 token（chat.z.ai 前端 Oit 实测，2026-06-16）。
 */
async function finishSignup({ username, email, token, password }) {
  console.log(
    "[zcode_register] finish_signup 请求:",
    JSON.stringify({ username, email, token, password: "***" }),
  );
  const res = await upstreamFetch(`${AUTH}/finish_signup`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      username,
      email,
      token,
      password,
      profile_image_url: "",
      sso_redirect: "",
    }),
  });
  if (!res.ok) {
    const raw = await safeText(res);
    console.log("[zcode_register] finish_signup 失败:", res.status, raw.slice(0, 400));
    throw new Error(`HTTP ${res.status} (finish_signup): ${raw.slice(0, 400)}`);
  }
  const j = await res.json();
  console.log("[zcode_register] finish_signup 响应:", JSON.stringify(j).slice(0, 400));
  // 捕获 session cookie（OAuth authorize 需要同时携带 cookie + Bearer 才能绑定 CLI flow）
  const rawCookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") || "").split(/,(?=[^ ])/).filter(Boolean);
  const sessionCookie = rawCookies.map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
  return { ...j, _sessionCookie: sessionCookie };
}

/** 登录（同样需 captcha）。仅在验证流程未直接返回 token 时作 fallback。 */
async function signin({ email, password, captchaVerifyParam }) {
  const body = { email, password };
  if (captchaVerifyParam) body.captcha_verify_param = captchaVerifyParam;
  const res = await upstreamFetch(`${AUTH}/signin`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readErr(res);
  return res.json();
}

/* ---------- 随机资料 ---------- */

function randomPassword(n = 16) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  let out = "";
  const buf = require("crypto").randomBytes(n);
  for (let i = 0; i < n; i += 1) out += chars[buf[i] % chars.length];
  return out;
}

function randomName() {
  const first = ["Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie"];
  const last = ["Lee", "Chen", "Park", "Kim", "Wang", "Liu", "Wu", "Sun"];
  const c = require("crypto");
  const f = first[c.randomInt(first.length)];
  const l = last[c.randomInt(last.length)];
  return `${f} ${l} ${c.randomInt(100, 9999)}`;
}

/* ---------- 编排 ---------- */

/**
 * 完整注册一个 z.ai 账号。
 *
 * @param {object} opts
 *   - email            临时邮箱地址（由调用方先 createMailbox 拿到）
 *   - name?            显示名，不传则随机
 *   - password?        密码，不传则随机
 *   - captchaVerifyParam 阿里云滑块验证参数（必填）
 *   - username?        verify_email 用；不传则取 signup 响应的 username 或 email
 *   - mailTimeoutMs    等验证邮件超时，默认 120s
 *   - onProgress(step, message)  进度回调
 *   - signal           AbortSignal
 * @returns {Promise<{token, user, via, email, password, name}>}
 */
async function registerAccount(opts = {}) {
  const {
    email,
    name = randomName(),
    password = randomPassword(),
    captchaVerifyParam,
    username,
    mailTimeoutMs = 120000,
    onProgress,
    signal,
  } = opts;

  if (!email) throw new Error("registerAccount: 缺少 email");
  if (!captchaVerifyParam) throw new Error("registerAccount: 缺少 captchaVerifyParam（阿里云滑块验证参数）");

  const progress = (step, message) => {
    try {
      onProgress?.({ step, message, ts: Date.now() });
    } catch {
      /* ignore */
    }
  };

  // 1) 提交注册
  progress("signup", "提交注册（含滑块验证）…");
  const sig = await signup({ name, email, password, captchaVerifyParam });
  // username 必须用注册时的 name（z.ai 邮件魔法链接的 username 参数即 name），
  // 不能 fallback 到 email——verify_email/finish_signup 后端会据此校验一致性。
  const effectiveUsername = username || sig.username || name;

  // 2) 部分账号 signup 即直接返回 token（无需邮件验证）
  if (sig.token) {
    progress("done", "注册成功（signup 直接返回 token）");
    return { token: sig.token, user: sig, via: "signup-direct", email, password, name };
  }

  // 3) 等待 z.ai 验证邮件并提取验证信息
  progress("wait_mail", "注册已提交，等待 z.ai 验证邮件…");
  const { message: mailMsg, verify } = await mail.waitForZaiVerify(email, {
    timeoutMs: mailTimeoutMs,
    pollIntervalMs: 4000,
    signal,
    onPoll: (p) =>
      progress("poll_mail", p.error ? `轮询出错：${p.error}` : `轮询邮箱…已扫描 ${p.scanned} 封`),
  });

  // 4) 用验证信息完成校验
  // z.ai 真实两步链路（chat.z.ai 前端 _page-BDxOmmuh.js + index Dit/Oit，2026-06-16 实测 200）：
  //   verify_email  {username,email,token}              → {success:true}            纯验证，不返回 JWT
  //   finish_signup {username,email,token,password,...} → {success,user:{token}}    设密码 + 拿 JWT(expires_at:null)
  // 顺序硬约束：finish_signup 必须在 verify_email 成功之后，否则 invalid verification token。
  progress("verify", `识别到验证信息 (${verify.kind})，校验中…`);
  if (verify.kind === "token") {
    // 4a) verify_email：纯验证，返回 {success:true}
    let v;
    try {
      v = await verifyEmail({ username: effectiveUsername, email, token: verify.token });
    } catch (e) {
      throw new Error(`verify_email 失败（${e.message}）；token 可能已过期或被消费，请重新注册`);
    }
    if (!v || !v.success) {
      throw new Error(`verify_email 未成功: ${JSON.stringify(v).slice(0, 200)}`);
    }

    // 4b) finish_signup：设密码并换取 JWT
    progress("finish", "邮箱已验证，设置密码完成注册…");
    const f = await finishSignup({
      username: effectiveUsername,
      email,
      token: verify.token,
      password,
    });
    const jwt = f && (f.token || (f.user && f.user.token));
    if (jwt) {
      progress("done", "注册成功");
      return { token: jwt, user: (f && f.user) || f, via: "finish_signup", email, password, name, sessionCookie: f._sessionCookie || "" };
    }
    throw new Error(`finish_signup 未返回 token: ${JSON.stringify(f).slice(0, 200)}`);
  }

  if (verify.kind === "code") {
    // z.ai 若改用数字验证码，需要专用端点；当前契约未见。提示需手动登录。
    throw new Error(
      `验证邮件为数字验证码模式 (code=${verify.code})，当前自动流程不支持，请用该邮箱+密码手动登录 chat.z.ai 完成`,
    );
  }

  if (verify.kind === "url") {
    throw new Error(`验证邮件只含链接 (${verify.url})，请手动访问完成验证`);
  }

  throw new Error("无法识别的验证信息");
}

/**
 * 构造写入 accounts.json 的账号对象（zai provider，来源 register）。
 * 与 zcode_oauth_login.js baseAccount 同风格，但面向 chat.z.ai 注册号。
 */
function buildAccount(id, result, extra = {}) {
  const user = result.user || {};
  const displayName = user.name || user.email || result.email || id;
  return {
    id,
    enabled: true,
    provider: "zai",
    source: "register",
    api_format: "anthropic-messages",
    endpoint_origin: "https://zcode.z.ai",
    api_base_url: "https://zcode.z.ai/api/v1",
    model_endpoint: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
    billing_current_url: "https://zcode.z.ai/api/v1/zcode-plan/billing/current",
    billing_balance_url: "https://zcode.z.ai/api/v1/zcode-plan/billing/balance",
    register: {
      email: result.email,
      password: result.password,
      name: result.name,
      via: result.via,
      // chat.z.ai 注册号 JWT + sessionCookie，供 authorizeZaiCli 做 OAuth 授权
      chat_zai_jwt: result.token,
      session_cookie: result.sessionCookie || "",
      created_at: new Date().toISOString(),
    },
    // authorization.token 在 OAuth 授权完成后由 _ensureApiKeyFresh 覆写为 zcode JWT；
    // 初始先留 chat.z.ai JWT 以便 proxy 识别账号存在。
    authorization: {
      type: "bearer",
      token: result.token,
    },
    oauth: {
      provider: "zai",
    },
    user_info: {
      id: user.id || "unknown",
      username: displayName,
      displayName,
      email: user.email || result.email,
    },
    // 官方 ZCode 客户端登录态原料占位块：OAuth 授权成功后由 baseAccount 覆盖为完整内容。
    // 此处先存续期原料（chat_zai_jwt/session_cookie），确保即使 OAuth 暂时失败凭证也可续期。
    zcode_client_state: {
      active_provider: "zai",
      zcode_jwt_token: "",
      zai_access_token: "",
      zai_refresh_token: "",
      user_info: { user_id: user.id || "", email: user.email || result.email || "", name: result.name || "", avatar: "" },
      renew: { chat_zai_jwt: result.token || "", session_cookie: result.sessionCookie || "" },
      provider_ids: ["builtin:zai-start-plan", "builtin:zai-coding-plan", "builtin:zai"],
      captured_at: new Date().toISOString(),
    },
    notes: extra.notes || "由注册机自动注册（chat.z.ai JWT，OAuth授权后升级为zcode JWT）",
  };
}

module.exports = {
  API_BASE,
  signup,
  verifyEmail,
  finishSignup,
  signin,
  registerAccount,
  buildAccount,
  randomName,
  randomPassword,
};
