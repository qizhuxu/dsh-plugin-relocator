/**
 * 插件清单：以 profile 的 package.json 为准，逐条解析"装在哪、多大、依赖是否自洽"。
 * 只读，不做任何修改。
 */
import fs from "node:fs";
import path from "node:path";
import {
  moduleDir,
  externalDirFor,
  lstatOrNull,
  realPathOrNull,
  isLink,
  isSubPath,
  measureTree,
  readJson,
  humanBytes
} from "./paths.js";
import { analyzeDeps } from "./deps.js";
import { pluginOverride } from "./config.js";
import { bodyInfo } from "./body.js";
import { SizeCache } from "./sizes.js";

/** DSH 安装侧自带、绝不能迁出的包。 */
export function isProtected(name, { bundles, dependencies }) {
  if (name.startsWith("@deepseek-ai/")) return true;
  // 在 bundles 里但不在 dependencies 里 => 由 DSH 安装侧提供（例如 @deepseek-ai/dsh-base）
  if (bundles.includes(name) && !(name in dependencies)) return true;
  if (name === "dsh-plugin-relocator") return true; // 自己
  return false;
}

export function readProfile(profileDir) {
  const pkg = readJson(path.join(profileDir, "package.json"), {}) ?? {};
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const dependencies = pkg.dependencies ?? {};
  return { pkg, bundles, dependencies };
}

export function hoistedTopNames(profileDir) {
  try {
    return fs
      .readdirSync(path.join(profileDir, "node_modules"), { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== ".bin")
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function pluginRow(profileDir, name, { spec, isBundle, bundles, dependencies }, options = {}) {
  const dir = moduleDir(profileDir, name);
  const st = lstatOrNull(dir);
  const link = !!st && st.isSymbolicLink();
  const realPath = st ? realPathOrNull(dir) : null;
  // 真实位置是否落在 profile 目录内（外置目录落在其他盘/其他根时即为 false）
  const inDsh = realPath ? isSubPath(profileDir, realPath) : true;
  const externalMode = typeof spec === "string" && spec.startsWith("link:");
  // file: 依赖的「本体」在 .dsh 的另一处（如 <DSH_HOME>\\plugins\\<name>）：只搬 node_modules 一侧时它会变成孤儿。
  const body = bodyInfo(profileDir, spec);
  return {
    name,
    spec: spec ?? null,
    bodySpec: body.bodySpec,
    bodyDir: body.bodyDir,
    bodyExists: body.bodyExists,
    /** 依赖写法是 file: 的插件，其“本体”在 .dsh 的另一处（如 plugins\<name>），与 node_modules 侧硬链接共享。 */
    fileSpec: typeof spec === "string" && spec.startsWith("file:"),
    version: realPath ? readJson(path.join(realPath, "package.json"), {})?.version ?? null : null,
    isBundle,
    installed: !!st,
    dir,
    realPath,
    isLink: link,
    linkTarget: link ? realPath : null,
    location: link && !inDsh ? "external" : "in-dsh",
    externalMode,
    protected: isProtected(name, { bundles, dependencies }),
    policy: pluginOverride(options.config ?? {}, name).policy ?? "inherit",
    ignored: pluginOverride(options.config ?? {}, name).ignored ?? []
  };
}

/**
 * 构建完整清单。size 来自缓存（缺失则为 null，由"测量体积"动作补齐）。
 * deps 为惰性字段：只在 options.withDeps 时计算。
 */
export function listPlugins({ profileDir, config, sizeCache, withDeps = false }) {
  const profile = readProfile(profileDir);
  const names = new Set([...Object.keys(profile.dependencies), ...profile.bundles]);
  const hoistedTop = withDeps ? hoistedTopNames(profileDir) : [];
  const rows = [];
  for (const name of [...names].sort()) {
    const row = pluginRow(profileDir, name, {
      spec: profile.dependencies[name],
      isBundle: profile.bundles.includes(name),
      bundles: profile.bundles,
      dependencies: profile.dependencies
    }, { config: config ?? {} });
    if (row.realPath) {
      const cached = sizeCache?.get(row.realPath);
      row.size = cached ?? null;
    } else {
      row.size = null;
    }
    if (withDeps && row.realPath) {
      row.deps = analyzeDeps(row.realPath, { hoistedTop });
      row.deps.riskCount = row.deps.risks.length;
    }
    rows.push(row);
  }
  return { profile, rows, counts: {
    total: rows.length,
    installed: rows.filter((r) => r.installed).length,
    external: rows.filter((r) => r.location === "external").length,
    protected: rows.filter((r) => r.protected).length
  } };
}

/** 单插件体积测量（含 inode 去重），写回缓存。 */
export function measurePlugin(row, sizeCache) {
  if (!row.realPath) return null;
  const measured = measureTree(row.realPath);
  const value = {
    at: Date.now(),
    files: measured.files,
    dirs: measured.dirs,
    bytes: measured.bytes,
    logicalBytes: measured.logicalBytes,
    inclusiveBytes: measured.logicalBytes,
    exclusiveBytes: measured.exclusiveBytes,
    sharedBytes: measured.sharedBytes,
    sharedFiles: measured.sharedFiles,
    links: measured.links,
    truncated: measured.truncated,
    human: humanBytes(measured.bytes),
    // 人类可读的三种口径：可立即回收（独占）、与他人共享、未去重逻辑体积
    exclusiveHuman: humanBytes(measured.exclusiveBytes),
    sharedHuman: humanBytes(measured.sharedBytes),
    logicalHuman: humanBytes(measured.logicalBytes)
  };
  sizeCache?.set(row.realPath, value);
  return value;
}

export function previewExternalDir(config, name) {
  if (!config.root) return null;
  return externalDirFor(config.root, name);
}
