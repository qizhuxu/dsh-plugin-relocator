/**
 * 操作日志与实时进度。
 * - journal.ndjson：只追加，记录每次迁移/体检/回滚的全过程，供 UI 查看与"一键回滚"取参数
 * - active：进程内当前操作快照，供 UI 轮询进度条
 * 所有阶段都带耗时与结果，失败时保留完整错误文本，不做黑箱。
 */
import fs from "node:fs";
import path from "node:path";
import { appendLine, readJson, writeJsonAtomic } from "./paths.js";

export class Journal {
  constructor(file, options = {}) {
    this.file = file;
    this.indexFile = file.replace(/\.ndjson$/, ".index.json");
    this.maxKeep = options.maxKeep ?? 300;
    // 单槽 active 会让并发操作互相覆盖进度，因此改成 actives（按 id 索引），
    // active 只作为"最近一条"的兼容别名保留。
    this.actives = new Map();
    this.active = null;
    this.seq = 0;
    this.listeners = options.listeners ?? [];
    this.live = new Map();
  }

  /** 订阅日志事件（kind: begin / step / warn / end）。 */
  on(listener) {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** 取一条正在进行的记录（供 step/progress 使用）。 */
  get(id) {
    return this.live.get(id) ?? null;
  }

  begin({ op, plugin, mode, meta = {} }) {
    const id = op + "-" + Date.now().toString(36) + "-" + (this.seq++).toString(36);
    const record = {
      id,
      op,
      plugin,
      mode: mode ?? null,
      meta,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      steps: [],
      error: null
    };
    const snapshot = {
      id,
      opId: id,
      op,
      plugin,
      mode: record.mode,
      percent: 0,
      phase: "准备中",
      step: null,
      message: "",
      files: 0,
      totalFiles: 0,
      bytes: 0,
      totalBytes: 0,
      startedAt: record.startedAt,
      steps: record.steps
    };
    this.actives.set(id, snapshot);
    this.active = snapshot;
    this.live.set(id, record);
    this.#emit("begin", record);
    return record;
  }

  /** 记录一个阶段；fn 可以是 async。异常会记进 steps 后继续抛出。 */
  async step(record, name, fn, options = {}) {
    const startedAt = Date.now();
    const entry = { name, status: "running", detail: "", startedAt, ms: 0 };
    record.steps.push(entry);
    this.progress({ phase: name, step: name, message: options.message ?? "" }, record.id);
    try {
      const result = await fn();
      entry.status = "ok";
      entry.detail = typeof result === "string" ? result : result == null ? "" : JSON.stringify(result).slice(0, 2000);
      if (result && typeof result === "object" && result.__detail === undefined && options.detailKey) {
        entry.detail = String(result[options.detailKey] ?? entry.detail);
      }
      return result;
    } catch (error) {
      entry.status = "failed";
      entry.detail = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      entry.ms = Date.now() - startedAt;
      entry.finishedAt = Date.now();
      this.#emit("step", record);
    }
  }

  warn(record, name, detail) {
    if (!record) {
      // 后台任务失败时可能还没有归属记录：自己造一条，保证日志里一定看得见。
      const fallback = {
        id: "warn-" + Date.now().toString(36) + "-" + (this.seq++).toString(36),
        op: "warn",
        plugin: null,
        mode: null,
        meta: {},
        status: "warn",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        steps: [{ name, status: "warn", detail: String(detail ?? ""), startedAt: Date.now(), finishedAt: Date.now(), ms: 0 }],
        error: null
      };
      this.#append(fallback);
      this.#emit("warn", fallback);
      return fallback;
    }
    record.steps.push({ name, status: "warn", detail, startedAt: Date.now(), finishedAt: Date.now(), ms: 0 });
    this.#emit("warn", record);
    return record;
  }

  /**
   * 更新进度。opId 省略时更新"最近一条"（兼容旧调用）。
   * 除了百分比，还接受 files/totalFiles/bytes/totalBytes/step —— 界面要显示"已处理/总数"。
   */
  progress(patch, opId) {
    const target = opId ? this.actives.get(opId) : this.active;
    if (!target) return;
    Object.assign(target, patch);
    if (typeof patch.percent === "number") target.percent = Math.max(0, Math.min(100, Math.round(patch.percent)));
    if (typeof patch.message === "string" && patch.message.length > 300) target.message = patch.message.slice(-300);
  }

  end(record, status, extra = {}) {
    record.status = status;
    record.finishedAt = Date.now();
    if (extra.error) record.error = String(extra.error instanceof Error ? extra.error.message : extra.error);
    if (extra.result !== undefined) record.result = extra.result;
    if (extra.rollback !== undefined) record.rollback = extra.rollback;
    this.#append(record);
    this.live.delete(record.id);
    this.actives.delete(record.id);
    if (this.active && this.active.id === record.id) {
      const rest = [...this.actives.values()];
      this.active = rest.length ? rest[rest.length - 1] : null;
    }
    this.#emit("end", record);
    return record;
  }

  #append(record) {
    try {
      appendLine(this.file, JSON.stringify(record));
      this.#trim();
    } catch {
      /* 日志写不进去不能影响主流程 */
    }
  }

  #trim() {
    try {
      const text = fs.readFileSync(this.file, "utf8");
      const lines = text.split("\n").filter(Boolean);
      if (lines.length <= this.maxKeep) return;
      const kept = lines.slice(lines.length - this.maxKeep);
      writeJsonAtomic(this.indexFile, { trimmedAt: Date.now(), kept: kept.length });
      fs.writeFileSync(this.file, kept.join("\n") + "\n", "utf8");
    } catch {
      /* ignore */
    }
  }

  history(limit = 50) {
    try {
      const lines = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean);
      const out = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
        const parsed = (() => {
          try {
            return JSON.parse(lines[i]);
          } catch {
            return null;
          }
        })();
        if (parsed) out.push(parsed);
      }
      return out;
    } catch {
      return [];
    }
  }

  last() {
    return this.history(1)[0] ?? null;
  }

  #emit(kind, record) {
    for (const listener of this.listeners) {
      try {
        listener(kind, record);
      } catch {
        /* ignore */
      }
    }
  }

  snapshot() {
    return { active: this.active, actives: [...this.actives.values()], last: this.last() };
  }
}
