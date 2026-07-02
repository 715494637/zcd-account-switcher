"use strict";

/**
 * 切号器核心引擎（非反代版）
 *
 * 把 accounts.json 里的一个账号「无感切换」到官方 ZCode 客户端：
 *   关闭 ZCode → 备份当前登录态(.last) → 合成并原子写入新登录态 → 重启 ZCode
 *   写入失败自动用 .last 回滚。
 *
 * 复用 synthesize_login_state.js 的合成逻辑（机器绑定加密 + provider 清洗）。
 * 进程控制思路来自 docs/zcode-account-switcher-main/src/switcher.js。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { exec, execSync } = require("child_process");
const {
  extractState,
  synthesizeCredentials,
  synthesizeConfig,
  defaultCredentialSecret,
} = require("../tools/synthesize_login_state");

const HOME = os.homedir();
// ZCode 客户端登录态文件（位置由 ZCode 决定，不可改 —— 这是我们要写入的目标）
const V2_DIR = path.join(HOME, ".zcode", "v2");
const CRED_FILE = path.join(V2_DIR, "credentials.json");
const CFG_FILE = path.join(V2_DIR, "config.json");
const MODEL_CACHE_FILE = path.join(V2_DIR, "bots-model-cache.v2.json");

// 切号器自己的数据全部就近放在应用数据目录（环境变量由主进程注入应用同目录，
// 回退到项目根）。备份/切换状态不再散落用户目录。
const DATA_DIR = process.env.SWITCHER_DATA_DIR || path.join(__dirname, "..", "..", "data");
const BACKUP_DIR = path.join(DATA_DIR, "switcher-last");
const STATE_FILE = path.join(DATA_DIR, "switcher-state.json");

// ZCode.exe 标准安装目录候选（仅作最后兜底；主检测靠注册表+运行进程）。
// 环境变量 ZCODE_EXE 可强制指定。
const PROGRAM_FILES = process.env.ProgramFiles || "C:\\Program Files";
const PROGRAM_FILES_X86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
const EXE_CANDIDATES = [
  process.env.ZCODE_EXE,
  path.join(LOCAL_APPDATA, "Programs", "ZCode", "ZCode.exe"), // NSIS per-user 默认目录（最常见）
  path.join(PROGRAM_FILES, "ZCode", "ZCode.exe"),
  path.join(PROGRAM_FILES_X86, "ZCode", "ZCode.exe"),
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 从 Windows 注册表卸载项里查 ZCode 安装目录。
 * ZCode 是 NSIS 包，安装后必写卸载项（HKCU 或 HKLM）。实测 InstallLocation 可能为空，
 * 但 DisplayIcon / UninstallString 一定带完整安装路径 —— 从中提取目录再拼 ZCode.exe。
 * 这是覆盖「任意安装位置」的关键手段，不依赖 ZCode 是否在运行。
 * @returns {string|null} 命中的 ZCode.exe 绝对路径
 */
function findZCodeFromRegistry() {
  // 用 PowerShell 一次性扫三处 Uninstall 根，输出候选目录（每行一个）
  const ps = [
    "$ErrorActionPreference='SilentlyContinue';",
    "$roots=@(",
    "'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    ");",
    "foreach($r in $roots){",
    "Get-ItemProperty $r|Where-Object{$_.DisplayName -match 'zcode'}|ForEach-Object{",
    "if($_.InstallLocation){$_.InstallLocation};",        // 优先 InstallLocation
    "if($_.DisplayIcon){Split-Path $_.DisplayIcon -Parent};", // 再 DisplayIcon 父目录
    "if($_.UninstallString){Split-Path ($_.UninstallString -replace '\"','') -Parent}", // 再卸载器父目录
    "}}",
  ].join("");
  let out = "";
  try {
    out = execSync(`powershell -NoProfile -Command "${ps}"`, {
      encoding: "utf8", windowsHide: true,
    });
  } catch (_) { return null; }
  const dirs = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, "ZCode.exe");
    try { if (fs.existsSync(exe)) return exe; } catch (_) {}
  }
  return null;
}

/**
 * 从正在运行的 ZCode 进程拿真实 exe 路径（处理任意安装位置；仅 ZCode 在跑时有效）。
 * @returns {string|null}
 */
function findZCodeFromProcess() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-Process ZCode -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique"',
      { encoding: "utf8", windowsHide: true }
    ).trim();
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (_) {}
  return null;
}

// 缓存解析到的 ZCode.exe 路径：会话内基本不变，避免每次状态轮询都 spawn PowerShell。
// 缓存路径若仍存在直接复用；不存在或强制刷新时才重新探测。
let _exeCache = null;
function findZCodeExe({ force = false } = {}) {
  if (!force && _exeCache) {
    try { if (fs.existsSync(_exeCache)) return _exeCache; } catch (_) {}
    _exeCache = null;
  }
  // 0) 环境变量强制指定（最高优先级，给非标准安装的用户兜底）
  if (process.env.ZCODE_EXE) {
    try { if (fs.existsSync(process.env.ZCODE_EXE)) return (_exeCache = process.env.ZCODE_EXE); } catch (_) {}
  }
  // 1) 注册表卸载项（安装即存在，覆盖任意安装目录，不依赖运行）—— 主力手段
  const fromReg = findZCodeFromRegistry();
  if (fromReg) return (_exeCache = fromReg);
  // 2) 正在运行的进程真实路径
  const fromProc = findZCodeFromProcess();
  if (fromProc) return (_exeCache = fromProc);
  // 3) 标准安装路径兜底
  for (const p of EXE_CANDIDATES) {
    try { if (fs.existsSync(p)) return (_exeCache = p); } catch (_) {}
  }
  return null;
}

