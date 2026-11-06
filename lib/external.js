/**
 * 外置插件清单与生命周期。
 *
 * 背景（为什么需要这个模块）：
 * 插件迁出到外置根之后，profile 里只剩一行 link: 声明，DSH 自带的插件管理器因此
 * 把它当成"本地开发目录"——既没有更新按钮（官方 updateRefusal 要求依赖写法是 registry spec），
 * 也不能自动发现它的新版本；而一旦在官方界面里卸载，profile 侧的依赖与 junction 都没了，
 * 外置目录就变成谁都看不见的孤儿（官方界面里不会再出现，我们的 migrate/restore 也不认它）。
 *
 * 这个模块补上两件事：
 *   1. 清单：扫安装根，列出**所有**外置插件（含未挂载的），给出挂载状态、来源、体积；
 *   2. 生命周期：重新挂载（attach）、摘除（detach）、检查更新（check）、更新（update）、移除（remove）。
 *
 * 更新一律在"外置工程自己"里做：临时工程把新版下载下来，替换本体后再用外置工程自己的
 * pnpm 装独立依赖。profile 的依赖树（那份 500+ 条的 lockfile）从头到尾不参与，这正是外置的意义。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  exists,
  readJson,
  writeJsonAtomic,
  humanBytes,
  measureTree,
  copyTree,
  toSpecPath,
  realPathOrNull,
  lstatOrNull
} from "./paths.js";
import { readProfile } from "./scan.js";
import {
  runtimePaths,
  patchProfileSpec,
  writeProjectFiles,
  materializeDeps,
  syncProfileLockfile,
  verifyProfileConsistency
} from "./migrate.js";

/** 安装根里不参与扫描的目录（我们自己的工程/回收站，以及 pnpm 的 store）。 */
const SKIP_DIRS = new Set([".store", ".relocator-tmp", ".relocator-trash", "node_modules", ".git", ".svn", ".hg"]);

