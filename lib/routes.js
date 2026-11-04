/**
 * 同源 HTTP 接口。全部 POST + JSON，沿用 DSH 官方插件（dsh-image-gen）的握手范式：
 *   sameOrigin → method → content-type → 读体解析 → {ok:true,...} / {ok:false,error}
 */
import path from "node:path";
import { humanBytes, exists, measureTree } from "./paths.js";

const MAX_BODY_BYTES = 64 * 1024;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function jsonError(res, status, error) {
  json(res, status, { ok: false, error: String(error?.message ?? error) });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * services: { config, saveConfig, paths, journal, locks, migrator, doctor, listAll, recommendAll, version }
 */
export function createRouter(services) {
  const {
    home,
    profileDir,
    journal,
    locks,
    migrator,
    configState,
    saveConfig,
    validateRoot,
    listAll,
    measureAll,
    recommendAll,
    runDoctor,
    loadDoctorReport,
    ignoredSetter,
    policySetter,
    rootSetter,
    rootFor,
    orphanBodies,
    purgeRollback,
    purgePaths,
    version
  } = services;

  /** 让长任务在后台跑：立刻返回，进度靠 /progress 轮询。 */
  const background = new Map();
  const start = (key, fn) => {
    if (background.has(key)) return { started: false, reason: "同一个操作正在进行中：" + key };
    const promise = Promise.resolve()
      .then(fn)
      .catch((error) => {
        journal.warn(null, "background", String(error?.message ?? error));
      })
      .finally(() => background.delete(key));
    background.set(key, promise);
    return { started: true, key };
  };

  const handlers = {
    "GET /status": () => ({
      ok: true,
      version,
      home,
      profileDir,
      config: configState(),
      drives: migrator.checkDrives(),
      locks: locks.list(),
      journal: journal.snapshot(),
      homeSize: null
    }),

    "POST /config/get": () => ({ ok: true, config: configState() }),

    "POST /config/set": async (body) => {
      const patch = body?.config ?? {};
      const saved = await saveConfig(patch);
      const check = validateRoot(saved.root, saved.storeDir, { create: body?.create === true });
      return { ok: true, config: saved, check };
    },

    "POST /config/validate": (body) => ({
      ok: true,
      check: validateRoot(body?.root ?? configState().root, body?.storeDir ?? configState().storeDir, { create: body?.create === true })
    }),

    "POST /plugins/list": async (body) => {
      const result = await listAll({ withDeps: body?.withDeps !== false, measure: body?.measure === true });
      return { ok: true, ...result };
    },

    "POST /plugins/measure": (body) => {
      if (body?.name) return measureAll({ names: [body.name] }).then((rows) => ({ ok: true, rows }));
      return { ok: true, ...start("measure-all", () => measureAll({})) };
    },

    "POST /recommend": async (body) => {
      const result = await recommendAll({ measure: body?.measure === true });
      return { ok: true, ...result };
    },

    "POST /ignore/set": async (body) => {
      if (!body?.name) throw new Error("缺少插件名");
      await ignoredSetter(body.name, body.ignored !== false);
      return { ok: true, name: body.name, ignored: body.ignored !== false };
    },

    "POST /policy/set": async (body) => {
      if (!body?.name) throw new Error("缺少插件名");
      await policySetter(body.name, body.policy ?? "inherit");
      return { ok: true, name: body.name, policy: body.policy ?? "inherit" };
    },

    "POST /migrate/out": (body) => {
      if (!body?.name) throw new Error("缺少插件名");
      const options = {
        force: body.force === true,
        // body: "move" 连 file: 本体一起搬（完全体），"keep" 只搬 node_modules 一侧；缺省按 config.bodyMode
        body: body.body === "move" || body.body === "keep" ? body.body : null,
        root: typeof body.root === "string" && body.root ? body.root : null
      };
      return start("migrate:" + body.name, () => migrator.migrateOut(body.name, options)).started === false
        ? { ok: false, error: "该插件已有迁移在进行中" }
        : { ok: true, started: true, name: body.name, action: "out", body: options.body ?? "auto", root: options.root };
    },

    /** 给单个插件指定安装根（空串 = 回到全局根）。 */
    "POST /root/set": async (body) => {
      if (!body?.name) throw new Error("缺少插件名");
      const saved = await rootSetter(body.name, body?.root ?? "");
      const effective = rootFor(saved, body.name);
      const check = effective ? validateRoot(effective, saved.storeDir, { create: body?.create === true }) : null;
      return { ok: true, config: saved, root: effective, check };
    },

    /** 扫 <DSH_HOME>/plugins 下的孤儿本体（没有任何 file: 依赖引用它们）。 */
    "POST /body/scan": () => ({ ok: true, ...orphanBodies() }),

    /** 清理孤儿本体：给 opId 时连回收点一起清，只给 paths 时按孤儿本体清。 */
    "POST /body/purge": (body) => {
      const relink = body?.relinkReferencing === true;
      if (body?.opId) {
        const extraPaths = Array.isArray(body.extraPaths) ? body.extraPaths.map((item) => String(item)) : [];
        return { ok: true, ...purgeRollback(body.opId, extraPaths, relink) };
      }
      const paths = Array.isArray(body?.paths) ? body.paths.map((item) => String(item)) : [];
      if (paths.length === 0) throw new Error("缺少 opId 或 paths");
      return { ok: true, ...purgePaths(paths, relink) };
    },

    "POST /migrate/restore": (body) => {
      if (!body?.name) throw new Error("缺少插件名");
      const result = start("restore:" + body.name, () => migrator.restore(body.name, { force: body.force === true }));
      return result.started === false ? { ok: false, error: "该插件已有迁移在进行中" } : { ok: true, started: true, name: body.name, action: "restore" };
    },

    "POST /migrate/rollback": (body) => {
      if (!body?.opId) throw new Error("缺少 opId");
      const result = start("rollback:" + body.opId, () => migrator.rollback(body.opId));
      return result.started === false ? { ok: false, error: "该回滚正在进行中" } : { ok: true, started: true, opId: body.opId };
    },

    "POST /migrate/purge": (body) => {
      if (!body?.opId) throw new Error("缺少 opId");
      return { ok: true, ...migrator.purgeRollback(body.opId, { relinkReferencing: body.relinkReferencing === true }) };
    },

    "POST /rollback/list": () => ({ ok: true, items: migrator.rollbackList() }),

    "POST /doctor/run": () => {
      const result = start("doctor", () => runDoctor());
      return result.started === false ? { ok: false, error: "体检已经在进行中" } : { ok: true, started: true };
    },

    "POST /doctor/report": () => {
      const report = loadDoctorReport();
      return report ? { ok: true, report, cached: true } : { ok: false, error: "还没有体检报告，请先运行体检" };
    },

    "POST /progress": () => ({ ok: true, ...journal.snapshot() }),

    "POST /history": (body) => ({ ok: true, items: journal.history(Math.min(200, body?.limit ?? 50)) }),

    "POST /open/path": async (body) => {
      const target = String(body?.path ?? "");
      if (!target) throw new Error("缺少路径");
      const allowed = [home, configState().root].filter(Boolean);
      if (!allowed.some((root) => path.resolve(target).toLowerCase().startsWith(path.resolve(root).toLowerCase()))) {
        throw new Error("只能打开 .dsh 或插件根目录以内的路径");
      }
      if (!exists(target)) throw new Error("路径不存在：" + target);
      const { spawn } = await import("node:child_process");
      spawn("explorer.exe", [path.resolve(target)], { detached: true, windowsHide: false }).unref();
      return { ok: true, opened: path.resolve(target) };
    }
  };

  const names = Object.keys(handlers).map((key) => key.split(" ")[1]);

  async function handle(urlPath, req, res) {
    const method = req.method ?? "GET";
    const key = method + " " + urlPath;
    let handler = handlers[key];
    if (!handler && method === "POST") handler = handlers["POST " + urlPath];
    if (!handler) {
      // 兼容把动作放在 body 里的调用方式
      if (method === "POST") {
        try {
          const body = await readBody(req);
          const action = body?.action ? "/" + String(body.action).replace(/^\//, "") : null;
          if (action && handlers["POST " + action]) {
            const result = await handlers["POST " + action](body);
            return json(res, 200, result);
          }
        } catch {
          /* fallthrough */
        }
      }
      return jsonError(res, 404, new Error("未知接口：" + key));
    }
    if (method !== "POST" && method !== "GET") return jsonError(res, 405, new Error("method-not-allowed"));
    if (method === "POST") {
      const contentType = String(req.headers["content-type"] ?? "");
      if (!contentType.includes("application/json")) return jsonError(res, 415, new Error("json-required"));
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        return jsonError(res, 400, error);
      }
      try {
        return json(res, 200, await handler(body));
      } catch (error) {
        return jsonError(res, 502, error);
      }
    }
    try {
      return json(res, 200, await handler({}));
    } catch (error) {
      return jsonError(res, 502, error);
    }
  }

  return { handle, names, sameOrigin, json, jsonError };
}
