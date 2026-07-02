"use strict";

const S = { accounts: [], quotas: {}, filter: "all", selected: new Set(), status: null, view: "pool", regJobs: {}, regOpen: new Set() };
const $ = (id) => document.getElementById(id);

// ===== toast =====
function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = `<span class="ic">${kind === "err" ? "✕" : "✓"}</span><span>${esc(msg)}</span>`;
  $("toasts").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 250); }, kind === "err" ? 5000 : 2600);
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ===== 自定义确认弹窗 =====
function confirmDialog(body, { title = "确认", okText = "确定", danger = false } = {}) {
  return new Promise((resolve) => {
    $("confirmTitle").textContent = title;
    $("confirmBody").textContent = body;
    const ok = $("confirmOk"), cancel = $("confirmCancel"), mask = $("confirmMask");
    ok.textContent = okText;
    ok.className = "btn " + (danger ? "btn-danger" : "btn-primary");
    mask.classList.add("show");
    const done = (v) => { mask.classList.remove("show"); ok.onclick = cancel.onclick = null; resolve(v); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
  });
}

// ===== 主题 / 视图 =====
function initTheme() {
  const saved = localStorage.getItem("switcher-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  else if (matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.dataset.theme = "dark";
}
function switchView(v) {
  S.view = v;
  document.querySelectorAll(".nav-item[data-view]").forEach((n) => n.classList.toggle("active", n.dataset.view === v));
  document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === "view-" + v));
  $("viewTitle").textContent = v === "reg" ? "注册机" : "账号池";
  if (v === "reg") {
    ensureCaptcha(); loadBatch(); renderRegJobs();
    _captchaFixer?.connect();
  } else {
    _captchaFixer?.disconnect();
  }
}

// ===== 格式化 =====
function fmtExpiry(iso) {
  if (!iso) return { text: "—", cls: "" };
  const d = new Date(iso), diff = d.getTime() - Date.now();
  if (!Number.isFinite(d.getTime())) return { text: "—", cls: "" };
  const days = Math.floor(Math.abs(diff) / 86400000), hrs = Math.floor((Math.abs(diff) % 86400000) / 3600000);
  if (diff < 0) return { text: `已过期${days}天`, cls: "exp-over" };
  return { text: `${days}天${hrs}时`, cls: diff < 2 * 86400000 ? "exp-soon" : "" };
}
function pct(rem, total) { return total > 0 ? Math.floor((rem / total) * 100) : 0; }
function barCls(p) { return p >= 50 ? "" : p >= 15 ? "warn" : "danger"; }

// ===== 账号池渲染 =====
async function refreshStatus() {
  const r = await api.status();
  if (!r.ok) { toast(r.error, "err"); return; }
  S.status = r.data; const d = r.data;
  $("sTotal").textContent = d.total; $("sUsable").textContent = d.usable; $("sDead").textContent = d.dead;
  const zs = $("zstate");
  if (d.zcodeFound === false) {
    // 没检测到 ZCode 安装：最高优先级警示（橙色），切号会失败，先提示用户装/指路
    zs.className = "zstate warn";
    zs.innerHTML = "⚠ 未检测到 ZCODE";
    zs.title = "未找到 ZCode 客户端。请确认已安装 ZCode；若安装路径特殊，可设置环境变量 ZCODE_EXE 指定。";
  } else {
    zs.className = "zstate" + (d.zcodeRunning ? "" : " off");
    zs.innerHTML = d.zcodeRunning ? "● ZCODE <b>运行中</b>" : "○ ZCODE 未运行";
    zs.title = "";
  }
  $("sCurrent").innerHTML = d.current
    ? `当前 <b style="color:var(--accent-ink)">${esc(d.current)}</b>`
    : `<span style="color:var(--ink-4)">未切换</span>`;
}

function filtered() {
  return S.accounts.filter((a) => S.filter === "usable" ? a.usable : S.filter === "dead" ? a.quotaDead : true);
}

