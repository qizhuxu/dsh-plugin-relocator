/**
 * 路径与文件系统小工具：DSH 目录解析、盘符判定、junction、原子写、树体积统计。
 * 本模块不依赖任何 DSH 内部 API —— 全部走 node:fs，保证在插件被外置到任意盘后仍可用。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** DSH 根目录：显式参数 > 环境变量 > <home>/.dsh */
export function resolveDshHome(explicit) {
  if (explicit) return path.resolve(String(explicit));
  const fromEnv = process.env.DSH_HOME || process.env.DSH_DATA_HOME || process.env.DSH_CONFIG_HOME;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".dsh");
}

export function profileDirOf(home, profile = "desktop") {
  return path.join(home, "profiles", profile);
}

/** 盘符根（"F:\\" 形式），UNC 返回 "\\\\server\\share"。用于同盘判定。 */
export function driveRoot(p) {
  if (!p) return "";
  const parsed = path.parse(path.resolve(p));
  return parsed.root ? parsed.root.toUpperCase() : "";
}

export function sameDrive(a, b) {
  const ra = driveRoot(a);
  const rb = driveRoot(b);
  return !!ra && ra === rb;
}

export function isSubPath(parent, child) {
  const p = path.resolve(parent).toLowerCase().replace(/[\\/]+$/, "");
  const c = path.resolve(child).toLowerCase().replace(/[\\/]+$/, "");
  return c === p || c.startsWith(p + path.sep);
}

/** pnpm / link: 规格里统一用正斜杠，避免 Windows 反斜杠被当转义。 */
export function toSpecPath(p) {
  return path.resolve(p).replace(/\\/g, "/");
}

/** 插件在 profile 里的落地目录（scoped 包展开成两级）。 */
export function moduleDir(profileDir, name) {
  return path.join(profileDir, "node_modules", ...String(name).split("/"));
}

/** 插件在外置根下的独立工程目录。scoped 包保持 @scope/name 结构，可读性最好。 */
export function externalDirFor(root, name) {
  return path.join(root, ...String(name).split("/"));
}

export function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

export function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function exists(p) {
  return lstatOrNull(p) !== null;
}

/** 链接（symlink / junction）判定；realpath 在 Windows 上对 junction 同样生效。 */
export function isLink(p) {
  const st = lstatOrNull(p);
  return !!st && st.isSymbolicLink();
}

export function realPathOrNull(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * 建立目录 junction 指向 target。
 * Windows 下 junction 无需管理员权限、可跨盘，且 Node 的 require 默认跟随 realpath，
 * 因此插件内部私有依赖会从真实目录（外置盘）解析，peer 依赖交由 DSH 加载器的拦截层解析。
 */
export function createJunction(target, linkPath) {
  const abs = path.resolve(target);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(abs, linkPath, "junction");
  return abs;
}

export function removeLink(linkPath) {
  const st = lstatOrNull(linkPath);
  if (!st) return false;
  if (st.isSymbolicLink()) {
    fs.unlinkSync(linkPath);
    return true;
  }
  fs.rmSync(linkPath, { recursive: true, force: true, maxRetries: 3 });
  return true;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** 原子写 JSON：先写 .tmp 再 rename，避免 UI 读到半个文件。 */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line.endsWith("\n") ? line : line + "\n", "utf8");
}

/** 目标盘剩余空间（字节）。statfs 在 Node 18.15+ 可用。 */
export function freeSpace(p) {
  try {
    const st = fs.statfsSync(p);
    return { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) };
  } catch {
    return null;
  }
}

export function humanBytes(n) {
  if (!Number.isFinite(n)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return (n < 0 ? "-" : "") + (i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : 1)) + units[i];
}

const SKIP_DIRS = new Set([".git", ".svn", ".hg"]);

/**
 * 统计一棵树的占用，并按 inode 去重。
 * - logicalBytes：逐文件相加（不查硬链接），等于资源管理器"大小"
 * - bytes：同一 inode 只算一次，是"真实多占了一块盘"的口径
 * - sharedBytes：nlink>1 的文件累计（其中大部分与 pnpm store 或 plugins 目录共享）
 * 链接目录一律不跟进，避免 junction 成环。
 */
export function measureTree(root, options = {}) {
  const maxFiles = options.maxFiles ?? 400000;
  const ignore = options.ignore ?? null;
  const seen = new Set();
  const out = {
    root,
    files: 0,
    dirs: 0,
    logicalBytes: 0,
    bytes: 0,
    sharedFiles: 0,
    sharedBytes: 0,
    /* nlink==1 的字节：这份数据只被当前树引用，移走/删掉即真正释放 */
    exclusiveBytes: 0,
    links: 0,
    errors: 0,
    truncated: false
  };
  const stack = [path.resolve(root)];
  while (stack.length) {
    if (out.files > maxFiles) {
      out.truncated = true;
      break;
    }
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      out.errors += 1;
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (ignore && ignore(abs)) continue;
        out.dirs += 1;
        stack.push(abs);
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
      out.files += 1;
      out.logicalBytes += st.size;
      const key = String(st.dev) + ":" + String(st.ino);
      if (seen.has(key)) continue;
      seen.add(key);
      out.bytes += st.size;
      if (st.nlink > 1) {
        out.sharedFiles += 1;
        out.sharedBytes += st.size;
      } else {
        out.exclusiveBytes += st.size;
      }
    }
  }
  return out;
}

/** 只数文件（比统计体积快，用于拷贝校验）。 */
export function countFiles(root, options = {}) {
  const seen = new Set();
  let files = 0;
  const stack = [path.resolve(root)];
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
      } else if (entry.isFile()) {
        const st = lstatOrNull(abs);
        if (!st) continue;
        const key = String(st.dev) + ":" + String(st.ino);
        if (seen.has(key)) continue;
        seen.add(key);
        files += 1;
      }
    }
  }
  return files;
}

/** 复制目录树（跟随链接内容），返回统计。跨盘复制时硬链接关系无法保留，会实际占用空间。 */
export function copyTree(from, to, options = {}) {
  const onProgress = options.onProgress ?? null;
  fs.mkdirSync(to, { recursive: true });
  let files = 0;
  let bytes = 0;
  let lastTick = Date.now();
  const stack = [[path.resolve(from), path.resolve(to)]];
  while (stack.length) {
    const [src, dst] = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(src, { withFileTypes: true });
    } catch (error) {
      if (options.skipErrors) continue;
      throw error;
    }
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (SKIP_DIRS.has(entry.name)) continue;
      const st = lstatOrNull(s);
      if (!st) continue;
      if (st.isSymbolicLink()) {
        // 链接一律不复用原目标（可能是 profile 内的相对链接），复制成实体。
        const real = realPathOrNull(s);
        if (real && !isSubPath(from, real) && statOrNull(real)?.isDirectory()) {
          stack.push([real, d]);
        } else if (real) {
          fs.mkdirSync(path.dirname(d), { recursive: true });
          fs.copyFileSync(real, d);
          files += 1;
          bytes += statOrNull(real)?.size ?? 0;
        }
        continue;
      }
      if (st.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        stack.push([s, d]);
        continue;
      }
      if (!st.isFile()) continue;
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      try {
        fs.chmodSync(d, st.mode);
      } catch {
        /* Windows 上可能不支持，忽略 */
      }
      files += 1;
      bytes += st.size;
      const now = Date.now();
      if (onProgress && now - lastTick > 400) {
        lastTick = now;
        onProgress({ files, bytes, current: s });
      }
    }
  }
  if (onProgress) onProgress({ files, bytes, current: null, done: true });
  return { files, bytes };
}
