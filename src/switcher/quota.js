"use strict";

/**
 * 轻量额度/福利查询（切号器专用，不依赖 main.js）。
 * 逻辑复刻自 main.js fetchAccountQuota：合并 billing/current(授权额度) + billing/balance(实际用量)。
 */

const ZCODE_APP_VERSION = process.env.ZCODE_APP_VERSION || "3.1.5";

function billingHeaders(account) {
  return {
    authorization: `Bearer ${account.authorization.token}`,
    accept: "application/json",
    "user-agent": account.default_headers?.["User-Agent"] || `ZCode/${ZCODE_APP_VERSION}`,
    "x-zcode-app-version": account.default_headers?.["X-ZCode-App-Version"] || ZCODE_APP_VERSION,
    "http-referer": account.default_headers?.["HTTP-Referer"] || "https://zcode.z.ai",
    "x-title": account.default_headers?.["X-Title"] || "Z Code@electron",
  };
}

function modelNameFromCapability(cap) {
  return String(cap || "").replace(/^model:/i, "");
}

function pickEntitlementFields(item) {
  const total = Number(item.total_units ?? item.grant_units ?? 0) || 0;
  const used = Number(item.used_units ?? 0) || 0;
  const remaining = Number(item.remaining_units ?? Math.max(0, total - used)) || 0;
  const available = Number(item.available_units ?? remaining) || 0;
  const cap = Array.isArray(item.capabilities) ? item.capabilities.find((v) => String(v).startsWith("model:")) : "";
  return {
    model: item.show_name || modelNameFromCapability(cap) || item.entitlement_id || "",
    unit_type: item.unit_type || "token",
    total_units: total,
    used_units: used,
    remaining_units: remaining,
    available_units: available,
    period_end: item.period_end || null,
    expires_at: item.expires_at || null,
  };
}

function entitlementKey(item) {
  if (item.entitlement_id) return `eid:${item.entitlement_id}`;
  const cap = Array.isArray(item.capabilities) ? item.capabilities.find((v) => String(v).startsWith("model:")) : "";
  if (cap) return `cap:${cap}`;
  return `name:${item.show_name || ""}`;
}

async function fetchJson(url, headers, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 查询账号额度 + 福利到期。
 * @returns {{ok, has_grant, has_remaining, primary_remaining_pct, refresh_at, plan_ends_at, models}}
 */
async function fetchQuota(account) {
  const apiBase = account.api_base_url || "https://zcode.z.ai/api/v1";
  const balanceUrl = account.billing_balance_url || `${apiBase}/zcode-plan/billing/balance`;
  const currentUrl = account.billing_current_url || `${apiBase}/zcode-plan/billing/current`;
  const headers = billingHeaders(account);

  const [balanceRes, currentRes] = await Promise.allSettled([
    fetchJson(balanceUrl + "?app_version=" + ZCODE_APP_VERSION + "&platform=win32-x64", headers),
    fetchJson(currentUrl + "?app_version=" + ZCODE_APP_VERSION + "&platform=win32-x64", headers),
  ]);

  const byKey = new Map();
  let planEndsAt = null;

  if (currentRes.status === "fulfilled") {
    const json = currentRes.value;
    if (!(typeof json?.code === "number" && json.code !== 0)) {
      const plans = json?.data?.plans || json?.plans || [];
      for (const plan of plans) {
        if (plan.ends_at) planEndsAt = plan.ends_at;
        for (const ent of plan.entitlements || []) {
          if (!(Array.isArray(ent.capabilities) && ent.capabilities.some((v) => String(v).startsWith("model:")))) continue;
          byKey.set(entitlementKey(ent), pickEntitlementFields({
            ...ent,
            period_end: ent.period_end ?? plan.ends_at ?? null,
            expires_at: ent.expires_at ?? plan.ends_at ?? null,
          }));
        }
      }
    }
  }

  if (balanceRes.status === "fulfilled") {
    const json = balanceRes.value;
    if (!(typeof json?.code === "number" && json.code !== 0)) {
      const data = json?.data || json;
      const balances = Array.isArray(data?.balances) ? data.balances : [];
      for (const item of balances) {
        if (!(Array.isArray(item.capabilities) && item.capabilities.some((v) => String(v).startsWith("model:")))) continue;
        const key = entitlementKey(item);
        const fromEnt = byKey.get(key);
        byKey.set(key, pickEntitlementFields({ period_end: fromEnt?.period_end, ...item }));
      }
    } else if (!byKey.size) {
      throw new Error(json.msg || `billing code ${json.code}`);
    }
  } else if (!byKey.size) {
    throw balanceRes.reason instanceof Error ? balanceRes.reason : new Error(String(balanceRes.reason));
  }

  const models = [...byKey.values()];
  const refreshCandidates = models
    .map((m) => m.period_end || m.expires_at)
    .filter(Boolean)
    .map((v) => (typeof v === "number" ? v * 1000 : Date.parse(v)))
    .filter((v) => Number.isFinite(v));
  const hasGrant = models.length > 0 && models.some((m) => Number(m.total_units) > 0);
  const primary = models.length
    ? models.reduce((best, m) => (Number(m.total_units) >= Number(best.total_units) ? m : best), models[0])
    : null;
  const hasRemaining = primary ? (Number(primary.remaining_units) > 0 || Number(primary.available_units) > 0) : false;
  const primaryPct = primary && Number(primary.total_units) > 0
    ? Math.floor((Number(primary.remaining_units) / Number(primary.total_units)) * 100)
    : 0;

  return {
    ok: true,
    has_grant: hasGrant,
    has_remaining: hasRemaining,
    primary_remaining_pct: primaryPct,
    refresh_at: refreshCandidates.length ? new Date(Math.min(...refreshCandidates)).toISOString() : null,
    plan_ends_at: planEndsAt ? new Date(typeof planEndsAt === "number" ? planEndsAt * 1000 : Date.parse(planEndsAt)).toISOString() : null,
    models,
  };
}

module.exports = { fetchQuota, billingHeaders };