function renderCards() {
  const box = $("cards"), list = filtered();
  $("empty").style.display = list.length ? "none" : "block";
  box.innerHTML = list.map(cardHtml).join("");
  box.querySelectorAll("[data-use]").forEach((b) => b.onclick = () => doUse(b.dataset.use));
  box.querySelectorAll("[data-q]").forEach((b) => b.onclick = () => loadQuota(b.dataset.q));
  box.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => doDelete([b.dataset.del]));
  box.querySelectorAll(".card-check").forEach((c) => c.onchange = () => {
    c.checked ? S.selected.add(c.dataset.sel) : S.selected.delete(c.dataset.sel);
    updateSelbar();
  });
  updateSelbar();
}

// 多选内联提示 + 全选按钮态
function updateSelbar() {
  const n = S.selected.size;
  $("selInline").classList.toggle("hidden", n === 0);
  $("selCount").textContent = n;
  const vis = filtered();
  const all = vis.length > 0 && vis.every((a) => S.selected.has(a.id));
  $("selectAllBtn").classList.toggle("on", all && vis.length > 0);
}

function cardHtml(a) {
  const q = S.quotas[a.id];
  const cls = ["card"]; if (a.isCurrent) cls.push("current"); if (a.quotaDead) cls.push("dead");
  let badge = "";
  if (a.isCurrent) badge = `<span class="chip chip-on">当前</span>`;
  else if (a.quotaDead) badge = `<span class="chip chip-err">废号</span>`;
  else if (a.quotaExhausted) badge = `<span class="chip chip-warn">额度尽</span>`;
  else if (a.usable) badge = `<span class="chip chip-off">可用</span>`;
  const checked = S.selected.has(a.id) ? "checked" : "";
  return `<div class="${cls.join(" ")}">
    <div class="card-head">
      <input type="checkbox" class="card-check" data-sel="${esc(a.id)}" ${checked} />
      <div style="min-width:0">
        <div class="card-id">${esc(a.id)}</div>
        <div class="card-email">${esc(a.email || "—")}</div>
      </div>
      <div class="spacer"></div>${badge}
    </div>
    <div class="quota-area" id="qa-${esc(a.id)}">${q ? quotaHtml(q) : '<span class="q-loading">点 ↻ 查额度</span>'}</div>
    <div class="card-actions">
      <button class="btn btn-primary btn-sm" data-use="${esc(a.id)}" ${a.usable ? "" : "disabled"}>切到此号</button>
      <div class="spacer"></div>
      <button class="ibtn btn-sm card-mini" data-q="${esc(a.id)}" data-tip="查额度" style="width:30px;height:30px">↻</button>
      <button class="ibtn btn-sm card-mini btn-danger" data-del="${esc(a.id)}" data-tip="删除" style="width:30px;height:30px">🗑</button>
    </div>
  </div>`;
}

function quotaHtml(q) {
  if (q.__err) return `<span class="q-err">查询失败</span>`;
  if (!q.has_grant) return `<span class="q-err">福利已结束</span>`;
  const rows = (q.models || []).map((m) => {
    const p = pct(m.remaining_units, m.total_units);
    return `<div class="quota-row"><div class="quota-label"><span>${esc(m.model)}</span><span>${p}%</span></div>
      <div class="bar ${barCls(p)}"><i style="width:${p}%"></i></div></div>`;
  }).join("");
  const exp = fmtExpiry(q.plan_ends_at);
  return rows + `<div class="meta-line"><span>刷新 ${fmtExpiry(q.refresh_at).text}</span><span class="${exp.cls}">福利 ${exp.text}</span></div>`;
}

