/**
 * 迁出 / 恢复 / 回滚（完全体版）。
 *
 * 迁出（out）流程 —— 全程只增不改，任何一步失败都退回原状：
 *   1. 加锁、前置校验（受保护包 / 未安装 / 隐式依赖 / 根目录未设置 / 目标冲突）
 *   2. 合并量测「本体 + node_modules 落地副本」两处（硬链接去重），算出真正能释放多少
 *   3. 把插件目录搬进外置根（同盘硬链接、跨盘复制），file: 本体若有多出的文件再补齐
 *   4. 单向覆盖校验（源里每个文件都在目标里、大小一致、抽样哈希）
 *   5. 在外置目录里补齐独立依赖（.npmrc / pnpm-workspace.yaml，必要时 pnpm install）
 *   6. 原子切换：原目录改名进回收点 → 建 junction 指回外置目录 → 改写 profile 依赖为 link:
 *      → 同步 pnpm-lock.yaml / node_modules/.modules.yaml（pnpm install --no-frozen-lockfile）
 *      → 把 file: 本体也挪进回收点（<opId>-body）
 *   7. 复验：junction 解析正确、依赖体检与迁出前一致、三处写法一致
 *
 * 恢复（restore）与回滚（rollback）走同一套"先搬后切"的顺序，因此两者都能再次回滚。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createJunction,
  exists,
  externalDirFor,
  humanBytes,
  isLink,
  isSubPath,
  lstatOrNull,
  readJson,
  removeLink,
  sameDrive,
  toSpecPath,
  writeJsonAtomic,
  driveRoot
} from "./paths.js";
import { analyzeDeps } from "./deps.js";
import { transferTree, verifyTrees } from "./transfer.js";
import { pluginRow, readProfile } from "./scan.js";
import { resolveStoreDir, rootFor } from "./config.js";
import { bodyInfo, bodySpecPath, bodyMovable, scanOrphanBodies, unionMeasure, verifyCovers } from "./body.js";

const SKIP_DIRS = new Set([".git", ".svn", ".hg"]);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/** 内置 node / pnpm 的可执行入口。 */
export function runtimePaths(home) {
  const root = path.join(home, "dsh-runtimes", "dsh-primary-runtime", "dependencies");
  const node = path.join(root, "node", "bin", "node.exe");
  const pnpm = path.join(root, "pnpm", "bin", "pnpm.mjs");
  return {
    node: exists(node) ? node : process.execPath,
    pnpm: exists(pnpm) ? pnpm : null
  };
}

function specIsLink(spec) {
  return typeof spec === "string" && spec.startsWith("link:");
}

/** 改写 profile package.json 里的依赖写法（只动 dependencies，不碰 bundles）。 */
export function patchProfileSpec(profileDir, name, spec) {
  const file = path.join(profileDir, "package.json");
  const pkg = readJson(file, {});
  if (!pkg?.dependencies) throw new Error("profile package.json 里没有 dependencies");
  const before = pkg.dependencies[name] ?? null;
  if (spec === null) delete pkg.dependencies[name];
  else pkg.dependencies[name] = spec;
  writeJsonAtomic(file, pkg);
  return { before, after: spec ?? null };
}

/** 生成外置工程所需的 .npmrc / pnpm-workspace.yaml（独立 store 与独立 linker）。 */
export function writeProjectFiles(dir, { config, name, root = null }) {
  const store = resolveStoreDir(root || config.root, config.storeDir);
  const npmrc = [
    "# 由 dsh-plugin-relocator 生成：让这个插件目录成为独立工程",
    "registry=" + (config.registry || "https://registry.npmmirror.com/"),
    "store-dir=" + store.split(path.sep).join("/"),
    "node-linker=isolated",
    "auto-install-peers=false",
    "strict-peer-dependencies=false",
    "fund=false",
    "audit=false",
    "update-notifier=false",
    "fetch-retries=2",
    "fetch-retry-mintimeout=10000",
    "fetch-retry-maxtimeout=30000",
    "fetch-timeout=60000",
    ""
  ].join(LF);
  fs.writeFileSync(path.join(dir, ".npmrc"), npmrc, "utf8");
  const workspace = ["packages:", "  - .", "nodeLinker: isolated", "autoInstallPeers: false", ""].join(LF);
  fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), workspace, "utf8");
  return { npmrc: path.join(dir, ".npmrc"), workspace: path.join(dir, "pnpm-workspace.yaml"), store };
}

/**
 * 在外置目录里装齐它自己的私有依赖。
 * 没有 dependencies 就直接返回 —— 但必须把"为什么跳过"的依据一并返回（不静默跳过）。
 */
