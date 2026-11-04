#!/usr/bin/env node
/**
 * 实验室自测（一次性目录，全程不碰真实 .dsh）。
 *
 * 验证三项断言：
 *   A. 私有依赖留在插件自身的 node_modules（迁移后仍从插件目录解析）
 *   B. peer 依赖仍是安装侧单例（插件目录里不存在第二份 @deepseek-ai/cordis）
 *   C. 界面半身契约完好（__ModuleLoader__.load + exports["./client"] + apply/inject）
 * 外加：迁移 / 回滚 / 恢复 的可逆性、transferTree+verifyTrees 往返校验、跨盘警告。
 *
 * 用法：node test/self-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { Journal } from "../lib/journal.js";
import { Locks } from "../lib/lock.js";
import { Migrator, checkDrives, referencedBodies } from "../lib/migrate.js";
import { analyzeDeps } from "../lib/deps.js";
import { transferTree, verifyTrees } from "../lib/transfer.js";
import { validateRoot, rootFor, setPluginRoot } from "../lib/config.js";
import { bodyInfo, bodyMovable, scanOrphanBodies, unionMeasure, verifyCovers } from "../lib/body.js";
import { readJson, resolveDshHome, driveRoot, sameDrive } from "../lib/paths.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAB = path.join(repo, ".lab");
const HOME = path.join(LAB, "home");
const PROFILE = path.join(HOME, "profiles", "lab");
const INSTALL_SIDE = path.join(HOME, "install-side");
const NAME = "my-plugin";
const PLUGIN_DIR = path.join(PROFILE, "node_modules", NAME);
const ROOT = path.join(LAB, "out");

let passed = 0;
let failed = 0;
function section(title) {
  console.log("");
  console.log("=== " + title + " ===");
}
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("  [PASS] " + label + (detail ? "   (" + detail + ")" : ""));
  } else {
    failed += 1;
    console.log("  [FAIL] " + label + (detail ? "   (" + detail + ")" : ""));
  }
}
function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}
function writeJson(file, value) {
  writeFile(file, JSON.stringify(value, null, 2) + "\n");
}
function listFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  }
  return out.sort();
}
/** 在整棵实验室目录里找某包的实体副本（不跟随链接）。 */
function countCopies(root, pkg) {
  const found = [];
  const target = path.join("node_modules", ...pkg.split("/"));
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(abs, "package.json")) && abs.endsWith(target)) found.push(abs);
      stack.push(abs);
    }
  }
  return found;
}
/** 用 vm 执行界面半身的 bundle，stub 掉 __ModuleLoader__，取出工厂返回值。 */
function loadClientBundle(file) {
  const code = fs.readFileSync(file, "utf8");
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { captured = spec; } } },
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Promise,
    Error
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  if (!captured) return null;
  const exported = captured.factory((id) => ({ fakeModule: id }));
  return { id: captured.id, exports: exported };
}

/* ------------------------------------------------------------------ */
section("0. 搭建实验室（一次性 profile，不碰真实 .dsh）");
fs.rmSync(LAB, { recursive: true, force: true });
fs.mkdirSync(LAB, { recursive: true });
// 外置安装根（真实使用中由用户在设置页选择，这里直接建好）
fs.mkdirSync(ROOT, { recursive: true });

// 安装侧单例（模拟 DSH 安装侧提供的 @deepseek-ai/cordis）
writeJson(path.join(INSTALL_SIDE, "node_modules", "@deepseek-ai", "cordis", "package.json"), {
  name: "@deepseek-ai/cordis",
  version: "4.0.0",
  main: "index.js"
});
writeFile(path.join(INSTALL_SIDE, "node_modules", "@deepseek-ai", "cordis", "index.js"), "export const singleton = true;\n");