// ===== 账号池动作 =====
async function loadList() {
  const r = await api.list();
  if (!r.ok) { toast(r.error, "err"); return; }
  S.accounts = r.data; renderCards();
}
async function loadQuota(id) {
  const qa = $("qa-" + id);
  if (qa) qa.innerHTML = '<span class="q-loading"><span class="spin"></span> 查询中</span>';
  const r = await api.quota(id);
  S.quotas[id] = r.ok ? r.data : { __err: r.error };
  if (qa) qa.innerHTML = quotaHtml(S.quotas[id]);
}
async function refreshAllQuota() {
  const ids = filtered().filter((a) => a.usable).map((a) => a.id);
  if (!ids.length) { toast("没有可用账号"); return; }
  filtered().forEach((a) => { const qa = $("qa-" + a.id); if (qa && a.usable) qa.innerHTML = '<span class="q-loading"><span class="spin"></span></span>'; });
  const prog = $("refreshProg");
  prog.style.display = ""; prog.style.color = "var(--accent-ink)";
  const total = ids.length, BATCH = 6;
  let done = 0;
  $("refreshBtn").disabled = true;
  // 分批并发：每批 BATCH 个号同时查，实时显示「刷新中 done/total」
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const r = await api.quotaMany(slice);
    if (r.ok) {
      for (const [id, res] of Object.entries(r.data)) {
        S.quotas[id] = res.ok ? res.data : { __err: res.error };
        const qa = $("qa-" + id); if (qa) qa.innerHTML = quotaHtml(S.quotas[id]);
      }
    }
    done += slice.length;
    prog.textContent = `刷新中 ${done}/${total}`;
  }
  prog.textContent = `已刷新 ${total} 个`;
  $("refreshBtn").disabled = false;
  setTimeout(() => { prog.style.display = "none"; }, 2500);
}
async function doUse(id) {
  if (!await confirmDialog(`切换到 ${id}？\n会关闭并重启 ZCode，进行中的对话会中断。`, { title: "切换账号", okText: "切换" })) return;
  toast("切换中，正在重启 ZCode…");
  const r = await api.use(id, { restart: true });
  if (!r.ok) { toast(r.error, "err"); return; }
  toast(`已切到 ${r.data.account_id}`);
  await refreshStatus(); await loadList();
}
async function doAuto() {
  if (!await confirmDialog("自动挑额度最多的号并切换？\n会关闭并重启 ZCode。", { title: "自动选号", okText: "选号切换" })) return;
  toast("查询额度并挑选中…");
  const r = await api.auto({ restart: true });
  if (!r.ok) { toast(r.error, "err"); return; }
  toast(`已切到 ${r.data.picked}（剩余 ${r.data.remaining_pct}%）`);
  await refreshStatus(); await loadList();
}
async function doDelete(ids) {
  ids = ids || [...S.selected];
  if (!ids.length) return;
  if (!await confirmDialog(`删除 ${ids.length} 个账号？不可恢复。`, { title: "删除", okText: "删除", danger: true })) return;
  const r = await api.remove(ids);
  if (!r.ok) { toast(r.error, "err"); return; }
  toast(`已删除 ${r.data.removed.length} 个`);
  ids.forEach((id) => S.selected.delete(id)); updateSelbar();
  await refreshStatus(); await loadList();
}
async function doClearDead() {
  const n = S.accounts.filter((a) => a.quotaDead).length;
  if (!n) { toast("没有废号"); return; }
  if (!await confirmDialog(`清空全部 ${n} 个废号？不可恢复。`, { title: "清空废号", okText: "清空", danger: true })) return;
  const r = await api.clearDead();
  if (!r.ok) { toast(r.error, "err"); return; }
  toast(`已清空 ${r.data.removed.length} 个废号`);
  await refreshStatus(); await loadList();
}
// 导出选中（卡密格式，用户/dev 都可用）
async function doExportSelected() {
  const ids = [...S.selected];
  if (!ids.length) { toast("请先选中账号", "err"); return; }
  const r = await api.exportCards({ ids });
  if (!r.ok) { toast(r.error, "err"); return; }
  exportCache = { text: r.data.text, ids: r.data.ids };
  $("exportText").value = r.data.text;
  $("exportHint").textContent = `导出选中 ${r.data.count} 张卡密`;
  $("exportMask").classList.add("show");
}

// 全选/取消全选：只翻转 checkbox 状态 + 更新 selbar，不重建整个卡片 DOM
function toggleSelectAll() {
  const vis = filtered();
  const all = vis.length > 0 && vis.every((a) => S.selected.has(a.id));
  vis.forEach((a) => all ? S.selected.delete(a.id) : S.selected.add(a.id));
  // 原地更新已渲染的 checkbox，避免 innerHTML 全量重建 + 重绑事件
  document.querySelectorAll(".card-check[data-sel]").forEach((cb) => {
    const inVis = vis.some((a) => a.id === cb.dataset.sel);
    if (inVis) cb.checked = !all;
  });
  updateSelbar();
}