export function materializeDeps(dir, { home, config, onLog, root = null, implicit = null }) {
  const pkg = readJson(path.join(dir, "package.json"), {});
  const deps = Object.keys(pkg?.dependencies ?? {});
  const peer = Object.keys(pkg?.peerDependencies ?? {});
  const optional = Object.keys(pkg?.optionalDependencies ?? {});
  const basis = {
    packageName: pkg?.name ?? path.basename(dir),
    source: path.join(dir, "package.json"),
    declaredDependencies: deps,
    declaredPeerDependencies: peer,
    declaredOptionalDependencies: optional,
    implicitDependencies: Array.isArray(implicit) ? implicit.map((risk) => risk.name + " @ " + risk.file + ":" + risk.line) : null,
    reason: null
  };
  if (deps.length === 0) {
    const parts = [
      "package.json（" + basis.source + "）没有声明 dependencies（运行时依赖）",
      peer.length
        ? "peerDependencies 有 " + peer.join("、") + "，按约定由 DSH 安装侧提供，不需要在这里装"
        : "peerDependencies 也为空",
      "实测隐式/hoisted 依赖 " + (Array.isArray(implicit) ? implicit.length : 0) + " 个",
      "因此跳过 pnpm install，保持插件目录内容与迁移前逐字节一致"
    ];
    basis.reason = parts.join("；");
    return Promise.resolve({ skipped: true, reason: "这个插件没有声明运行时依赖，无需 pnpm install（不改动目录内容）。依据：" + basis.reason, deps, peer, basis });
  }
  const files = writeProjectFiles(dir, { config, name: pkg?.name ?? path.basename(dir), root });
  const { node, pnpm } = runtimePaths(home);
  if (!pnpm) {
    return Promise.resolve({
      skipped: true,
      reason: "找不到内置 pnpm，已写好 .npmrc / pnpm-workspace.yaml，请手动在该目录执行 pnpm install",
      ...files,
      deps,
      peer,
      basis
    });
  }
  basis.reason = "package.json 声明了 " + deps.length + " 个运行时依赖：" + deps.join("、");
  return new Promise((resolve) => {
    const child = spawn(node, [pnpm, "install", "--prod", "--no-frozen-lockfile", "--reporter=append-only"], {
      cwd: dir,
      env: { ...process.env, npm_config_yes: "true", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
      windowsHide: true
    });
    let tail = "";
    const collect = (chunk) => {
      const text = String(chunk);
      tail = (tail + text).slice(-4000);
      onLog?.(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => resolve({ ...files, deps, peer, basis, ok: false, output: String(error?.message ?? error) }));
    child.on("close", (code) => resolve({ ...files, deps, peer, basis, ok: code === 0, code, output: tail }));
  });
}

/** 在 profile 里跑一次 pnpm install，把 pnpm-lock.yaml 与 node_modules/.modules.yaml 跟 package.json 对齐。 */
export function syncProfileLockfile(profileDir, { home, onLog = null } = {}) {
  const { node, pnpm } = runtimePaths(home);
  if (!pnpm) {
    return Promise.resolve({ skipped: true, ok: null, reason: "找不到内置 pnpm，跳过 lock 同步（pnpm-lock.yaml 可能与 package.json 不一致）" });
  }
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(node, [pnpm, "install", "--no-frozen-lockfile", "--reporter=append-only"], {
      cwd: profileDir,
      env: { ...process.env, npm_config_yes: "true", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
      windowsHide: true
    });
    let tail = "";
    const collect = (chunk) => {
      const text = String(chunk);
      tail = (tail + text).slice(-4000);
      onLog?.(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => resolve({ ok: false, skipped: false, ms: Date.now() - startedAt, output: String(error?.message ?? error) }));
    child.on("close", (code) => resolve({ ok: code === 0, skipped: false, code, ms: Date.now() - startedAt, output: tail }));
  });
}

/** 从 pnpm-lock.yaml 的 importer 段读出某个包的 specifier / version（纯文本扫描，不引 yaml 依赖）。 */
export function lockEntry(profileDir, name) {
  const file = path.join(profileDir, "pnpm-lock.yaml");
  if (!exists(file)) return { file, found: false, specifier: null, version: null, line: null };
  const lines = fs.readFileSync(file, "utf8").split(LF).map((line) => line.replaceAll(CR, ""));
  // pnpm-lock.yaml 里 scoped 包名会写成单引号（例如 '@scope/pkg':），三种写法都要认
  const keys = [name + ":", JSON.stringify(name) + ":", "'" + name + "':"];
  for (let i = 0; i < lines.length; i += 1) {
    if (!keys.includes(lines[i].trim())) continue;
    let specifier = null;
    let version = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
      const text = lines[j].trim();
      if (!text) continue;
      if (text.startsWith("specifier:")) {
        specifier = text.slice("specifier:".length).trim();
        continue;
      }
      if (text.startsWith("version:")) {
        version = text.slice("version:".length).trim();
        continue;
      }
      if (text.endsWith(":")) break;
    }
    return { file, found: true, specifier, version, line: i + 1 };
  }
  return { file, found: false, specifier: null, version: null, line: null };
}

/** node_modules/.modules.yaml 里是否还把这个包当成"目录依赖"（file: 的残留）。 */
export function modulesEntry(profileDir, name) {
  const file = path.join(profileDir, "node_modules", ".modules.yaml");
  if (!exists(file)) return { file, found: false, directory: false, line: null };
  const lines = fs.readFileSync(file, "utf8").split(LF);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes(name)) continue;
    const window = lines.slice(Math.max(0, i - 2), i + 4).join(LF);
    return { file, found: true, directory: window.includes("directory:"), line: i + 1 };
  }
  return { file, found: false, directory: false, line: null };
}

/** 三处写法是否一致：profile/package.json、pnpm-lock.yaml、node_modules/.modules.yaml。 */
export function verifyProfileConsistency(profileDir, name, { expectSpec = null } = {}) {
  const pkg = readJson(path.join(profileDir, "package.json"), {});
  const spec = pkg?.dependencies?.[name] ?? null;
  const lock = lockEntry(profileDir, name);
  const modules = modulesEntry(profileDir, name);
  const problems = [];
  if (expectSpec != null && spec !== expectSpec) problems.push("profile 依赖写法是 " + spec + "，期望 " + expectSpec);
  if (!lock.found) problems.push("pnpm-lock.yaml 里找不到 " + name + " 的 importer 条目（下次 frozen 安装会失败）");
  else if (expectSpec != null && lock.specifier !== expectSpec) {
    problems.push("pnpm-lock.yaml 的 specifier 是 " + lock.specifier + "，与 package.json 的 " + expectSpec + " 不一致（下次 frozen 安装会失败）");
  }
  if (typeof spec === "string" && spec.startsWith("link:") && modules.directory) {
    problems.push("node_modules/.modules.yaml 仍把该包当作目录依赖（file:），未同步");
  }
  return { ok: problems.length === 0, spec, lock, modules, problems };
}

/**
 * 收集所有 profile 里本地依赖（file: / 绝对 link:）指向的本体位置，附带是谁在引用。
 * 返回 Map<小写绝对路径, [{profile, profileDir, depName, spec}]>。
 */
