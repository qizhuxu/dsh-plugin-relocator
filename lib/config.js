/**
 * 配置：默认值 <- bundle patch（cordis config） <- <DSH_HOME>/plugin-relocator/config.json
 * UI 写入的永远是第三层，因此升级/重装插件不会冲掉用户设置。
 */
import path from "node:path";
import fs from "node:fs";
import { resolveDshHome, readJson, writeJsonAtomic, sameDrive } from "./paths.js";

export const DEFAULTS = {
  /** 插件安装根目录。留空表示"尚未选择"，此时不允许迁出。 */
  root: "",
  /** 外置工程的 pnpm store。必须与 root 同盘，否则硬链接去重失效、占用翻倍。 */
  storeDir: "",
  /** 外置工程使用的 registry；中文环境默认 npmmirror。 */
  registry: "https://registry.npmmirror.com/",
  /** 新装插件的默认策略：external（落在 root）| inDsh（留在 .dsh）。 */
  defaultPolicy: "inDsh",
  /** 体积推荐阈值（MB）。 */
  oversizeMB: 100,
  /** 迁出前是否强制要求"依赖自洽"（无隐式依赖）。 */
  strictImplicitDeps: true,
  /** 找不到声明的依赖时，是否允许从 profile 的 hoisted node_modules 兜底（默认关，避免假自洽）。 */
  allowHoistFallback: false,
  /** 迁移前后是否在 profile 里跑一次 pnpm install 让 lockfile 收敛。失败只告警不阻断。 */
  syncProfileLockfile: true,
  /**
   * 搬运方式：auto（同盘用硬链接，瞬时且不额外占空间；跨盘自动退化为复制）
   * | link（强制硬链接，跨盘会失败）| copy（逐字节复制，回滚点与正式目录彻底独立，代价是占用翻倍）。
   * 注意 auto/link 产生的是硬链接：若某个程序"原地改写"同一个文件，两边内容会一起变；
   * 插件自更新基本都是"写临时文件再改名"，不受影响。
   */
  transferMode: "auto",
  /**
   * 完全体迁移：move = 连 file: 本体一起搬进外置目录（迁出后 .dsh 侧不再留整份本体）
   * | keep = 只搬 node_modules 一侧（等价于旧行为，本体原样留在 .dsh）。
   * 只在依赖写法是 file: 且本体位于 .dsh 内部时才生效；其它位置的本体一律不动。
   */
  bodyMode: "move",
  /** 迁移成功后是否自动删除回收点（默认关：保留一键回滚的能力）。 */
  autoPurgeRollback: false,
  /** 搬移/恢复时每棵树抽样校验哈希的文件数（0 = 只比大小）。 */
  hashSamples: 32,
  /** 逐插件安装根覆盖：{ "<name>": "F:\\DSH-Plugins" }；缺省或留空则跟随全局 root。 */
  roots: {},
  /** 界面显示位置：settings（仅设置页）| sidebar（仅左侧栏主面板）| both（两处都显示）。 */
  surface: "settings",
  /** 逐插件覆盖：{ "<name>": { policy, ignored: string[], preferLocation } } */
  plugins: {}
};

export function configFile(home) {
  return path.join(home, "plugin-relocator", "config.json");
}
export function stateDir(home) {
  return path.join(home, "plugin-relocator");
}

