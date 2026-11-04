/**
 * .dsh 体检（只读）：一次遍历按 inode 跨子树去重，按顶层目录归账，并给出可清理项清单。
 *
 * 设计原则：
 *   - 只读，绝不删除任何东西；清理建议交由用户确认后走单独接口。
 *   - 凡是"算不出当前正在使用的代"的情形一律 fail-safe：只报告、不推荐删除。
 *   - 所有数字都区分三种口径：logicalBytes（不去重）/ bytes（跨树按 inode 去重）
 *     / exclusiveBytes（nlink==1，删掉即真正释放）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { humanBytes, measureTree, lstatOrNull, exists } from "./paths.js";

const INTERESTING_TOP = [
  "attachments",
  "plugins",
  "profiles",
  "dsh-ops",
  "electron",
  "dsh-runtimes",
  "speech-to-text",
  "cache",
  "sessions",
  "ig5",
  "storages",
  "logs",
  "skills",
  "im",
  "jet-hub",
  "bin",
  "dsh-desktop",
  "dsh-ops-shell"
];

/**
 * 复算"当前正在使用的 bash-ipc 生成代"名字。
 * 算法取自 dsh-ops/lib/bash-ipc.js:148 ——
 *   identity = sha256(JSON.stringify({ root, msys: receipt.msysSha256, files: receipt.files })).slice(0, 24)
 * 其中 root 是内置 bash（@dsh-ops/bash-win32-x64）所在目录。
 * 任何一个输入缺失/读不到 => 返回 identity: null，调用方必须放弃对 bash-ipc 代做删除建议。
 */
export function bashIpcIdentity(profileDir) {
  const receiptPath = path.join(
    profileDir,
    "node_modules",
    "dsh-ops",
    "runtime",
    "win32-x64",
    "bash-ipc",
    "provenance.json"
  );
  const receipt = (() => {
    try {
      return JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    } catch {
      return null;
    }
  })();
  if (!receipt?.msysSha256 || !receipt?.files) {
    return { identity: null, root: null, reason: "读不到 " + receiptPath + "（缺少 msysSha256/files）" };
  }
  const rootCandidates = [
    path.join(profileDir, "node_modules", "@dsh-ops", "bash-win32-x64"),
    path.join(profileDir, "node_modules", "dsh-ops", "runtime", "win32-x64", "bash-ipc", "msys")
  ];
  const root = rootCandidates.find((candidate) => exists(candidate));
  if (!root) {
    return { identity: null, root: null, reason: "找不到内置 bash 目录（@dsh-ops/bash-win32-x64）" };
  }
  const identity = crypto
    .createHash("sha256")
    .update(Buffer.from(JSON.stringify({ root, msys: receipt.msysSha256, files: receipt.files })))
    .digest("hex")
    .slice(0, 24);
  return { identity, root, reason: null, receipt: receiptPath };
}

function newStats() {
  return { files: 0, dirs: 0, logicalBytes: 0, bytes: 0, exclusiveBytes: 0, sharedBytes: 0 };
}

function addStats(target, size, shared) {
  target.files += 1;
  target.logicalBytes += size;
  if (!shared) {
    target.bytes += size;
    target.exclusiveBytes += size;
  } else {
    target.sharedBytes += size;
  }
}

/**
 * 遍历整棵 home，跨子树按 inode 去重。
 * 返回 { totals, rows, detail, topFiles, hardlinks, errors }。
 * 每 2000 个文件让出一次事件循环，避免长时间阻塞宿主。
 */
