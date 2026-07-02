"use strict";

/**
 * ZCode 切号器 - Electron 主进程
 *
 * 桥接渲染进程 ↔ 已验证的后端模块（switcher/core.js + switcher/quota.js）。
 * contextIsolation=true，渲染进程只能通过 preload 暴露的 window.api 调用。
 */

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");

// ---- 内存优化（须在 app.whenReady 之前调用）----
// 切号器是轻量工具，不需要 GPU 渲染管线；禁用硬件加速可节省显存分配 (~20-30MB)
app.disableHardwareAcceleration();
// 限制 V8 堆（UI 足够轻量，128MB 绰绰有余）
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=128");
// 关闭不需要的 Chromium 功能：共享渲染进程内存
app.commandLine.appendSwitch("disable-features", "SpareRendererForSitePerProcess,AutofillServerCommunication");

// 后端模块（开发态在 src/；打包后 extraResources → app-src/switcher）
const DEV_SRC = path.join(__dirname, "src");  // desktop 现在自包含，src 就在 desktop/ 内
const PACKED_SRC = path.join(process.resourcesPath || "", "app-src");
const SRC_DIR = fs.existsSync(path.join(DEV_SRC, "switcher", "core.js")) ? DEV_SRC : PACKED_SRC;

// dev 模式：环境变量 SWITCHER_DEV=1 或存在标记文件时开启注册/导出能力。
const IS_DEV = process.env.SWITCHER_DEV === "1" || fs.existsSync(path.join(__dirname, "dev", ".enabled"));

// 数据目录就近：打包后用 exe 同级 data/，开发态用 desktop/data/。
// 所有切号器自有数据（accounts.json / 切换状态 / 备份）都落这里，不散落用户目录。
//
// ⚠️ 便携版（Portable）特殊处理：electron-builder 运行时先解压到系统临时目录，
// process.execPath 指向临时路径（关闭后清除）。electron-builder 会专门注入
// PORTABLE_EXECUTABLE_DIR = 便携 exe 的实际目录，必须优先用它，
// 否则每次重启数据都消失。
const APP_DIR = process.env.PORTABLE_EXECUTABLE_DIR   // 便携版：exe 真实所在目录
  || (app.isPackaged ? path.dirname(process.execPath)  // NSIS 安装版：安装目录
  : __dirname);                                        // 开发态：desktop/
const DATA_DIR = process.env.SWITCHER_DATA_DIR || path.join(APP_DIR, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.SWITCHER_DATA_DIR = DATA_DIR; // 供 core.js 读取（须在 require 之前设置）

const core = require(path.join(SRC_DIR, "switcher", "core.js"));
const { fetchQuota } = require(path.join(SRC_DIR, "switcher", "quota.js"));
const cardkey = require(path.join(SRC_DIR, "switcher", "cardkey.js"));

// accounts.json 放数据目录（可用环境变量覆盖）
const ACCOUNTS_FILE = process.env.ZCODE_ACCOUNTS_FILE || path.join(DATA_DIR, "accounts.json");

const LOG_FILE = path.join(DATA_DIR, "switcher.log");
const LOG_MAX_BYTES = 2 * 1024 * 1024; // 2 MB 上限：超出则截断保留后半段
function logLine(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line, "utf8");
    // 定期检查大小（只在可能超限时）：避免每次 stat，用文件大小近似判断
    const size = fs.statSync(LOG_FILE).size;
    if (size > LOG_MAX_BYTES) {
      // 读后半段 ≈ 1 MB 写回，丢弃早期日志
      const fd = fs.openSync(LOG_FILE, "r");
      const keep = Math.floor(size / 2);
      const buf = Buffer.alloc(size - keep);
      fs.readSync(fd, buf, 0, buf.length, keep);
      fs.closeSync(fd);
      fs.writeFileSync(LOG_FILE, buf, "utf8");
    }
  } catch (_) {}
}
process.on("uncaughtException", (e) => logLine("uncaughtException: " + (e?.stack || e)));
process.on("unhandledRejection", (e) => logLine("unhandledRejection: " + (e?.stack || e)));

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "ZCode 切号器",
    backgroundColor: "#f5f3ec",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false, // 中文+代码工具无需拼写检查，关闭节省后台线程
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.SWITCHER_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: "detach" });
}

// 统一 IPC 包装：返回 {ok, data?|error?}
const wrap = async (channel, fn) => {
  try { return { ok: true, data: await fn() }; }
  catch (e) { logLine(`[ipc:${channel}] ${e?.message || e}`); return { ok: false, error: e?.message || String(e) }; }
};

// ---- 账号/状态 ----