export function loadConfig(home, fromPatch = {}) {
  const clean = (value) => {
    const out = {};
    for (const [key, raw] of Object.entries(value ?? {})) {
      if (raw === undefined) continue;
      out[key] = raw && typeof raw === "object" && typeof raw.get === "function" ? raw.get() : raw;
    }
    return out;
  };
  const merged = { ...DEFAULTS, ...clean(fromPatch), ...clean(readJson(configFile(home), {})) };
  merged.plugins = { ...(readJson(configFile(home), {})?.plugins ?? {}) };
  // 逐插件安装根：只保留"非空字符串 -> 字符串"的条目，避免脏数据把路径解析搞崩。
  const rawRoots = merged.roots && typeof merged.roots === "object" && !Array.isArray(merged.roots) ? merged.roots : {};
  merged.roots = {};
  for (const [key, value] of Object.entries(rawRoots)) {
    if (typeof value === "string" && value.trim()) merged.roots[key] = value.trim();
  }
  if (merged.bodyMode !== "move" && merged.bodyMode !== "keep") merged.bodyMode = DEFAULTS.bodyMode;
  merged.autoPurgeRollback = merged.autoPurgeRollback === true;
  merged.hashSamples = Number.isFinite(Number(merged.hashSamples)) ? Math.max(0, Math.min(2000, Math.round(Number(merged.hashSamples)))) : DEFAULTS.hashSamples;
  if (!merged.root) merged.root = "";
  merged.storeDir = resolveStoreDir(merged.root, merged.storeDir);
  // 界面显示位置只接受三个值，脏数据一律回落到设置页。
  if (merged.surface !== "settings" && merged.surface !== "sidebar" && merged.surface !== "both") merged.surface = "settings";
  return merged;
}

export function defaultStoreDir(root) {
  return path.join(root, ".store", "v11");
}

/**
 * store-dir 归一化：空 -> <root>/.store/v11；相对路径 -> 相对 **安装根** 解析（不是相对进程 cwd）；
 * 绝对路径 -> 原样。返回绝对路径，供同盘判定、.npmrc 的 store-dir= 与迁移使用。
 */
export function resolveStoreDir(root, storeDir) {
  const base = root ? path.resolve(String(root)) : "";
  const raw = String(storeDir ?? "").trim();
  if (!raw) return base ? defaultStoreDir(base) : "";
  if (path.isAbsolute(raw)) return path.resolve(raw);
  // 没有安装根时不要相对进程 cwd 解析（那会把 .store\v11 变成 C:\... 的假绝对路径），原样返回。
  return base ? path.resolve(base, raw) : raw;
}

export function saveConfig(home, config) {
  const file = configFile(home);
  const current = readJson(file, {}) ?? {};
  // 白名单：UI 会把 status 里的派生字段（configFile / effectiveStoreDir）一起回传，
  // 不筛选的话它们会被当成用户设置写进文件，越滚越多。
  const allowed = new Set([...Object.keys(DEFAULTS), "plugins"]);
  const patch = {};
  for (const [key, value] of Object.entries(config ?? {})) if (allowed.has(key)) patch[key] = value;
  const next = { ...current, ...patch };
  delete next.effectiveStoreDir;
  delete next.configFile;
  next.DEFAULTS_VERSION = 1;
  writeJsonAtomic(file, next);
  return next;
}

export function pluginOverride(config, name) {
  const entry = config.plugins?.[name];
  return entry && typeof entry === "object" ? entry : {};
}

export function setPluginOverride(home, config, name, patch) {
  const plugins = { ...(config.plugins ?? {}) };
  plugins[name] = { ...(plugins[name] ?? {}), ...patch };
  saveConfig(home, { plugins });
  config.plugins = plugins;
  return plugins[name];
}

/**
 * 取某个插件实际使用的安装根：逐插件覆盖优先，否则用全局 root。
 * 空字符串一律视为"没设"。
 */
export function rootFor(config, name) {
  const per = config?.roots?.[name];
  if (typeof per === "string" && per.trim()) return per.trim();
  return config?.root ?? "";
}

/** 写入逐插件安装根（传空串表示删除覆盖、回到全局根）。 */
export function setPluginRoot(home, config, name, root) {
  const roots = { ...(config.roots ?? {}) };
  if (typeof root === "string" && root.trim()) roots[name] = root.trim();
  else delete roots[name];
  // 返回写盘后的完整配置（调用方要拿它替换内存里的 config，否则逐插件根不会生效）。
  const saved = saveConfig(home, { roots });
  saved.roots = roots;
  config.roots = roots;
  return saved;
}