export function bodyReferences(home) {
  const out = new Map();
  const root = path.join(home, "profiles");
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const profileName of names) {
    const profileDir = path.join(root, profileName);
    const pkg = readJson(path.join(profileDir, "package.json"), null);
    const deps = pkg?.dependencies ?? null;
    if (!deps) continue;
    for (const [depName, spec] of Object.entries(deps)) {
      const dir = bodySpecPath(profileDir, spec);
      if (!dir) continue;
      const key = path.resolve(dir).toLowerCase();
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({ profile: profileName, profileDir, depName, spec });
    }
  }
  return out;
}

/** 只关心路径集合的老接口（判定"孤儿本体"）。 */
export function referencedBodies(home) {
  return new Set(bodyReferences(home).keys());
}

/** 把源里"目标缺失"的文件补进目标（本体比 pnpm 落地副本多出文件时用；只补缺、不覆盖）。 */
export function copyMissing(source, target, { onProgress = null } = {}) {
  const stats = { copied: 0, bytes: 0, scanned: 0 };
  const stack = [source];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
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
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      stats.scanned += 1;
      const to = path.join(target, path.relative(source, abs));
      if (exists(to)) continue;
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(abs, to);
      } catch {
        continue;
      }
      stats.copied += 1;
      try {
        stats.bytes += fs.statSync(abs).size;
      } catch {
        /* 忽略 */
      }
      onProgress?.(stats);
    }
  }
  return stats;
}

/** 盘符/同盘判定与提示文案（纯函数，便于自测直接调用）。 */
export function checkDrives({ root, storeDir, home }) {
  const store = resolveStoreDir(root, storeDir);
  return {
    root,
    store,
    rootStoreSameDrive: sameDrive(root, store),
    rootHomeSameDrive: sameDrive(root, home),
    rootDrive: driveRoot(root),
    homeDrive: driveRoot(home),
    storeDrive: driveRoot(store),
    notes: [
      sameDrive(root, home)
        ? "外置根与 .dsh 同盘：迁出用硬链接完成，瞬时且不额外占空间"
        : "外置根与 .dsh 不同盘：迁出必须逐字节复制，会先多占一份空间，删除 .dsh 侧旧目录后才真正回收",
      sameDrive(root, store)
        ? "外置根与 pnpm store 同盘：外置依赖目录可以直接硬链接自 store，不额外占空间"
        : "外置根与 pnpm store 不同盘：外置依赖会真实复制一份，占用会明显上升（建议把 store-dir 也挪到外置根同盘）"
    ]
  };
}

export class Migrator {
  constructor({ home, profileDir, config, journal, locks, keepRollback = true }) {
    this.home = home;
    this.profileDir = profileDir;
    this.config = config;
    this.journal = journal;
    this.locks = locks;
    this.keepRollback = keepRollback;
    this.baseDir = path.join(home, "plugin-relocator");
    this.rollbackRoot = path.join(this.baseDir, "rollback");
    fs.mkdirSync(this.rollbackRoot, { recursive: true });
  }

  /** 这个插件该装到哪个根（逐插件覆盖优先，否则全局根）。 */
  rootForPlugin(name) {
    return rootFor(this.config, name) || this.config.root || "";
  }

  /** 目标根与 store 是否同一盘 —— 决定能不能硬链接去重。 */
  checkDrives(name = null) {
    const root = (name && this.rootForPlugin(name)) || this.config.root;
    return checkDrives({ root, storeDir: this.config.storeDir, home: this.home });
  }

  metaFile(opId) {
    return path.join(this.rollbackRoot, opId + ".json");
  }

  rollbackList() {
    const out = [];
    for (const name of fs.readdirSync(this.rollbackRoot)) {
      if (!name.endsWith(".json")) continue;
      const meta = readJson(path.join(this.rollbackRoot, name), null);
      if (!meta) continue;
      const backupDir = path.join(this.rollbackRoot, meta.opId);
      const bodyDir = meta.bodyBackupDir ?? null;
      const roots = [backupDir, bodyDir].filter((item) => item && exists(item));
      const union = roots.length ? unionMeasure(roots) : { bytes: 0, fullyFreedBytes: 0, stillLinkedBytes: 0, entries: 0 };
      out.push({
        ...meta,
        backupExists: exists(backupDir),
        backupBytes: union.bytes,
        freedBytes: union.fullyFreedBytes,
        freedHuman: humanBytes(union.fullyFreedBytes),
        sharedBytes: union.stillLinkedBytes,
        entries: union.entries,
        bodyExists: !!bodyDir && exists(bodyDir)
      });
    }
    return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }

  /** <DSH_HOME>/plugins 下没有被任何 file: 依赖引用的孤儿本体。 */
  orphanBodies() {
    const profile = readProfile(this.profileDir);
    const rows = Object.keys(profile.dependencies).map((name) => ({ name, spec: profile.dependencies[name] }));
    return scanOrphanBodies({ home: this.home, profileDir: this.profileDir, rows });
  }

