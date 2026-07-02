"use strict";

/**
 * ZCode 切号器 CLI（非反代版）
 *
 *   node src/switcher/cli.js list                 列出所有账号 + 当前选中
 *   node src/switcher/cli.js quota [id]           查额度/福利到期（不传 id = 查全部并排序）
 *   node src/switcher/cli.js use <id>             切换到该账号（关 ZCode→合成→重启）
 *   node src/switcher/cli.js use <id> --no-restart  只换文件不重启
 *   node src/switcher/cli.js current              显示当前切的账号
 *   node src/switcher/cli.js auto                 自动挑「额度最多的可用号」切过去
 *   node src/switcher/cli.js rollback             回滚到切换前的登录态
 *
 * 账号数据来自 accounts.json（默认项目根目录，--accounts 可覆盖）。
 */

const fs = require("fs");
const path = require("path");
const core = require("./core");
const { fetchQuota } = require("./quota");

const DEFAULT_ACCOUNTS = path.resolve(__dirname, "..", "..", "accounts.json");

// ---- 颜色（无依赖）----
const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const c = (color, s) => `${C[color] || ""}${s}${C.reset}`;

function parseArgs(argv) {
  const args = { _: [], accounts: DEFAULT_ACCOUNTS, restart: true, force: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--accounts") args.accounts = path.resolve(argv[++i]);
    else if (a === "--no-restart") args.restart = false;
    else if (a === "--no-force") args.force = false;
    else if (a === "--json") args.json = true;
    else args._.push(a);
  }
  return args;
}

function loadAccounts(file) {
  if (!fs.existsSync(file)) throw new Error("找不到 accounts.json: " + file);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(data.accounts)) throw new Error("accounts.json 缺少 accounts 数组");
  return data;
}

function findAccount(data, id) {
  const acc = data.accounts.find((a) => a.id === id);
  if (!acc) throw new Error("找不到账号: " + id);
  return acc;
}

function accountLabel(a) {
  const email = a.zcode_client_state?.user_info?.email || a.user_info?.email || a.register?.email || "";
  const name = a.user_info?.displayName || a.user_info?.username || "";
  return email || name || a.id;
}

function isUsable(a) {
  return a && a.enabled !== false && a.quota_dead !== true && a.authorization?.token;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const now = Date.now();
  const diffMs = d.getTime() - now;
  const days = Math.floor(Math.abs(diffMs) / 86400000);
  const hours = Math.floor((Math.abs(diffMs) % 86400000) / 3600000);
  const rel = diffMs >= 0 ? `还剩 ${days}天${hours}时` : c("red", `已过期 ${days}天`);
  return `${d.toLocaleString("zh-CN", { hour12: false })} (${rel})`;
}

function bar(pct) {
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
  const color = pct >= 50 ? "green" : pct >= 15 ? "yellow" : "red";
  return c(color, "█".repeat(n)) + c("gray", "░".repeat(10 - n)) + ` ${pct}%`;
}

// ---- 命令 ----

async function cmdList(args) {
  const data = loadAccounts(args.accounts);
  const st = core.readSwitcherState();
  const running = await core.isZCodeRunning();
  const usable = data.accounts.filter(isUsable);
  const dead = data.accounts.filter((a) => a.quota_dead === true);

  console.log(c("bold", `\n账号总数 ${data.accounts.length}  |  可用 ${c("green", usable.length)}  |  废号 ${c("red", dead.length)}  |  ZCode ${running ? c("green", "运行中") : c("gray", "未运行")}`));
  console.log(c("gray", "当前切到: ") + (st.current_account_id ? c("cyan", st.current_account_id + (st.current_email ? ` (${st.current_email})` : "")) : c("gray", "无")));
  console.log(c("gray", "─".repeat(70)));
  for (const a of usable.slice(0, 200)) {
    const cur = a.id === st.current_account_id ? c("cyan", "● ") : "  ";
    const flags = [];
    if (a.quota_exhausted) flags.push(c("yellow", "额度耗尽"));
    if (!a.zcode_client_state?.zcode_jwt_token && !a.authorization?.token) flags.push(c("red", "无JWT"));
    console.log(`${cur}${c("bold", a.id.padEnd(10))} ${accountLabel(a).padEnd(38)} ${flags.join(" ")}`);
  }
  if (usable.length > 200) console.log(c("gray", `  …还有 ${usable.length - 200} 个`));
  console.log("");
}

