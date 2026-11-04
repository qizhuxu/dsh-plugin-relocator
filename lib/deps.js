/**
 * 依赖自洽体检 —— 迁出的前置条件。
 *
 * 为什么需要：profile 的 node_modules 是 hoisted（扁平）布局，插件即使没在
 * package.json 里声明某个依赖，也能"顺手"从顶层拿到它。一旦迁到外置独立目录，
 * 顶层不再有这些包，插件启动就会 MODULE_NOT_FOUND。
 * 因此迁出前必须证明源码里出现的裸模块名都有明确出处。
 *
 * 四类出处，风险不同：
 *   explicit      —— 插件自己在 package.json 里声明了，会装进它自己的 node_modules。
 *   dsh-singleton —— DSH 安装侧保证存在的单例（@deepseek-ai/cordis、react 等）。
 *                    DSH 加载器有解析拦截层，迁移后仍解析到安装侧同一份，安全。
 *   hoisted       —— 没声明、只是从 profile 顶层白拿的；迁出后大概率 MODULE_NOT_FOUND，风险项。
 *   private       —— 没在 package.json 里声明，但插件自己的 node_modules 里就有实体
 *                    （外置独立工程、或插件自带嵌套 node_modules）。随目录一起搬走即可，安全。
 *   absent        —— 哪都没有。本来就是坏的（或仅测试期使用）。
 *
 * 结论可解释：每个隐式依赖都带 文件:行 证据与来源分类。
 */
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { readJson } from "./paths.js";

const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => (name.startsWith("node:") ? name.slice(5) : "node:" + name))
]);

const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx"]);
const TYPE_EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", ".cache", ".turbo", "docs", "examples", "vendor"]);

/** 合法 npm 包名；用于过滤静态扫描噪声。用字符串构造，避免正则字面量里的斜杠转义陷阱。 */
const VALID_NAME = new RegExp("^(?:@[a-z0-9-_.~]+/)?[a-z0-9-_.~]+$", "i");
const TEST_FILE = new RegExp("(^|[.\\-_/])(test|spec)\\.[cm]?[jt]sx?$", "i");

/** 从一条 import/require 说明符里取出包名；非裸模块返回 null。 */
export function packageNameOf(spec) {
  if (!spec || typeof spec !== "string") return null;
  if (spec.startsWith(".") || spec.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(spec)) return null;
  if (spec.startsWith("node:")) return null;
  if (/^(data|https?|file|blob):/.test(spec)) return null;
  const segments = spec.split("/");
  if (spec.startsWith("@")) {
    if (segments.length < 2) return null;
    return segments[0] + "/" + segments[1];
  }
  return segments[0];
}

const LINE_START = [
  /^\s*import\s+["']([^"'\n]{1,200})["']/,
  /^\s*import\s+[^;"'\n]*?\bfrom\s*["']([^"'\n]{1,200})["']/,
  /^\s*export\s+[^;"'\n]*?\bfrom\s*["']([^"'\n]{1,200})["']/
];
const INLINE = [
  /\bimport\s*\(\s*["']([^"'\n]{1,200})["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'\n]{1,200})["']\s*\)/g
];

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function collectSources(root, limit, exts) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!exts.has(ext)) continue;
      if (/\.d\.[cm]?ts$/.test(entry.name)) continue;
      if (TEST_FILE.test(entry.name)) continue;
      out.push(abs);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * 收集插件自身 node_modules 里的包名（含 @scope/name 两段式）。
 * 外置独立工程的私有依赖就落在这里；搬目录时它们跟着走，因此不算风险。
 */
export function ownNodeModules(pluginDir) {
  const out = new Set();
  const dir = path.join(pluginDir, "node_modules");
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      let scoped = [];
      try {
        scoped = fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of scoped) {
        if (sub.name.startsWith(".")) continue;
        out.add(entry.name + "/" + sub.name);
      }
      continue;
    }
    out.add(entry.name);
  }
  return out;
}

/**
 * @param {string} pluginDir 插件真实目录（外置目录同样适用）
 * @param {object} options
 * @param {string[]} options.hoistedTop profile 顶层 node_modules 的包名
 * @param {string[]} options.sharedNames DSH 安装侧保证存在的单例包名
 */