  async migrateOut(name, { force = false, onProgress = null, body = null, root = null } = {}) {
    const profile = readProfile(this.profileDir);
    const row = pluginRow(this.profileDir, name, {
      spec: profile.dependencies[name],
      isBundle: profile.bundles.includes(name),
      bundles: profile.bundles,
      dependencies: profile.dependencies
    }, { config: this.config });

    if (row.protected) throw new Error("「" + name + "」是 DSH 核心或安装侧自带的包，不允许迁出");
    if (!row.installed) throw new Error("「" + name + "」当前没有安装在 profile 里");
    if (row.location === "external") throw new Error("「" + name + "」已经在外置目录里了");

    const targetRoot = root || this.rootForPlugin(name);
    if (!targetRoot) throw new Error("还没有设置插件安装根目录");
    if (!exists(targetRoot)) {
      try {
        fs.mkdirSync(targetRoot, { recursive: true });
        this.journal.warn(null, "root", "安装根目录不存在，已自动创建：" + targetRoot);
      } catch (error) {
        throw new Error("插件安装根目录不存在且无法创建：" + targetRoot + "（" + (error && error.message) + "）");
      }
    }

    const drives = checkDrives({ root: targetRoot, storeDir: this.config.storeDir, home: this.home });
    if (!drives.rootStoreSameDrive && !force) {
      throw Object.assign(
        new Error("外置根与 pnpm store 不在同一个盘（" + drives.rootDrive + " vs " + drives.storeDrive + "），外置依赖会真实复制一份、占用上升。确认要继续请加 force。"),
        { code: "CROSS_DRIVE", drives }
      );
    }

    const before = analyzeDeps(row.realPath, { hoistedTop: [] });
    if (before.ok === false && !force) {
      throw Object.assign(
        new Error(
          "「" + name + "」存在未声明、只能靠 hoisted 白拿的依赖：" +
            before.risks.map((risk) => risk.name + "（" + risk.file + ":" + risk.line + "）").join("、") +
            "。迁出后会 MODULE_NOT_FOUND；请先把它写进 package.json，或加 force 强制迁出。"
        ),
        { code: "IMPLICIT_DEPS", risks: before.risks }
      );
    }

    const originalSpec = profile.dependencies[name] ?? null;
    const info = bodyInfo(this.profileDir, originalSpec);
    const rowIsLink = isLink(row.dir);
    const samePath = info.bodyExists && path.resolve(info.bodyDir).toLowerCase() === path.resolve(row.dir).toLowerCase();
    const movable = !info.bodyExists
      ? { movable: false, reason: "这条依赖不是 file: 写法（没有独立本体），只搬 node_modules 一侧" }
      : samePath
        ? { movable: false, reason: "本体就是 profile 里的落地目录，随 node_modules 一起搬" }
        : bodyMovable(this.home, info.bodyDir);
    const bodyMode = body === "move" || body === "keep" ? body : this.config.bodyMode === "keep" ? "keep" : "move";
    const bodyPlan = bodyMode === "move" && movable.movable === true;
    /* 迁移源：本体目录（file: 时为准）+ node_modules 侧落地目录（实体时）。
       node_modules 侧若是符号链接，它只是指针，内容全在本体里，且 transferTree 会跳过符号链接，
       所以这种情况必须以本体为源、并且之后把本体搬到外置根（否则外置目录会是空的）。 */
    const sources = [];
    if (bodyPlan) sources.push(info.bodyDir);
    if (!rowIsLink) sources.push(row.dir);
    if (sources.length === 0) sources.push(row.dir);
    const bodyIsSource = bodyPlan && sources[0] === info.bodyDir;

    const targetDir = externalDirFor(targetRoot, name);
    if (exists(targetDir)) throw new Error("外置目录已存在，先处理它：" + targetDir);

    const opId = this.journal.begin({
      op: "out",
      plugin: name,
      mode: "out",
      meta: { from: row.dir, to: targetDir, body: bodyPlan ? info.bodyDir : null, bodyMode }
    }).id;
    const record = this.journal.get(opId);
    this.locks.acquire(name, opId);
    const started = Date.now();
    const backupDir = path.join(this.rollbackRoot, opId);
    const bodyBackupCandidate = path.join(this.rollbackRoot, opId + "-body");
    let bodyBackupDir = null;
    let lockSync = null;
    let consistency = null;
    try {
      /* S2：合并量测（本体 + 落地副本，硬链接只算一次） */
      const merged = await this.journal.step(record, "measure", async () => {
        const roots = sources;
        const measured = unionMeasure(roots);
        this.journal.progress({
          phase: "measure",
          message:
            roots.length + " 处共 " + measured.entries + " 个文件（去重 " + measured.files + "）/ " + humanBytes(measured.bytes) +
            "；清空回收点后可真正释放 " + humanBytes(measured.fullyFreedBytes),
          percent: 4,
          files: measured.entries,
          totalFiles: measured.entries,
          bytes: measured.bytes,
          totalBytes: measured.bytes
        });
        return measured;
      });

      /* S3：搬进外置根 */
      const totalFiles = Math.max(1, merged.entries);
      const stats = transferTree(sources[0], targetDir, {
        mode: this.config.transferMode ?? "auto",
        onProgress: (progress) =>
          this.journal.progress({
            phase: "transfer",
            message: "已搬 " + progress.files + " / " + totalFiles + " 个文件（硬链接 " + progress.linked + "，复制 " + progress.copied + "）",
            percent: 5 + Math.min(47, Math.round((progress.files / totalFiles) * 47)),
            files: progress.files,
            totalFiles,
            bytes: progress.bytes,
            totalBytes: merged.bytes
          })
      });
      const gaps = { copied: 0, bytes: 0, scanned: 0 };
      for (const extra of sources.slice(1)) {
        const part = copyMissing(extra, targetDir);
        gaps.copied += part.copied;
        gaps.bytes += part.bytes;
        gaps.scanned += part.scanned;
      }
      if (gaps.copied > 0) {
        this.journal.progress({ phase: "transfer", message: "本体里有 " + gaps.copied + " 个文件不在 pnpm 落地副本里，已一并补齐（" + humanBytes(gaps.bytes) + "）", percent: 52 });
      }

      /* S4：单向覆盖校验 */
      await this.journal.step(record, "verify", async () => {
        this.journal.progress({ phase: "verify", message: "单向覆盖校验（源里每个文件都要在目标里）", percent: 55 });
        const checks = [];
        for (const src of sources) {
          checks.push(await verifyCovers(src, targetDir, { sampleHashes: src === sources[0] ? this.config.hashSamples ?? 32 : 0 }));
        }
        const first = checks.find((check) => !check.ok) ?? checks[0];
        if (!first.ok) {
          throw new Error(
            "搬移后校验失败：缺少 " + first.missing.length + " 个文件、大小不符 " + first.sizeMismatch.length + " 个、哈希不符 " + first.hashMismatch.length + " 个" +
              (first.missing.length ? "（例如 " + first.missing.slice(0, 3).join("、") + "）" : "")
          );
        }
        const second = checks.length > 1 ? checks[1] : null;
        if (second && !second.ok) throw new Error("本体复制不完整：缺少 " + second.missing.length + " 个文件");
        return { sourceFiles: first.sourceFiles, targetFiles: first.targetFiles, bodyFiles: second ? second.sourceFiles : null, hashed: first.hashed, truncated: first.truncated };
      });

      /* S5：独立依赖 */
      const deps = await this.journal.step(record, "deps", async () => {
        this.journal.progress({ phase: "deps", message: "在外置目录里准备独立依赖", percent: 60 });
        const result = await materializeDeps(targetDir, {
          home: this.home,
          config: this.config,
          root: targetRoot,
          implicit: before.risks,
          onLog: (text) => this.journal.progress({ phase: "deps", message: text.slice(-300) })
        });
        this.journal.progress({
          phase: "deps",
          message: result.skipped ? "跳过独立依赖安装：" + result.reason : "独立依赖安装完成（声明的运行时依赖 " + (result.deps ? result.deps.length : 0) + " 个）",
          percent: 68
        });
        if (result.ok === false) this.journal.warn(record, "deps", "pnpm install 非零退出（" + result.code + "），已保留日志尾部");
        return result;
      });

      await this.journal.step(record, "deps-check", async () => {
        const probe = analyzeDeps(targetDir, { hoistedTop: [] });
        if (probe.ok === false && !force) {
          throw new Error(
            "外置目录里的依赖体检不通过：" + probe.risks.map((risk) => risk.name + "（" + risk.file + ":" + risk.line + "）").join("、")
          );
        }
        return { ok: probe.ok, risks: probe.risks.length, ownModules: probe.ownModules.length };
      });

      /* S6：原子切换 + 改写 + 同步 lock + 本体随迁 */
      let renamed = false;
      let linked = false;
      let specPatched = false;
      let bodyMoved = false;
      try {
        this.journal.progress({ phase: "switch", message: "原子切换：原目录改名进回收点", percent: 72 });
        fs.renameSync(row.dir, backupDir);
        renamed = true;
        createJunction(targetDir, row.dir);
        linked = true;
        const linkSpec = "link:" + toSpecPath(targetDir);
        this.journal.progress({ phase: "switch", message: "改写 profile 依赖为 " + linkSpec, percent: 76 });
        patchProfileSpec(this.profileDir, name, linkSpec);
        specPatched = true;

        if (this.config.syncProfileLockfile !== false) {
          const now = verifyProfileConsistency(this.profileDir, name, { expectSpec: linkSpec });
          if (now.ok) {
            lockSync = { skipped: true, ok: true, reason: "pnpm-lock.yaml 与 package.json 已经一致，无需同步" };
          } else {
            this.journal.progress({ phase: "lockfile", message: "同步 pnpm-lock.yaml 与 node_modules/.modules.yaml（跑一次 pnpm install，可能要一两分钟）：" + now.problems.join("；"), percent: 80 });
            lockSync = await syncProfileLockfile(this.profileDir, {
              home: this.home,
              onLog: (text) => this.journal.progress({ phase: "lockfile", message: text.slice(-300) })
            });
            if (lockSync.ok === false) {
              this.journal.warn(record, "lockfile", "pnpm install 同步失败（code " + lockSync.code + "）：" + String(lockSync.output ?? "").slice(-300));
            }
          }
          consistency = verifyProfileConsistency(this.profileDir, name, { expectSpec: linkSpec });
          if (!consistency.ok) this.journal.warn(record, "consistency", "三处写法仍不一致：" + consistency.problems.join("；"));
        } else {
          consistency = { ok: null, skipped: true, problems: ["已关闭 syncProfileLockfile，pnpm-lock.yaml / .modules.yaml 保持原样"] };
        }

        if (bodyPlan) {
          this.journal.progress({ phase: "switch", message: "把 file: 本体也挪进回收点（" + info.bodyDir + " → " + bodyBackupCandidate + "）", percent: 88 });
          fs.renameSync(info.bodyDir, bodyBackupCandidate);
          bodyBackupDir = bodyBackupCandidate;
          bodyMoved = true;
        }
      } catch (error) {
        if (bodyMoved && bodyBackupDir && exists(bodyBackupDir) && !exists(info.bodyDir)) {
          try {
            fs.renameSync(bodyBackupDir, info.bodyDir);
            bodyBackupDir = null;
            bodyMoved = false;
          } catch {
            /* 本体没退回去，留给人工处理；下面的报错里带着路径 */
          }
        }
        if (specPatched) {
          patchProfileSpec(this.profileDir, name, originalSpec);
          if (lockSync && lockSync.skipped === false) {
            try {
              await syncProfileLockfile(this.profileDir, { home: this.home });
            } catch {
              /* 尽力而为 */
            }
          }
        }
        if (linked) removeLink(row.dir);
        if (renamed) fs.renameSync(backupDir, row.dir);
        throw error;
      }

      /* S7：复验 */
      await this.journal.step(record, "recheck", async () => {
        const real = fs.realpathSync(row.dir);
        if (path.resolve(real).toLowerCase() !== path.resolve(targetDir).toLowerCase()) {
          throw new Error("junction 解析错误：期望 " + targetDir + "，实际 " + real);
        }
        const after = analyzeDeps(row.dir, { hoistedTop: [] });
        if (after.ok !== before.ok && !force) {
          throw new Error("迁出后依赖体检结果变化：迁出前 ok=" + before.ok + "，迁出后 ok=" + after.ok);
        }
        return { real, ok: after.ok, risks: after.risks.length };
      });

      const rollbackRoots = [backupDir, bodyBackupDir].filter((item) => item && exists(item));
      const rollbackStats = unionMeasure(rollbackRoots);
      const summary = {
        opId,
        plugin: name,
        mode: "out",
        root: targetRoot,
        targetDir,
        backupDir,
        bodyDir: info.bodyDir ?? null,
        bodyBackupDir,
        bodyMode,
        bodyMoved,
        bodyReason: movable.reason,
        originalSpec,
        transferred: {
          files: stats.files,
          bytes: stats.bytes,
          human: humanBytes(stats.bytes),
          linked: stats.linked,
          copied: stats.copied,
          bodyGaps: gaps.copied
        },
        deps: {
          skipped: deps.skipped ?? false,
          ok: deps.ok ?? null,
          code: deps.code ?? null,
          declared: deps.deps ?? [],
          peer: deps.peer ?? [],
          basis: deps.basis ?? null
        },
        lockfile: lockSync ? { skipped: lockSync.skipped ?? false, ok: lockSync.ok ?? null, code: lockSync.code ?? null, ms: lockSync.ms ?? null, reason: lockSync.reason ?? null } : null,
        consistency,
        freed: {
          entries: merged.entries,
          bytes: merged.bytes,
          exclusiveBytes: merged.exclusiveBytes,
          sharedBytes: merged.sharedBytes,
          fullyFreedBytes: merged.fullyFreedBytes,
          fullyFreedHuman: humanBytes(merged.fullyFreedBytes),
          stillLinkedBytes: merged.stillLinkedBytes,
          stillLinkedHuman: humanBytes(merged.stillLinkedBytes)
        },
        rollback: {
          dirs: rollbackRoots,
          bytes: rollbackStats.bytes,
          human: humanBytes(rollbackStats.bytes),
          fullyFreedBytes: rollbackStats.fullyFreedBytes,
          fullyFreedHuman: humanBytes(rollbackStats.fullyFreedBytes),
          stillLinkedBytes: rollbackStats.stillLinkedBytes,
          entries: rollbackStats.entries
        },
        drives
      };

      const metaRecord = {
        opId,
        mode: "out",
        plugin: name,
        dir: row.dir,
        root: targetRoot,
        targetDir,
        backupDir,
        bodyDir: info.bodyDir ?? null,
        bodyBackupDir,
        bodyMode,
        originalSpec,
        at: Date.now(),
        ms: Date.now() - started,
        undone: false
      };
      // 凭据同时写两处：随插件走的「迁移凭据」+ 回收点旁的记录（后者丢了还能靠前者恢复）
      writeJsonAtomic(path.join(targetDir, ".relocator.json"), { ...metaRecord, at: Date.now() });
      writeJsonAtomic(this.metaFile(opId), metaRecord);

      if (this.config.autoPurgeRollback === true && rollbackRoots.length) {
        try {
          summary.autoPurged = this.purgeRollback(opId);
        } catch (error) {
          this.journal.warn(record, "autopurge", "自动清理回收点失败：" + String(error?.message ?? error));
        }
      }

      this.journal.end(record, "ok", { result: summary });
      return summary;
    } catch (error) {
      this.journal.end(record, "failed", { error: String(error?.message ?? error) });
      throw error;
    } finally {
      this.locks.release(name);
    }
  }