/** 把插件名变成安全的目录名（用于回收站）。 */
function safeName(name) {
  return String(name ?? "plugin").replace(/[\\/:*?"<>|]/g, "_");
}

/* ------------------------------------------------------------------ *
 * 来源判定
 * ------------------------------------------------------------------ */

/**
 * 把 profile 里记录的依赖写法分类。
 * registry：0.6.7 / ^1.2.0 / latest（官方管理器唯一认的形态，也是外置后失去的那部分）
 * git：github:owner/repo、git+https://…、…git#sha
 * tarball / url：以 http(s) 结尾是 .tgz/.tar.gz 的算压缩包
 * file：file: 或 link: 的本地目录
 */
export function classifySpec(spec) {
  const raw = typeof spec === "string" ? spec.trim() : "";
  if (!raw) return { kind: "unknown", spec: "", label: "未记录来源" };
  if (/^link:/i.test(raw)) return { kind: "file", spec: raw, label: "本地目录（link:）" };
  if (/^file:/i.test(raw)) return { kind: "file", spec: raw, label: "本地目录（file:）" };
  if (/^(github|gitlab|bitbucket|gist):/i.test(raw)) return { kind: "git", spec: raw, label: "Git 仓库" };
  if (/^git\+/i.test(raw) || /\.git(#|$)/i.test(raw)) return { kind: "git", spec: raw, label: "Git 仓库" };
  if (/^https?:\/\//i.test(raw)) {
    if (/\.(tgz|tar\.gz|tar)(\?|$)/i.test(raw)) return { kind: "tarball", spec: raw, label: "压缩包地址" };
    return { kind: "url", spec: raw, label: "网址" };
  }
  if (/^(workspace|catalog|portal|patch|npm):/i.test(raw)) return { kind: "unknown", spec: raw, label: "其它协议" };
  return { kind: "registry", spec: raw, label: "npm registry" };
}

/** 把 file:/link: 写法解析成绝对路径（相对路径按 profile 目录解析）。 */
export function specDir(spec, profileDir) {
  const raw = String(spec ?? "").trim();
  const matched = /^(?:link|file):(.*)$/is.exec(raw);
  if (!matched) return null;
  let rest = matched[1].trim();
  if (rest.startsWith("~")) rest = path.join(os.homedir(), rest.slice(1));
  const abs = path.isAbsolute(rest) ? rest : path.join(profileDir, rest);
  return path.resolve(abs);
}

/** 把 git 简写还原成可 ls-remote 的 URL（去掉 #sha 片段）。 */
export function gitUrlOf(spec) {
  const raw = String(spec ?? "").trim();
  const short = /^(github|gitlab|bitbucket|gist):(.+)$/i.exec(raw);
  if (short) {
    const host = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org", gist: "gist.github.com" }[short[1].toLowerCase()];
    return "https://" + host + "/" + short[2].replace(/#.*$/, "");
  }
  return raw.replace(/^git\+/, "").replace(/#.*$/, "");
}

/* ------------------------------------------------------------------ *
 * 极简 semver（不引依赖：只需要比较与 range 过滤）
 * ------------------------------------------------------------------ */

export function parseVersion(value) {
  // 允许 3、3.2、3.2.1 三种写法（registry 的 range 里常见 >=3、~3.2）
  const matched = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$/.exec(String(value ?? "").trim());
  if (!matched) return null;
  return { major: Number(matched[1]), minor: Number(matched[2] ?? 0), patch: Number(matched[3] ?? 0), pre: matched[4] ?? "", parts: matched[3] === undefined ? (matched[2] === undefined ? 1 : 2) : 3 };
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

const fmt = (v) => v.major + "." + v.minor + "." + v.patch;

export function satisfiesRange(version, range) {
  const raw = String(range ?? "").trim();
  if (!parseVersion(version)) return false;
  if (!raw || raw === "*" || raw === "latest" || raw === "x") return true;
  if (raw.includes("||")) return raw.split("||").some((part) => satisfiesRange(version, part.trim()));
  // 空格是 AND（>=2.0.0 <3 这种写法要先拆开，不能整体当成一个 operator 去解析）
  if (/\s/.test(raw)) {
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length > 1) return parts.every((part) => satisfiesRange(version, part));
  }
  if (raw.startsWith("^")) {
    const base = parseVersion(raw.slice(1));
    if (!base) return false;
    const upper = base.major > 0 ? { major: base.major + 1, minor: 0, patch: 0 } : { major: 0, minor: base.minor + 1, patch: 0 };
    return compareVersions(version, raw.slice(1)) >= 0 && compareVersions(version, fmt(upper)) < 0;
  }
  if (raw.startsWith("~")) {
    const base = parseVersion(raw.slice(1));
    if (!base) return false;
    const upper = { major: base.major, minor: base.minor + 1, patch: 0 };
    return compareVersions(version, raw.slice(1)) >= 0 && compareVersions(version, fmt(upper)) < 0;
  }
  if (raw.startsWith(">=")) return compareVersions(version, raw.slice(2).trim()) >= 0;
  if (raw.startsWith("<=")) return compareVersions(version, raw.slice(2).trim()) <= 0;
  if (raw.startsWith(">")) return compareVersions(version, raw.slice(1).trim()) > 0;
  if (raw.startsWith("<")) return compareVersions(version, raw.slice(1).trim()) < 0;
  // 精确写法：3 段比较相等；1~2 段按 npm 的兼容语义（1 -> <2，1.2 -> <1.3）
  const base = parseVersion(raw);
  if (!base) return false;
  if (base.parts >= 3) return compareVersions(version, raw) === 0;
  const upper = base.parts === 1 ? { major: base.major + 1, minor: 0, patch: 0 } : { major: base.major, minor: base.minor + 1, patch: 0 };
  return compareVersions(version, fmt({ major: base.major, minor: base.minor, patch: base.patch })) >= 0 && compareVersions(version, fmt(upper)) < 0;
}

export function bestVersion(versions, range) {
  const ok = (Array.isArray(versions) ? versions : []).filter((v) => satisfiesRange(v, range));
  if (!ok.length) return null;
  return ok.sort(compareVersions)[ok.length - 1];
}

/* ------------------------------------------------------------------ *
 * 契约与目录扫描
 * ------------------------------------------------------------------ */

/** 目录是否是 DSH 插件：dsh.bundle.patch / dsh.client / exports["./client"] 任一即可。 */
export function contractOf(dir, manifest = null) {
  const pkg = manifest ?? readJson(path.join(dir, "package.json"), null);
  if (!pkg) return { ok: false, bundle: false, client: false, patch: null, reason: "读不到 package.json" };
  const patch = typeof pkg?.dsh?.bundle?.patch === "string" ? pkg.dsh.bundle.patch : null;
  const bundle = Boolean(pkg?.dsh?.bundle);
  const client = Boolean(pkg?.dsh?.client) || Boolean(pkg?.exports?.["./client"]);
  return {
    ok: bundle || client,
    bundle,
    client,
    patch,
    entry: pkg?.main ?? null,
    reason: bundle || client ? null : "package.json 里没有 dsh.bundle / dsh.client / exports[\"./client\"]"
  };
}

/** 安装根下的一级（或 @scope 二级）插件目录，返回相对 root 的路径数组。 */
export function pluginDirsIn(root) {
  const out = [];
  if (!exists(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const abs = path.join(root, entry.name);
    if (entry.name.startsWith("@")) {
      for (const inner of fs.readdirSync(abs, { withFileTypes: true })) {
        if (!inner.isDirectory() || SKIP_DIRS.has(inner.name)) continue;
        if (exists(path.join(abs, inner.name, "package.json"))) out.push(entry.name + "/" + inner.name);
      }
      continue;
    }
    if (exists(path.join(abs, "package.json"))) out.push(entry.name);
  }
  return out;
}

/** 所有安装根（全局 root + 逐插件覆盖），去重且保留顺序。 */
export function rootsOf(config) {
  const out = [];
  const push = (value) => {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return;
    const abs = path.resolve(raw);
    if (out.some((item) => item.toLowerCase() === abs.toLowerCase())) return;
    out.push(abs);
  };
  push(config?.root);
  for (const value of Object.values(config?.roots ?? {})) push(value);
  return out;
}

/**
 * 扫描安装根，给出每个外置插件的完整画像。
 * 挂载状态：mounted（profile 里的 link: 正指向它）/ unmounted（profile 里没有）/
 * mounted-elsewhere（profile 里有同名依赖但指向别处）/ broken（不满足插件契约）。
 */
export function scanExternal({ home, profileDir, config, sizeCache = null, measure = false } = {}) {
  const profile = readProfile(profileDir);
  const dependencies = profile.dependencies ?? {};
  const bundles = profile.bundles ?? [];
  const roots = rootsOf(config);
  const items = [];
  for (const root of roots) {
    if (!exists(root)) continue;
    for (const rel of pluginDirsIn(root)) {
      const dir = path.join(root, ...rel.split("/"));
      const manifestPath = path.join(dir, "package.json");
      const pkg = readJson(manifestPath, null);
      const name = pkg?.name ?? rel;
      const contract = contractOf(dir, pkg);
      const meta = readJson(path.join(dir, ".relocator.json"), null);
      const spec = dependencies[name] ?? null;
      const linked = spec ? specDir(spec, profileDir) : null;
      const sameTarget = Boolean(linked) && path.resolve(linked).toLowerCase() === path.resolve(dir).toLowerCase();
      const nmDir = path.join(profileDir, "node_modules", ...String(name).split("/"));
      const nmStat = lstatOrNull(nmDir);
      const nmReal = nmStat ? realPathOrNull(nmDir) : null;
      const nmKind = !nmStat ? "missing" : nmStat.isSymbolicLink() ? "junction" : "directory";
      let state = "unmounted";
      if (!contract.ok) state = "broken";
      else if (spec && sameTarget) state = "mounted";
      else if (spec) state = "mounted-elsewhere";
      const originalSpec = meta?.originalSpec ?? meta?.lastSpec ?? null;
      const source = classifySpec(originalSpec);
      let updatedAt = null;
      try {
        updatedAt = fs.statSync(manifestPath).mtimeMs;
      } catch {
        updatedAt = null;
      }
      const item = {
        name,
        version: pkg?.version ?? null,
        description: pkg?.description ?? null,
        dir,
        root,
        rel,
        contract,
        meta,
        originalSpec,
        lastSpec: meta?.lastSpec ?? null,
        source,
        mount: {
          state,
          spec,
          specDir: linked,
          sameTarget,
          inBundles: bundles.includes(name),
          nodeModules: nmKind,
          nodeModulesReal: nmReal,
          nodeModulesMatch: Boolean(nmReal) && path.resolve(nmReal).toLowerCase() === path.resolve(dir).toLowerCase()
        },
        declared: Object.keys(pkg?.dependencies ?? {}),
        peers: Object.keys(pkg?.peerDependencies ?? {}),
        updatedAt,
        size: sizeCache?.get(dir) ?? null
      };
      items.push(item);
    }
  }
  if (measure) {
    for (const item of items) {
      try {
        item.size = measureExternal(item.dir, sizeCache);
      } catch {
        /* 单个目录测不动不影响清单 */
      }
    }
  }
  const counts = {
    total: items.length,
    mounted: items.filter((item) => item.mount.state === "mounted").length,
    unmounted: items.filter((item) => item.mount.state === "unmounted").length,
    mountedElsewhere: items.filter((item) => item.mount.state === "mounted-elsewhere").length,
    broken: items.filter((item) => item.mount.state === "broken").length,
    measured: items.filter((item) => item.size).length
  };
  return { roots, profileDir, items, counts };
}

/** 测一个外置目录的体积（复用 scan.js 的口径，写进同一个缓存）。 */
export function measureExternal(dir, sizeCache = null) {
  const measured = measureTree(dir);
  const value = {
    at: Date.now(),
    files: measured.files,
    dirs: measured.dirs,
    bytes: measured.bytes,
    logicalBytes: measured.logicalBytes,
    exclusiveBytes: measured.exclusiveBytes,
    sharedBytes: measured.sharedBytes,
    sharedFiles: measured.sharedFiles,
    links: measured.links,
    truncated: measured.truncated,
    human: humanBytes(measured.bytes),
    exclusiveHuman: humanBytes(measured.exclusiveBytes),
    sharedHuman: humanBytes(measured.sharedBytes),
    logicalHuman: humanBytes(measured.logicalBytes)
  };
  sizeCache?.set(dir, value);
  return value;
}

/* ------------------------------------------------------------------ *
 * 命令执行
 * ------------------------------------------------------------------ */

function runCommand(command, args, { cwd = null, onLog = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: cwd ?? undefined,
        env: { ...process.env, npm_config_yes: "true", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
        windowsHide: true
      });
    } catch (error) {
      resolve({ ok: false, code: null, output: String(error?.message ?? error) });
      return;
    }
    let tail = "";
    const collect = (chunk) => {
      const text = String(chunk);
      tail = (tail + text).slice(-4000);
      onLog?.(text);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => resolve({ ok: false, code: null, output: String(error?.message ?? error) }));
    child.on("close", (code) => resolve({ ok: code === 0, code, output: tail }));
  });
}

function runPnpm(home, cwd, args, onLog = null) {
  const { node, pnpm } = runtimePaths(home);
  if (!pnpm) return Promise.resolve({ ok: false, code: null, output: "找不到内置 pnpm（" + pnpm + "）" });
  return runCommand(node, [pnpm, ...args], { cwd, onLog });
}

async function gitHead(url) {
  const result = await runCommand("git", ["ls-remote", url, "HEAD"]);
  const line = String(result.output ?? "").split("\n").map((item) => item.trim()).find((item) => item.length > 0) ?? "";
  const sha = (/^([0-9a-f]{40})/.exec(line) ?? [])[1] ?? null;
  return { sha, ref: line.split(/\s+/)[1] ?? null, ok: Boolean(sha), output: result.output, error: sha ? null : String(result.output ?? "").slice(-300) };
}

/** profile 的 dsh.profile.bundles 增删（对齐 DSH 的 selectBundle 语义）。 */
export function setBundle(profileDir, name, enabled) {
  const file = path.join(profileDir, "package.json");
  const pkg = readJson(file, null);
  if (!pkg) throw new Error("读不到 profile package.json：" + file);
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? [...pkg.dsh.profile.bundles] : [];
  const has = bundles.includes(name);
  if (enabled === has) return { changed: false, bundles };
  if (enabled) bundles.push(name);
  else bundles.splice(bundles.indexOf(name), 1);
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  pkg.dsh.profile.bundles = bundles;
  writeJsonAtomic(file, pkg);
  return { changed: true, bundles };
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

export class Externals {
  constructor({ home, profileDir, config, journal, locks = null, sizeCache = null }) {
    this.home = home;
    this.profileDir = profileDir;
    this.config = config;
    this.journal = journal;
    this.locks = locks;
    this.sizeCache = sizeCache;
    this.baseDir = path.join(home, "plugin-relocator");
    this.backupRoot = path.join(this.baseDir, "backups");
  }

  scan({ measure = false } = {}) {
    return scanExternal({ home: this.home, profileDir: this.profileDir, config: this.config, sizeCache: this.sizeCache, measure });
  }

  find(name) {
    return this.scan().items.find((item) => item.name === name) ?? null;
  }

  /** 回收站清单（移除动作把目录移到这里，删它才真正释放空间）。 */
  trashList() {
    const out = [];
    for (const root of this.scan().roots) {
      const trashRoot = path.join(root, ".relocator-trash");
      if (!exists(trashRoot)) continue;
      for (const entry of fs.readdirSync(trashRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(trashRoot, entry.name);
        let bytes = 0;
        try {
          bytes = measureTree(dir).bytes;
        } catch {
          bytes = 0;
        }
        out.push({ name: entry.name, dir, root, bytes, human: humanBytes(bytes) });
      }
    }
    return out;
  }

  purgeTrash(names = null) {
    const wanted = Array.isArray(names) && names.length ? new Set(names) : null;
    const deleted = [];
    let freedBytes = 0;
    for (const item of this.trashList()) {
      if (wanted && !wanted.has(item.name) && !wanted.has(item.dir)) continue;
      try {
        fs.rmSync(item.dir, { recursive: true, force: true });
        deleted.push(item);
        freedBytes += item.bytes;
      } catch {
        /* 删不动就留着，报告里仍能看到 */
      }
    }
    return { deleted, freedBytes, freedHuman: humanBytes(freedBytes) };
  }

  #backup(opId) {
    const dir = path.join(this.backupRoot, opId);
    fs.mkdirSync(dir, { recursive: true });
    const saved = [];
    for (const file of ["package.json", "pnpm-lock.yaml"]) {
      const from = path.join(this.profileDir, file);
      if (!exists(from)) continue;
      fs.copyFileSync(from, path.join(dir, file));
      saved.push(file);
    }
    return { dir, saved };
  }

  #restoreProfile(backup) {
    for (const file of backup.saved ?? []) {
      const from = path.join(backup.dir, file);
      if (!exists(from)) continue;
      fs.copyFileSync(from, path.join(this.profileDir, file));
    }
  }

  /** node_modules/<name> 是否真的落在这个外置目录上。 */
  #linkCheck(name, target) {
    const dir = path.join(this.profileDir, "node_modules", ...String(name).split("/"));
    const stat = lstatOrNull(dir);
    if (!stat) return { ok: false, reason: "node_modules 里没有 " + name + "（pnpm install 没有建链接）" };
    const real = realPathOrNull(dir);
    if (!real) return { ok: false, reason: "node_modules/" + name + " 无法解析真实路径" };
    if (path.resolve(real).toLowerCase() !== path.resolve(target).toLowerCase()) {
      return { ok: false, reason: "node_modules/" + name + " 指向 " + real + "，不是 " + target };
    }
    return { ok: true, link: stat.isSymbolicLink() ? "junction" : "目录", real };
  }

  /**
   * 把外置目录重新挂回 profile：写 link: 声明 → 补进 bundles → pnpm install 同步 lock → 校验。
   * 失败会把 profile 的 package.json / pnpm-lock.yaml 还原并重新同步。
   */
  async attach(name, { force = false, onLog = null } = {}) {
    const item = this.find(name);
    if (!item) throw new Error("安装根里没有找到外置插件：" + name);
    if (!item.contract.ok) throw new Error("目录不满足 DSH 插件契约：" + item.dir + "（" + item.contract.reason + "）");
    const target = path.resolve(item.dir);
    const spec = "link:" + toSpecPath(target);
    const profile = readProfile(this.profileDir);
    const current = profile.dependencies[name] ?? null;
    if (current && item.mount.state === "mounted") {
      return { ok: true, already: true, name, dir: target, spec, inBundles: item.mount.inBundles, nodeModules: item.mount.nodeModules };
    }
    if (current && !force) {
      throw new Error("profile 里已有同名依赖「" + current + "」，它不是指向这个外置目录；确认改写请带 force");
    }
    const record = this.journal.begin({ op: "attach", plugin: name, mode: "attach", meta: { dir: target, previousSpec: current } });
    const backup = this.#backup(record.id);
    try {
      await this.journal.step(record, "写声明", async () => patchProfileSpec(this.profileDir, name, spec), { message: "profile 依赖改写为 " + spec });
      const bundle = await this.journal.step(record, "加入 bundles", async () => setBundle(this.profileDir, name, true), { message: "让 DSH 启动时加载它" });
      const sync = await this.journal.step(record, "同步 lock", () => syncProfileLockfile(this.profileDir, { home: this.home, onLog }), { message: "profile 里跑 pnpm install" });
      const check = await this.journal.step(record, "校验", async () => {
        const consistency = verifyProfileConsistency(this.profileDir, name, { expectSpec: spec });
        const link = this.#linkCheck(name, target);
        const problems = [...consistency.problems];
        if (!link.ok) problems.push(link.reason);
        if (sync && sync.ok === false) problems.push("pnpm install 退出码 " + sync.code + "：" + String(sync.output ?? "").slice(-300));
        return { consistency, link, problems };
      });
      if (check.problems.length) throw new Error("挂载校验未通过：" + check.problems.join("；"));
      const result = {
        name,
        dir: target,
        spec,
        bundleAdded: bundle?.changed === true,
        bundles: bundle?.bundles ?? null,
        nodeModules: check.link.link,
        sync: { ok: sync?.ok ?? null, ms: sync?.ms ?? null },
        backup: backup.dir
      };
      this.journal.end(record, "ok", { result });
      return { ok: true, ...result };
    } catch (error) {
      this.#restoreProfile(backup);
      try {
        await syncProfileLockfile(this.profileDir, { home: this.home });
      } catch {
        /* 还原阶段不再抛错 */
      }
      this.journal.end(record, "failed", { error: String(error?.message ?? error), rollback: { backup: backup.dir } });
      throw error;
    }
  }

  /** 从 profile 摘掉（等价官方卸载），但保留外置目录本体。 */
  async detach(name, { onLog = null } = {}) {
    const profile = readProfile(this.profileDir);
    const spec = profile.dependencies[name] ?? null;
    if (!spec) throw new Error(name + " 没有挂载在 profile 里");
    const record = this.journal.begin({ op: "detach", plugin: name, mode: "detach", meta: { spec } });
    const backup = this.#backup(record.id);
    try {
      const bundle = await this.journal.step(record, "移出 bundles", async () => setBundle(this.profileDir, name, false), { message: "让它不再被加载" });
      const removal = await this.journal.step(record, "pnpm remove", () => runPnpm(this.home, this.profileDir, ["remove", name, "--reporter=append-only"], onLog), { message: "profile 里移除依赖与链接" });
      if (!removal.ok) throw new Error("pnpm remove 失败（退出码 " + removal.code + "）：" + String(removal.output).slice(-300));
      const after = readProfile(this.profileDir);
      if (after.dependencies[name]) throw new Error("pnpm remove 之后 profile 里仍有 " + name);
      const dir = path.join(this.profileDir, "node_modules", ...String(name).split("/"));
      const result = {
        name,
        spec,
        bundleRemoved: bundle?.changed === true,
        nodeModulesLeft: exists(dir),
        backup: backup.dir
      };
      this.journal.end(record, "ok", { result });
      return { ok: true, ...result };
    } catch (error) {
      this.#restoreProfile(backup);
      try {
        await syncProfileLockfile(this.profileDir, { home: this.home });
      } catch {
        /* 还原阶段不再抛错 */
      }
      this.journal.end(record, "failed", { error: String(error?.message ?? error), rollback: { backup: backup.dir } });
      throw error;
    }
  }

  /**
   * 检查更新（只读）。
   * registry → 查 registry 的 dist-tags.latest 与满足原 range 的最高版本；
   * git → git ls-remote 拿远端 HEAD；
   * 其它来源如实说明"不支持自动检查"。
   */
  async check(name, { registry = null, spec = null } = {}) {
    const item = this.find(name);
    if (!item) throw new Error("安装根里没有找到外置插件：" + name);
    const sourceSpec = spec ?? item.originalSpec ?? null;
    const source = classifySpec(sourceSpec);
    const current = item.version ?? null;
    const base = { name, dir: item.dir, current, sourceSpec, kind: source.kind, label: source.label };
    if (source.kind === "registry") {
      const reg = String(registry || this.config.registry || "https://registry.npmmirror.com/").replace(/\/+$/, "");
      const url = reg + "/" + name.split("/").map((part) => encodeURIComponent(part)).join("/");
      let data = null;
      let error = null;
      try {
        const response = await fetch(url, { headers: { accept: "application/json" } });
        if (!response.ok) error = "HTTP " + response.status;
        else data = await response.json();
      } catch (caught) {
        error = String(caught?.message ?? caught);
      }
      if (!data) return { ...base, ok: false, registry: reg, error: "registry 查询失败：" + error };
      const versions = Object.keys(data.versions ?? {});
      const latest = data["dist-tags"]?.latest ?? bestVersion(versions, "*");
      const inRange = bestVersion(versions, sourceSpec);
      return {
        ...base,
        ok: true,
        registry: reg,
        latest,
        inRange,
        hasUpdate: Boolean(latest && compareVersions(latest, current) > 0),
        withinRange: latest ? satisfiesRange(latest, sourceSpec) : null,
        total: versions.length,
        recent: versions.sort(compareVersions).slice(-12)
      };
    }
    if (source.kind === "git") {
      const url = gitUrlOf(sourceSpec);
      const head = await gitHead(url);
      const pinned = (/[#]([0-9a-f]{7,40})$/i.exec(String(sourceSpec ?? "")) ?? [])[1] ?? null;
      const changed = Boolean(head.sha) && (!pinned || !(head.sha.startsWith(pinned) || pinned.startsWith(head.sha)));
      return {
        ...base,
        ok: Boolean(head.sha),
        url,
        pinned,
        remoteHead: head.sha,
        remoteRef: head.ref,
        hasUpdate: changed,
        error: head.error
      };
    }
    return {
      ...base,
      ok: true,
      supported: false,
      reason:
        source.kind === "file"
          ? "来源是本地目录：更新等于从原目录重新复制一份，请先在源目录更新再点更新"
          : source.kind === "tarball" || source.kind === "url"
            ? "来源是压缩包/网址：更新会重新下载同一个地址"
            : "没有记录来源（.relocator.json 缺 originalSpec）：更新时需要手动填写安装 spec"
    };
  }

  /**
   * 更新：临时工程下载新版 → 旧本体移入回收站 → 新本体就位 → 按新 package.json 装独立依赖 → 校验。
   * 任何一步失败都会把旧本体从回收站搬回来。
   */
  async update(name, { to = null, spec = null, force = false, onLog = null } = {}) {
    const item = this.find(name);
    if (!item) throw new Error("安装根里没有找到外置插件：" + name);
    const sourceSpec = spec ?? item.originalSpec ?? null;
    const source = classifySpec(sourceSpec);
    let targetSpec = null;
    if (spec) targetSpec = spec;
    else if (to && source.kind === "registry") targetSpec = name + "@" + to;
    else if (source.kind === "registry") targetSpec = name + "@latest";
    else if (source.kind === "git") targetSpec = gitUrlOf(sourceSpec);
    else if (source.kind === "tarball" || source.kind === "url") targetSpec = sourceSpec;
    else if (source.kind === "file") targetSpec = specDir(sourceSpec, this.profileDir);
    if (!targetSpec) {
      throw new Error("没有可用于更新的来源（.relocator.json 缺 originalSpec）；请在请求里给 spec，例如 " + name + "@1.2.3 或 github:owner/repo");
    }
    const root = item.root;
    const record = this.journal.begin({
      op: "update",
      plugin: name,
      mode: "update",
      meta: { dir: item.dir, from: item.version, sourceSpec, targetSpec }
    });
    const work = path.join(root, ".relocator-tmp", record.id);
    const trashRoot = path.join(root, ".relocator-trash");
    const trash = path.join(trashRoot, safeName(name) + "-" + Date.now().toString(36));
    try {
      await this.journal.step(record, "准备工程", async () => {
        fs.mkdirSync(work, { recursive: true });
        fs.writeFileSync(
          path.join(work, "package.json"),
          JSON.stringify({ name: "relocator-update-probe", version: "0.0.0", private: true }, null, 2) + "\n",
          "utf8"
        );
        writeProjectFiles(work, { config: this.config, name, root });
        return { work };
      }, { message: "建一个只用于下载新版的临时工程" });
      const install = await this.journal.step(record, "下载新版", () => runPnpm(this.home, work, ["add", targetSpec, "--reporter=append-only"], onLog), { message: "pnpm add " + targetSpec });
      if (!install.ok) throw new Error("下载新版失败（退出码 " + install.code + "）：" + String(install.output).slice(-400));
      const staged = path.join(work, "node_modules", ...String(name).split("/"));
      if (!exists(staged)) throw new Error("pnpm add 之后没有找到 " + staged + "（安装 spec 与插件名不匹配？）");
      const stagedPkg = readJson(path.join(staged, "package.json"), null);
      const newVersion = stagedPkg?.version ?? null;
      const contract = contractOf(staged, stagedPkg);
      if (!contract.ok) throw new Error("下载到的新版不满足 DSH 插件契约：" + contract.reason);
      const from = item.version ?? null;
      if (newVersion && from && compareVersions(newVersion, from) <= 0 && !force) {
        throw new Error("下载到的新版是 " + newVersion + "，不比当前的 " + from + " 新；确认覆盖请带 force");
      }
      await this.journal.step(record, "备份旧本体", async () => {
        fs.mkdirSync(trashRoot, { recursive: true });
        fs.renameSync(item.dir, trash);
        return { trash };
      }, { message: "旧本体移入 " + trash });
      await this.journal.step(record, "替换本体", async () => {
        copyTree(staged, item.dir, { skipErrors: false });
        const meta = item.meta
          ? { ...item.meta, lastSpec: sourceSpec, updateOpId: record.id, updateFrom: from, updateTo: newVersion, updatedAt: Date.now() }
          : { opId: record.id, mode: "update", plugin: name, dir: item.dir, root, targetDir: item.dir, originalSpec: sourceSpec, updateTo: newVersion, updatedAt: Date.now() };
        writeJsonAtomic(path.join(item.dir, ".relocator.json"), meta);
        return { version: newVersion };
      }, { message: "写入 " + (newVersion ?? "新版本") });
      const deps = await this.journal.step(record, "独立依赖", () => materializeDeps(item.dir, { home: this.home, config: this.config, root, onLog }), { message: "按新 package.json 装独立依赖" });
      const verify = await this.journal.step(record, "校验", async () => {
        const pkg = readJson(path.join(item.dir, "package.json"), null);
        const found = contractOf(item.dir, pkg);
        const problems = [];
        if (!pkg) problems.push("替换后读不到 package.json");
        if (!found.ok) problems.push("替换后不再满足 DSH 插件契约：" + found.reason);
        return { version: pkg?.version ?? null, contract: found, problems };
      });
      if (verify.problems.length) throw new Error("更新校验未通过：" + verify.problems.join("；"));
      fs.rmSync(work, { recursive: true, force: true });
      const result = {
        name,
        dir: item.dir,
        from,
        to: verify.version,
        sourceSpec,
        targetSpec,
        trash,
        bundle: item.contract.bundle,
        deps: { skipped: deps?.skipped === true, ok: deps?.ok ?? null, reason: deps?.reason ?? null }
      };
      this.journal.end(record, "ok", { result });
      return { ok: true, ...result };
    } catch (error) {
      try {
        if (exists(trash)) {
          fs.rmSync(item.dir, { recursive: true, force: true });
          fs.renameSync(trash, item.dir);
        }
        fs.rmSync(work, { recursive: true, force: true });
      } catch (caught) {
        this.journal.warn(record, "更新回滚", String(caught?.message ?? caught));
      }
      this.journal.end(record, "failed", { error: String(error?.message ?? error), rollback: { trash } });
      throw error;
    }
  }

  /**
   * 移除外置插件：已挂载的先摘除，然后把目录移入 <root>/.relocator-trash。
   * 不做不可逆删除 —— 清空回收站是另一个显式动作（purgeTrash）。
   */
  async remove(name, { detachFirst = true, onLog = null } = {}) {
    const item = this.find(name);
    if (!item) throw new Error("安装根里没有找到外置插件：" + name);
    const record = this.journal.begin({ op: "remove", plugin: name, mode: "remove", meta: { dir: item.dir, root: item.root, mounted: item.mount.state } });
    try {
      let detached = null;
      if (detachFirst && (item.mount.state === "mounted" || item.mount.state === "mounted-elsewhere")) {
        detached = await this.detach(name, { onLog });
      }
      const trashRoot = path.join(item.root, ".relocator-trash");
      fs.mkdirSync(trashRoot, { recursive: true });
      const trash = path.join(trashRoot, safeName(name) + "-" + Date.now().toString(36));
      const measured = await this.journal.step(record, "移入回收站", async () => {
        const bytes = measureTree(item.dir).bytes;
        fs.renameSync(item.dir, trash);
        return { trash, bytes, human: humanBytes(bytes) };
      }, { message: "从安装根移出（同盘 rename，瞬时）" });
      const result = {
        name,
        dir: item.dir,
        trash,
        bytes: measured?.bytes ?? 0,
        human: measured?.human ?? "0 B",
        detached: Boolean(detached)
      };
      this.journal.end(record, "ok", { result });
      return { ok: true, ...result };
    } catch (error) {
      this.journal.end(record, "failed", { error: String(error?.message ?? error) });
      throw error;
    }
  }
}