// ===== 导入 =====
function updateImportBadge() {
  const t = $("importText").value.trim(), badge = $("importBadge"), ok = $("importOkBtn");
  if (!t) { badge.textContent = "等待粘贴"; badge.className = "paste-badge"; ok.disabled = true; return; }
  const n = t.split(/\r?\n/).filter((l) => l.trim().startsWith("ZC1.")).length;
  if (n > 0) { badge.textContent = `识别 ${n} 张卡密`; badge.className = "paste-badge ok"; ok.disabled = false; }
  else if (t.startsWith("{") || t.startsWith("[")) { badge.textContent = "JSON"; badge.className = "paste-badge ok"; ok.disabled = false; }
  else { badge.textContent = "无法识别"; badge.className = "paste-badge err"; ok.disabled = true; }
}
function afterImport(r) {
  if (r.canceled) return;
  if (!r.ok) { toast(r.error, "err"); return; }
  const d = r.data, parts = [`导入 ${d.count} 个`];
  if (d.skipped?.length) parts.push(`跳过 ${d.skipped.length}`);
  if (d.errors?.length) parts.push(`无效 ${d.errors.length}`);
  toast(parts.join("，"));
  $("importMask").classList.remove("show"); $("importText").value = ""; updateImportBadge();
  refreshStatus(); loadList();
}

// ===== 导出卡密（dev）=====
let exportCache = { text: "", ids: [] };
async function openExport() {
  const r = await api.exportCards({ ids: S.selected.size ? [...S.selected] : null, unsoldOnly: $("exportUnsoldOnly").checked });
  if (!r.ok) { toast(r.error, "err"); return; }
  exportCache = { text: r.data.text, ids: r.data.ids };
  $("exportText").value = r.data.text;
  $("exportHint").textContent = `导出 ${r.data.count} 张卡密`;
  $("exportMask").classList.add("show");
}

// ===== 注册机（dev）=====
const ALIYUN_SDK = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
let regCaptchaInited = false, regConsumed = false, regSelected = new Set();

function loadScriptOnce(src, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    // 已加载过：直接 resolve（注意 script.src 会被规范化为绝对 URL）
    const abs = (() => { try { return new URL(src, location.href).href; } catch (_) { return src; } })();
    if ([...document.scripts].some((s) => s.src === abs || s.src === src)) return resolve();
    const el = document.createElement("script");
    el.src = src; el.async = true;
    const timer = setTimeout(() => { el.onload = el.onerror = null; reject(new Error("脚本加载超时(>" + Math.round(timeoutMs/1000) + "s)")); }, timeoutMs);
    el.onload = () => { clearTimeout(timer); resolve(); };
    el.onerror = () => { clearTimeout(timer); reject(new Error("脚本加载失败(网络被拦或URL失效)")); };
    document.head.appendChild(el);
  });
}
function setRegStatus(msg, cls = "") { const e = $("regStatus"); e.className = "reg-status " + cls; e.innerHTML = msg; }

// 显示带「重试」按钮的失败状态
function showRegRetry(message) {
  setRegStatus(esc(message) + ` <a id="regRetry" style="color:var(--accent-ink);cursor:pointer;text-decoration:underline;margin-left:6px">重试</a>`, "err");
  const r = $("regRetry"); if (r) r.onclick = () => { regCaptchaInited = false; ensureCaptcha(); };
}

