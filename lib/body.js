/**
 * 「本体」与硬链接图谱。
 *
 * 背景：有些插件在 profile 里是以 file: 声明的（例如 "dsh-x": "file:../../plugins/dsh-x"）。
 * pnpm 会把那个目录「拷进」node_modules（同盘时用硬链接，因此两边是同一份 inode）。
 * 于是 .dsh 里出现两处同内容的大目录：
 *   <DSH_HOME>\plugins\<name>                         ← 本体（file: 的源）
 *   <DSH_HOME>\profiles\desktop\node_modules\<name>   ← pnpm 的落地副本
 * 只把后者搬走时前者会变成 2 GB 级孤儿；本模块负责把这件事看清楚、量准确、搬干净。
 *
 * 口径约定（与 paths.js 的 measureTree 一致）：
 *   entries       逐条目录项的个数（等于文件系统里看得见的文件数）
 *   files         唯一 inode 数（硬链接只算一次）
 *   bytes         唯一 inode 的体积合计（"真实多占了一块盘"）
 *   exclusiveBytes   nlink == 1：这份数据只被当前集合引用，删掉即释放
 *   sharedBytes      nlink > 1：被其它路径也引用着
 *   fullyFreedBytes  引用它的链接全都在本集合内 ⇒ 删除本集合才真正释放
 *   stillLinkedBytes sharedBytes 里删除本集合也释放不掉的部分（外置真身还链着）
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { exists, humanBytes, isSubPath, measureTree } from "./paths.js";

const SKIP_DIRS = new Set([".git", ".svn", ".hg"]);
const DEFAULT_MAX_FILES = 400000;

/** 把 file: 写法解析成绝对路径（相对路径按 profile 目录解析，与 pnpm 一致）。 */
export function bodySpecPath(profileDir, spec) {
  if (typeof spec !== "string" || !spec.startsWith("file:")) return null;
  const raw = spec.slice("file:".length).trim();
  if (!raw) return null;
  return path.resolve(profileDir, raw);
}

/** 把 link: 写法解析成绝对路径。 */
export function linkSpecPath(spec) {
  if (typeof spec !== "string" || !spec.startsWith("link:")) return null;
  const raw = spec.slice("link:".length).trim();
  return raw ? path.resolve(raw) : null;
}

/** 一条依赖写法对应的本体信息（只做 stat，不遍历，可安全放进每次列表请求）。 */
export function bodyInfo(profileDir, spec) {
  const bodyDir = bodySpecPath(profileDir, spec);
  if (!bodyDir) return { bodySpec: null, bodySpecRaw: null, bodyDir: null, bodyExists: false, bodyOnSameDriveAsHome: null };
  // bodySpec 给的是绝对路径（界面直接显示、可用资源管理器打开），bodySpecRaw 保留原始写法。
  return { bodySpec: bodyDir, bodySpecRaw: spec, bodyDir, bodyExists: exists(bodyDir), bodyOnSameDriveAsHome: null };
}

const norm = (value) => path.resolve(String(value)).toLowerCase();

/**
 * 跨多个根做一次并集量测：硬链接在全集合范围内只算一次。
 * 返回的对象里既有"集合整体"的数字，也有逐根的数字，还有"删掉这个集合能释放多少"。
 */
export function unionMeasure(roots, options = {}) {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const list = (roots ?? []).filter(Boolean).map((root) => path.resolve(root));
  const inodes = new Map(); // dev:ino -> { size, nlink, refs }
  const perRoot = new Map();
  for (const root of list) perRoot.set(root, { root, files: 0, dirs: 0, logicalBytes: 0, missing: !exists(root) });
  const out = {
    roots: list,
    entries: 0,
    files: 0,
    dirs: 0,
    logicalBytes: 0,
    bytes: 0,
    exclusiveBytes: 0,
    sharedBytes: 0,
    fullyFreedBytes: 0,
    stillLinkedBytes: 0,
    links: 0,
    errors: 0,
    truncated: false,
    perRoot: [...perRoot.values()]
  };
  const stack = list.map((root) => ({ root, dir: root }));
  while (stack.length) {
    if (out.entries > maxFiles) {
      out.truncated = true;
      break;
    }
    const { root, dir } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      out.errors += 1;
      continue;
    }
    const bucket = perRoot.get(root);
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        out.dirs += 1;
        bucket.dirs += 1;
        stack.push({ root, dir: abs });
        continue;
      }
      if (entry.isSymbolicLink()) {
        out.links += 1;
        continue;
      }
      if (!entry.isFile()) continue;
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch {
        out.errors += 1;
        continue;
      }
      out.entries += 1;
      out.logicalBytes += st.size;
      bucket.files += 1;
      bucket.logicalBytes += st.size;
      const key = String(st.dev) + ":" + String(st.ino);
      const hit = inodes.get(key);
      if (hit) {
        hit.refs += 1;
        continue;
      }
      inodes.set(key, { size: st.size, nlink: st.nlink, refs: 1 });
    }
  }
  for (const item of inodes.values()) {
    out.files += 1;
    out.bytes += item.size;
    if (item.nlink > 1) out.sharedBytes += item.size;
    else out.exclusiveBytes += item.size;
    // 引用它的链接数 <= 本集合内的引用数 ⇒ 本集合里就有它的全部链接 ⇒ 删集合即释放
    if (item.refs >= item.nlink) out.fullyFreedBytes += item.size;
  }
  out.stillLinkedBytes = Math.max(0, out.sharedBytes - Math.max(0, out.fullyFreedBytes - out.exclusiveBytes));
  out.truncatedRoots = out.truncated;
  return out;
}