async function cmdQuota(args) {
  const data = loadAccounts(args.accounts);
  const id = args._[1];
  const targets = id ? [findAccount(data, id)] : data.accounts.filter(isUsable);
  if (!id) console.log(c("gray", `查询 ${targets.length} 个可用账号额度（并发）…`));

  const results = await Promise.all(targets.map(async (a) => {
    try {
      const q = await fetchQuota(a);
      return { a, q };
    } catch (e) {
      return { a, err: e.message };
    }
  }));

  // 按主力剩余百分比降序
  results.sort((x, y) => (y.q?.primary_remaining_pct || -1) - (x.q?.primary_remaining_pct || -1));

  for (const { a, q, err } of results) {
    if (err) {
      console.log(`${c("bold", a.id.padEnd(10))} ${c("red", "查询失败")} ${c("gray", err.slice(0, 60))}`);
      continue;
    }
    const head = `${c("bold", a.id.padEnd(10))} ${accountLabel(a).padEnd(36)}`;
    const status = !q.has_grant ? c("red", "福利已结束(废号)") : q.has_remaining ? c("green", "可用") : c("yellow", "额度用尽");
    console.log(`${head} ${status}`);
    if (id) {
      // 详细模式：列每个模型
      for (const m of q.models) {
        const pct = m.total_units > 0 ? Math.floor((m.remaining_units / m.total_units) * 100) : 0;
        console.log(`    ${m.model.padEnd(16)} ${bar(pct)}  ${c("gray", `${m.remaining_units}/${m.total_units} ${m.unit_type}`)}`);
      }
      console.log(`    ${c("gray", "额度刷新:")} ${fmtDate(q.refresh_at)}`);
      console.log(`    ${c("gray", "福利到期:")} ${fmtDate(q.plan_ends_at)}`);
    } else {
      console.log(`    ${bar(q.primary_remaining_pct)}  ${c("gray", "福利到期:")} ${fmtDate(q.plan_ends_at)}`);
    }
  }
  console.log("");
}

async function cmdUse(args) {
  const data = loadAccounts(args.accounts);
  const id = args._[1];
  if (!id) throw new Error("用法: use <id>");
  const acc = findAccount(data, id);
  if (!isUsable(acc)) throw new Error(`账号 ${id} 不可用（废号/禁用/无token）`);
  console.log(c("gray", `切换到 ${c("cyan", id)} (${accountLabel(acc)})…`));
  const r = await core.switchTo(acc, { restart: args.restart, force: args.force });
  console.log(c("green", `✓ 已切换到 ${r.account_id}`) + (r.email ? ` (${r.email})` : ""));
  console.log(c("gray", r.restarted ? `  ZCode 已重启 (${r.exe})` : "  未重启（--no-restart），需手动启动 ZCode 生效"));
}

async function cmdCurrent(args) {
  const st = core.readSwitcherState();
  if (!st.current_account_id) { console.log(c("gray", "当前未通过切号器切换任何账号")); return; }
  console.log(`当前: ${c("cyan", st.current_account_id)}${st.current_email ? ` (${st.current_email})` : ""}`);
  console.log(c("gray", `切换时间: ${st.switched_at || "—"}`));
  console.log(c("gray", `ZCode: ${(await core.isZCodeRunning()) ? "运行中" : "未运行"}`));
}

async function cmdAuto(args) {
  const data = loadAccounts(args.accounts);
  const candidates = data.accounts.filter((a) => isUsable(a) && a.quota_exhausted !== true);
  if (!candidates.length) throw new Error("没有可用账号");
  console.log(c("gray", `从 ${candidates.length} 个候选里挑额度最多的…`));

  const scored = await Promise.all(candidates.map(async (a) => {
    try { const q = await fetchQuota(a); return { a, q, score: q.has_grant && q.has_remaining ? q.primary_remaining_pct : -1 }; }
    catch { return { a, score: -1 }; }
  }));
  scored.sort((x, y) => y.score - x.score);
  const best = scored[0];
  if (!best || best.score < 0) throw new Error("所有候选账号额度均不可用");

  console.log(c("green", `选中 ${best.a.id} (${accountLabel(best.a)}) 剩余 ${best.score}%`));
  const r = await core.switchTo(best.a, { restart: args.restart, force: args.force });
  console.log(c("green", `✓ 已切换并${r.restarted ? "重启" : "写入（未重启）"}`));
}

async function cmdRollback(args) {
  console.log(c("gray", "回滚到切换前的登录态…"));
  const r = await core.rollback({ restart: args.restart });
  console.log(c("green", `✓ 已回滚${r.restarted ? "并重启 ZCode" : ""}`));
}

function printHelp() {
  console.log(`
${c("bold", "ZCode 切号器")} — 把 accounts.json 的号无感切到官方 ZCode 客户端

  ${c("cyan", "list")}              列出所有账号 + 当前选中
  ${c("cyan", "quota")} [id]        查额度/福利到期（不传=查全部按剩余排序；传 id=详细）
  ${c("cyan", "use")} <id>          切换账号（关 ZCode→合成登录态→重启）
  ${c("cyan", "auto")}              自动挑额度最多的可用号切过去
  ${c("cyan", "current")}           显示当前切的账号
  ${c("cyan", "rollback")}          回滚到切换前的登录态

  选项: --no-restart  --no-force  --accounts <file>
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "list";
  switch (cmd) {
    case "list": return cmdList(args);
    case "quota": return cmdQuota(args);
    case "use": return cmdUse(args);
    case "current": return cmdCurrent(args);
    case "auto": return cmdAuto(args);
    case "rollback": return cmdRollback(args);
    case "help": case "-h": case "--help": return printHelp();
    default: console.log(c("red", "未知命令: " + cmd)); printHelp(); process.exit(1);
  }
}

main().catch((e) => {
  console.error(c("red", "✗ " + (e instanceof Error ? e.message : String(e))));
  process.exit(1);
});
