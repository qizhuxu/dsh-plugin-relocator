/**
 * 目录搬运与校验。
 *
 * 同盘优先用硬链接（瞬间完成、不额外占用空间），跨盘才退化为逐字节复制。
 * 硬链接是安全的：每个链接都独立存在，删掉任意一侧都不会破坏另一侧。
 */
import fs from "node:fs";
import path from "node:path";
import { lstatOrNull, humanBytes } from "./paths.js";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 把 from 的内容搬到 to（to 必须还不存在或是空目录）。
 * mode: "auto"（默认，同盘硬链接）/ "link" / "copy"
 */
export function transferTree(from, to, { onProgress, mode = "auto", chunk = 512 } = {}) {
  const started = Date.now();
  ensureDir(to);
  const stats = { files: 0, dirs: 0, linked: 0, copied: 0, bytes: 0, skipped: [], mode };
  const stack = [{ src: from, dst: to }];
  let sinceYield = 0;
  while (stack.length) {
    const item = stack.pop();
    const st = lstatOrNull(item.src);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      stats.skipped.push({ path: item.src, reason: "symlink" });
      continue;
    }
    if (st.isDirectory()) {
      ensureDir(item.dst);
      stats.dirs += 1;
      for (const entry of fs.readdirSync(item.src, { withFileTypes: true })) {
        stack.push({ src: path.join(item.src, entry.name), dst: path.join(item.dst, entry.name) });
      }
      continue;
    }
    if (!st.isFile()) {
      stats.skipped.push({ path: item.src, reason: "not-a-file" });
      continue;
    }
    let done = false;
    if (mode !== "copy") {
      try {
        fs.linkSync(item.src, item.dst);
        stats.linked += 1;
        done = true;
      } catch (error) {
        if (mode === "link") throw error;
      }
    }
    if (!done) {
      fs.copyFileSync(item.src, item.dst);
      stats.copied += 1;
    }
    stats.files += 1;
    stats.bytes += st.size;
    sinceYield += 1;
    if (onProgress && sinceYield >= chunk) {
      sinceYield = 0;
      onProgress({ ...stats, current: item.src });
    }
  }
  stats.ms = Date.now() - started;
  stats.human = humanBytes(stats.bytes);
  return stats;
}

/** 收集相对路径 → 大小 的清单，用于两侧比对。 */
export function manifest(root, { limit = 400000 } = {}) {
  const map = new Map();
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    const st = lstatOrNull(abs);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(abs)) stack.push(rel ? rel + path.sep + entry : entry);
      continue;
    }
    if (map.size >= limit) return { map, truncated: true };
    map.set(rel, st.size);
  }
  return { map, truncated: false };
}

/**
 * 比对两侧是否一致：文件集合 + 逐个大小。
 * 默认只比大小（快）；sampleHashes > 0 时再抽样比 sha256。
 */
export async function verifyTrees(a, b, { sampleHashes = 0 } = {}) {
  const left = manifest(a);
  const right = manifest(b);
  const onlyLeft = [];
  const onlyRight = [];
  const sizeMismatch = [];
  for (const [rel, size] of left.map) {
    if (!right.map.has(rel)) onlyLeft.push(rel);
    else if (right.map.get(rel) !== size) sizeMismatch.push({ rel, left: size, right: right.map.get(rel) });
  }
  for (const rel of right.map.keys()) if (!left.map.has(rel)) onlyRight.push(rel);
  const hashMismatch = [];
  if (sampleHashes > 0 && onlyLeft.length === 0 && onlyRight.length === 0 && sizeMismatch.length === 0) {
    const crypto = await import("node:crypto");
    const files = [...left.map.keys()];
    const step = Math.max(1, Math.floor(files.length / sampleHashes));
    for (let index = 0; index < files.length && hashMismatch.length === 0; index += step) {
      const rel = files[index];
      const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (digest(path.join(a, rel)) !== digest(path.join(b, rel))) hashMismatch.push(rel);
    }
  }
  return {
    ok: onlyLeft.length === 0 && onlyRight.length === 0 && sizeMismatch.length === 0 && hashMismatch.length === 0,
    leftFiles: left.map.size,
    rightFiles: right.map.size,
    onlyLeft: onlyLeft.slice(0, 20),
    onlyRight: onlyRight.slice(0, 20),
    sizeMismatch: sizeMismatch.slice(0, 20),
    hashMismatch: hashMismatch.slice(0, 20),
    truncated: left.truncated || right.truncated
  };
}
