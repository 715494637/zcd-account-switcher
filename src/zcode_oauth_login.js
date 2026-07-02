"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { spawn } = require("child_process");
const { upstreamFetch } = require("./upstream_transport");

const DEFAULT_ACCOUNTS_FILE = path.resolve(__dirname, "..", "accounts.json");
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const ZCODE_API_BASE = process.env.ZCODE_API_BASE_URL || "https://zcode.z.ai/api/v1";
// ZCode CLI OAuth（zai provider）固定参数：chat.z.ai 注册号用这套 client/redirect 换 zcode token。
// 逆向自 chat.z.ai 前端 prod-fe-1.1.54 的 oauth/cli/init 响应（2026-06-16）。
const CHAT_API_BASE = "https://chat.z.ai";
const ZAI_CLI_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
const ZAI_OAUTH_AUTHORIZE_URL = process.env.ZAI_OAUTH_AUTHORIZE_URL || `${CHAT_API_BASE}/auth/oauth/authorize`;
const ZAI_OAUTH_APPROVE_URL = process.env.ZAI_OAUTH_APPROVE_URL || `${CHAT_API_BASE}/api/oauth/authorize`;
const ZAI_OAUTH_TOKEN_URL = process.env.ZAI_OAUTH_TOKEN_URL || `${ZCODE_API_BASE}/oauth/token`;
const ZAI_OAUTH_REDIRECT_URI = process.env.ZAI_OAUTH_REDIRECT_URI || "zcode://zai-auth/callback";

const PROVIDERS = {
  zai: {
    id: "zai",
    label: "Z.AI",
    mode: "zai-code"
  },
  bigmodel: {
    id: "bigmodel",
    label: "BigModel / ZCode Plan",
    mode: "localhost-callback",
    authorizeUrl: process.env.BIGMODEL_OAUTH_AUTHORIZE_URL || "https://bigmodel.cn/login",
    tokenUrl: process.env.BIGMODEL_OAUTH_TOKEN_URL || `${ZCODE_API_BASE}/oauth/token`,
    userinfoUrl: process.env.BIGMODEL_OAUTH_USERINFO_URL || "https://bigmodel.cn/api/biz/customer/getCustomerInfo",
    appId: process.env.BIGMODEL_OAUTH_APP_ID || "zcode"
  }
};

const PROVIDER_ALIASES = {
  zai: "zai",
  "z.ai": "zai",
  "z-ai": "zai",
  z: "zai",
  bigmodel: "bigmodel",
  "big-model": "bigmodel",
  big_model: "bigmodel",
  glm: "bigmodel"
};

function parseArgs(argv) {
  const args = {
    accounts: DEFAULT_ACCOUNTS_FILE,
    id: "",
    provider: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    noBrowser: false,
    setDefault: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--accounts") args.accounts = argv[++i];
    else if (arg === "--id") args.id = argv[++i];
    else if (arg === "--provider") args.provider = normalizeProvider(argv[++i]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number.parseInt(argv[++i], 10);
    else if (arg === "--no-browser") args.noBrowser = true;
    else if (arg === "--set-default") args.setDefault = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.id) throw new Error("Missing --id <account-id>");
  return args;
}

function printHelp() {
  console.log(`Usage:
  node src/zcode_oauth_login.js --id <account-id> [--provider zai|bigmodel] [--set-default]

Examples:
  node src/zcode_oauth_login.js --id zai-a --provider zai --set-default
  node src/zcode_oauth_login.js --id bm-a --provider bigmodel
  node src/zcode_oauth_login.js --id zai-a --provider zai --no-browser
`);
}

function normalizeProvider(value) {
  const key = String(value || "").trim().toLowerCase();
  const provider = PROVIDER_ALIASES[key];
  if (!provider) throw new Error(`Unsupported provider: ${value}`);
  return provider;
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function chooseProvider() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Missing --provider <zai|bigmodel> in non-interactive mode");
  }
  console.log("Choose login provider:");
  console.log("  1) BigModel / ZCode Plan");
  console.log("  2) Z.AI");
  const answer = (await ask("Provider [1]: ")).trim();
  if (!answer || answer === "1") return "bigmodel";
  if (answer === "2") return "zai";
  return normalizeProvider(answer);
}