function isUsable(a) {
  return a && a.enabled !== false && a.quota_dead !== true && a.authorization?.token;
}
function accountLabel(a) {
  return a.zcode_client_state?.user_info?.email || a.user_info?.email || a.register?.email
    || a.user_info?.displayName || a.user_info?.username || a.id;
}

ipcMain.handle("app:status", () => wrap("status", async () => {
  const st = core.readSwitcherState();
  const data = core.loadAccountsData(ACCOUNTS_FILE);
  return {
    zcodeRunning: await core.isZCodeRunning(),
    zcodeFound: core.findZCodeExe() !== null, // 是否检测到 ZCode 安装（注册表+进程+候选路径）
    hasBackup: core.hasBackup(),
    current: st.current_account_id || null,
    currentEmail: st.current_email || "",
    switchedAt: st.switched_at || null,
    total: data.accounts.length,
    usable: data.accounts.filter(isUsable).length,
    dead: data.accounts.filter((a) => a.quota_dead === true).length,
    accountsFile: ACCOUNTS_FILE,
    dev: IS_DEV,
  };
}));

ipcMain.handle("account:list", () => wrap("list", () => {
  const data = core.loadAccountsData(ACCOUNTS_FILE);
  const st = core.readSwitcherState();
  return data.accounts.map((a) => ({
    id: a.id,
    label: accountLabel(a),
    email: a.zcode_client_state?.user_info?.email || a.user_info?.email || a.register?.email || "",
    usable: isUsable(a),
    enabled: a.enabled !== false,
    quotaDead: a.quota_dead === true,
    quotaExhausted: a.quota_exhausted === true,
    hasJwt: Boolean(a.authorization?.token || a.zcode_client_state?.zcode_jwt_token),
    isCurrent: a.id === st.current_account_id,
    source: a.source || "",
  }));
}));

ipcMain.handle("account:quota", (_e, id) => wrap("quota", async () => {
  const data = core.loadAccountsData(ACCOUNTS_FILE);
  const acc = data.accounts.find((a) => a.id === id);
  if (!acc) throw new Error("找不到账号: " + id);
  return await fetchQuota(acc);
}));

ipcMain.handle("account:quota-many", (_e, ids) => wrap("quota-many", async () => {
  const data = core.loadAccountsData(ACCOUNTS_FILE);
  const out = {};
  const list = (Array.isArray(ids) ? ids : []).map(String);
  // 并发查询（额度查询是只读，安全）
  await Promise.all(list.map(async (id) => {
    const acc = data.accounts.find((a) => String(a.id) === id);
    if (!acc) { out[id] = { ok: false, error: "账号不存在" }; return; }
    try { out[id] = { ok: true, data: await fetchQuota(acc) }; }
    catch (e) { out[id] = { ok: false, error: e?.message || String(e) }; }
  }));
  return out;
}));

// ---- 切号 ----

ipcMain.handle("account:use", (_e, id, opts) => wrap("use", async () => {
  const data = core.loadAccountsData(ACCOUNTS_FILE);
  const acc = data.accounts.find((a) => a.id === id);
  if (!acc) throw new Error("找不到账号: " + id);
  if (!isUsable(acc)) throw new Error(`账号 ${id} 不可用（废号/禁用/无token）`);
  return await core.switchTo(acc, { restart: opts?.restart !== false, force: true });
}));

ipcMain.handle("account:auto", (_e, opts) => wrap("auto", async () => {
  const data = core.loadAccountsData(ACCOUNTS_FILE);
  const candidates = data.accounts.filter((a) => isUsable(a) && a.quota_exhausted !== true);
  if (!candidates.length) throw new Error("没有可用账号");
  const scored = await Promise.all(candidates.map(async (a) => {
    try { const q = await fetchQuota(a); return { a, score: q.has_grant && q.has_remaining ? q.primary_remaining_pct : -1 }; }
    catch { return { a, score: -1 }; }
  }));
  scored.sort((x, y) => y.score - x.score);
  const best = scored[0];
  if (!best || best.score < 0) throw new Error("所有候选账号额度均不可用");
  const r = await core.switchTo(best.a, { restart: opts?.restart !== false, force: true });
  return { ...r, picked: best.a.id, label: accountLabel(best.a), remaining_pct: best.score };
}));

ipcMain.handle("account:rollback", () => wrap("rollback", () => core.rollback({ restart: true })));

ipcMain.handle("zcode:kill", () => wrap("kill", () => core.killZCode()));
ipcMain.handle("zcode:launch", () => wrap("launch", () => ({ exe: core.launchZCode() })));

// ---- 批量管理 ----

ipcMain.handle("account:remove", (_e, ids) => wrap("remove", () =>
  ({ removed: core.removeAccounts(ACCOUNTS_FILE, ids) })));