let regInitToken = 0;
async function ensureCaptcha() {
  if (regCaptchaInited) return;
  const token = ++regInitToken; // 防并发重入：只有最新一次能推进状态
  setRegStatus("正在加载滑块…");
  const holder = $("regCaptchaHolder");
  holder.innerHTML = '<span class="hint"><span class="spin"></span> 正在加载滑块…</span>';
  try {
    window.AliyunCaptchaConfig = { region: "sgp", prefix: "no8xfe" };
    console.log("[验证码] 开始加载阿里云 SDK:", ALIYUN_SDK);
    if (typeof window.initAliyunCaptcha !== "function") await loadScriptOnce(ALIYUN_SDK, 15000);
    if (regInitToken !== token) return; // 已被更新的重试取代
    if (typeof window.initAliyunCaptcha !== "function") throw new Error("SDK 已加载但未暴露 initAliyunCaptcha");
    console.log("[验证码] SDK 加载成功，开始初始化");
    holder.innerHTML = '<span class="hint"><span class="spin"></span> 初始化滑块…</span>';
    // 初始化整体超时：若 12s 内未拿到实例/未渲染，判定为挂起并提示重试
    let initDone = false;
    const initTimer = setTimeout(() => {
      if (!initDone && regInitToken === token) {
        console.error("[验证码] 初始化超时，未见实例");
        showRegRetry("滑块初始化超时（可能是网络/SDK 异常），点此重试");
      }
    }, 12000);
    window.initAliyunCaptcha({
      SceneId: "36qgs6xb", mode: "embed", element: "#regCaptchaHolder", prefix: "no8xfe", region: "sgp",
      slideStyle: { width: 360, height: 42 }, language: "cn",
      success: (param) => { initDone = true; clearTimeout(initTimer); consumeCaptcha(param); },
      fail: (c) => {
        initDone = true; clearTimeout(initTimer);
        const code = c && typeof c === "object" ? (c.failCode || c.code || JSON.stringify(c)) : c;
        console.error("[验证码] 验证失败:", code);
        setRegStatus("验证失败，请重新拖动 (code:" + code + ")", "err");
        // 失败后自动刷新滑块（F014=token过期，刷新后恢复可用）
        setTimeout(() => { regConsumed = false; refreshCaptcha(); }, 500);
      },
      getInstance: (inst) => {
        initDone = true; clearTimeout(initTimer);
        window._regInst = inst; console.log("[验证码] 获取到实例:", inst);
      },
    });
    regCaptchaInited = true;
    if (regInitToken === token) setRegStatus("拖动滑块即开始注册一个号", "ok");
    console.log("[验证码] 初始化完成");
    // 嵌入模式下定位修正兜底：若 SDK 仍把内部元素设成 fixed，强制归位
    setTimeout(() => {
      const ld = document.querySelector("#regCaptchaHolder .hint"); if (ld) ld.remove();
      document.querySelectorAll("#regCaptchaHolder *").forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.position === "fixed") { el.style.position = "relative"; el.style.zIndex = "auto"; }
      });
    }, 700);
  } catch (e) {
    console.error("[验证码] 加载失败:", e);
    if (regInitToken === token) showRegRetry("加载滑块失败：" + e.message + "，点此重试");
  }
}
function refreshCaptcha() { try { const i = window._regInst; if (i?.refresh) i.refresh(); } catch (_) {} }

async function consumeCaptcha(param) {
  const p = typeof param === "string" ? param : (param?.captchaVerifyParam || "");
  if (!p) { setRegStatus("滑块未返回参数，重试", "err"); refreshCaptcha(); return; }
  if (regConsumed) return;
  regConsumed = true;
  setRegStatus("验证通过，正在注册…", "ok");
  const r = await api.regStart({ captcha_verify_param: p });
  if (r.ok && r.data?.jobId) { S.regJobs[r.data.jobId] = { id: r.data.jobId, status: "running", email: "", steps: ["验证通过，开始注册…"] }; renderRegJobs(); }
  else setRegStatus("注册启动失败：" + (r.error || "未知"), "err");
  // 刷新滑块，备用下一次注册
  setTimeout(() => { regConsumed = false; refreshCaptcha(); }, 120);
}

// 注册任务事件：累积每个 job 的步骤，供展开查看
api.onRegJob((job) => {
  const j = S.regJobs[job.id] || (S.regJobs[job.id] = { id: job.id, steps: [] });
  j.status = job.status; j.email = job.email || j.email; j.accountId = job.accountId; j.error = job.error; j.oauthError = job.oauthError;
  if (job.lastMessage && j.steps[j.steps.length - 1] !== job.lastMessage) j.steps.push(job.lastMessage);
  if (job.status === "done") { j.steps.push(job.oauthError ? "OAuth 待重试：" + job.oauthError : "✓ 注册完成"); loadBatch(); }
  else if (job.status === "error") j.steps.push("✗ 失败：" + job.error);
  renderRegJobs();
});

