"use strict";

const path = require("path");
const { spawn } = require("child_process");

const SHARED_PROXY_SERVER = String(process.env.ZCODE2API_PROXY_SERVER || "").trim();
const UPSTREAM_PROXY_SERVER = String(process.env.ZCODE2API_UPSTREAM_PROXY_SERVER || SHARED_PROXY_SERVER || "").trim();
const UPSTREAM_TRANSPORT = String(process.env.ZCODE2API_UPSTREAM_TRANSPORT || "node").trim().toLowerCase();
const UPSTREAM_CURL_BIN = String(process.env.ZCODE2API_CURL_BIN || "curl").trim() || "curl";
const UPSTREAM_CURL_HTTP_VERSION = String(process.env.ZCODE2API_CURL_HTTP_VERSION || "http1.1").trim().toLowerCase();
const CURL_IMPERSONATE_DIR = String(process.env.ZCODE2API_CURL_IMPERSONATE_DIR || "/opt/curl-impersonate-zcode").trim();
const CURL_TIMEOUT_MS = Number.parseInt(process.env.ZCODE2API_CURL_TIMEOUT_MS || "120000", 10);
const CURL_HOSTS = new Set(
  String(process.env.ZCODE2API_CURL_HOSTS || "chat.z.ai,zcode.z.ai")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const CURL_PROFILES = Object.freeze({
  chrome116: "curl_chrome116",
  chrome110: "curl_chrome110",
  edge101: "curl_edge101",
  firefox117: "curl_ff117",
  safari15_5: "curl_safari15_5",
});
let runtimeCurlProfile = normalizeCurlProfile(process.env.ZCODE2API_CURL_PROFILE || "default");
let runtimeProxyServer = UPSTREAM_PROXY_SERVER;

function normalizeCurlProfile(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (!raw || raw === "env" || raw === "default") return "default";
  if (raw === "random") return "random";
  if (raw === "chrome" || raw === "chrome_116") return "chrome116";
  if (raw === "chrome_110") return "chrome110";
  if (raw === "edge" || raw === "edge_101") return "edge101";
  if (raw === "firefox" || raw === "ff" || raw === "ff117" || raw === "firefox_117") return "firefox117";
  if (raw === "safari" || raw === "safari_15_5") return "safari15_5";
  return CURL_PROFILES[raw] ? raw : "default";
}

function setRuntimeCurlProfile(value) {
  runtimeCurlProfile = normalizeCurlProfile(value);
  return runtimeCurlProfile;
}

function getRuntimeCurlProfile() {
  return runtimeCurlProfile;
}

function setRuntimeProxyServer(value) {
  runtimeProxyServer = String(value || "").trim();
  return runtimeProxyServer;
}

function getRuntimeProxyServer() {
  return runtimeProxyServer;
}

function selectCurlBin(profile = runtimeCurlProfile) {
  const normalized = normalizeCurlProfile(profile);
  if (normalized === "default") return UPSTREAM_CURL_BIN;
  const keys = Object.keys(CURL_PROFILES);
  const selected = normalized === "random" ? keys[Math.floor(Math.random() * keys.length)] : normalized;
  const bin = CURL_PROFILES[selected];
  if (!bin) return UPSTREAM_CURL_BIN;
  return path.isAbsolute(bin) ? bin : path.join(CURL_IMPERSONATE_DIR, bin);
}

function headerEntries(headers = {}) {
  if (!headers) return [];
  if (typeof headers.forEach === "function") {
    const out = [];
    headers.forEach((value, key) => out.push([key, value]));
    return out;
  }
  if (Array.isArray(headers)) return headers;
  return Object.entries(headers);
}

function normalizeBody(body) {
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  return Buffer.from(String(body));
}

function parseCurlHead(head) {
  const lines = head.split(/\r?\n/);
  const statusLine = lines.shift() || "";
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/i);
  if (!statusMatch) throw new Error(`curl response invalid status line: ${statusLine}`);
  const rawHeaders = [];
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    rawHeaders.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  return {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] || "",
    rawHeaders,
  };
}

