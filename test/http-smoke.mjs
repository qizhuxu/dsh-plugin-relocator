#!/usr/bin/env node
/**
 * 宿主半身冒烟测试：不启动 DSH，把插件注册的路由挂到真实 http 服务器上逐个打接口。
 *
 * 覆盖：
 *   - 路由注册契约（prefix + 同源校验 + effect 释放）
 *   - 配置读写 / 校验、插件清单、推荐
 *   - 迁出（后台任务）→ 回滚点 → 一键回滚，全程通过 HTTP 驱动
 *   - 体检（后台任务）→ 体检报告
 *   - 握手边界：异源 403、缺 content-type 415、未知接口 404、坏 body 400
 *
 * 用法：node test/http-smoke.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAB = path.join(repo, ".lab-http");
const HOME = path.join(LAB, "home");
const PROFILE = path.join(HOME, "profiles", "desktop");
const OUT = path.join(LAB, "out");
const NAME = "smoke-plugin";
const PLUGIN_DIR = path.join(PROFILE, "node_modules", NAME);
const ROUTE = "/api/dsh-plugin-relocator";

let passed = 0;
let failed = 0;
function section(title) {
  console.log("");
  console.log("=== " + title + " ===");
}
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("  [PASS] " + label + (detail ? "   (" + detail + ")" : ""));
  } else {
    failed += 1;
    console.log("  [FAIL] " + label + (detail ? "   (" + detail + ")" : ""));
  }
}
function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}
function writeJson(file, value) {
  writeFile(file, JSON.stringify(value, null, 2) + "\n");
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------ 实验室 ------------------------------ */
section("0. 搭建一次性 DSH_HOME（不碰真实 .dsh）");
fs.rmSync(LAB, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

writeJson(path.join(PLUGIN_DIR, "package.json"), {
  name: NAME,
  version: "1.0.0",
  type: "module",
  main: "lib/index.js",
  exports: { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  dependencies: {},
  dsh: { client: { platform: "web", inject: [] } }
});
writeFile(path.join(PLUGIN_DIR, "lib", "index.js"), 'export const name = "smoke-plugin";\nexport function apply() {}\n');
writeFile(
  path.join(PLUGIN_DIR, "lib", "client.js"),
  'window.__ModuleLoader__.load({ id: "smoke-plugin", factory: (require) => ({ apply: () => {}, inject: [] }) });\n'
);
writeJson(path.join(PROFILE, "package.json"), {
  name: "desktop",
  private: true,
  dependencies: { [NAME]: "1.0.0" },
  dsh: { profile: { bundles: [NAME] } }
});
check("实验室就绪", fs.existsSync(path.join(PROFILE, "package.json")), PROFILE);

process.env.DSH_HOME = HOME;
const mod = await import("../lib/index.js");

let route = null;
const effects = [];
const ctx = {
  inject(names, callback) {
    check("宿主声明了 webServer 依赖", Array.isArray(names) && names.includes("webServer"), JSON.stringify(names));
    callback({
      webServer: {
        register(spec) {
          route = spec;
          return () => {
            route = null;
          };
        }
      },
      effect(fn, label) {
        effects.push({ fn, label });
      }
    });
  },
  logger: { info() {} }
};

section("1. 路由注册契约");
const api = mod.apply(ctx, { root: OUT, registry: "https://registry.npmmirror.com/" });
check("注册了 prefix 路由且路径正确", !!route && route.kind === "prefix" && route.path === ROUTE, route ? route.kind + " " + route.path : "未注册");
check("effect 说明里带路由（可回收）", effects.length === 1 && String(effects[0].label).includes(ROUTE), effects.map((e) => e.label).join(" | "));
check("apply 返回 migrator/journal/route", !!api.migrator && !!api.journal && api.route === ROUTE);

const server = http.createServer((req, res) => route.handler(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = "http://127.0.0.1:" + port + ROUTE;

async function post(action, body, headers = {}) {
  const response = await fetch(base + "/" + action, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {})
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}
async function get(action) {
  const response = await fetch(base + "/" + action);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}
/** 轮询操作历史，等某个操作跑完（后台任务都是异步的）。 */
async function waitForOp(op, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { payload } = await post("history", { limit: 20 });
    const hit = (payload?.items ?? []).find((item) => item.op === op && item.status !== "running");
    if (hit) return hit;
    await sleep(150);
  }
  return null;
}

section("2. 只读接口");
{
  const status = await get("status");
  check("GET /status 可用", status.status === 200 && status.payload?.ok === true, "HTTP " + status.status);
  check("/status 报告 profileDir 与版本", status.payload?.profileDir === PROFILE && !!status.payload?.version, String(status.payload?.version));
  check("/status 带盘符判定", !!status.payload?.drives, JSON.stringify(status.payload?.drives?.rootStoreSameDrive));

  const config = await post("config/get");
  check("POST /config/get 返回根目录", config.payload?.config?.root === OUT, String(config.payload?.config?.root));

  const check1 = await post("config/validate", { root: OUT, storeDir: path.join(OUT, ".store", "v11") });
  check("POST /config/validate 通过", check1.payload?.check?.ok === true, JSON.stringify(check1.payload?.check?.problems));

  const check2 = await post("config/validate", { root: "", storeDir: "" });
  check("空根目录被判为不可用", check2.payload?.check?.ok === false && check2.payload?.check?.problems?.[0]?.code === "root-empty");

  const list = await post("plugins/list", { withDeps: false });
  const row = (list.payload?.rows ?? []).find((item) => item.name === NAME);
  check("插件清单里有 smoke-plugin", !!row, (list.payload?.rows ?? []).length + " 行");
  check("位置判定为 in-dsh", row?.location === "in-dsh", String(row?.location));

  const rec = await post("recommend");
  check("推荐接口返回规则与候选", Array.isArray(rec.payload?.rules) && !!rec.payload?.summary, "候选 " + (rec.payload?.summary?.candidateCount ?? "?"));
}

section("3. 迁出 → 回滚点 → 一键回滚（全程 HTTP）");
{
  const out = await post("migrate/out", { name: NAME });
  check("POST /migrate/out 受理", out.status === 200 && out.payload?.started === true, JSON.stringify(out.payload));
  const done = await waitForOp("out", 90000);
  check("迁出完成", !!done && done.status === "ok", done ? done.status + " / " + (done.error ?? "无错误") : "超时");

  const targetDir = path.join(OUT, NAME);
  check("外置目录生成", fs.existsSync(path.join(targetDir, "package.json")), targetDir);
  check(".dsh 侧变成 junction", fs.lstatSync(PLUGIN_DIR).isSymbolicLink());
  const pkg = JSON.parse(fs.readFileSync(path.join(PROFILE, "package.json"), "utf8"));
  check("profile 声明改写为 link:", String(pkg.dependencies[NAME]).startsWith("link:"), String(pkg.dependencies[NAME]));

  const rollback = await post("rollback/list");
  const entry = (rollback.payload?.items ?? []).find((item) => item.mode === "out" && item.undone !== true);
  check("回滚点已登记且带体积", !!entry && entry.backupExists === true, entry ? String(entry.backupBytes) + " B" : "未登记");

  const undo = await post("migrate/rollback", { opId: entry.opId });
  check("POST /migrate/rollback 受理", undo.payload?.started === true, JSON.stringify(undo.payload));
  const undone = await waitForOp("rollback", 90000);
  check("回滚完成", !!undone && undone.status === "ok", undone ? undone.status + " / " + (undone.error ?? "无错误") : "超时");
  check(".dsh 侧回到真实目录", !fs.lstatSync(PLUGIN_DIR).isSymbolicLink());
  check("外置目录已清掉", !fs.existsSync(targetDir));
  const pkg2 = JSON.parse(fs.readFileSync(path.join(PROFILE, "package.json"), "utf8"));
  check("profile 声明还原", pkg2.dependencies[NAME] === "1.0.0", String(pkg2.dependencies[NAME]));

  const history = await post("history", { limit: 10 });
  check("操作历史落盘（out + rollback）", (history.payload?.items ?? []).some((item) => item.op === "out") && (history.payload?.items ?? []).some((item) => item.op === "rollback"));
}

section("4. 体检");
{
  const started = await post("doctor/run");
  check("POST /doctor/run 受理", started.payload?.started === true, JSON.stringify(started.payload));
  const done = await waitForOp("doctor", 120000);
  check("体检任务结束", !!done, done ? done.status : "超时");
  const report = await post("doctor/report");
  check("体检报告可读", report.payload?.ok === true && !!report.payload?.report, JSON.stringify(Object.keys(report.payload?.report ?? {})));
  check("报告含可回收清单", Array.isArray(report.payload?.report?.reclaim), (report.payload?.report?.reclaim ?? []).length + " 项");
}

section("5. 握手边界");
{
  const foreign = await post("config/get", {}, { origin: "http://evil.example" });
  check("异源请求被拒（403）", foreign.status === 403 && String(foreign.payload?.error).includes("origin-rejected"), "HTTP " + foreign.status + " " + foreign.payload?.error);

  const noType = await fetch(base + "/config/get", { method: "POST", body: "{}" });
  check("缺 content-type 被拒（415）", noType.status === 415, "HTTP " + noType.status);

  const unknown = await post("nope/nothing");
  check("未知接口 404", unknown.status === 404 && String(unknown.payload?.error).includes("未知接口"), "HTTP " + unknown.status);

  const badBody = await fetch(base + "/config/get", { method: "POST", headers: { "content-type": "application/json" }, body: "{不是 json" });
  check("坏 JSON 被拒（400）", badBody.status === 400, "HTTP " + badBody.status);

  const missingName = await post("migrate/out", {});
  check("缺插件名返回 502+原因", missingName.status === 502 && String(missingName.payload?.error).includes("缺少插件名"), "HTTP " + missingName.status);
}

section("6. 释放");
{
  const effect = effects[0];
  const dispose = effect.fn();
  check("effect 返回释放函数", typeof dispose === "function");
  dispose();
  check("释放后路由已注销", route === null);
  await new Promise((resolve) => server.close(resolve));
  check("HTTP 服务器已关闭", server.listening === false);
}

console.log("");
console.log("==================================================");
console.log("  通过 " + passed + " 项，失败 " + failed + " 项");
console.log("  实验室目录：" + LAB);
console.log("==================================================");
process.exitCode = failed === 0 ? 0 : 1;