/** 从 path 开始向上找到第一个真实存在的目录（用于"目标目录还没建"的判断）。 */
export function nearestExistingAncestor(target) {
  let current = path.resolve(target);
  for (let i = 0; i < 64; i += 1) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** 校验根目录可用性：存在性、可写性、与 store 同盘、是否落在 .dsh 内部。 */
export function validateRoot(home, root, storeDir, { create = false } = {}) {
  const problems = [];
  const warnings = [];
  if (!root) {
    problems.push({ code: "root-empty", message: "尚未选择插件安装根目录。" });
    return { ok: false, problems, warnings };
  }
  const abs = path.resolve(root);
  let needsCreate = false;
  try {
    if (create && !fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
    fs.accessSync(abs, fs.constants.W_OK);
  } catch (error) {
    // 目录还不存在是常态（用户在设置页输入一个新路径）：只要最近的已存在祖先可写就允许，
    // 保存配置时再递归创建，不把"尚未创建"误报成"不可写"。
    const ancestor = nearestExistingAncestor(abs);
    if (ancestor) {
      try {
        fs.accessSync(ancestor, fs.constants.W_OK);
        needsCreate = true;
        warnings.push({ code: "root-will-create", message: "根目录尚不存在，已自动创建：" + abs });
      } catch (inner) {
        problems.push({
          code: "root-unwritable",
          message: "根目录不可写：" + abs + "（最近的已存在目录 " + ancestor + " 也不可写，" + String(inner?.code ?? inner) + "）"
        });
      }
    } else {
      problems.push({ code: "root-unwritable", message: "根目录不可用：" + abs + "（" + String(error?.code ?? error) + "）" });
    }
  }
  if (needsCreate) {
    try {
      fs.mkdirSync(abs, { recursive: true });
      needsCreate = !fs.existsSync(abs) ? true : false;
    } catch (error) {
      problems.push({ code: "root-create-failed", message: "无法创建根目录：" + abs + "（" + String(error?.code ?? error) + "）" });
    }
  }
  const lower = abs.toLowerCase();
  const homeAbs = path.resolve(home).toLowerCase();
  // 系统敏感位置：把插件装到这里，之后的清理/删除动作太危险，直接判为问题。
  const unsafe = [];
  // 注意：path.resolve("D:") 会解析成"该盘的当前目录"，所以必须拿原始输入判断盘符根。
  if (/^[a-z]:[\\/]?$/i.test(String(root).trim())) unsafe.push("盘符根目录");
  const sysRoots = [
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramData,
    "C:\\Windows",
    "C:\\Program Files"
  ]
    .filter(Boolean)
    .map((item) => path.resolve(item).toLowerCase());
  for (const sys of sysRoots) {
    if (lower === sys || lower.startsWith(sys + path.sep)) {
      unsafe.push(path.resolve(sys));
      break;
    }
  }
  if (lower === homeAbs) unsafe.push(".dsh 根目录本身");
  if (unsafe.length) {
    problems.push({
      code: "root-unsafe",
      message: "安装根目录不能是" + unsafe.join("、") + "：" + abs + "。请换一个专用目录（例如 F:\\DSH-Plugins）。"
    });
  }
  const dshProfile = path.join(home, "profiles").toLowerCase();
  if (lower === dshProfile || lower.startsWith(dshProfile + path.sep)) {
    problems.push({
      code: "root-inside-profile",
      message: "安装根目录不能位于 profiles 内部（" + abs + "）：那等于没搬出 .dsh，插件仍会随 .dsh 一起被备份/清理。"
    });
  } else if (lower !== homeAbs && lower.startsWith(homeAbs + path.sep)) {
    warnings.push({ code: "root-inside-home", message: "安装根目录位于 .dsh 内部（" + abs + "）：备份/清理 .dsh 时会连它一起带走，建议换到独立目录。" });
  }
  const store = resolveStoreDir(abs, storeDir);
  if (!sameDrive(abs, store)) {
    warnings.push({
      code: "store-cross-drive",
      message: "pnpm store（" + store + "）与安装根（" + abs + "）不在同一盘：硬链接去重失效，node_modules 会真实占用磁盘，迁移收益大幅下降。"
    });
  }
  return { ok: problems.length === 0, problems, warnings, root: abs, storeDir: store };
}