export function analyzeDeps(pluginDir, options = {}) {
  const hoistedTop = new Set(options.hoistedTop ?? []);
  const sharedNames = new Set(options.sharedNames ?? [
    "@deepseek-ai/cordis",
    "@deepseek-ai/schemastery",
    "@deepseek-ai/dsh-typert-protocol",
    "react",
    "react-dom",
    // electron 由 Electron 运行时本身提供（桌面主进程内置模块），不在 node_modules 里
    "electron"
  ]);
  const limit = options.maxFiles ?? 4000;
  const pkg = readJson(path.join(pluginDir, "package.json"), null);
  if (!pkg) {
    return { ok: false, error: "package.json 读取失败", implicit: [], risks: [], missing: [], used: [], declared: [] };
  }
  const deps = Object.keys(pkg.dependencies ?? {});
  const optional = Object.keys(pkg.optionalDependencies ?? {});
  const peers = Object.keys(pkg.peerDependencies ?? {});
  const dev = Object.keys(pkg.devDependencies ?? {});
  const declared = new Set([...deps, ...optional, ...peers, ...dev]);
  const runtimeDeclared = new Set([...deps, ...optional, ...peers]);

  // 只扫描"真正会被加载的产物"：
  //   - 入口（main / exports["."]）所在目录，加上客户端半身所在目录
  //   - 若入口是 TS 才连源码一起看；否则 .ts/.tsx 只是源码，不参与运行时依赖
  // 这样能避免把 src/ 下的测试期依赖（例如 electron）误判成运行时依赖。
  const entryHint = pkg.main ?? (typeof pkg.exports?.["."] === "string" ? pkg.exports["."] : pkg.exports?.["."]?.default);
  const clientHint = typeof pkg.exports?.["./client"] === "string" ? pkg.exports["./client"] : pkg.exports?.["./client"]?.default;
  const roots = new Set();
  for (const hint of [entryHint, clientHint]) {
    if (typeof hint !== "string") continue;
    const dir = path.dirname(hint);
    const abs = path.resolve(pluginDir, dir);
    if (fs.existsSync(abs)) roots.add(abs);
  }
  if (roots.size === 0) roots.add(path.resolve(pluginDir));
  const isTsEntry = typeof entryHint === "string" && /\.[cm]?tsx?$/.test(entryHint);
  const exts = isTsEntry ? new Set([...CODE_EXT, ...TYPE_EXT]) : CODE_EXT;
  const files = [];
  const seenFiles = new Set();
  for (const root of roots) {
    for (const file of collectSources(root, limit, exts)) {
      const key = file.toLowerCase();
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      files.push(file);
    }
  }
  const used = new Map();
  for (const file of files) {
    let text;
    try {
      if (fs.statSync(file).size > 4 * 1024 * 1024) continue;
      text = stripComments(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const record = (spec, lineNo) => {
      const name = packageNameOf(spec);
      if (!name || name === pkg.name) return;
      if (BUILTINS.has(spec) || BUILTINS.has(name)) return;
      if (!VALID_NAME.test(name)) return;
      if (used.has(name)) return;
      used.set(name, {
        name,
        spec,
        file: path.relative(pluginDir, file).replace(/\\/g, "/"),
        line: lineNo
      });
    };
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/import|export|require/.test(line)) continue;
      for (const pattern of LINE_START) {
        const match = pattern.exec(line);
        if (match) record(match[1], i + 1);
      }
      for (const pattern of INLINE) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(line))) record(match[1], i + 1);
      }
    }
  }

  const own = ownNodeModules(pluginDir);
  const rows = [];
  for (const [name, info] of used) {
    if (declared.has(name)) {
      rows.push({ ...info, category: "explicit", providedBy: "plugin", runtime: runtimeDeclared.has(name) });
      continue;
    }
    // 没声明、但插件自己的 node_modules 里确实有 —— 外置独立工程的标准形态：
    // 依赖装在自己目录下，搬走时一起搬，因此不是风险。
    if (own.has(name)) {
      rows.push({ ...info, category: "private", providedBy: "plugin-node_modules", runtime: true });
      continue;
    }
    // @deepseek-ai/* 一律视为安装侧/浏览器模块表提供的单例：
    // 宿主半身走 DSH 加载器拦截层，浏览器半身走 __ModuleLoader__ 的虚拟模块表，
    // 两者都不会从插件自己的 node_modules 解析，因此迁移后仍然可用。
    const isSingleton = sharedNames.has(name) || name.startsWith("@deepseek-ai/");
    const category = isSingleton ? "dsh-singleton" : hoistedTop.has(name) ? "hoisted" : "absent";
    rows.push({
      ...info,
      category,
      providedBy: category === "dsh-singleton" ? "dsh-singleton" : category === "hoisted" ? "profile-node_modules" : "nowhere",
      runtime: true
    });
  }

  const risks = rows.filter((row) => row.category === "hoisted" || row.category === "absent");
  const singletons = rows.filter((row) => row.category === "dsh-singleton");
  const entryRaw = pkg.main ?? (typeof pkg.exports?.["."] === "string" ? pkg.exports["."] : pkg.exports?.["."]?.default);
  const entry = typeof entryRaw === "string" ? entryRaw : null;
  const clientRaw = typeof pkg.exports?.["./client"] === "string" ? pkg.exports["./client"] : pkg.exports?.["./client"]?.default;

  return {
    ok: risks.length === 0,
    name: pkg.name,
    version: pkg.version,
    declared: [...declared],
    runtimeDeclared: [...runtimeDeclared],
    devOnly: dev.filter((name) => !runtimeDeclared.has(name)),
    used: [...used.values()],
    rows,
    implicit: singletons,
    ownModules: [...own],
    risks,
    missing: risks.filter((row) => row.category === "absent"),
    unusedDeclared: [...declared].filter((name) => !used.has(name)),
    scannedFiles: files.length,
    truncated: files.length >= limit,
    entry,
    entryExists: entry ? fs.existsSync(path.join(pluginDir, entry)) : true,
    clientPath: typeof clientRaw === "string" ? clientRaw : null,
    clientExists: typeof clientRaw === "string" ? fs.existsSync(path.join(pluginDir, clientRaw)) : null,
    hasClient: !!pkg.dsh?.client
  };
}