// 异步检测 ZCode 是否在运行：用 exec 而非 execSync，避免冻结主进程事件循环
// （状态每 8s 轮询一次，同步阻塞会造成 UI 周期性卡顿）。
function isZCodeRunning() {
  return new Promise((resolve) => {
    try {
      exec('tasklist /FI "IMAGENAME eq ZCode.exe" /NH /FO CSV', { windowsHide: true }, (err, stdout) => {
        resolve(!err && /"ZCode\.exe"/i.test(stdout || ""));
      });
    } catch (_) { resolve(false); }
  });
}

async function killZCode({ waitMs = 9000 } = {}) {
  if (!(await isZCodeRunning())) return true;
  try {
    execSync("taskkill /F /IM ZCode.exe", { windowsHide: true, stdio: "ignore" });
  } catch (_) {}
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!(await isZCodeRunning())) return true;
    await sleep(400);
  }
  return !(await isZCodeRunning());
}

function launchZCode() {
  const exe = findZCodeExe();
  if (!exe) throw new Error(
    "未找到 ZCode 客户端。\n" +
    "请确认 ZCode 已安装（官网下载后正常安装即可）。\n" +
    "若已安装仍无法识别，可设置环境变量 ZCODE_EXE=<ZCode.exe 完整路径> 后重启本程序。"
  );
  const child = exec(`"${exe}"`, { windowsHide: false });
  child.unref();
  return exe;
}

function readJsonIfExists(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (_) { return fallback; }
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** 备份当前登录态到 switcher-last（回滚用）。 */
function backupCurrent() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  for (const [src, name] of [[CRED_FILE, "credentials.json"], [CFG_FILE, "config.json"]]) {
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(BACKUP_DIR, name));
  }
}

function hasBackup() {
  return fs.existsSync(path.join(BACKUP_DIR, "credentials.json")) ||
         fs.existsSync(path.join(BACKUP_DIR, "config.json"));
}

function restoreBackup() {
  const c = path.join(BACKUP_DIR, "credentials.json");
  const g = path.join(BACKUP_DIR, "config.json");
  if (fs.existsSync(c)) atomicWriteJson(CRED_FILE, JSON.parse(fs.readFileSync(c, "utf8")));
  if (fs.existsSync(g)) atomicWriteJson(CFG_FILE, JSON.parse(fs.readFileSync(g, "utf8")));
}

function readSwitcherState() {
  return readJsonIfExists(STATE_FILE, { current_account_id: null, switched_at: null, history: [] });
}

function writeSwitcherState(patch) {
  const cur = readSwitcherState();
  const next = { ...cur, ...patch };
  atomicWriteJson(STATE_FILE, next);
  return next;
}

/**
 * 把账号的登录态写入官方客户端文件（不含进程控制，供 use/dry-run 复用）。
 */
function writeLoginState(account) {
  const state = extractState(account);
  if (!state.zcodeJwt) throw new Error(`账号 ${account.id} 缺少 zcode JWT`);
  const baseCred = readJsonIfExists(CRED_FILE, {});
  const baseCfg = readJsonIfExists(CFG_FILE, {});
  const newCred = synthesizeCredentials(baseCred, state);
  const newCfg = synthesizeConfig(baseCfg, state);
  atomicWriteJson(CRED_FILE, newCred);
  atomicWriteJson(CFG_FILE, newCfg);
  // 清掉脏 model 选择缓存（含旧 provider 的混合 model ID 会导致对话卡死），客户端会重建
  try { if (fs.existsSync(MODEL_CACHE_FILE)) fs.unlinkSync(MODEL_CACHE_FILE); } catch (_) {}
  return state;
}

/**
 * 切换到指定账号。
 * @param {object} account  accounts.json 里的账号对象
 * @param {{restart?:boolean, force?:boolean}} opts
 */
async function switchTo(account, opts = {}) {
  const { restart = true, force = true } = opts;
  const running = await isZCodeRunning();
  if (running && !force) throw new Error("ZCode 正在运行，请先关闭或用 --force");

  // 1. 关闭 ZCode（运行中改登录态文件不可靠，客户端会回写）
  if (running) {
    const ok = await killZCode();
    if (!ok) throw new Error("关闭 ZCode 超时，已取消切换");
  }

  // 2. 备份当前登录态
  try { backupCurrent(); } catch (e) { throw new Error("备份当前登录态失败: " + e.message); }

  // 3. 合成并写入；失败自动回滚
  let state;
  try {
    state = writeLoginState(account);
  } catch (e) {
    try { restoreBackup(); } catch (_) {}
    throw new Error("写入登录态失败，已自动回滚: " + e.message);
  }

  // 4. 记录当前账号
  writeSwitcherState({
    current_account_id: account.id,
    current_email: state.userInfo.email || "",
    switched_at: new Date().toISOString(),
  });

  // 5. 重启
  let launched = false;
  let exe = null;
  if (restart) {
    try { exe = launchZCode(); launched = true; } catch (e) {
      console.warn("⚠ 启动 ZCode 失败（登录态已切换，可手动启动）: " + e.message);
    }
  }
  return { restarted: launched, wasRunning: running, exe, account_id: account.id, email: state.userInfo.email };
}