  async restore(name, { force = false, onProgress = null, spec = null } = {}) {
    const profile = readProfile(this.profileDir);
    const row = pluginRow(this.profileDir, name, {
      spec: profile.dependencies[name],
      isBundle: profile.bundles.includes(name),
      bundles: profile.bundles,
      dependencies: profile.dependencies
    }, { config: this.config });
    if (!row.installed) throw new Error("「" + name + "」当前没有安装在 profile 里");
    if (row.location !== "external") throw new Error("「" + name + "」本来就在 .dsh 内，无需恢复");
    const targetDir = fs.realpathSync(row.dir);
    const meta = readJson(path.join(targetDir, ".relocator.json"), null);
    if (!meta && !force) {
      throw Object.assign(new Error("外置目录里没有 .relocator.json 迁移凭据（不是本插件迁出去的？）。确认要继续请加 force。"), { code: "NO_META" });
    }

    const opId = this.journal.begin({ op: "restore", plugin: name, mode: "restore", meta: { from: targetDir, to: row.dir } }).id;
    const record = this.journal.get(opId);
    this.locks.acquire(name, opId);
    const started = Date.now();
    const staging = row.dir + ".relocator-staging";
    try {
      const total = unionMeasure([targetDir]);
      const stats = transferTree(targetDir, staging, {
        mode: this.config.transferMode ?? "auto",
        onProgress: (progress) =>
          this.journal.progress({
            phase: "transfer",
            message: "已搬回 " + progress.files + " / " + total.entries + " 个文件",
            percent: Math.min(50, Math.round((progress.files / Math.max(1, total.entries)) * 50)),
            files: progress.files,
            totalFiles: total.entries
          })
      });
      const verdict = await verifyTrees(targetDir, staging, { sampleHashes: this.config.hashSamples ?? 32 });
      if (!verdict.ok) {
        throw new Error(
          "搬回后校验失败：" + JSON.stringify({ onlyLeft: verdict.onlyLeft.length, onlyRight: verdict.onlyRight.length, sizeMismatch: verdict.sizeMismatch.length })
        );
      }

      const linkAside = row.dir + ".relocator-link";
      const specBefore = profile.dependencies[name] ?? null;
      let swapped = false;
      try {
        fs.renameSync(row.dir, linkAside);
        fs.renameSync(staging, row.dir);
        swapped = true;
        patchProfileSpec(this.profileDir, name, spec ?? meta?.originalSpec ?? null);
      } catch (error) {
        if (swapped) {
          fs.renameSync(row.dir, staging);
          fs.renameSync(linkAside, row.dir);
          patchProfileSpec(this.profileDir, name, specBefore);
        }
        throw error;
      }
      fs.rmSync(linkAside, { recursive: true, force: true });
      fs.rmSync(path.join(row.dir, ".relocator.json"), { force: true });

      // 本体回迁：原本体被上一轮迁出挪进了回收点，file: 写法要求它回到原位。
      // 同盘用硬链接复制，瞬时且不额外占空间；回收点那份保持不动，方便再次回滚。
      let bodyRestoredTo = null;
      let bodyBytes = 0;
      const wantBody = meta && typeof meta.originalSpec === "string" && meta.originalSpec.startsWith("file:") ? bodyInfo(this.profileDir, meta.originalSpec) : null;
      if (wantBody && wantBody.bodyDir && !exists(wantBody.bodyDir) && meta.bodyBackupDir && exists(meta.bodyBackupDir)) {
        this.journal.progress({ phase: "body", message: "把 file: 本体复制回原位：" + wantBody.bodyDir, percent: 56 });
        const copied = transferTree(meta.bodyBackupDir, wantBody.bodyDir, { mode: this.config.transferMode ?? "auto" });
        bodyBytes = copied.bytes;
        const cover = await verifyCovers(meta.bodyBackupDir, wantBody.bodyDir, { sampleHashes: this.config.hashSamples ?? 32 });
        if (!cover.ok) throw new Error("本体回迁校验失败：缺少 " + cover.missing.length + " 个文件");
        bodyRestoredTo = wantBody.bodyDir;
      }

      let lockSync = null;
      if (this.config.syncProfileLockfile !== false) {
        const wantSpec = spec ?? meta?.originalSpec ?? null;
        const now = verifyProfileConsistency(this.profileDir, name, { expectSpec: wantSpec });
        if (now.ok) lockSync = { skipped: true, ok: true, reason: "已经一致" };
        else {
          this.journal.progress({ phase: "lockfile", message: "同步 pnpm-lock.yaml 与 node_modules/.modules.yaml", percent: 70 });
          lockSync = await syncProfileLockfile(this.profileDir, {
            home: this.home,
            onLog: (text) => this.journal.progress({ phase: "lockfile", message: text.slice(-300) })
          });
          if (lockSync.ok === false) this.journal.warn(record, "lockfile", "pnpm install 同步失败（code " + lockSync.code + "）");
        }
      }

      let backupDir = targetDir;
      try {
        const candidate = targetDir + ".relocator-backup-" + opId;
        fs.renameSync(targetDir, candidate);
        backupDir = candidate;
      } catch (error) {
        this.journal.warn(record, "backup", "外置目录无法挪到备份位（" + String(error?.message ?? error) + "），已原地保留：" + targetDir);
      }

      writeJsonAtomic(this.metaFile(opId), {
        opId,
        mode: "restore",
        plugin: name,
        dir: row.dir,
        targetDir,
        backupDir,
        backupInPlace: backupDir === targetDir,
        originalSpec: meta?.originalSpec ?? null,
        restoreSpec: spec ?? meta?.originalSpec ?? null,
        bodyDir: wantBody?.bodyDir ?? null,
        bodyRestoredTo,
        at: Date.now(),
        ms: Date.now() - started,
        undone: false
      });
      this.journal.end(record, "ok", { result: { opId, plugin: name, targetDir, restored: stats, bodyRestoredTo, bodyBytes, lockfile: lockSync } });
      return { opId, name, mode: "restore", dir: row.dir, targetDir, transferred: stats, bodyRestoredTo, bodyBytes, canRollback: true };
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      this.journal.end(record, "failed", { error: String(error?.message ?? error) });
      throw error;
    } finally {
      this.locks.release(name);
    }
  }