function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const response = await upstreamFetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    const detail = text ? text.slice(0, 300) : "<empty response>";
    throw new Error(`HTTP ${response.status} from ${url}: ${detail}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const detail = text ? text.slice(0, 300) : "<empty response>";
    throw new Error(`Invalid JSON from ${url}: ${detail}`);
  }
  return json;
}

function ensureEnvelopeOk(json, context) {
  if (typeof json?.code === "number" && json.code !== 0 && json.code !== 200) {
    throw new Error(`${context} failed: ${json.msg || `business code ${json.code}`}`);
  }
  return json.data ?? json;
}

async function openUrlInBrowser(url) {
  const platform = process.platform;
  const command = platform === "darwin"
    ? { exe: "open", args: [url] }
    : platform === "win32"
      ? { exe: "cmd.exe", args: ["/c", "start", "", url] }
      : { exe: "xdg-open", args: [url] };
  const child = spawn(command.exe, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return command;
}

function writeText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function createCallbackServer({ callbackPath, state }) {
  let settled = false;
  let closed = false;
  let resolveCallback;
  let rejectCallback;
  const waitForCallback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname !== callbackPath) {
        writeText(res, 404, "Not found.");
        return;
      }
      const returnedState = url.searchParams.get("state") || "";
      const code = url.searchParams.get("authCode") || url.searchParams.get("code") || "";
      if (!code || returnedState !== state) {
        writeText(res, 400, "Authorization failed: missing code or state mismatch.");
        if (!settled) {
          settled = true;
          rejectCallback(new Error("OAuth callback missing code or state mismatch"));
        }
        return;
      }
      writeText(res, 200, "Authorization successful. You may close this browser tab.");
      if (!settled) {
        settled = true;
        resolveCallback({ code, url: url.toString() });
      }
    } catch (error) {
      writeText(res, 500, "Authorization failed.");
      if (!settled) {
        settled = true;
        rejectCallback(error);
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Unable to bind callback server");
  const close = () => new Promise((resolve) => {
    if (closed) {
      resolve();
      return;
    }
    closed = true;
    server.close(() => resolve());
  });
  return {
    callbackUrl: `http://127.0.0.1:${address.port}${callbackPath}`,
    waitForCallback,
    cancel: async (reason = "OAuth login cancelled") => {
      if (!settled) {
        settled = true;
        rejectCallback(new Error(reason));
      }
      await close();
    },
    close
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function loginZaiCli({ timeoutMs, noBrowser }) {
  const flow = await startZaiLogin({ timeoutMs });
  console.log(`Open this URL to authorize:\n${flow.authorizeUrl}\n`);
  if (!noBrowser) await openUrlInBrowser(flow.authorizeUrl);
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const callbackUrl = (await ask("Paste zcode:// callback URL after authorization: ")).trim();
    return flow.complete(callbackUrl);
  }
  return flow.waitForResult();
}