// 渲染注册任务行（running/done/error，可展开看步骤）
function renderRegJobs() {
  const jobs = Object.values(S.regJobs);
  const rows = jobs.map((j) => {
    const open = S.regOpen.has(j.id) ? "open" : "";
    const st = j.status === "running" ? `<span class="chip chip-warn"><span class="spin"></span> 注册中</span>`
      : j.status === "error" ? `<span class="chip chip-err">失败</span>`
      : j.oauthError ? `<span class="chip chip-warn">待授权</span>` : `<span class="chip chip-on">就绪</span>`;
    const ck = j.status === "done" && j.accountId ? `<input type="checkbox" data-rsel="${esc(j.accountId)}" ${regSelected.has(j.accountId) ? "checked" : ""}>` : `<span style="width:15px"></span>`;
    const steps = j.steps.map((s) => `<div class="reg-step ${s.startsWith("✗") ? "err" : ""}"><span class="dot">▸</span><span>${esc(s)}</span></div>`).join("");
    return `<div class="reg-row ${open}" data-jid="${esc(j.id)}">
      <div class="reg-row-main">
        ${ck}<span class="caret">▸</span>
        <span class="em">${esc(j.email || j.accountId || j.id)}</span>${st}
      </div>
      <div class="reg-steps">${steps || '<div class="reg-step">等待…</div>'}</div>
    </div>`;
  }).join("");
  $("regRows").innerHTML = rows;
  $("regEmpty").style.display = jobs.length ? "none" : "block";
  $("regRows").querySelectorAll(".reg-row-main").forEach((m) => m.onclick = (e) => {
    if (e.target.matches("[data-rsel]")) return;
    const jid = m.closest(".reg-row").dataset.jid;
    S.regOpen.has(jid) ? S.regOpen.delete(jid) : S.regOpen.add(jid);
    m.closest(".reg-row").classList.toggle("open");
  });
  $("regRows").querySelectorAll("[data-rsel]").forEach((c) => c.onchange = (e) => {
    e.stopPropagation();
    c.checked ? regSelected.add(c.dataset.rsel) : regSelected.delete(c.dataset.rsel);
  });
}

async function loadBatch() {
  const r = await api.regBatch();
  if (!r.ok) return;
  const b = r.data;
  $("batchTag").textContent = `${b.accounts.length} 个号` + (b.runningJobs ? ` · 注册中 ${b.runningJobs}` : "");
}

function regIds() { return regSelected.size ? [...regSelected] : null; }

