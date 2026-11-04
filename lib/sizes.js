/**
 * 体积测量缓存：按真实路径 + mtime 记住上次结果，避免每次打开 UI 都重扫几十万文件。
 */
import { readJson, writeJsonAtomic } from "./paths.js";

/** 缓存结构版本：字段增减时 +1，旧条目自动失效（否则推荐页会拿着缺字段的旧记录显示“未测量”）。 */
export const SIZE_CACHE_VERSION = 2;

export class SizeCache {
  constructor(file) {
    this.file = file;
    this.data = readJson(file, {}) ?? {};
    this.dirty = false;
  }

  get(key) {
    const hit = this.data[key];
    if (!hit || hit.v !== SIZE_CACHE_VERSION) return null;
    return hit;
  }

  set(key, value) {
    this.data[key] = { ...value, v: SIZE_CACHE_VERSION };
    this.dirty = true;
  }

  delete(key) {
    if (this.data[key]) {
      delete this.data[key];
      this.dirty = true;
    }
  }

  /** 丢掉不在 keepPaths 里的陈旧记录（插件被卸载/搬走后） */
  prune(keepPaths) {
    const keep = new Set([...keepPaths].map((p) => p.toLowerCase()));
    for (const key of Object.keys(this.data)) {
      if (!keep.has(key.toLowerCase())) {
        delete this.data[key];
        this.dirty = true;
      }
    }
  }

  save() {
    if (!this.dirty) return false;
    writeJsonAtomic(this.file, this.data);
    this.dirty = false;
    return true;
  }
}