function makeHeaders(rawHeaders) {
  const lower = new Map();
  const setCookies = [];
  for (const [name, value] of rawHeaders) {
    const key = String(name).toLowerCase();
    if (key === "set-cookie") setCookies.push(value);
    if (!lower.has(key)) lower.set(key, []);
    lower.get(key).push(value);
  }
  return {
    get(name) {
      const values = lower.get(String(name || "").toLowerCase());
      return values && values.length ? values.join(", ") : null;
    },
    getSetCookie() {
      return [...setCookies];
    },
    forEach(callback) {
      for (const [name, values] of lower.entries()) callback(values.join(", "), name);
    },
  };
}

function makeResponse({ status, statusText, rawHeaders, body }) {
  let consumed = false;
  const bodyBuffer = Buffer.from(body || Buffer.alloc(0));
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    redirected: false,
    url: "",
    headers: makeHeaders(rawHeaders),
    async text() {
      consumed = true;
      return bodyBuffer.toString("utf8");
    },
    async json() {
      consumed = true;
      return JSON.parse(bodyBuffer.toString("utf8") || "null");
    },
    get bodyUsed() {
      return consumed;
    },
  };
}

function shouldUseCurl(url) {
  if (UPSTREAM_TRANSPORT !== "curl") return false;
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return target.protocol === "https:" && CURL_HOSTS.has(target.hostname.toLowerCase());
}

function requestWithCurl(url, options = {}, timeoutMs = CURL_TIMEOUT_MS) {
  const args = [
    "-sS",
    "-i",
    "--connect-timeout",
    "30",
    "--max-time",
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
  ];
  if (UPSTREAM_CURL_HTTP_VERSION === "http1.1" || UPSTREAM_CURL_HTTP_VERSION === "1.1") args.push("--http1.1");
  else if (UPSTREAM_CURL_HTTP_VERSION === "http2" || UPSTREAM_CURL_HTTP_VERSION === "h2" || UPSTREAM_CURL_HTTP_VERSION === "2") args.push("--http2");
  if (options.redirect !== "manual") args.push("--location");
  if (runtimeProxyServer) args.push("--proxy", runtimeProxyServer);
  args.push("-X", options.method || "GET");
  for (const [name, value] of headerEntries(options.headers)) {
    if (value === undefined || value === null) continue;
    args.push("-H", `${name}: ${value}`);
  }
  const body = normalizeBody(options.body);
  if (body) args.push("--data-binary", "@-");
  args.push(url);

  return new Promise((resolve, reject) => {
    const child = spawn(selectCurlBin(), args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`curl request timed out after ${timeoutMs}ms`));
    }, timeoutMs + 1000);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const err = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(`curl request failed (${code}): ${err || "no stderr"}`));
        return;
      }
      try {
        let pending = Buffer.concat(stdout);
        let parsed = null;
        while (true) {
          const marker = Buffer.from("\r\n\r\n");
          const headerEnd = pending.indexOf(marker);
          if (headerEnd < 0) throw new Error("curl response missing HTTP headers");
          const head = pending.subarray(0, headerEnd).toString("latin1");
          const rest = pending.subarray(headerEnd + marker.length);
          if (
            /^HTTP\/\d(?:\.\d)?\s+100\b/i.test(head) ||
            /^HTTP\/\d(?:\.\d)?\s+2\d\d\s+Connection\s+established\b/i.test(head) ||
            /^HTTP\/\d(?:\.\d)?\s+2\d\d\b[\s\S]*\r?\nConnection\s+established\b/im.test(head)
          ) {
            pending = rest;
            continue;
          }
          parsed = parseCurlHead(head);
          pending = rest;
          if (parsed.status >= 300 && parsed.status < 400 && options.redirect !== "manual") {
            continue;
          }
          break;
        }
        resolve(makeResponse({ ...parsed, body: pending }));
      } catch (error) {
        reject(error);
      }
    });
    if (options.signal) {
      if (options.signal.aborted) child.kill("SIGKILL");
      else options.signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    }
    if (body) child.stdin.end(body);
    else child.stdin.end();
  });
}

async function upstreamFetch(url, options = {}, timeoutMs) {
  if (shouldUseCurl(url)) return requestWithCurl(url, options, timeoutMs);
  return fetch(url, options);
}

module.exports = {
  upstreamFetch,
  requestWithCurl,
  shouldUseCurl,
  normalizeCurlProfile,
  setRuntimeCurlProfile,
  getRuntimeCurlProfile,
  setRuntimeProxyServer,
  getRuntimeProxyServer,
};