export async function walkHome(home, { onProgress, topLimit = 20, detailDepth = 2 } = {}) {
  const seen = new Map(); // dev:ino -> { size, path }
  const rowsMap = new Map();
  const detailMap = new Map();
  const totals = newStats();
  const hardlinkSamples = [];
  const topFiles = [];
  const errors = [];
  let scanned = 0;
  let hardlinkInodes = 0;
  let hardlinkBytes = 0;

  const rowOf = (key, label = key) => {
    if (!rowsMap.has(key)) rowsMap.set(key, { key, label, ...newStats() });
    return rowsMap.get(key);
  };
  const detailOf = (key) => {
    if (!detailMap.has(key)) detailMap.set(key, { key, ...newStats() });
    return detailMap.get(key);
  };

  const stack = [];
  let topEntries = [];
  try {
    topEntries = fs.readdirSync(home, { withFileTypes: true });
  } catch (error) {
    errors.push({ path: home, error: String(error?.message ?? error) });
  }
  for (const entry of topEntries) stack.push({ abs: path.join(home, entry.name), rel: entry.name, depth: 1, top: entry.name });

  while (stack.length) {
    const item = stack.pop();
    const st = lstatOrNull(item.abs);
    if (!st) continue;
    if (st.isSymbolicLink()) continue; // 不跟随链接，避免重复计算
    if (st.isDirectory()) {
      totals.dirs += 1;
      rowOf(item.top).dirs += 1;
      if (item.rel.split(path.sep).length <= detailDepth) detailOf(item.rel).dirs += 1;
      let entries = [];
      try {
        entries = fs.readdirSync(item.abs, { withFileTypes: true });
      } catch (error) {
        errors.push({ path: item.abs, error: String(error?.message ?? error) });
        continue;
      }
      for (const entry of entries) {
        stack.push({ abs: path.join(item.abs, entry.name), rel: item.rel + path.sep + entry.name, depth: item.depth + 1, top: item.top });
      }
      continue;
    }
    if (!st.isFile()) continue;

    scanned += 1;
    const size = st.size;
    const key = st.dev + ":" + st.ino;
    const first = seen.get(key);
    const shared = !!first;
    totals.files += 1;
    totals.logicalBytes += size;
    if (!shared) {
      seen.set(key, { size, path: item.abs });
      totals.bytes += size;
      if (st.nlink > 1) {
        totals.sharedBytes += size;
        hardlinkInodes += 1;
        hardlinkBytes += size;
        if (hardlinkSamples.length < 12) hardlinkSamples.push({ path: item.abs, bytes: size, nlink: st.nlink });
      } else {
        totals.exclusiveBytes += size;
      }
      const row = rowOf(item.top);
      addStats(row, size, false);
      const detailKey = item.rel.split(path.sep).slice(0, detailDepth).join("/");
      if (detailKey !== item.top) addStats(detailOf(detailKey), size, false);
    }

    if (topFiles.length < topLimit) {
      topFiles.push({ path: item.abs, bytes: size });
      topFiles.sort((a, b) => b.bytes - a.bytes);
    } else if (size > topFiles[topFiles.length - 1].bytes) {
      topFiles[topFiles.length - 1] = { path: item.abs, bytes: size };
      topFiles.sort((a, b) => b.bytes - a.bytes);
    }

    if ((scanned & 2047) === 0) {
      onProgress?.({ files: scanned, current: item.rel });
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const decorate = (raw) => ({
    ...raw,
    logicalHuman: humanBytes(raw.logicalBytes),
    bytesHuman: humanBytes(raw.bytes),
    exclusiveHuman: humanBytes(raw.exclusiveBytes),
    sharedHuman: humanBytes(raw.sharedBytes)
  });

  return {
    totals: { ...totals, hardlinkInodes, hardlinkBytes, seenInodes: seen.size },
    rows: [...rowsMap.values()].map(decorate).sort((a, b) => b.bytes - a.bytes),
    detail: [...detailMap.values()].map(decorate).sort((a, b) => b.bytes - a.bytes),
    topFiles: topFiles.map((f) => ({ ...f, human: humanBytes(f.bytes) })),
    hardlinks: { inodes: hardlinkInodes, bytes: hardlinkBytes, human: humanBytes(hardlinkBytes), samples: hardlinkSamples },
    errors
  };
}

/** 逐个测量清理候选（数量有限，单独 measureTree 即可）。 */
function candidate(home, id, label, relPath, risk, note) {
  const abs = path.join(home, relPath);
  if (!exists(abs)) return null;
  const st = lstatOrNull(abs);
  if (!st) return null;
  if (st.isFile()) {
    return { id, label, path: abs, files: 1, bytes: st.size, human: humanBytes(st.size), risk, note };
  }
  const measured = measureTree(abs);
  return {
    id,
    label,
    path: abs,
    files: measured.files,
    bytes: measured.bytes,
    exclusiveBytes: measured.exclusiveBytes,
    human: humanBytes(measured.bytes),
    risk,
    note
  };
}

/**
 * 生成清理建议清单。
 * risk: safe = 纯缓存/历史代，删掉不影响功能；review = 用户数据，需自行确认。
 */
export function buildReclaim(home, profileDir) {
  const items = [];
  const push = (entry) => entry && items.push(entry);

  // 1) bash-ipc 历史代
  const bipcDir = path.join(home, "dsh-ops", "bash-ipc");
  const identity = bashIpcIdentity(profileDir);
  if (exists(bipcDir)) {
    let names = [];
    try {
      names = fs.readdirSync(bipcDir);
    } catch {
      names = [];
    }
    if (!identity.identity) {
      items.push({
        id: "bash-ipc-unknown",
        label: "bash-ipc 生成代（无法判定当前代）",
        path: bipcDir,
        bytes: 0,
        human: "未测量",
        risk: "review",
        note: "未能复算当前生成代（" + (identity.reason ?? "原因未知") + "），为避免误删正在使用的运行时，本项不做删除建议。目录共 " + names.length + " 项。"
      });
    } else {
      for (const name of names) {
        if (!/^[0-9a-f]{24}$/.test(name)) continue;
        if (name === identity.identity) continue;
        push(
          candidate(
            home,
            "bash-ipc-stale:" + name,
            "bash-ipc 历史生成代 " + name.slice(0, 12) + "…",
            path.join("dsh-ops", "bash-ipc", name),
            "safe",
            "当前正在使用的是 " + identity.identity.slice(0, 12) + "…；本代是升级前的旧副本（约占 400 MB）。删除前请确认没有旧的受限 shell 进程仍在使用它。"
          )
        );
      }
    }
  }

  // 2) 缓存目录
  push(candidate(home, "cache-attachments", "cache/attachments（历史附件缓存）", path.join("cache", "attachments"), "safe", "插件/工具留下的中间附件，2026-10-08 之后不再变化。"));
  push(candidate(home, "cache-image-gen", "cache/dsh-image-gen（图片生成缓存）", path.join("cache", "dsh-image-gen"), "safe", "图片生成的中间产物缓存。"));
  push(candidate(home, "plugin-manager-logs", ".plugin-manager 操作日志", path.join("profiles", "desktop", ".plugin-manager", "logs"), "safe", "每次插件装/卸/更新的 pnpm 原始日志，仅用于排错，可全删。"));
  // 3) 市场发现缓存单独列出（文件级；真实位置在 profile 下的 .dsh-market）
  try {
    const market = path.join(profileDir, ".dsh-market");
    for (const name of fs.readdirSync(market)) {
      if (!/^discovery-.*\.json$/.test(name)) continue;
      const abs = path.join(market, name);
      const st = fs.statSync(abs);
      items.push({
        id: "market:" + name,
        label: "市场索引 " + name,
        path: abs,
        files: 1,
        bytes: st.size,
        human: humanBytes(st.size),
        risk: "safe",
        note: "插件市场本地索引，删除后下次打开市场会重新拉取。"
      });
    }
  } catch {
    /* 目录不存在 */
  }

  push(candidate(home, "session-projcache", "storages/session_projcache（会话投影缓存）", path.join("storages", "session_projcache"), "safe", "会话列表的投影缓存，删掉会重建。"));
  push(candidate(home, "acl-backups", "acl-backups（权限备份）", path.join("profiles", "desktop", "acl-backups"), "review", "沙箱 ACL 修复时留下的备份；确认近期无需回滚后可删。"));

  // 4) 需用户判断的
  push(candidate(home, "attachments", "attachments（附件 CAS 仓库）", "attachments", "review", "历次对话产生的附件原件，没有自动回收机制；删除会丢失历史图片/文件。建议在插件列表里按月上锁后再清。"));
  push(candidate(home, "ig5-projects", "ig5 逆向工程数据库", "ig5", "review", "IG5 的分析数据库（memory.sqlite 等），删掉等于丢弃分析进度。"));
  push(candidate(home, "sessions", "sessions（会话记录）", "sessions", "review", "对话历史本体，删除会丢会话。"));

  return items.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
}

/** home 之外的缓存（只报告，不参与清理流程）。 */
export function externalCaches() {
  const out = [];
  const add = (label, abs) => {
    if (!exists(abs)) return;
    const measured = measureTree(abs);
    out.push({ label, path: abs, files: measured.files, bytes: measured.bytes, human: humanBytes(measured.bytes) });
  };
  const roaming = path.join(os.homedir(), "AppData", "Roaming", "@deepseek-ai", "dsh-desktop");
  for (const name of ["Code Cache", "Cache", "GPUCache", "GrShaderCache", "ShaderCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "IndexedDB"]) {
    add("@deepseek-ai/dsh-desktop/" + name, path.join(roaming, name));
  }
  add("pnpm store v11（插件依赖的真身）", path.join(os.homedir(), "AppData", "Local", "pnpm", "store", "v11"));
  add("pnpm cache", path.join(os.homedir(), "AppData", "Local", "pnpm-cache"));
  add("系统临时目录", os.tmpdir());
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** 完整报告。 */
export async function runDoctor({ home, profileDir, onProgress }) {
  const started = Date.now();
  const walk = await walkHome(home, { onProgress });
  const reclaim = buildReclaim(home, profileDir);
  const identity = bashIpcIdentity(profileDir);
  const reclaimTotal = reclaim.filter((item) => item.risk === "safe").reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  return {
    home,
    profileDir,
    at: Date.now(),
    durationMs: Date.now() - started,
    bashIpc: identity,
    ...walk,
    reclaim,
    reclaimSafeBytes: reclaimTotal,
    reclaimSafeHuman: humanBytes(reclaimTotal),
    external: externalCaches()
  };
}