  /** 一键回滚：把上一次迁移/恢复退回原状。 */
  async rollback(opId, { onProgress = null } = {}) {
    const meta = readJson(this.metaFile(opId), null);
    if (!meta) throw new Error("找不到回滚记录：" + opId);
    if (meta.undone) throw new Error("这条记录已经回滚过了");
    const name = meta.plugin;
    this.locks.acquire(name, "rb-" + opId);
    const record = this.journal.begin({ op: "rollback", plugin: name, mode: meta.mode, meta: { of: opId } });
    try {
      if (meta.mode === "out") {
        // 把 .dsh 侧的 junction 去掉，把回收点里的原目录搬回来，本体也回到原位，再删除外置目录
        const st = lstatOrNull(meta.dir);
        if (st?.isSymbolicLink()) removeLink(meta.dir);
        else if (st) throw new Error(" .dsh 侧路径已被占用且不是 junction，无法自动回滚：" + meta.dir);
        fs.renameSync(meta.backupDir, meta.dir);
        if (meta.bodyBackupDir && meta.bodyDir && exists(meta.bodyBackupDir)) {
          if (exists(meta.bodyDir)) throw new Error("本体原位已被占用，无法自动回滚：" + meta.bodyDir);
          fs.renameSync(meta.bodyBackupDir, meta.bodyDir);
        }
        patchProfileSpec(this.profileDir, name, meta.originalSpec ?? null);
        if (exists(meta.targetDir)) fs.rmSync(meta.targetDir, { recursive: true, force: true, maxRetries: 3 });
        if (this.config.syncProfileLockfile !== false) {
          try {
            await syncProfileLockfile(this.profileDir, { home: this.home, onLog: (text) => this.journal.progress({ phase: "lockfile", message: text.slice(-200) }) });
          } catch {
            /* 尽力而为 */
          }
        }
      } else {
        // restore 的回滚：先把备份位复原成外置目录，撤掉本体副本，再把 .dsh 侧重新变回 junction
        if (meta.backupDir && meta.backupDir !== meta.targetDir && exists(meta.backupDir)) {
          if (exists(meta.targetDir)) fs.rmSync(meta.targetDir, { recursive: true, force: true, maxRetries: 3 });
          fs.renameSync(meta.backupDir, meta.targetDir);
        }
        if (meta.bodyRestoredTo && exists(meta.bodyRestoredTo)) {
          fs.rmSync(meta.bodyRestoredTo, { recursive: true, force: true, maxRetries: 3 });
        }
        const aside = meta.dir + ".relocator-undo";
        fs.renameSync(meta.dir, aside);
        createJunction(meta.targetDir, meta.dir);
        patchProfileSpec(this.profileDir, name, "link:" + toSpecPath(meta.targetDir));
        fs.rmSync(aside, { recursive: true, force: true, maxRetries: 3 });
        if (this.config.syncProfileLockfile !== false) {
          try {
            await syncProfileLockfile(this.profileDir, { home: this.home, onLog: (text) => this.journal.progress({ phase: "lockfile", message: text.slice(-200) }) });
          } catch {
            /* 尽力而为 */
          }
        }
      }
      const updated = { ...meta, undone: true, undoneAt: Date.now() };
      writeJsonAtomic(this.metaFile(opId), updated);
      this.journal.end(record, "ok", { result: { opId, undone: true, mode: meta.mode } });
      return { opId, undone: true, mode: meta.mode };
    } catch (error) {
      this.journal.end(record, "failed", { error: String(error?.message ?? error) });
      throw error;
    } finally {
      this.locks.release(name);
    }
  }

