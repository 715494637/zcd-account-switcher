"use strict";

/**
 * tempmail.ing 临时邮箱客户端（Node 原生 fetch，零依赖）。
 *
 * 逻辑抽取自 services/tmpmail（providers/tempmailing），独立实现，不引用 Python。
 * tempmail.ing 不校验 TLS 指纹，Node 原生 fetch 即可。
 *
 *   建箱：POST https://api.tempmail.ing/api/generate {duration}
 *        → { email:{ address, expiresAt, createdAt, durationMinutes }, success }
 *   取件：GET  https://api.tempmail.ing/api/emails/<urlencode(email)>   (+ If-None-Match)
 *        → { emails:[ { subject, from_address, from_name, to, received_at, text, content/html, id } ], success }
 *        → 304 表示自上次 etag 后无新邮件
 *
 * 本模块只负责「拿邮件正文」。z.ai 验证信息（token / code / verify 链接）的识别见
 * extractZaiVerify / waitForZaiVerify。
 */

const BASE = "https://api.tempmail.ing";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/147.0.0.0 Safari/537.36";

function baseHeaders() {
  return {
    Accept: "*/*",
    Origin: "https://tempmail.ing",
    Referer: "https://tempmail.ing/",
    "User-Agent": UA,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 创建临时邮箱。durationMinutes: 邮箱存活分钟数（tempmail.ing 实测支持）。 */
async function createMailbox(durationMinutes = 10, opts = {}) {
  const res = await fetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: { ...baseHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ duration: durationMinutes }),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(`tempmail.ing generate HTTP ${res.status}: ${await safeText(res)}`);
  }
  const data = await res.json();
  const email = data?.email?.address;
  if (!email) {
    throw new Error(`tempmail.ing generate 未返回 email: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return {
    email,
    expiresAt: data.email.expiresAt || null,
    createdAt: data.email.createdAt || null,
    durationMinutes: data.email.durationMinutes || durationMinutes,
  };
}

/** 拉取一次收件箱（不等待）。返回 { messages, etag, unchanged }。 */
async function fetchMessages(email, etag, opts = {}) {
  const headers = { ...baseHeaders() };
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(`${BASE}/api/emails/${encodeURIComponent(email)}`, {
    headers,
    signal: opts.signal,
  });
  if (res.status === 304) return { messages: [], etag: etag || null, unchanged: true };
  if (!res.ok) {
    throw new Error(`tempmail.ing fetch HTTP ${res.status}: ${await safeText(res)}`);
  }
  const data = await res.json();
  const newEtag = res.headers.get("etag") || etag || null;
  const items = Array.isArray(data?.emails) ? data.emails : [];
  return { messages: items.map(normalizeMessage), etag: newEtag, unchanged: false };
}

function normalizeMessage(m) {
  const fromAddr = m.from_address || m.from || "";
  const fromName = m.from_name || "";
  const from = fromName && fromAddr ? `${fromName} <${fromAddr}>` : fromAddr;
  return {
    id: String(m.id || m.message_id || ""),
    subject: m.subject || "",
    from,
    to: m.to || "",
    date: m.received_at || m.date || null,
    bodyText: m.text || "",
    bodyHtml: m.content || m.body_html || m.html || null,
  };
}

/** 轮询直到匹配到邮件或超时。匹配命中返回首个 Message；超时抛错。 */
async function waitForMessage(email, cfg = {}) {
  const {
    matchFrom,
    matchSubject,
    timeoutMs = 90000,
    pollIntervalMs = 3000,
    onPoll,
    signal,
  } = cfg;
  const deadline = Date.now() + timeoutMs;
  let etag = null;
  let lastCount = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("aborted");
    let res;
    try {
      res = await fetchMessages(email, etag, { signal });
    } catch (e) {
      if (onPoll) onPoll({ error: String(e?.message || e) });
      await sleep(pollIntervalMs);
      continue;
    }
    etag = res.etag;
    lastCount = res.messages.length;
    for (const m of res.messages) {
      if (matchFrom && !String(m.from).toLowerCase().includes(matchFrom.toLowerCase())) continue;
      if (matchSubject && !String(m.subject).toLowerCase().includes(matchSubject.toLowerCase())) continue;
      return m;
    }
    if (onPoll) onPoll({ count: lastCount });
    await sleep(pollIntervalMs);
  }
  throw new Error(`tempmail.ing 等待邮件超时 (${timeoutMs}ms)`);
}

/**
 * 从 z.ai 验证邮件正文里提取验证信息。
 *
 * 识别优先级：
 *   1. verify_email?…token=XXX      → { kind:"token", token }
 *   2. ?token=XXX / &token=XXX       → { kind:"token", token }
 *   3. 6 位数字验证码                 → { kind:"code", code }
 *   4. 含 verify 的完整 URL          → { kind:"url", url }
 * 无法识别返回 null。
 */
function extractZaiVerify(message) {
  const text = [message?.subject, message?.bodyText, message?.bodyHtml]
    .filter(Boolean)
    .join("\n");
  if (!text) return null;

  let m = text.match(/verify_email\?[^"'\s<>]*token=([A-Za-z0-9_.\-]+)/i);
  if (m) return { kind: "token", token: m[1] };

  m = text.match(/[?&]token=([A-Za-z0-9_.\-]{6,})/i);
  if (m) return { kind: "token", token: m[1] };

  m = text.match(/(?:code|验证码|verification)[^\d]{0,16}(\d{4,8})/i);
  if (m) return { kind: "code", code: m[1] };

  m = text.match(/\b(\d{6})\b/);
  if (m) return { kind: "code", code: m[1] };

  m = text.match(/https?:\/\/[^\s"'<>]*verify[^\s"'<>]*/i);
  if (m) return { kind: "url", url: m[0] };

  return null;
}

/**
 * 轮询临时邮箱，直到出现可识别的 z.ai 验证邮件。
 * 返回 { message, verify }；超时抛错。
 *
 * 比 waitForMessage 更适合注册流程：临时邮箱可能混入无关邮件，这里对每封新邮件
 * 都跑 extractZaiVerify，命中 z.ai 验证信息才返回。
 */
async function waitForZaiVerify(email, cfg = {}) {
  const { timeoutMs = 120000, pollIntervalMs = 4000, onPoll, signal } = cfg;
  const deadline = Date.now() + timeoutMs;
  let etag = null;
  let scanned = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("aborted");
    let res;
    try {
      res = await fetchMessages(email, etag, { signal });
    } catch (e) {
      if (onPoll) onPoll({ error: String(e?.message || e) });
      await sleep(pollIntervalMs);
      continue;
    }
    etag = res.etag;
    for (const m of res.messages) {
      scanned += 1;
      const verify = extractZaiVerify(m);
      if (verify) return { message: m, verify };
    }
    if (onPoll) onPoll({ scanned });
    await sleep(pollIntervalMs);
  }
  throw new Error(`tempmail.ing 等待 z.ai 验证邮件超时 (${timeoutMs}ms, 共扫描 ${scanned} 封)`);
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

module.exports = {
  BASE,
  createMailbox,
  fetchMessages,
  waitForMessage,
  waitForZaiVerify,
  extractZaiVerify,
  normalizeMessage,
};