async function startZaiLogin({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let cancelled = false;
  const state = randomHex();
  const authorizeUrl = buildZaiAuthorizeUrl({ state });
  const expiresAt = Math.floor((Date.now() + timeoutMs) / 1000);

  return {
    provider: "zai",
    authorizeUrl,
    state,
    redirectUri: ZAI_OAUTH_REDIRECT_URI,
    expiresAt,
    cancel: () => {
      cancelled = true;
    },
    complete: async (callbackUrl) => {
      if (cancelled) throw new Error("OAuth login cancelled");
      const callback = parseZaiCallbackUrl(callbackUrl, state);
      return exchangeZaiOAuthCode(callback);
    },
    waitForResult: async () => {
      if (cancelled) throw new Error("OAuth login cancelled");
      throw new Error("Z.AI OAuth now returns a zcode:// callback URL. Paste the callback URL into the CLI prompt, or use registration auto OAuth.");
    }
  };
}

function buildZaiAuthorizeUrl({ state, redirectUri = ZAI_OAUTH_REDIRECT_URI } = {}) {
  if (!state) throw new Error("buildZaiAuthorizeUrl: missing state");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: ZAI_CLI_CLIENT_ID,
    redirect_uri: redirectUri,
    state
  });
  return `${ZAI_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

function parseZaiCallbackUrl(callbackUrl, expectedState) {
  let url;
  try {
    url = new URL(String(callbackUrl || "").trim());
  } catch {
    throw new Error("OAuth callback URL is invalid");
  }
  const code = url.searchParams.get("code") || url.searchParams.get("authCode") || "";
  const state = url.searchParams.get("state") || "";
  if (!code || !state) throw new Error("OAuth callback missing code/authCode or state");
  if (expectedState && state !== expectedState) throw new Error("OAuth callback state mismatch");
  return { code, state, redirectUri: ZAI_OAUTH_REDIRECT_URI };
}

async function exchangeZaiOAuthCode({ code, state, redirectUri = ZAI_OAUTH_REDIRECT_URI, signal } = {}) {
  if (!code) throw new Error("exchangeZaiOAuthCode: missing code");
  if (!state) throw new Error("exchangeZaiOAuthCode: missing state");
  const tokenJson = await fetchJson(ZAI_OAUTH_TOKEN_URL, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "zai",
      code,
      redirect_uri: redirectUri,
      state
    })
  });
  const data = ensureEnvelopeOk(tokenJson, "Z.AI OAuth token exchange");
  const token = data.token && String(data.token).trim();
  const accessToken = (
    data.zai?.access_token ||
    data.zai?.accessToken ||
    data.access_token ||
    data.accessToken ||
    ""
  );
  if (!token) throw new Error("Z.AI OAuth token exchange response is missing token");
  return {
    provider: "zai",
    token,
    accessToken,
    refreshToken: data.refresh_token || data.refreshToken || "",
    userInfo: normalizeZaiCliUser(data.user || data.userInfo || data.zai?.user)
  };
}

/**
 * 用 chat.z.ai 注册号 JWT，纯 HTTP 完成 zcode cli OAuth 授权（无需浏览器）。
 *
 * 注册流程（zcode_register.js）只拿到 chat.z.ai 的会话 JWT；账号必须再走这一步
 * OAuth 授权，才会落到 zcode.z.ai 域、billing 才能查到额度（否则
 * https://chat.z.ai/api/v1/zcode-plan/billing/balance 404）。
 *
 * 链路（2026-06-16 逆向 chat.z.ai 前端 _page-B_b42mkJ.js 的 ne("approve") + 实测 200）：
 *   1) POST zcode /oauth/cli/init {provider:zai}            → flow_id + poll_token + authorize_url(含 state)
 *   2) POST chat.z.ai /api/oauth/authorize (Bearer chatJWT, action=approve, form)
 *                                                            → {redirect_url: "...callback/zai?code=...&state=..."}
 *   3) GET 回调 redirect_url                                  → zcode 把 code 链接到 flow_id
 *   4) GET zcode /oauth/cli/poll/{flowId}                     → ready → {token, zai.access_token, user}
 *
 * 返回与 startZaiLogin 相同的 loginResult 形状，可直接喂给 baseAccount。
 *
 * @param {object} opts
 *   - chatZaiJwt   chat.z.ai 注册号 JWT（finish_signup 返回的 user.token，Bearer 头鉴权）
 *   - timeoutMs    poll 超时，默认 5min
 *   - signal       AbortSignal
 *   - onProgress(msg) 进度回调
 * @returns {Promise<{provider, token, accessToken, refreshToken, userInfo}>}
 */
async function authorizeZaiCliLegacy({ chatZaiJwt, sessionCookie = "", timeoutMs = DEFAULT_TIMEOUT_MS, signal, onProgress } = {}) {
  if (!chatZaiJwt) throw new Error("authorizeZaiCli: 缺少 chatZaiJwt（chat.z.ai 注册号 JWT）");
  const progress = (msg) => {
    try {
      onProgress?.(msg);
    } catch {
      /* ignore */
    }
  };

  // 1) zcode cli init
  progress("OAuth：初始化 zcode cli 授权流程…");
  const pollToken = randomHex();
  const initJson = await fetchJson(`${ZCODE_API_BASE}/oauth/cli/init`, {
    method: "POST",
    signal,
    headers: { authorization: `Bearer ${pollToken}`, "content-type": "application/json" },
    body: JSON.stringify({ provider: "zai" })
  });
  const init = ensureEnvelopeOk(initJson, "Z.AI OAuth init");
  const flowId = init.flow_id;
  const returnedPollToken = init.poll_token || pollToken;
  let state = "";
  try {
    state = new URL(init.authorize_url).searchParams.get("state") || "";
  } catch {
    /* keep "" */
  }
  if (!flowId || !state) throw new Error("Z.AI OAuth init 响应缺少 flow_id / state");

  // 2) chat.z.ai authorize approve：注册号 JWT 作 Bearer，后端 action=approve 直接签发 code
  progress("OAuth：用注册号身份自动授权 ZCode 客户端…");
  const form = new URLSearchParams({
    client_id: ZAI_CLI_CLIENT_ID,
    redirect_uri: ZAI_OAUTH_REDIRECT_URI,
    state,
    response_type: "code",
    action: "approve"
  });
  const approveHeaders = { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${chatZaiJwt}` };
  if (sessionCookie) approveHeaders["Cookie"] = sessionCookie;
  const approveRes = await upstreamFetch(`${CHAT_API_BASE}/api/oauth/authorize`, {
    method: "POST",
    signal,
    headers: approveHeaders,
    body: form.toString()
  });
  let callbackUrl = "";
  if (approveRes.redirected && approveRes.url) {
    callbackUrl = approveRes.url;
  } else {
    const data = await approveRes.json().catch(() => ({}));
    callbackUrl = data.redirect_url || "";
  }
  if (!callbackUrl) {
    const txt = await approveRes.text().catch(() => "");
    throw new Error(`OAuth approve 未返回 redirect_url (HTTP ${approveRes.status}): ${String(txt).slice(0, 200)}`);
  }

  // 3) 触发回调，把 code 链接到 flow_id（响应是 HTML 成功页，忽略）
  progress("OAuth：完成回调，换取 zcode 凭证…");
  await upstreamFetch(callbackUrl, { method: "GET", signal }).catch(() => {
    /* best-effort：即便这里失败，第 2 步若已自动跟随重定向也可能已回调过 */
  });

  // 4) poll → ready
  const intervalMs = Math.max(1000, Number(init.poll_interval_sec || 1) * 1000);
  const expiresAt = Number(init.expires_at || 0) * 1000;
  const stopAt = Math.min(Date.now() + timeoutMs, expiresAt || Date.now() + timeoutMs);
  while (Date.now() < stopAt) {
    if (signal?.aborted) throw new Error("OAuth login cancelled");
    const pollJson = await fetchJson(`${ZCODE_API_BASE}/oauth/cli/poll/${encodeURIComponent(flowId)}`, {
      method: "GET",
      signal,
      headers: { authorization: `Bearer ${returnedPollToken}` }
    });
    const data = ensureEnvelopeOk(pollJson, "Z.AI OAuth poll");
    if (data.status === "failed") throw new Error("Z.AI OAuth 授权失败（poll status=failed）");
    if (data.status === "ready") {
      if (!data.token || !data.zai?.access_token) throw new Error("Z.AI OAuth ready 响应缺少 token 数据");
      progress("OAuth：授权成功，已获取 zcode 凭证。");
      return {
        provider: "zai",
        token: data.token,
        accessToken: data.zai.access_token,
        refreshToken: "",
        userInfo: normalizeZaiCliUser(data.user)
      };
    }
    await sleep(Math.min(intervalMs, Math.max(0, stopAt - Date.now())));
  }
  throw new Error("Z.AI OAuth 授权超时");
}