async function rollback(opts = {}) {
  const { restart = true } = opts;
  if (!hasBackup()) throw new Error("没有可回滚的备份（switcher-last 不存在）");
  if (await isZCodeRunning()) {
    const ok = await killZCode();
    if (!ok) throw new Error("关闭 ZCode 超时");
  }
  restoreBackup();
  writeSwitcherState({ current_account_id: null, rolled_back_at: new Date().toISOString() });
  let launched = false;
  if (restart) { try { launchZCode(); launched = true; } catch (_) {} }
  return { restarted: launched };
}

// ===== accounts.json 读写（批量管理用，结构与反代 main.js 兼容）=====

// mtime 缓存：避免 8s 轮询每次重复 readFileSync + JSON.parse。
// 写操作（saveAccountsData/importAccounts/removeAccounts）调用后调 _invalidateAccountsCache()。
const _acctCache = new Map(); // accountsFile → { mtime, data }

function _invalidateAccountsCache(accountsFile) {
  _acctCache.delete(accountsFile);
}

function loadAccountsData(accountsFile) {
  if (!fs.existsSync(accountsFile)) {
    return { schema_version: "zcode2api.accounts.v1", accounts: [] };
  }
  let mtime;
  try { mtime = fs.statSync(accountsFile).mtimeMs; } catch (_) { mtime = 0; }
  const cached = _acctCache.get(accountsFile);
  if (cached && cached.mtime === mtime) return cached.data;
  const data = JSON.parse(fs.readFileSync(accountsFile, "utf8").replace(/^﻿/, ""));
  if (!Array.isArray(data.accounts)) data.accounts = [];
  _acctCache.set(accountsFile, { mtime, data });
  return data;
}

function saveAccountsData(accountsFile, data) {
  data.updated_at = new Date().toISOString();
  atomicWriteJson(accountsFile, data);
  _invalidateAccountsCache(accountsFile); // 写后失效缓存，下次读取走磁盘
}

/** 批量删除账号。返回删除的 id 列表。 */
function removeAccounts(accountsFile, ids) {
  const data = loadAccountsData(accountsFile);
  const set = new Set((ids || []).map(String));
  const before = data.accounts.length;
  const removed = [];
  data.accounts = data.accounts.filter((a) => {
    if (set.has(String(a.id))) { removed.push(a.id); return false; }
    return true;
  });
  if (data.accounts.length !== before) saveAccountsData(accountsFile, data);
  return removed;
}

/**
 * 导入账号。payload 支持两种形态：
 *   1) 完整 accounts.json（{accounts:[...]}）
 *   2) 裸数组 [account, ...]
 * 默认按 id 去重跳过已存在；overwrite=true 则覆盖。
 */
function importAccounts(accountsFile, payload, opts = {}) {
  const overwrite = !!opts.overwrite;
  const incoming = Array.isArray(payload) ? payload
    : Array.isArray(payload?.accounts) ? payload.accounts : null;
  if (!incoming) throw new Error("导入数据格式不正确（需 accounts 数组或账号数组）");

  const data = loadAccountsData(accountsFile);
  const byId = new Map(data.accounts.map((a) => [String(a.id), a]));
  const imported = [];
  const skipped = [];
  for (const acc of incoming) {
    const id = acc && acc.id ? String(acc.id) : "";
    if (!id) { skipped.push({ id: "(无id)", reason: "缺少 id" }); continue; }
    if (!acc.authorization?.token && !acc.zcode_client_state?.zcode_jwt_token) {
      skipped.push({ id, reason: "缺少 token" }); continue;
    }
    if (byId.has(id) && !overwrite) { skipped.push({ id, reason: "已存在" }); continue; }
    if (byId.has(id)) {
      const idx = data.accounts.findIndex((a) => String(a.id) === id);
      data.accounts[idx] = { ...data.accounts[idx], ...acc };
    } else {
      data.accounts.push(acc);
      byId.set(id, acc);
    }
    imported.push(id);
  }
  if (imported.length) saveAccountsData(accountsFile, data);
  return { imported, skipped, count: imported.length };
}

module.exports = {
  V2_DIR, CRED_FILE, CFG_FILE, BACKUP_DIR, STATE_FILE,
  findZCodeExe, isZCodeRunning, killZCode, launchZCode,
  writeLoginState, switchTo, rollback,
  backupCurrent, hasBackup, restoreBackup,
  readSwitcherState, writeSwitcherState,
  loadAccountsData, saveAccountsData, removeAccounts, importAccounts,
  defaultCredentialSecret,
};
