"use strict";

/**
 * 卡密编解码 —— 把账号压成一行「最小凭证」卡密，用于发卡网售卖。
 *
 * 格式：ZC1.<base64url(JSON)>
 *   JSON 只含切号必需的最小字段：
 *     v  版本号(1)
 *     j  zcode JWT（调 API + 写 config.json apiKey + credentials.zcodejwttoken）
 *     a  zai access_token（写 credentials.oauth:zai:access_token）
 *     e  email（显示用，区分账号）
 *
 *   其余字段（provider/billing_url/headers/user_id）导入时用默认值或从 JWT 解出，
 *   不进卡密 —— 保持最短、最“干净”，客户看到的只是一串 ZC1.xxx 乱码。
 *
 * 去重：导入时从 JWT payload 解出 user_id 作为账号 id，重复卡密 = 同 id 自动跳过。
 */

const PREFIX = "ZC1.";

function b64urlEncode(str) {
  return Buffer.from(str, "utf8").toString("base64url");
}
function b64urlDecode(b64) {
  return Buffer.from(b64, "base64url").toString("utf8");
}

function jwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return {};
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")); }
  catch { return {}; }
}

/** 从账号对象提取最小凭证字段。 */
function extractMinimal(account) {
  const cs = account.zcode_client_state || {};
  return {
    jwt: cs.zcode_jwt_token || account.authorization?.token || "",
    access: cs.zai_access_token || account.oauth?.access_token || "",
    email: cs.user_info?.email || account.user_info?.email || account.register?.email || "",
  };
}

/** 账号对象 → 一行卡密 ZC1.xxx。无 JWT 抛错。 */
function encodeCard(account) {
  const m = extractMinimal(account);
  if (!m.jwt) throw new Error(`账号 ${account?.id || "?"} 缺少 zcode JWT，无法导出卡密`);
  const payload = { v: 1, j: m.jwt, a: m.access, e: m.email };
  return PREFIX + b64urlEncode(JSON.stringify(payload));
}

/** 批量账号 → 卡密文本（一行一张）。 */
function encodeCards(accounts) {
  const lines = [];
  const errors = [];
  for (const a of accounts) {
    try { lines.push(encodeCard(a)); }
    catch (e) { errors.push({ id: a?.id, reason: e.message }); }
  }
  return { text: lines.join("\n"), count: lines.length, errors };
}

/** 一行卡密 → 账号对象（补全切号 + 额度查询所需的默认字段）。 */
function decodeCard(line) {
  const s = String(line || "").trim();
  if (!s.startsWith(PREFIX)) throw new Error("不是有效卡密（缺少 ZC1. 前缀）");
  let obj;
  try { obj = JSON.parse(b64urlDecode(s.slice(PREFIX.length))); }
  catch { throw new Error("卡密损坏（base64 解码失败）"); }
  if (!obj || !obj.j) throw new Error("卡密内容不完整（缺少 token）");

  const payload = jwtPayload(obj.j);
  const userId = payload.user_id || payload.sub || "";
  const email = obj.e || "";
  // id 用 user_id 前缀保证去重；无 user_id 回退 email hash
  const id = userId ? ("zai-" + String(userId).slice(0, 8))
    : email ? ("zai-" + simpleHash(email)) : ("zai-" + simpleHash(obj.j));

  return {
    id,
    enabled: true,
    provider: "zai",
    source: "cardkey-import",
    api_base_url: "https://zcode.z.ai/api/v1",
    billing_current_url: "https://zcode.z.ai/api/v1/zcode-plan/billing/current",
    billing_balance_url: "https://zcode.z.ai/api/v1/zcode-plan/billing/balance",
    authorization: { type: "bearer", token: obj.j },
    oauth: { provider: "zai", access_token: obj.a || undefined },
    user_info: { id: userId || "unknown", email, username: email || userId || id, displayName: email || userId || id },
    zcode_client_state: {
      active_provider: "zai",
      zcode_jwt_token: obj.j,
      zai_access_token: obj.a || "",
      zai_refresh_token: "",
      user_info: { user_id: userId || "", email, name: "", avatar: "" },
      provider_ids: ["builtin:zai-start-plan", "builtin:zai-coding-plan", "builtin:zai"],
      imported_at: new Date().toISOString(),
    },
  };
}

/** 多行卡密文本 → 账号数组。容错：跳过空行/非卡密/坏卡，收集到 errors。 */
function decodeCards(text) {
  const accounts = [];
  const errors = [];
  const lines = String(text || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith(PREFIX)) { errors.push({ line: line.slice(0, 20), reason: "非卡密行" }); continue; }
    try { accounts.push(decodeCard(line)); }
    catch (e) { errors.push({ line: line.slice(0, 24) + "…", reason: e.message }); }
  }
  return { accounts, errors, count: accounts.length };
}

function simpleHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).slice(0, 8);
}

module.exports = { PREFIX, encodeCard, encodeCards, decodeCard, decodeCards, extractMinimal };