async function authorizeZaiOAuthCodeFlow({ chatZaiJwt, sessionCookie = "", timeoutMs = DEFAULT_TIMEOUT_MS, signal, onProgress } = {}) {
  if (!chatZaiJwt) throw new Error("authorizeZaiCli: missing chatZaiJwt");
  const progress = (msg) => {
    try {
      onProgress?.(msg);
    } catch {
      /* ignore */
    }
  };

  progress("OAuth: initializing ZCode authorization flow...");
  const state = randomHex();
  const stopAt = Date.now() + timeoutMs;

  progress("OAuth: approving ZCode client with registered Z.AI session...");
  const form = new URLSearchParams({
    client_id: ZAI_CLI_CLIENT_ID,
    redirect_uri: ZAI_OAUTH_REDIRECT_URI,
    state,
    response_type: "code",
    action: "approve"
  });
  const approveHeaders = {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: `Bearer ${chatZaiJwt}`
  };
  if (sessionCookie) approveHeaders.Cookie = sessionCookie;

  const approveRes = await upstreamFetch(ZAI_OAUTH_APPROVE_URL, {
    method: "POST",
    redirect: "manual",
    signal,
    headers: approveHeaders,
    body: form.toString()
  });
  let callbackUrl = approveRes.headers.get("location") || "";
  const responseText = callbackUrl ? "" : await approveRes.text().catch(() => "");
  if (!callbackUrl && responseText) {
    try {
      const data = JSON.parse(responseText);
      callbackUrl = data.redirect_url || data.redirectUrl || data.location || "";
    } catch {
      const match = responseText.match(/zcode:\/\/zai-auth\/callback\?[^"'<\s]+/);
      callbackUrl = match ? match[0] : "";
    }
  }
  if (!callbackUrl) {
    throw new Error(`OAuth approve did not return callback URL (HTTP ${approveRes.status}): ${responseText.slice(0, 200)}`);
  }
  if (Date.now() >= stopAt || signal?.aborted) throw new Error("Z.AI OAuth authorization timed out");

  progress("OAuth: exchanging authorization code for zcode token...");
  const callback = parseZaiCallbackUrl(callbackUrl, state);
  const loginResult = await exchangeZaiOAuthCode({ ...callback, signal });
  progress("OAuth: authorization succeeded; zcode token acquired.");
  return loginResult;
}

async function loginBigmodel({ timeoutMs, noBrowser }) {
  const flow = await startBigmodelLogin({ timeoutMs });
  console.log(`Open this URL to authorize:\n${flow.authorizeUrl}\n`);
  if (!noBrowser) await openUrlInBrowser(flow.authorizeUrl);
  return flow.waitForResult();
}

async function startBigmodelLogin({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const provider = PROVIDERS.bigmodel;
  const state = randomHex();
  const callbackServer = await createCallbackServer({
    callbackPath: "/oauth/callback/bigmodel",
    state
  });
  const authorizeUrl = buildBigmodelAuthorizeUrl({
    callbackUrl: callbackServer.callbackUrl,
    state
  });
  return {
    provider: "bigmodel",
    authorizeUrl,
    waitForResult: async () => {
      try {
        const callback = await withTimeout(callbackServer.waitForCallback, timeoutMs, "BigModel OAuth callback");
        const tokenJson = await fetchJson(provider.tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: "bigmodel",
            code: callback.code,
            redirect_uri: callbackServer.callbackUrl,
            state
          })
        });
        const data = ensureEnvelopeOk(tokenJson, "BigModel OAuth token exchange");
        const token = data.token && String(data.token).trim();
        const accessToken = (
          data.bigmodel?.access_token ||
          data.bigmodel?.accessToken ||
          data.access_token ||
          data.accessToken ||
          ""
        ).trim();
        const refreshToken = (
          data.bigmodel?.refresh_token ||
          data.bigmodel?.refreshToken ||
          data.refresh_token ||
          data.refreshToken ||
          ""
        ).trim();
        if (!token) throw new Error("BigModel OAuth token response is missing data.token");
        if (!accessToken) throw new Error("BigModel OAuth token response is missing access token");
        const userInfo = await fetchBigmodelUserInfo(accessToken).catch(() => null);
        return {
          provider: "bigmodel",
          token,
          accessToken,
          refreshToken,
          userInfo: userInfo || { id: "unknown", username: "user", displayName: "User" }
        };
      } finally {
        await callbackServer.close();
      }
    },
    cancel: callbackServer.cancel,
    close: callbackServer.close
  };
}

