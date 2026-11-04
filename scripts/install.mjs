#!/usr/bin/env node
/**
 * 把 dsh-plugin-relocator 装进一个 DSH profile（默认 desktop）。
 *
 * 做三件事：
 *   1. 备份 profile 的 package.json
 *   2. 写入 dependencies["dsh-plugin-relocator"] = "link:<本工程绝对路径>"，并把包名加进 dsh.profile.bundles
 *   3. 在 profile 里跑一次 pnpm install，让 pnpm 自己建好 node_modules 里的链接
 *
 * 用法：
 *   node scripts/install.mjs --dry-run            # 只看计划，不动任何文件
 *   node scripts/install.mjs                       # 真装（会跑 pnpm install，几分钟）
 *   node scripts/install.mjs --profile web         # 装进别的 profile
 *   node scripts/install.mjs --no-install          # 只改 package.json，不跑 pnpm
 *   node scripts/install.mjs --dsh-home D:\x\.dsh  # 指定 DSH_HOME
 *   node scripts/install.mjs --uninstall           # 卸载（从 dependencies/bundles 移除）
 *
 * 装完需要重启 DSH 才会加载（界面半身也要重新加载）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveDshHome, profileDirOf, toSpecPath, readJson, writeJsonAtomic } from "../lib/paths.js";
import { runtimePaths } from "../lib/migrate.js";

const NAME = "dsh-plugin-relocator";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { dryRun: false, install: true, profile: "desktop", home: null, uninstall: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--no-install") out.install = false;
    else if (arg === "--uninstall") out.uninstall = true;
    else if (arg === "--profile") out.profile = argv[++i];
    else if (arg === "--dsh-home") out.home = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg.startsWith("--profile=")) out.profile = arg.slice("--profile=".length);
    else if (arg.startsWith("--dsh-home=")) out.home = arg.slice("--dsh-home=".length);
    else throw new Error("不认识的参数：" + arg);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("用法：node scripts/install.mjs [--dry-run] [--profile desktop] [--dsh-home <path>] [--no-install] [--uninstall]");
  process.exit(0);
}

/* ------------------------------- 前置检查 ------------------------------- */
const selfPkg = readJson(path.join(repo, "package.json"), {});
if (selfPkg.name !== NAME) throw new Error("工程 package.json 的 name 不是 " + NAME + "：" + selfPkg.name);
if (!selfPkg.exports?.["./client"]) throw new Error('工程 package.json 缺少 exports["./client"]，界面半身不会被加载');
const clientEntry = selfPkg.exports["./client"];
const clientRel = typeof clientEntry === "string" ? clientEntry : clientEntry?.default ?? clientEntry?.import;
if (!clientRel) throw new Error('exports["./client"] 里找不到 default 入口');
const clientFile = path.join(repo, String(clientRel).replace(/^\.\//, ""));
if (!fs.existsSync(clientFile)) throw new Error("界面半身文件不存在：" + clientFile);

const home = resolveDshHome(args.home ?? undefined);
const profileDir = profileDirOf(home, args.profile);
const pkgFile = path.join(profileDir, "package.json");
if (!fs.existsSync(pkgFile)) throw new Error("找不到 profile：" + profileDir);
const pkg = readJson(pkgFile, {});
const spec = "link:" + toSpecPath(repo);
const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? [...pkg.dsh.profile.bundles] : [];
const alreadyBundle = bundles.includes(NAME);
const alreadyDep = pkg.dependencies?.[NAME] === spec;

console.log("DSH_HOME    : " + home);
console.log("profile     : " + profileDir);
console.log("插件工程    : " + repo);
console.log("声明规格    : " + spec);
console.log("bundles     : " + bundles.length + " 项，" + (alreadyBundle ? "已包含 " : "待加入 ") + NAME);
console.log("dependencies: " + (alreadyDep ? "已是同一个 link: 规格" : "待写入 " + NAME));
console.log("模式        : " + (args.uninstall ? "卸载" : args.dryRun ? "试运行（不写文件）" : "安装") + (args.install && !args.dryRun && !args.uninstall ? " + pnpm install" : ""));

if (args.dryRun) {
  console.log("\n[试运行] 以上为计划，未改动任何文件。");
  process.exit(0);
}

/* ------------------------------- 备份 + 写入 ------------------------------- */
const backup = pkgFile + ".relocator-backup-" + Date.now().toString(36);
fs.copyFileSync(pkgFile, backup);
console.log("\n已备份 profile package.json -> " + backup);

const next = { ...pkg };
next.dependencies = { ...(pkg.dependencies ?? {}) };
if (args.uninstall) {
  delete next.dependencies[NAME];
  next.dsh = { ...(pkg.dsh ?? {}), profile: { ...(pkg.dsh?.profile ?? {}), bundles: bundles.filter((item) => item !== NAME) } };
  console.log("已从 dependencies 与 bundles 中移除 " + NAME);
} else {
  next.dependencies[NAME] = spec;
  if (!alreadyBundle) next.dsh = { ...(pkg.dsh ?? {}), profile: { ...(pkg.dsh?.profile ?? {}), bundles: [...bundles, NAME] } };
  console.log("已写入 dependencies[" + NAME + "] = " + spec + (alreadyBundle ? "（bundles 已有，未重复添加）" : "，并加入 bundles"));
}
writeJsonAtomic(pkgFile, next);
console.log("已更新 " + pkgFile);

if (args.uninstall) {
  const link = path.join(profileDir, "node_modules", NAME);
  const st = fs.lstatSync(link, { throwIfNoEntry: false });
  if (st) {
    try {
      if (st.isSymbolicLink()) fs.unlinkSync(link);
      else fs.rmSync(link, { recursive: true, force: true });
      console.log("已移除 " + link);
    } catch (error) {
      console.log("移除 node_modules 链接失败（可忽略，下次 pnpm install 会收拾）：" + String(error?.message ?? error));
    }
  } else {
    console.log("node_modules 里没有它的链接，无需清理");
  }
  console.log("\n卸载完成：重启 DSH 生效。要彻底还原可执行：");
  console.log('  copy "' + backup + '" "' + pkgFile + '"');
  process.exit(0);
}

/* ------------------------------- pnpm install ------------------------------- */
if (!args.install) {
  console.log("\n已跳过 pnpm install（--no-install）。请在 profile 里手动执行一次 pnpm install 后重启 DSH。");
  process.exit(0);
}
const { node, pnpm } = runtimePaths(home);
console.log("\n在 profile 里执行 pnpm install（这一步会重算整棵依赖树，通常要几分钟）…");
if (!pnpm || !fs.existsSync(pnpm)) {
  console.log("找不到内置 pnpm（" + pnpm + "），请在 profile 里手动执行：");
  console.log('  cd "' + profileDir + '" && pnpm install');
  process.exit(0);
}
const started = Date.now();
const child = spawn(node, [pnpm, "install", "--reporter=append-only"], {
  cwd: profileDir,
  env: { ...process.env, npm_config_yes: "true", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
const pipe = (stream, prefix) => {
  let tail = "";
  stream.on("data", (chunk) => {
    const text = String(chunk);
    tail = (tail + text).slice(-2000);
    for (const line of text.split(/\r?\n/)) if (line.trim()) console.log(prefix + line.trimEnd());
  });
  return () => tail;
};
const outTail = pipe(child.stdout, "  ");
const errTail = pipe(child.stderr, "  ! ");
child.on("error", (error) => {
  console.log("pnpm 启动失败：" + String(error?.message ?? error));
  process.exitCode = 1;
});
child.on("close", (code) => {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (code === 0) {
    console.log("\npnpm install 完成（" + seconds + "s）。");
    const link = path.join(profileDir, "node_modules", NAME);
    const st = fs.lstatSync(link, { throwIfNoEntry: false });
    console.log("  node_modules/" + NAME + "：" + (st ? (st.isSymbolicLink() ? "链接 -> " + fs.readlinkSync(link) : "真实目录") : "未生成"));
    console.log("\n装好了。请重启 DSH：设置 → 插件 里会出现「插件搬家」页签。");
  } else {
    console.log("\npnpm install 退出码 " + code + "（" + seconds + "s）");
    if (errTail()) console.log(errTail());
    void outTail;
    console.log("提示：profile package.json 已改好，你可以稍后重试；要还原就把备份 copy 回去。");
    process.exitCode = code ?? 1;
  }
});