// ===== 事件绑定 =====
// 导航
document.querySelectorAll(".nav-item[data-view]").forEach((n) => n.onclick = () => switchView(n.dataset.view));
$("navBuy").onclick = () => api.openExternal("https://pay.ldxp.cn/item/fajqvp");
$("navTheme").onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next; localStorage.setItem("switcher-theme", next);
};
// 账号池
$("autoBtn").onclick = doAuto;
$("refreshBtn").onclick = refreshAllQuota;
$("clearDeadBtn").onclick = doClearDead;
$("selectAllBtn").onclick = toggleSelectAll;
$("buyBtn").onclick = () => api.openExternal("https://pay.ldxp.cn/item/fajqvp");
$("exportBtn").onclick = () => S.selected.size ? doExportSelected() : openExport();
$("importBtn").onclick = () => { $("importMask").classList.add("show"); updateImportBadge(); $("importText").focus(); };
$("importX").onclick = $("importCancelBtn").onclick = () => $("importMask").classList.remove("show");
$("importText").oninput = updateImportBadge;
$("importFileBtn").onclick = async () => afterImport(await api.importDialog());
$("importOkBtn").onclick = async () => { const t = $("importText").value.trim(); if (t) afterImport(await api.importText(t)); };
// 多选栏
$("selExportBtn").onclick = doExportSelected;
$("selDelBtn").onclick = () => doDelete();
$("selClearBtn").onclick = () => {
  S.selected.clear();
  document.querySelectorAll(".card-check[data-sel]:checked").forEach((cb) => cb.checked = false);
  updateSelbar();
};
$("filters").querySelectorAll(".filter").forEach((f) => f.onclick = () => {
  $("filters").querySelector(".active")?.classList.remove("active");
  f.classList.add("active"); S.filter = f.dataset.f; renderCards();
});
// 导出（dev）
$("exportX").onclick = () => $("exportMask").classList.remove("show");
$("exportUnsoldOnly").onchange = openExport;
$("exportCopyBtn").onclick = async () => {
  if (!exportCache.text) { toast("无卡密", "err"); return; }
  await navigator.clipboard.writeText(exportCache.text); toast(`已复制 ${exportCache.ids.length} 张`);
};
$("exportSaveBtn").onclick = async () => {
  const r = await api.saveCardsFile(exportCache.text);
  if (r.canceled) return; if (!r.ok) { toast(r.error, "err"); return; } toast("已导出 " + r.data.path);
};
$("exportSoldBtn").onclick = async () => {
  if (!exportCache.ids.length) return;
  if (!await confirmDialog(`把 ${exportCache.ids.length} 张标记已售？默认不再出现在「仅未售」里。`, { title: "结束批次", okText: "标记已售" })) return;
  const r = await api.markSold(exportCache.ids);
  if (!r.ok) { toast(r.error, "err"); return; }
  toast(`已标记 ${r.data.marked} 张`); $("exportMask").classList.remove("show");
};
// 注册机批次（dev）
// 手动刷新验证码（失效/超时时点击）
const _cRefBtn = $("captchaRefreshBtn");
if (_cRefBtn) _cRefBtn.onclick = () => { regConsumed = false; refreshCaptcha(); };
$("regSelectAll").onclick = () => {
  const checks = $("regRows").querySelectorAll("[data-rsel]");
  const all = checks.length > 0 && [...checks].every((c) => c.checked);
  checks.forEach((c) => { c.checked = !all; c.checked ? regSelected.add(c.dataset.rsel) : regSelected.delete(c.dataset.rsel); });
};
$("regCopyBtn").onclick = async () => {
  const r = await api.regCards(regIds());
  if (!r.ok) { toast(r.error, "err"); return; }
  if (!r.data.count) { toast("没有可复制的号", "err"); return; }
  await navigator.clipboard.writeText(r.data.text); toast(`已复制 ${r.data.count} 张卡密`);
};
$("regImportBtn").onclick = async () => {
  const ids = regIds();
  const r = await api.regImportToPool(ids);
  if (!r.ok) { toast(r.error, "err"); return; }
  toast(`已导入切号池 ${r.data.count} 个`);
  // 导入后从批次列表移除已导入的记录，不再持续显示
  if (ids) {
    const idSet = new Set(ids);
    Object.keys(S.regJobs).forEach((jid) => {
      if (idSet.has(S.regJobs[jid].accountId)) delete S.regJobs[jid];
    });
    regSelected.clear();
  } else {
    // 全量导入：移除所有已完成的 job
    Object.keys(S.regJobs).forEach((jid) => {
      if (S.regJobs[jid].status === "done") delete S.regJobs[jid];
    });
  }
  renderRegJobs(); loadList(); refreshStatus();
};
$("regEndBtn").onclick = async () => {
  // 一键结束，无需确认弹窗
  const r = await api.regEndBatch();
  if (!r.ok) { toast(r.error, "err"); return; }
  S.regJobs = {}; regSelected.clear(); renderRegJobs(); loadBatch();
  if (r.data.cleared) toast(`批次已结束（清 ${r.data.cleared} 个）`);
};