function buildBigmodelAuthorizeUrl({ callbackUrl, state }) {
  const provider = PROVIDERS.bigmodel;
  const authorizeParams = new URLSearchParams({
    response_type: "code",
    redirect_uri: callbackUrl,
    client_id: provider.appId,
    state,
    // Older ZCode desktop builds used these names. Keeping both makes the URL
    // work against either authorize implementation.
    redirect: callbackUrl,
    appId: provider.appId
  });
  return `${provider.authorizeUrl}?${authorizeParams.toString()}`;
}

async function fetchBigmodelUserInfo(accessToken) {
  const provider = PROVIDERS.bigmodel;
  const json = await fetchJson(provider.userinfoUrl, {
    method: "GET",
    headers: {
      authorization: accessToken,
      "content-type": "application/json"
    }
  });
  const data = json.data ?? json;
  const name = data.nickName || data.customerName || data.username || "user";
  return {
    id: data.customerNumber || data.id || "unknown",
    username: name,
    displayName: name,
    ...(data.avatar ? { avatarUrl: data.avatar } : {})
  };
}

function normalizeZaiCliUser(user) {
  const id = user?.user_id || user?.id || "unknown";
  const email = user?.email || user?.mail || "";
  const name = user?.name || email || id;
  return {
    id,
    username: name,
    displayName: name,
    ...(email ? { email } : {}),
    ...(user?.avatar ? { avatarUrl: user.avatar } : {})
  };
}