// 插件本体
writeJson(path.join(PLUGIN_DIR, "package.json"), {
  name: NAME,
  version: "1.0.0",
  type: "module",
  main: "lib/index.js",
  exports: {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  // 故意不声明 my-private-dep：它只以“自带 node_modules”的形态存在，
  // 用来验证 private 分类，以及迁移后私有依赖的解析位置。
  peerDependencies: { "@deepseek-ai/cordis": "*" },
  dsh: { client: { platform: "web", inject: [] } }
});
writeFile(path.join(PLUGIN_DIR, "lib", "index.js"), [
  'import privateDep from "my-private-dep";',
  'export const name = "my-plugin";',
  'export const inject = [];',
  "export function apply(ctx) { return privateDep; }"
].join("\n") + "\n");
writeFile(path.join(PLUGIN_DIR, "lib", "client.js"), [
  "window.__ModuleLoader__.load({",
  '  id: "my-plugin",',
  "  factory: (require) => {",
  '    const React = require("react");',
  "    const apply = (ctx) => { return React; };",
  '    return { apply, inject: ["slots"] };',
  "  }",
  "});"
].join("\n") + "\n");
writeJson(path.join(PLUGIN_DIR, "node_modules", "my-private-dep", "package.json"), {
  name: "my-private-dep",
  version: "9.9.9",
  main: "index.js"
});
writeFile(path.join(PLUGIN_DIR, "node_modules", "my-private-dep", "index.js"), "export default { private: true };\n");

// profile（只有一行依赖 + 一个 bundle）
writeJson(path.join(PROFILE, "package.json"), {
  name: "lab-profile",
  private: true,
  dependencies: { [NAME]: "1.0.0" },
  dsh: { profile: { bundles: [NAME] } }
});

const filesBefore = listFiles(PLUGIN_DIR);
check("实验室搭建完成", fs.existsSync(path.join(PLUGIN_DIR, "package.json")), filesBefore.length + " 个文件");

/* ------------------------------------------------------------------ */
section("A. 私有依赖：分类正确 + 迁出前从插件自身解析");
{
  const deps = analyzeDeps(PLUGIN_DIR, { hoistedTop: [] });
  const row = deps.rows.find((item) => item.name === "my-private-dep");
  check("analyzeDeps 结论 ok=true", deps.ok === true, "风险=" + deps.risks.length);
  check("my-private-dep 归类为 private", row && row.category === "private", row ? row.category : "未找到");
  check("ownModules 含 my-private-dep", deps.ownModules.includes("my-private-dep"));

  const req = createRequire(path.join(PLUGIN_DIR, "lib", "index.js"));
  const resolved = req.resolve("my-private-dep");
  check("createRequire 解析到插件自身 node_modules",
    resolved.toLowerCase().startsWith(path.join(PLUGIN_DIR, "node_modules").toLowerCase()),
    path.relative(LAB, resolved));
}

/* ------------------------------------------------------------------ */
section("B. peer 依赖：全实验室只有一份安装侧单例");
{
  const copies = countCopies(LAB, "@deepseek-ai/cordis");
  check("安装侧单例恰好 1 份", copies.length === 1, copies.map((p) => path.relative(LAB, p)).join(", "));
  check("插件目录内没有第二份 cordis", !fs.existsSync(path.join(PLUGIN_DIR, "node_modules", "@deepseek-ai", "cordis")));
  const installReq = createRequire(path.join(INSTALL_SIDE, "package.json"));
  check("安装侧可解析 cordis", !!installReq.resolve("@deepseek-ai/cordis"));
}

/* ------------------------------------------------------------------ */
section("C. 界面半身契约：插件本体");
{
  const pkg = readJson(path.join(PLUGIN_DIR, "package.json"), {});
  const clientRel = typeof pkg.exports["./client"] === "string" ? pkg.exports["./client"] : pkg.exports["./client"].default;
  check('exports["./client"] 存在', !!clientRel, String(clientRel));
  check("客户端文件存在", fs.existsSync(path.join(PLUGIN_DIR, clientRel)));
  const loaded = loadClientBundle(path.join(PLUGIN_DIR, clientRel));
  check("__ModuleLoader__.load 的 id 等于包名", loaded && loaded.id === NAME, loaded ? loaded.id : "未捕获");
  check("bundle 导出 apply/inject",
    loaded && typeof loaded.exports.apply === "function" && Array.isArray(loaded.exports.inject));
}

/* ------------------------------------------------------------------ */
section("C2. 界面半身契约：dsh-plugin-relocator 自身");
{
  const selfPkg = readJson(path.join(repo, "package.json"), {});
  const rel = selfPkg.exports["./client"];
  const clientRel = typeof rel === "string" ? rel : rel.default;
  check('package.json 声明 exports["./client"]', !!clientRel, String(clientRel));
  const loaded = loadClientBundle(path.join(repo, clientRel.replace("./", "")));
  check("loader id 等于 dsh-plugin-relocator", loaded && loaded.id === "dsh-plugin-relocator", loaded ? loaded.id : "未捕获");
  check("导出 apply/inject，inject 含 slots/locale/uiWorkspace",
    loaded && typeof loaded.exports.apply === "function" &&
    ["slots", "locale", "uiWorkspace"].every((key) => loaded.exports.inject.includes(key)),
    loaded ? JSON.stringify(loaded.exports.inject) : "未捕获");
}

/* ------------------------------------------------------------------ */
section("D. 配置校验与跨盘判定");
{
  const inside = validateRoot(HOME, path.join(PROFILE, "inside-root"), "", {});
  check("根目录落在 profile 内被当作致命问题（会把 profile 自己搬走）",
    inside.ok === false && inside.problems.some((p) => p.code === "root-inside-profile"),
    JSON.stringify(inside.problems.map((p) => p.code)));

  const same = validateRoot(HOME, ROOT, path.join(ROOT, ".store", "v11"), {});
  check("同盘根目录无致命问题", same.ok === true, JSON.stringify(same.problems));

  const probes = ["C:", "D:", "E:", "F:"].filter((d) => fs.existsSync(d + path.sep));
  const other = probes.find((d) => !sameDrive(d + path.sep, HOME));
  if (other) {
    const drivesOther = checkDrives({ root: path.join(other + path.sep, "dsh-plugins-lab"), storeDir: path.join(other + path.sep, "dsh-plugins-lab", ".store", "v11"), home: HOME });
    check("跨盘时 rootHomeSameDrive=false", drivesOther.rootHomeSameDrive === false, other + " vs " + driveRoot(HOME));
    check("跨盘时给出明确提示", drivesOther.notes[0].includes("不同盘"), drivesOther.notes[0]);
  } else {
    console.log("  [SKIP] 本机只有一个盘，跳过跨盘断言");
  }
}

/* ------------------------------------------------------------------ */
section("E. 迁出");
const config = {
  root: ROOT,
  storeDir: path.join(ROOT, ".store", "v11"),
  registry: "https://registry.npmmirror.com/",
  defaultPolicy: "external",
  oversizeMB: 1,
  strictImplicitDeps: true,
  plugins: {}
};
const journal = new Journal(path.join(HOME, "plugin-relocator", "journal.ndjson"));
const locks = new Locks(path.join(HOME, "plugin-relocator", "locks.json"));
const migrator = new Migrator({ home: HOME, profileDir: PROFILE, config, journal, locks });
fs.mkdirSync(ROOT, { recursive: true });

const out = await migrator.migrateOut(NAME, { force: false });
const targetDir = path.join(ROOT, NAME);
check("迁出返回 opId", typeof out.opId === "string" && out.opId.length > 0, out.opId);
check("原路径变成 junction", fs.lstatSync(PLUGIN_DIR).isSymbolicLink());
check("junction 指向外置目录",
  path.resolve(fs.realpathSync(PLUGIN_DIR)).toLowerCase() === path.resolve(targetDir).toLowerCase(),
  path.relative(LAB, fs.realpathSync(PLUGIN_DIR)));
{
  const pkg = readJson(path.join(PROFILE, "package.json"), {});
  check('profile 声明改写为 link:', pkg.dependencies[NAME] === "link:" + targetDir.split(path.sep).join("/"),
    String(pkg.dependencies[NAME]));
}
check("外置目录有插件本体", fs.existsSync(path.join(targetDir, "lib", "client.js")));
check("外置目录有 .relocator.json", fs.existsSync(path.join(targetDir, ".relocator.json")));
{
  const meta = readJson(path.join(targetDir, ".relocator.json"), {});
  check("元数据记录原始 spec", meta.originalSpec === "1.0.0", String(meta.originalSpec));
}
check("回滚点保留原目录实体", fs.existsSync(path.join(HOME, "plugin-relocator", "rollback", out.opId, "package.json")));

section("A2. 迁出后：私有依赖仍从插件自身解析");
{
  const req = createRequire(path.join(targetDir, "lib", "index.js"));
  const resolved = req.resolve("my-private-dep");
  check("解析到外置目录内的 node_modules",
    resolved.toLowerCase().startsWith(path.join(targetDir, "node_modules").toLowerCase()),
    path.relative(LAB, resolved));
  const after = analyzeDeps(PLUGIN_DIR, { hoistedTop: [] });
  check("迁出后依赖体检 ok 不变", after.ok === true, "风险=" + after.risks.length);
}

section("B2. 迁出后：仍然只有一份 cordis");
{
  const copies = countCopies(LAB, "@deepseek-ai/cordis");
  check("全实验室 cordis 仍为 1 份", copies.length === 1, copies.map((p) => path.relative(LAB, p)).join(", "));
  const req = createRequire(path.join(targetDir, "lib", "index.js"));
  let local = null;
  try {
    local = req.resolve("@deepseek-ai/cordis");
  } catch {
    local = null;
  }
  check("插件目录内解析不到 cordis（交给加载器拦截层）", local === null);
}

section("C3. 迁出后：界面半身仍可加载");
{
  const loaded = loadClientBundle(path.join(targetDir, "lib", "client.js"));
  check("外置 client bundle 契约完好", loaded && loaded.id === NAME && typeof loaded.exports.apply === "function");
}

/* ------------------------------------------------------------------ */
section("F. 一键回滚（迁出 → 回滚）");
{
  await migrator.rollback(out.opId);
  check("原路径恢复为真实目录", !fs.lstatSync(PLUGIN_DIR).isSymbolicLink());
  const pkg = readJson(path.join(PROFILE, "package.json"), {});
  check("profile 声明还原", pkg.dependencies[NAME] === "1.0.0", String(pkg.dependencies[NAME]));
  check("外置目录已删除", !fs.existsSync(targetDir));
  const filesAfter = listFiles(PLUGIN_DIR);
  check("文件集合与迁移前一致", JSON.stringify(filesAfter) === JSON.stringify(filesBefore),
    filesBefore.length + " vs " + filesAfter.length);
  const list = migrator.rollbackList();
  const entry = list.find((item) => item.opId === out.opId);
  check("回滚记录标记 undone", entry && entry.undone === true, entry ? "undone=" + entry.undone : "未找到");
}

/* ------------------------------------------------------------------ */
section("G. 迁出 → 恢复（回到 .dsh）");
{
  const out2 = await migrator.migrateOut(NAME, {});
  const res = await migrator.restore(NAME, {});
  check("恢复返回 opId", typeof res.opId === "string", res.opId);
  check("原路径回到 profile 内真实目录", !fs.lstatSync(PLUGIN_DIR).isSymbolicLink());
  const pkg = readJson(path.join(PROFILE, "package.json"), {});
  check("profile 声明还原为原始 spec", pkg.dependencies[NAME] === "1.0.0", String(pkg.dependencies[NAME]));
  check("外置目录已让位", !fs.existsSync(path.join(ROOT, NAME)));
  const filesBack = listFiles(PLUGIN_DIR);
  check("文件集合还原", JSON.stringify(filesBack) === JSON.stringify(filesBefore), filesBack.length + " 个文件");
  check("迁移元数据已清理", !fs.existsSync(path.join(PLUGIN_DIR, ".relocator.json")));
  void out2;
}

/* ------------------------------------------------------------------ */
section("H. transferTree / verifyTrees 往返校验");
{
  const from = path.join(LAB, "t-from");
  const to = path.join(LAB, "t-to");
  writeFile(path.join(from, "a.txt"), "alpha\n");
  writeFile(path.join(from, "sub", "b.txt"), "beta\n");
  const stats = transferTree(from, to, { onProgress: null });
  check("transferTree 搬了 2 个文件", stats.files === 2, JSON.stringify(stats));
  const ok = await verifyTrees(from, to, { sampleHashes: 32 });
  check("verifyTrees 通过", ok.ok === true, JSON.stringify({ onlyLeft: ok.onlyLeft.length, size: ok.sizeMismatch.length }));
  if (stats.linked > 0) {
    check("同盘搬运默认用硬链接（瞬时、零额外占用）", fs.statSync(path.join(from, "a.txt")).ino === fs.statSync(path.join(to, "a.txt")).ino);
  }
  // 注意：硬链接下"原地改写"会同时改到源文件；真实安装器都是"写临时文件再改名"，故此处模拟替换语义。
  const tmp = path.join(LAB, "t-tmp");
  writeFile(tmp, "BEta\n");
  fs.renameSync(tmp, path.join(to, "sub", "b.txt"));
  const bad = await verifyTrees(from, to, { sampleHashes: 32 });
  check("内容被替换后 verifyTrees 报错", bad.ok === false, "hashMismatch=" + bad.hashMismatch.length);
  const missing = await verifyTrees(from, path.join(LAB, "t-none"), { sampleHashes: 0 });
  check("目标缺失时 verifyTrees 报错", missing.ok === false);
}

/* ------------------------------------------------------------------ */
section("I. 锁与日志");
{
  const lockConflict = (() => {
    locks.acquire(NAME, "op-test");
    try {
      locks.acquire(NAME, "op-test-2");
      return null;
    } catch (error) {
      return String(error.message);
    } finally {
      locks.release(NAME);
    }
  })();
  check("并发迁移被锁拦下", !!lockConflict && lockConflict.includes("正在"), String(lockConflict));
  const history = journal.history(50);
  check("操作历史已落盘", history.length >= 2, history.length + " 条");
  check("历史里有 out 与 restore", history.some((h) => h.op === "out") && history.some((h) => h.op === "restore"));
}

/* ------------------------------------------------------------------ */
section("J. 本体（file: 源）、孤儿与独立根");
{
  const J = path.join(LAB, "body");
  fs.rmSync(J, { recursive: true, force: true });
  const mk = (dir, name, text) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };

  const u1 = path.join(J, "u1");
  mk(u1, "a.txt", "hello-body");
  fs.linkSync(path.join(u1, "a.txt"), path.join(u1, "b.txt"));
  const m1 = unionMeasure([u1]);
  check("unionMeasure：硬链接只算一个 inode", m1.files === 1, "entries=" + m1.entries + " files=" + m1.files);
  check("unionMeasure：链接全在集合内 ⇒ 可完全释放", m1.fullyFreedBytes === m1.bytes && m1.stillLinkedBytes === 0, JSON.stringify({ bytes: m1.bytes, freed: m1.fullyFreedBytes }));
  check("unionMeasure：共享字节被识别", m1.sharedBytes === m1.bytes && m1.exclusiveBytes === 0, "shared=" + m1.sharedBytes);

  const u2 = path.join(J, "u2");
  const outside = path.join(J, "outside");
  mk(u2, "c.txt", "linked-away");
  fs.mkdirSync(outside, { recursive: true });
  fs.linkSync(path.join(u2, "c.txt"), path.join(outside, "c-copy.txt"));
  const m2 = unionMeasure([u2]);
  check("unionMeasure：集合外还链着 ⇒ 不能完全释放", m2.fullyFreedBytes === 0 && m2.stillLinkedBytes === m2.bytes, JSON.stringify({ freed: m2.fullyFreedBytes, still: m2.stillLinkedBytes }));

  const coverFail = await verifyCovers(u1, u2, { sampleHashes: 8 });
  check("verifyCovers：源里的文件缺失就报错", coverFail.ok === false && coverFail.missing.length === 2, coverFail.missing.join(","));
  const u3 = path.join(J, "u3");
  mk(u3, "c.txt", "linked-away");
  mk(u3, "extra.txt", "extra");
  const coverExtra = await verifyCovers(u2, u3, { sampleHashes: 8 });
  check("verifyCovers：目标多出文件不影响（单向覆盖）", coverExtra.ok === true, "targetFiles=" + coverExtra.targetFiles);

  const info = bodyInfo(PROFILE, "file:../../../plugins/my-plugin");
  check("bodyInfo：解析 file: 为绝对路径", !!info.bodySpec && path.isAbsolute(info.bodySpec), String(info.bodySpec));
  check("bodyInfo：非 file: 写法不认本体", bodyInfo(PROFILE, "1.0.0").bodyDir === null);
  const movableInDir = path.join(HOME, "plugins", "x");
  fs.mkdirSync(movableInDir, { recursive: true });
  const movableIn = bodyMovable(HOME, movableInDir);
  const movableOut = bodyMovable(HOME, path.join(LAB, "elsewhere", "x"));
  check("bodyMovable：.dsh 内本体可随迁", movableIn.movable === true, movableIn.reason);
  check("bodyMovable：.dsh 外本体一律不动", movableOut.movable === false, movableOut.reason);

  const cfg = { root: ROOT, storeDir: path.join(ROOT, ".store", "v11"), roots: { [NAME]: path.join(LAB, "per-plugin") } };
  check("rootFor：逐插件覆盖优先", rootFor(cfg, NAME) === path.join(LAB, "per-plugin"));
  check("rootFor：未覆盖时回落全局根", rootFor(cfg, "other") === ROOT);
  const merged = setPluginRoot(HOME, { ...cfg }, NAME, path.join(LAB, "per-plugin-2"));
  check("setPluginRoot：改写并持久化", rootFor(merged, NAME) === path.join(LAB, "per-plugin-2"),
    String(readJson(path.join(HOME, "plugin-relocator", "config.json"), {}).roots?.[NAME]));
  const cleared = setPluginRoot(HOME, merged, NAME, "");
  check("setPluginRoot：空串删除覆盖", !(NAME in (cleared.roots ?? {})), JSON.stringify(cleared.roots ?? {}));
  const unsafe = validateRoot(HOME, driveRoot(ROOT), "", {});
  check("validateRoot：拒绝盘符根", unsafe.ok === false && unsafe.problems.some((p) => p.code === "root-unsafe"),
    JSON.stringify(unsafe.problems.map((p) => p.code)));

  const orphanHome = path.join(J, "ohome");
  const orphanProfile = path.join(orphanHome, "profiles", "lab");
  writeJson(path.join(orphanProfile, "package.json"), { name: "lab", dependencies: { referenced: "file:../../plugins/referenced" } });
  mk(path.join(orphanHome, "plugins", "orphan"), "big.bin", "x".repeat(2048));
  mk(path.join(orphanHome, "plugins", "referenced"), "index.js", "module.exports = 1;\n");
  const scan = scanOrphanBodies({ home: orphanHome, profileDir: orphanProfile, rows: [{ name: "referenced", spec: "file:../../plugins/referenced" }] });
  check("scanOrphanBodies：只列出没被引用的本体", scan.orphans.length === 1 && scan.orphans[0].name === "orphan", JSON.stringify(scan.orphans.map((o) => o.name)));
  check("scanOrphanBodies：给出可回收体积", scan.orphans[0].bytes >= 2048, scan.orphans[0].human);
  check("referencedBodies：解析出 profile 引用的本体", referencedBodies(orphanHome).has(path.resolve(path.join(orphanHome, "plugins", "referenced")).toLowerCase()));

  const jr = new Journal(path.join(J, "j.ndjson"));
  const a = jr.begin({ op: "out", plugin: "p1", mode: "out" });
  const b = jr.begin({ op: "restore", plugin: "p2", mode: "restore" });
  const snap = jr.snapshot();
  check("journal：两个操作并行时都在册", snap.actives.length === 2, "actives=" + snap.actives.map((x) => x.id).join(","));
  jr.progress({ percent: 42, files: 3, totalFiles: 10, phase: "transfer" }, a.id);
  check("journal：按 opId 定位进度", jr.snapshot().actives.find((x) => x.id === a.id).percent === 42);
  check("journal：active 仍指最近一条", jr.snapshot().active.id === b.id);
  jr.end(a, "ok", { result: { ok: 1 } });
  const snap2 = jr.snapshot();
  check("journal：结束后只在册一条", snap2.actives.length === 1 && snap2.actives[0].id === b.id, "actives=" + snap2.actives.length);
  check("journal：last 记录状态与结果", snap2.last?.status === "ok" && snap2.last?.result?.ok === 1);
  jr.end(b, "failed", { error: "boom" });
  check("journal：全部结束后 active 为空", jr.snapshot().active === null);
}

/* ------------------------------------------------------------------ */
console.log("");
console.log("==================================================");
console.log("  通过 " + passed + " 项，失败 " + failed + " 项");
console.log("  实验室目录：" + LAB);
console.log("  注：本脚本证明的是“解析位置与契约结构”；真实 DSH 加载器在运行中");
console.log("      的应用里的拦截行为，需要在跑起来的 DSH 里用 test/http-smoke.mjs");
console.log("      加人工观察确认。");
console.log("==================================================");
process.exitCode = failed === 0 ? 0 : 1;