ipcMain.handle("account:clear-dead", () => wrap("clear-dead", () => {
  const data = core.loadAccountsData(ACCOUNTS_FILE);
  const deadIds = data.accounts.filter((a) => a.quota_dead === true).map((a) => a.id);
  if (!deadIds.length) return { removed: [] };
  return { removed: core.removeAccounts(ACCOUNTS_FILE, deadIds) };
}));

ipcMain.handle("account:import-dialog", () => wrap("import", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "导入账号（JSON）",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (r.canceled || !r.filePaths?.length) return { canceled: true };
  let imported = [], skipped = [];
  for (const fp of r.filePaths) {
    try {
      const payload = JSON.parse(fs.readFileSync(fp, "utf8").replace(/^﻿/, ""));
      const res = core.importAccounts(ACCOUNTS_FILE, payload, { overwrite: false });
      imported.push(...res.imported); skipped.push(...res.skipped);
    } catch (e) { skipped.push({ id: path.basename(fp), reason: e?.message || String(e) }); }
  }
  return { canceled: false, imported, skipped, count: imported.length };
}));

ipcMain.handle("account:import-text", (_e, text) => wrap("import-text", () => {
  const t = String(text || "").trim();
  // 卡密格式：含 ZC1. 行 → 走 cardkey 解码
  if (/(^|\n)\s*ZC1\./.test(t) || t.startsWith("ZC1.")) {
    const { accounts, errors } = cardkey.decodeCards(t);
    if (!accounts.length) throw new Error("没有解析出有效卡密");
    const res = core.importAccounts(ACCOUNTS_FILE, accounts, { overwrite: false });
    return { ...res, errors };
  }
  // 否则按 JSON（完整 accounts.json 或账号数组）
  const payload = JSON.parse(t.replace(/^﻿/, ""));
  return core.importAccounts(ACCOUNTS_FILE, payload, { overwrite: false });
}));

// ---- 导出卡密（dev）----
ipcMain.handle("account:export-cards", (_e, opts) => wrap("export-cards", () => {
  // 用户端也可导出选中账号（卡密格式，用于备份/转移）；无选中且非 dev 时要求必须传 ids
  const data = core.loadAccountsData(ACCOUNTS_FILE);
  const wantIds = Array.isArray(opts?.ids) && opts.ids.length ? new Set(opts.ids.map(String)) : null;
  const unsoldOnly = opts?.unsoldOnly !== false;
  let pool = data.accounts.filter((a) => a.authorization?.token || a.zcode_client_state?.zcode_jwt_token);
  if (wantIds) pool = pool.filter((a) => wantIds.has(String(a.id)));
  else if (unsoldOnly) pool = pool.filter((a) => !a.sold_at);
  const { text, count, errors } = cardkey.encodeCards(pool);
  return { text, count, ids: pool.slice(0, count).map((a) => a.id), errors };
}));

ipcMain.handle("account:save-cards-file", (_e, text) => wrap("save-cards", async () => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: "导出卡密",
    defaultPath: `cards-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: "文本", extensions: ["txt"] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, String(text || ""), "utf8");
  return { canceled: false, path: r.filePath };
}));

ipcMain.handle("account:mark-sold", (_e, ids) => wrap("mark-sold", () => {
  if (!IS_DEV) throw new Error("仅 dev 模式可操作");
  const data = core.loadAccountsData(ACCOUNTS_FILE);
  const set = new Set((ids || []).map(String));
  let marked = 0;
  const now = new Date().toISOString();
  for (const a of data.accounts) { if (set.has(String(a.id)) && !a.sold_at) { a.sold_at = now; marked++; } }
  if (marked) core.saveAccountsData(ACCOUNTS_FILE, data);
  return { marked };
}));

ipcMain.handle("shell:open-external", (_e, url) => wrap("open-external", () => shell.openExternal(url)));

// ---- dev 注册机 IPC（仅 dev 模式加载；客户版不打包 dev/ 目录）----
if (IS_DEV) {
  try {
    const { registerDevIpc } = require(path.join(__dirname, "dev", "register-ipc.js"));
    registerDevIpc({ ipcMain, SRC_DIR, core, cardkey, wrap, getMainWindow: () => mainWindow, accountsFile: ACCOUNTS_FILE, log: logLine });
    logLine("dev register IPC loaded");
  } catch (e) {
    logLine("dev register IPC load failed: " + (e?.message || e));
  }
}

// ---- 生命周期 ----

app.whenReady().then(() => {
  logLine(`switcher start (electron ${process.versions.electron}, accounts=${ACCOUNTS_FILE})`);
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
