#!/usr/bin/env node
/**
 * 只读测量 DSH_HOME（.dsh）的真实占用：一次遍历、按 dev:ino 去重、按顶层目录归账。
 * 用法：node scripts/measure-home.mjs [--dsh-home <path>] [--json]
 */
import { resolveDshHome, profileDirOf, humanBytes } from "../lib/paths.js";
import { walkHome, buildReclaim } from "../lib/doctor.js";

const argv = process.argv.slice(2);
const homeArg = argv.includes("--dsh-home") ? argv[argv.indexOf("--dsh-home") + 1] : undefined;
const asJson = argv.includes("--json");
const home = resolveDshHome(homeArg);
const profileDir = profileDirOf(home);
const started = Date.now();
const walk = await walkHome(home, { topLimit: 24, detailDepth: 1 });
const reclaim = buildReclaim(home, profileDir);
const totals = walk.totals;
const safe = reclaim.filter((r) => r.risk === "safe").reduce((sum, r) => sum + (r.bytes ?? 0), 0);
if (asJson) {
  console.log(JSON.stringify({ home, ms: Date.now() - started, totals, rows: walk.rows.map((r) => ({ label: r.label, files: r.files, bytes: r.bytes, exclusiveBytes: r.exclusiveBytes, sharedBytes: r.sharedBytes, human: humanBytes(r.bytes) })), sharedBytes: totals.sharedBytes, sharedHuman: humanBytes(totals.sharedBytes), filesWithHardlinks: totals.hardlinkInodes, thresholdSeconds: 30, reclaim }));
} else {
  console.log("DSH_HOME: " + home);
  console.log("遍历耗时: " + ((Date.now() - started) / 1000).toFixed(1) + "s");
  console.log("文件 " + totals.files + " / 目录 " + totals.dirs + " / 逻辑 " + humanBytes(totals.logicalBytes) + " / 去重后 " + humanBytes(totals.bytes) + " / 独占 " + humanBytes(totals.exclusiveBytes) + " / 硬链接共享 " + humanBytes(totals.sharedBytes));
  console.log("");
  for (const r of walk.rows) console.log(String(r.bytes).padStart(13) + "  " + String(r.files).padStart(7) + "f  " + r.label);
  console.log("");
  console.log("零风险可回收合计: " + humanBytes(safe));
}