/**
 * 单棵树是否被另一棵树"覆盖"（源里每个文件都在目标里、且大小一致）。
 * verifyTrees 要求双向完全相等；本体随迁时目标会多出 pnpm 侧的文件，因此需要单向校验。
 */
export function verifyCovers(source, target, options = {}) {
  const sampleHashes = options.sampleHashes ?? 0;
  const limit = options.maxFiles ?? DEFAULT_MAX_FILES;
  const collect = (root) => {
    const map = new Map();
    const stack = [path.resolve(root)];
    let truncated = false;
    while (stack.length) {
      if (map.size > limit) {
        truncated = true;
        break;
      }
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
        let st;
        try {
          st = fs.lstatSync(abs);
        } catch {
          continue;
        }
        map.set(path.relative(root, abs).split(path.sep).join("/"), { abs, size: st.size });
      }
    }
    return { map, truncated };
  };
  const left = collect(source);
  const right = collect(target);
  const missing = [];
  const sizeMismatch = [];
  const hashMismatch = [];
  let hashed = 0;
  let step = 1;
  if (sampleHashes > 0 && left.map.size > sampleHashes) step = Math.ceil(left.map.size / sampleHashes);
  let index = 0;
  for (const [rel, meta] of left.map) {
    index += 1;
    const other = right.map.get(rel);
    if (!other) {
      if (missing.length < 20) missing.push(rel);
      continue;
    }
    if (other.size !== meta.size) {
      if (sizeMismatch.length < 20) sizeMismatch.push(rel + " (" + meta.size + " vs " + other.size + ")");
      continue;
    }
    if (sampleHashes > 0 && index % step === 0 && hashed < sampleHashes) {
      hashed += 1;
      try {
        if (defaultHash(meta.abs) !== defaultHash(other.abs) && hashMismatch.length < 20) hashMismatch.push(rel);
      } catch {
        /* 读不了就不判哈希 */
      }
    }
  }
  return {
    ok: missing.length === 0 && sizeMismatch.length === 0 && hashMismatch.length === 0,
    sourceFiles: left.map.size,
    targetFiles: right.map.size,
    sourceOnly: missing.slice(0, 20),
    missing,
    sizeMismatch,
    hashMismatch,
    hashed,
    truncated: left.truncated || right.truncated
  };
}

function defaultHash(file) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

/**
 * 扫描 <DSH_HOME>\plugins 下的"孤儿本体"：没有被任何 file: 依赖引用的目录。
 * 这是完全体迁移后最容易残留的大块头（2 GB 级别）。
 */
export function scanOrphanBodies({ home, profileDir, rows }) {
  const pluginsRoot = path.join(home, "plugins");
  const referenced = new Map();
  const missing = [];
  for (const row of rows ?? []) {
    const dir = bodySpecPath(profileDir, row.spec);
    if (!dir) continue;
    referenced.set(norm(dir), row.name);
    if (!exists(dir)) missing.push({ name: row.name, dir });
  }
  const orphans = [];
  let entries = [];
  try {
    entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  } catch {
    return { pluginsRoot, exists: false, referenced: [...referenced.keys()], orphans, missing, totalBytes: 0 };
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const dir = path.join(pluginsRoot, entry.name);
    if (referenced.has(norm(dir))) continue;
    if (!exists(dir)) continue;
    let measured;
    try {
      measured = measureTree(dir);
    } catch {
      measured = { files: 0, bytes: 0 };
    }
    orphans.push({
      name: entry.name,
      dir,
      files: measured.files,
      bytes: measured.bytes,
      exclusiveBytes: measured.exclusiveBytes ?? 0,
      sharedBytes: measured.sharedBytes ?? 0,
      human: humanBytes(measured.bytes),
      exclusiveHuman: humanBytes(measured.exclusiveBytes ?? 0)
    });
  }
  orphans.sort((a, b) => b.bytes - a.bytes);
  return {
    pluginsRoot,
    exists: true,
    referenced: [...referenced.keys()],
    orphans,
    missing,
    totalBytes: orphans.reduce((sum, item) => sum + item.bytes, 0)
  };
}

/** 本体是否允许"随迁"：只搬 .dsh 内的本体，其它位置（例如用户的源码仓库）一律只读不动。 */
export function bodyMovable(home, bodyDir) {
  if (!bodyDir) return { movable: false, reason: "这条依赖不是 file: 写法，没有独立本体" };
  if (!exists(bodyDir)) return { movable: false, reason: "本体目录不存在：" + bodyDir };
  if (!isSubPath(home, bodyDir)) {
    return { movable: false, reason: "本体不在 .dsh 内（" + bodyDir + "），为避免动到你的源码仓库，只搬 node_modules 一侧" };
  }
  if (norm(bodyDir) === norm(path.join(home, "plugins"))) return { movable: false, reason: "本体就是 plugins 目录本身，跳过" };
  return { movable: true, reason: "本体在 .dsh 内，可随迁" };
}