// ===== 阿里云验证码弹窗居中修正器 =====
// 根因（CDP 实测确认，两层）：
//  1) SDK 弹窗 #aliyunCaptcha-window-float 默认 position:absolute，相对最近的定位
//     祖先 #aliyunCaptcha-float-wrapper(position:relative) 定位 —— top:50%/left:50%
//     解析成那个 46×360 小按钮条容器的中心(23px/180px)，弹窗卡在左上角遮住按钮。
//  2) 即便强制 position:fixed，float-wrapper 还带了 identity transform(matrix(1,0,0,1,0,0))，
//     按 CSS 规范这会让它成为 fixed 后代的「包含块」，fixed 依旧相对小容器而非视口。
// 解法三件套：强制弹窗 fixed + 清除 aliyun 祖先容器的 transform + 自身相对视口居中。
// 全用 inline !important，SDK 改不动；幂等比对避免触发 observer 死循环。
//
// ⚡ 性能门控：MutationObserver 监听整个 body 的 childList+attributes 开销不低——
//    非 dev 用户永远不需要验证码弹窗；dev 用户只在「注册机」视图激活时才需要。
//    因此：仅在 dev 模式下初始化，且切到 reg 视图时 connect，切走时 disconnect。
let _captchaFixerObserver = null; // dev 模式下懒建，非 dev 永远为 null
function startCaptchaPopupFixer() {
  const GAP = 8;
  let scheduled = false;

  function applyFix() {
    scheduled = false;
    document.querySelectorAll('[id^="aliyunCaptcha-window-"]').forEach((pop) => {
      if ((pop.id || "").includes("embed")) return;

      // 1) 清除 aliyun 祖先容器的 transform（消除错误 fixed/absolute 包含块）
      let p = pop.parentElement;
      while (p && p !== document.body) {
        const id = p.id || "", cls = typeof p.className === "string" ? p.className : "";
        if ((id.includes("aliyun") || cls.includes("aliyun"))
            && getComputedStyle(p).transform !== "none"
            && p.style.getPropertyValue("transform") !== "none") {
          p.style.setProperty("transform", "none", "important");
        }
        p = p.parentElement;
      }

      // 2) 强制 fixed，清 transform/inset 残留，读取弹窗真实尺寸
      pop.style.setProperty("position",  "fixed", "important");
      pop.style.setProperty("transform", "none",  "important");
      pop.style.setProperty("top",    "0",    "important");
      pop.style.setProperty("left",   "0",    "important");
      pop.style.setProperty("right",  "auto", "important");
      pop.style.setProperty("bottom", "auto", "important");
      pop.style.setProperty("margin", "0",    "important");
      const pr = pop.getBoundingClientRect();
      const pw = pr.width || 332, ph = pr.height || 330;

      // 3) 靠近按钮条定位：优先 holder，其次按钮体，再次居中
      const anchor = document.querySelector("#regCaptchaHolder")
                  || document.querySelector("#aliyunCaptcha-float-wrapper");
      const vw = window.innerWidth, vh = window.innerHeight;
      let tx, ty;
      if (anchor) {
        const ar = anchor.getBoundingClientRect();
        tx = Math.max(GAP, Math.min(ar.left, vw - pw - GAP));
        if (ar.bottom + GAP + ph <= vh - GAP) {
          ty = ar.bottom + GAP;
        } else if (ar.top - GAP - ph >= GAP) {
          ty = ar.top - GAP - ph;
        } else {
          ty = Math.max(GAP, (vh - ph) / 2);
        }
      } else {
        tx = Math.max(GAP, (vw - pw) / 2);
        ty = Math.max(GAP, (vh - ph) / 2);
      }

      // 4) 幂等写入（避免每次 MutationObserver 触发都重写引发循环）
      const tStr = Math.round(tx) + "px", yStr = Math.round(ty) + "px";
      if (pop.style.getPropertyValue("left") !== tStr) pop.style.setProperty("left", tStr, "important");
      if (pop.style.getPropertyValue("top")  !== yStr) pop.style.setProperty("top",  yStr, "important");
    });
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(applyFix);
  }

  // 返回已构建但尚未 observe 的 MutationObserver——由 switchView 决定何时 connect/disconnect。
  // 非 dev 模式调用方不会建 observer，此函数也不会被调用。
  _captchaFixerObserver = new MutationObserver(schedule);
  // 首次运行一遍（observer 尚未启动，手动调）
  return { connect: () => {
    _captchaFixerObserver.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ["style", "class"],
    });
    schedule();
  }, disconnect: () => _captchaFixerObserver.disconnect() };
}
let _captchaFixer = null; // connect/disconnect 句柄，仅 dev 有值

// ===== 初始化 =====
(async function init() {
  initTheme();
  await refreshStatus();
  if (S.status?.dev) {
    document.querySelectorAll(".dev-only").forEach((el) => el.style.display = "");
    // dev 模式才建弹窗修正器（返回 connect/disconnect 句柄；非 dev 永远不建 MutationObserver）
    _captchaFixer = startCaptchaPopupFixer();
  }
  await loadList();
  // 可见性门控轮询：窗口最小化/隐藏时暂停 status 轮询，恢复时立即刷新一次再继续
  let _timer = setInterval(refreshStatus, 8000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearInterval(_timer); _timer = null;
    } else {
      refreshStatus();
      _timer = _timer || setInterval(refreshStatus, 8000);
    }
  });
})();
