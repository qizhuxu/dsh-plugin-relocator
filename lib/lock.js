/**
 * 每插件互斥锁：迁移/恢复期间禁止对同一插件并发操作。
 * 锁落在 <DSH_HOME>/plugin-relocator/locks.json，带 pid 与时间戳；
 * 进程崩溃后留下的锁会被判定为过期（pid 已死或超过 staleMs）自动回收。
 */
import path from "node:path";
import { readJson, writeJsonAtomic } from "./paths.js";

const STALE_MS = 30 * 60 * 1000;

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export class Locks {
  constructor(file) {
    this.file = file;
    this.memory = new Set();
  }

  #read() {
    const raw = readJson(this.file, {}) ?? {};
    return raw && typeof raw === "object" ? raw : {};
  }

  #write(value) {
    writeJsonAtomic(this.file, value);
  }

  /** 返回 { ok, holder } —— ok=false 表示别的操作正持有该插件。 */
  check(plugin) {
    if (this.memory.has(plugin)) return { ok: false, holder: { plugin, opId: "local", at: Date.now(), pid: process.pid } };
    const all = this.#read();
    const entry = all[plugin];
    if (!entry) return { ok: true };
    const stale = Date.now() - (entry.at ?? 0) > STALE_MS || !pidAlive(entry.pid);
    if (stale) {
      delete all[plugin];
      this.#write(all);
      return { ok: true, stale: true };
    }
    return { ok: false, holder: entry };
  }

  acquire(plugin, opId) {
    const state = this.check(plugin);
    if (!state.ok) {
      const holder = state.holder ?? {};
      throw new Error("插件 " + plugin + " 正在被另一个操作占用（" + (holder.opId ?? "?") + "，pid " + (holder.pid ?? "?") + "）。请等待其结束或先执行回滚。");
    }
    this.memory.add(plugin);
    const all = this.#read();
    all[plugin] = { opId, at: Date.now(), pid: process.pid };
    this.#write(all);
    return () => this.release(plugin);
  }

  release(plugin) {
    this.memory.delete(plugin);
    const all = this.#read();
    if (all[plugin]) {
      delete all[plugin];
      this.#write(all);
    }
  }

  list() {
    const all = this.#read();
    const out = [];
    for (const [plugin, entry] of Object.entries(all)) {
      const stale = Date.now() - (entry.at ?? 0) > STALE_MS || !pidAlive(entry.pid);
      out.push({ plugin, ...entry, stale });
    }
    return out;
  }
}