  /**
   * 删掉回收点（迁移确认无误后回收空间）。
   * extraPaths 只接受"孤儿本体"（<DSH_HOME>/plugins 下没有被任何 file: 依赖引用的目录），
   * 其它一律拒绝 —— 避免界面上出现任意路径删除。
   */
  /** 给残留引用的孤儿本体找个替代目录：优先 <安装根>/<名字>。 */
  replacementFor(abs) {
    const name = path.basename(abs);
    const root = rootFor(this.config, name);
    if (!root) return null;
    const candidate = externalDirFor(root, name);
    return exists(candidate) ? candidate : null;
  }

  /** 把引用了某个本体的 profile 改指向外置副本，并同步 node_modules 侧的链接。 */
  relinkProfiles(refs, replacement, relinked, blocked, abs) {
    const spec = "link:" + toSpecPath(replacement);
    let failed = false;
    for (const ref of refs) {
      try {
        patchProfileSpec(ref.profileDir, ref.depName, spec);
        const side = path.join(ref.profileDir, "node_modules", ...String(ref.depName).split("/"));
        if (exists(side) && isLink(side)) {
          removeLink(side);
          createJunction(replacement, side);
        }
        relinked.push({ profile: ref.profile, depName: ref.depName, spec, side });
      } catch (error) {
        failed = true;
        blocked.push({ path: abs, refs: [ref], reason: String(error?.message ?? error) });
      }
    }
    return !failed;
  }