function maskToken(token) {
  if (!token) return "";
  if (token.length <= 24) return `${token.slice(0, 4)}...${token.slice(-4)}`;
  return `${token.slice(0, 12)}...${token.slice(-8)}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// 组装「写入官方 ZCode 客户端登录态所需的全部原料」，集中在账号对象的 zcode_client_state 块。
// 切号工具据此合成官方客户端的两份文件：
//   credentials.json:
//     oauth:active_provider          = active_provider
//     oauth:zai:access_token         = zai_access_token
//     oauth:zai:refresh_token        = zai_refresh_token（z.ai 不下发，恒空，仅对齐官方结构）
//     oauth:zai:user_info            = user_info（含 email，用于客户端显示账号）
//     zcodejwttoken                  = zcode_jwt_token（调 API 的 JWT）
//   config.json:
//     provider[builtin:zai-*].options.apiKey = zcode_jwt_token（明文 JWT，payload 含 user_id）
// renew.chat_zai_jwt 是 zcode JWT 过期（code:3012）后重新 OAuth 续期的唯一原料——
// 因为 z.ai OAuth 不发 refresh_token，官方客户端自带的续期路径对注册号不可用。
function buildZcodeClientState(loginResult = {}, register = null) {
  const u = loginResult.userInfo || {};
  return {
    active_provider: loginResult.provider || "zai",
    zcode_jwt_token: loginResult.token || "",
    zai_access_token: loginResult.accessToken || "",
    zai_refresh_token: loginResult.refreshToken || "",
    user_info: {
      user_id: u.id || u.user_id || "",
      email: u.email || (register && register.email) || "",
      name: u.displayName || u.username || u.name || "",
      avatar: u.avatarUrl || u.avatar || ""
    },
    renew: {
      chat_zai_jwt: (register && register.chat_zai_jwt) || "",
      session_cookie: (register && register.session_cookie) || ""
    },
    provider_ids: ["builtin:zai-start-plan", "builtin:zai-coding-plan", "builtin:zai"],
    captured_at: new Date().toISOString()
  };
}

// 用一次 OAuth 结果刷新账号的官方客户端登录态原料，保留续期信息与旧值兜底（新结果缺失字段时不抹掉旧值）。
function refreshClientState(stored, loginResult = {}) {
  const prev = stored.zcode_client_state || {};
  const next = buildZcodeClientState(loginResult, {
    chat_zai_jwt: (prev.renew && prev.renew.chat_zai_jwt) || (stored.register && stored.register.chat_zai_jwt) || "",
    session_cookie: (prev.renew && prev.renew.session_cookie) || (stored.register && stored.register.session_cookie) || "",
    email: (prev.user_info && prev.user_info.email) || (stored.register && stored.register.email) || ""
  });
  if (!next.zai_access_token && prev.zai_access_token) next.zai_access_token = prev.zai_access_token;
  if (!next.user_info.email && prev.user_info && prev.user_info.email) next.user_info.email = prev.user_info.email;
  if (!next.user_info.user_id && prev.user_info && prev.user_info.user_id) next.user_info.user_id = prev.user_info.user_id;
  stored.zcode_client_state = next;
  return next;
}

function baseAccount(id, loginResult, register = null) {
  return {
    id,
    enabled: true,
    provider: loginResult.provider,
    source: "direct-browser-oauth",
    api_format: "anthropic-messages",
    direct_anthropic_compatibility: "native Anthropic Messages protocol; model calls require ZCode runtime headers and fresh X-Aliyun-Captcha-Verify-Param",
    endpoint_origin: "https://zcode.z.ai",
    api_base_url: "https://zcode.z.ai/api/v1",
    model_endpoint: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
    billing_current_url: "https://zcode.z.ai/api/v1/zcode-plan/billing/current",
    billing_balance_url: "https://zcode.z.ai/api/v1/zcode-plan/billing/balance",
    default_headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "X-ZCode-Agent": "glm",
      "User-Agent": "ZCode/3.0.0",
      "X-ZCode-App-Version": "3.0.0",
      "HTTP-Referer": "https://zcode.z.ai",
      "X-Title": "Z Code@electron"
    },
    runtime_headers: {
      required: true,
      strategy: "generate-fresh-aliyun-captcha-param",
      client_configs_url: "https://zcode.z.ai/api/v1/client/configs?app_version=3.0.0&platform=win32-x64",
      captcha_sdk_url: "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js",
      captcha_config_path: "data.configs.captcha",
      generated_header_names: [
        "X-Aliyun-Captcha-Verify-Param",
        "x-session-id",
        "x-query-id",
        "x-request-id",
        "x-zcode-trace-id"
      ],
      storage_policy: "do-not-store-dynamic-captcha-param"
    },
    authorization: {
      type: "bearer",
      token: loginResult.token
    },
    oauth: {
      provider: loginResult.provider,
      access_token: loginResult.accessToken || undefined,
      refresh_token: loginResult.refreshToken || undefined
    },
    credential_keys: {
      direct_oauth: true,
      zcode_jwt_token: "authorization.token",
      access_token: "oauth.access_token",
      user_info: "user_info"
    },
    token_presence: {
      zcode_jwt_token: Boolean(loginResult.token),
      oauth_access_token: Boolean(loginResult.accessToken)
    },
    user_info: loginResult.userInfo || null,
    // 写入官方 ZCode 客户端登录态 + 续期所需的全部原料（切号工具消费此块）。
    zcode_client_state: buildZcodeClientState(loginResult, register)
  };
}

function upsertAccount(accountsFile, account, setDefault) {
  const data = fs.existsSync(accountsFile)
    ? readJson(accountsFile)
    : {
        schema_version: "zcode2api.accounts.v1",
        notes: [
          "do not commit this file; it contains bearer tokens",
          "do not persist historical captcha verification params; generate a new runtime header before model requests"
        ],
        accounts: []
      };
  if (!Array.isArray(data.accounts)) data.accounts = [];
  const index = data.accounts.findIndex((item) => item.id === account.id);
  if (index >= 0) data.accounts[index] = { ...data.accounts[index], ...account };
  else data.accounts.push(account);
  if (setDefault) data.default_account_id = account.id;
  data.updated_at = new Date().toISOString();
  writeJson(accountsFile, data);
  return index >= 0 ? "updated" : "added";
}

async function startOAuthLogin({ provider, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const normalized = normalizeProvider(provider || "bigmodel");
  return PROVIDERS[normalized].mode === "zai-code"
    ? startZaiLogin({ timeoutMs })
    : startBigmodelLogin({ timeoutMs });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.provider) args.provider = await chooseProvider();
  const provider = PROVIDERS[args.provider];
  const loginResult = provider.mode === "zai-code"
    ? await loginZaiCli(args)
    : await loginBigmodel(args);
  const accountsFile = path.resolve(args.accounts);
  const account = baseAccount(args.id, loginResult);
  const action = upsertAccount(accountsFile, account, args.setDefault);
  console.log(JSON.stringify({
    ok: true,
    action,
    accounts_file: accountsFile,
    account_id: args.id,
    provider: loginResult.provider,
    user: account.user_info,
    token_present: true,
    token_preview: maskToken(loginResult.token),
    set_default: args.setDefault
  }, null, 2));
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  PROVIDERS,
  baseAccount,
  buildZcodeClientState,
  refreshClientState,
  maskToken,
  normalizeProvider,
  openUrlInBrowser,
  startOAuthLogin,
  authorizeZaiCli: authorizeZaiOAuthCodeFlow,
  upsertAccount
};

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }, null, 2));
    process.exit(1);
  });
}
