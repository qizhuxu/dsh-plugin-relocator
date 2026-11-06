/**
 * dsh-plugin-relocator —— 宿主半身。
 *
 * 把插件安装到用户指定目录，并给每个插件一份独立的 node_modules / pnpm-lock.yaml / .npmrc；
 * 提供体检、智能推荐、迁出/恢复/回滚与完整的操作日志。
 * 界面半身在 ./client.js，二者通过同源 HTTP 接口（ROUTE 前缀）通信。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Journal } from "./journal.js";
import { Locks } from "./lock.js";
import { SizeCache } from "./sizes.js";
import {
  loadConfig,
  saveConfig as persistConfig,
  validateRoot as validateRootImpl,
  setPluginOverride,
  pluginOverride,
  resolveStoreDir,
  configFile,
  rootFor,
  setPluginRoot
} from "./config.js";
import { listPlugins, measurePlugin, readProfile, pluginRow } from "./scan.js";
import { recommend } from "./recommend.js";
import { Migrator, bodyReferences } from "./migrate.js";
import { Externals } from "./external.js";
import { runDoctor } from "./doctor.js";
import { createRouter } from "./routes.js";
import { resolveDshHome, profileDirOf, measureTree, humanBytes, readJson, writeJsonAtomic, exists } from "./paths.js";

export const name = "dsh-plugin-relocator";
export const inject = ["webServer"];

const ROUTE = "/api/dsh-plugin-relocator";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function ownVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function apply(ctx, pluginConfig = {}) {
  const home = resolveDshHome();
  const profileDir = profileDirOf(home);
  const baseDir = path.join(home, "plugin-relocator");
  fs.mkdirSync(baseDir, { recursive: true });

  const journal = new Journal(path.join(baseDir, "journal.ndjson"));
  const locks = new Locks(path.join(baseDir, "locks.json"));
  const sizeCache = new SizeCache(path.join(baseDir, "size-cache.json"));

  let config = loadConfig(home, pluginConfig);
  const migrator = new Migrator({ home, profileDir, config, journal, locks });
  // 外置插件清单与生命周期（重新挂载 / 摘除 / 检查更新 / 更新 / 移除）。
  const externals = new Externals({ home, profileDir, config, journal, locks, sizeCache });

  /** 因为 config 是 Milo 的浅合并对象，任何改写都要同步给 migrator。 */
  const applyConfig = (next) => {
    config = next;
    migrator.config = next;
    externals.config = next;
    return config;
  };

  const saveConfig = async (patch) => {
    const merged = persistConfig(home, patch ?? {});
    return applyConfig(merged);
  };

  const configState = () => ({
    ...config,
    root: config.root ?? "",
    storeDir: resolveStoreDir(config.root, config.storeDir),
    effectiveStoreDir: resolveStoreDir(config.root, config.storeDir),
    configFile: configFile(home),
    registry: config.registry ?? "https://registry.npmmirror.com/"
  });

  const validateRoot = (root, storeDir, options) => validateRootImpl(home, root, storeDir, options);

  const snapshotRows = ({ withDeps = false } = {}) => {
    const result = listPlugins({ profileDir, config, sizeCache, withDeps });
    // 标记原生大件：命中 Ghidra/JDK/.dll/.exe 之类
    for (const row of result.rows) {
      row.nativeHeavy = row.nativeHeavy ?? false;
    }
    return result;
  };

  const measureRows = (rows) => {
    for (const row of rows) {
      if (!row.realPath) continue;
      try {
        row.size = measurePlugin(row, sizeCache);
        if (row.size && !row.nativeHeavy && row.size.bytes >= 20 * 1024 * 1024 && row.realPath) {
          row.nativeHeavy = guessNative(row.realPath);
        }
      } catch {
        /* 单个插件测不动不影响其它 */
      }
    }
    sizeCache.prune(rows.map((row) => row.realPath).filter(Boolean));
    sizeCache.save();
    return rows;
  };

  const listAll = async ({ withDeps = true, measure = false } = {}) => {
    const result = snapshotRows({ withDeps });
    if (measure) measureRows(result.rows);
    else {
      for (const row of result.rows) {
        const cached = sizeCache.get(row.realPath);
        if (cached) row.size = cached;
      }
    }
    return result;
  };

  const measureAll = async ({ names } = {}) => {
    const result = snapshotRows({ withDeps: false });
    const selected = names?.length ? result.rows.filter((row) => names.includes(row.name)) : result.rows;
    measureRows(selected);
    return selected;
  };

  const recommendAll = async ({ measure = false } = {}) => {
    const result = snapshotRows({ withDeps: true });
    if (measure) measureRows(result.rows);
    else {
      for (const row of result.rows) {
        const cached = sizeCache.get(row.realPath);
        if (cached) row.size = cached;
      }
    }
    return recommend(result.rows, { config, history: journal.history(400) });
  };

  const ignoredSetter = async (plugin, ignored) => {
    setPluginOverride(config, plugin, { ignored: ignored === true });
    writeJsonAtomic(configFile(home), config);
    return true;
  };

  const policySetter = async (plugin, policy) => {
    setPluginOverride(config, plugin, { policy });
    writeJsonAtomic(configFile(home), config);
    return true;
  };

  /** 给单个插件指定安装根（空串 = 取消覆盖，回到全局根）。 */
  const rootSetter = async (plugin, root) => {
    if (!plugin) throw new Error("缺少插件名");
    const merged = setPluginRoot(home, config, plugin, root ?? "");
    return applyConfig(merged);
  };

  /** <DSH_HOME>/plugins 下没有被 profile 依赖引用的孤儿本体（附带是被哪些 profile 引用的）。 */
  const orphanBodies = () => {
    const data = migrator.orphanBodies();
    const references = bodyReferences(home);
    const orphans = (data.orphans ?? []).map((item) => {
      const refs = references.get(String(item.dir).toLowerCase()) ?? [];
      return { ...item, referencedBy: refs.map((ref) => ref.profile + "/" + ref.depName), referenceCount: refs.length };
    });
    return { ...data, orphans };
  };

  /** 清理回收点（可附带受校验的孤儿本体）。 */
  const purgeRollback = (opId, extraPaths, relinkReferencing) => migrator.purgeRollback(opId, { extraPaths: extraPaths ?? [], relinkReferencing: relinkReferencing === true });

  /** 清理孤儿本体（不依赖某次回收点记录）。 */
  const purgePaths = (paths, relinkReferencing) => migrator.purgePaths(paths ?? [], { relinkReferencing: relinkReferencing === true });

  const runDoctorOperation = async () => {
    // 体检也要留痕：进度条与操作历史里都要看得见（否则用户点完按钮没有任何反馈）。
    const record = journal.begin({ op: "doctor", plugin: null, mode: "doctor", meta: {} });
    try {
      const report = await runDoctor({
        home,
        profileDir,
        onProgress: (progress) =>
          journal.progress({ phase: "doctor", message: "已扫描 " + progress.files + " 个文件：" + progress.current, percent: Math.min(95, (progress.files / 200000) * 100) })
      });
      writeJsonAtomic(path.join(baseDir, "doctor-report.json"), report);
      journal.end(record, "ok", {
        result: { files: report?.totals?.files ?? null, bytes: report?.totals?.bytes ?? null, reclaimSafeHuman: report?.reclaimSafeHuman ?? null }
      });
      return report;
    } catch (error) {
      journal.end(record, "failed", { error: String(error?.message ?? error) });
      throw error;
    }
  };

  const loadDoctorReport = () => readJson(path.join(baseDir, "doctor-report.json"), null);

  const router = createRouter({
    home,
    profileDir,
    journal,
    locks,
    migrator,
    externals,
    configState,
    saveConfig,
    validateRoot,
    listAll,
    measureAll,
    recommendAll,
    runDoctor: runDoctorOperation,
    loadDoctorReport,
    ignoredSetter,
    policySetter,
    rootSetter,
    rootFor,
    orphanBodies,
    purgeRollback,
    purgePaths,
    version: ownVersion()
  });

  applyConfig(config);

  ctx.inject(["webServer"], (webCtx) => {
    const dispose = webCtx.webServer.register({
      kind: "prefix",
      path: ROUTE,
      handler: async (req, res) => {
        try {
          if (!router.sameOrigin(req)) return router.jsonError(res, 403, new Error("origin-rejected"));
          const raw = (req.url ?? "").split("?")[0];
          let remainder = raw.startsWith(ROUTE) ? raw.slice(ROUTE.length) : raw;
          if (!remainder || remainder === "/") remainder = "/status";
          await router.handle(decodeURIComponent(remainder), req, res);
        } catch (error) {
          try {
            router.jsonError(res, 500, error);
          } catch {
            /* 连接可能已断开 */
          }
        }
      }
    });
    webCtx.effect(
      () => {
        return () => {
          try {
            dispose();
          } catch {
            /* ignore */
          }
          sizeCache.save();
        };
      },
      "dsh-plugin-relocator: 同源 HTTP 接口 " + ROUTE
    );
    ctx.logger?.info?.("dsh-plugin-relocator 已挂载：" + ROUTE);
  });

  return { migrator, externals, journal, locks, sizeCache, route: ROUTE };
}

/** 粗判是否有原生大件（只需要一个信号，不做全量遍历）。 */
function guessNative(root, budget = 400) {
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < budget) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (/\.(dll|exe|node|so|dylib|jar)$/i.test(entry.name)) return true;
      if (/^(ghidra|jdk|jre|runtimes?)$/i.test(entry.name)) return true;
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      if (seen >= budget) break;
    }
  }
  return false;
}