  /** 按「孤儿本体」规则收下一批待删目录：拒绝系统路径 / profile 内部路径 / 仍被引用的本体。 */
  collectOrphans(paths, { relinkReferencing = false } = {}) {
    const list = (Array.isArray(paths) ? paths : []).map((item) => String(item));
    const references = bodyReferences(this.home);
    const dirs = [];
    const relinked = [];
    const blocked = [];
    for (const raw of list) {
      const abs = path.resolve(raw);
      if (dirs.some((item) => item.path.toLowerCase() === abs.toLowerCase())) continue;
      const movable = bodyMovable(this.home, abs);
      if (!movable.movable) throw new Error("拒绝删除这个路径（" + movable.reason + "）：" + abs);
      if (isSubPath(this.profileDir, abs)) throw new Error("拒绝删除 profile 内部路径：" + abs);
      const refs = references.get(abs.toLowerCase()) ?? [];
      if (refs.length) {
        const replacement = this.replacementFor(abs);
        if (!relinkReferencing || !replacement) {
          blocked.push({ path: abs, refs, replacement });
          continue;
        }
        if (!this.relinkProfiles(refs, replacement, relinked, blocked, abs)) continue;
      }
      if (exists(abs)) dirs.push({ path: abs, label: "孤儿本体" });
    }
    if (blocked.length) {
      const detail = blocked
        .map((item) => item.path + "（" + item.refs.map((ref) => ref.profile + "/" + ref.depName).join("、") + "）")
        .join("；");
      throw new Error(
        "这些路径仍被 profile 的本地依赖引用，未删除：" + detail +
          "。如确认改用外置副本，请带 relinkReferencing=true 重试（会把这些 profile 的声明改成指向外置副本）。"
      );
    }
    return { dirs, relinked };
  }

  /** 清理孤儿本体目录（不依赖某次回收点记录）。 */
  purgePaths(paths, { relinkReferencing = false } = {}) {
    const { dirs, relinked } = this.collectOrphans(paths, { relinkReferencing });
    if (dirs.length === 0) throw new Error("没有可清理的孤儿本体");
    const union = unionMeasure(dirs.map((item) => item.path));
    for (const item of dirs) fs.rmSync(item.path, { recursive: true, force: true, maxRetries: 3 });
    return {
      deleted: dirs,
      paths: dirs.map((item) => item.path),
      relinked,
      freedBytes: union.fullyFreedBytes,
      freedHuman: humanBytes(union.fullyFreedBytes),
      stillLinkedBytes: union.stillLinkedBytes,
      stillLinkedHuman: humanBytes(union.stillLinkedBytes),
      logicalBytes: union.bytes,
      entries: union.entries
    };
  }

  purgeRollback(opId, { extraPaths = [], relinkReferencing = false } = {}) {
    const meta = readJson(this.metaFile(opId), null);
    if (!meta) throw new Error("找不到记录：" + opId);
    const { dirs, relinked } = this.collectOrphans(extraPaths, { relinkReferencing });
    const collected = [...dirs];
    const push = (dir, label) => {
      if (!dir) return;
      const abs = path.resolve(String(dir));
      if (collected.some((item) => item.path.toLowerCase() === abs.toLowerCase())) return;
      if (!exists(abs)) return;
      collected.push({ path: abs, label });
    };
    push(meta.backupDir, "node_modules 侧回收点");
    push(meta.bodyBackupDir, "本体回收点");
    const union = unionMeasure(collected.map((item) => item.path));
    for (const item of collected) fs.rmSync(item.path, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(this.metaFile(opId), { force: true });
    return {
      opId,
      deleted: collected,
      relinked,
      freedBytes: union.fullyFreedBytes,
      freedHuman: humanBytes(union.fullyFreedBytes),
      stillLinkedBytes: union.stillLinkedBytes,
      stillLinkedHuman: humanBytes(union.stillLinkedBytes),
      logicalBytes: union.bytes,
      entries: union.entries
    };
  }
}
