/**
 * 智能推荐：全部规则可解释、可配置，不做黑箱打分。
 *
 * 迁出的**前置条件**（任一不满足则直接列入 blocked，不允许迁出）：
 *   1. 不是 DSH 核心/安装侧包（@deepseek-ai/* 或 bundles 里由安装侧提供的）
 *   2. 已实际安装
 *   3. 依赖自洽：没有"靠 hoisted 白拿"的隐式依赖（除非强制）
 */
import { isProtected } from "./scan.js";

const MB = 1024 * 1024;

export function defaultRules(config = {}) {
  const oversizeMB = Number(config.oversizeMB ?? 100);
  return [
    {
      code: "oversize",
      weight: 40,
      text: (row) => "真实占用 " + row.size.human + "，超过阈值 " + oversizeMB + " MB",
      hit: (row) => (row.size?.bytes ?? 0) >= oversizeMB * MB
    },
    {
      code: "huge-file-count",
      weight: 12,
      text: (row) => "文件数 " + row.size.files.toLocaleString("en-US") + "，每次 pnpm reconcile 都要重排这么多目录项",
      hit: (row) => (row.size?.files ?? 0) >= 5000
    },
    {
      code: "native-payload",
      weight: 15,
      text: (row) => "内含原生二进制/大运行时（Ghidra、JDK、.dll/.exe/.node），这种东西最适合独立目录",
      hit: (row) => row.nativeHeavy === true
    },
    {
      code: "own-deps",
      weight: 8,
      text: (row) => "自带 " + row.deps.runtimeDeclared.length + " 个运行时依赖，独立依赖目录后才真正与主 profile 解耦",
      hit: (row) => (row.deps?.runtimeDeclared?.length ?? 0) > 0
    },
    {
      code: "no-deps",
      weight: 4,
      text: () => "没有任何私有依赖，迁出只是普通的目录搬移，零风险",
      hit: (row) => (row.deps?.runtimeDeclared?.length ?? 0) === 0
    },
    {
      code: "disabled-but-installed",
      weight: 6,
      text: () => "在配置里已禁用，却仍占着依赖树的位置",
      hit: (row) => row.disabled === true
    },
    {
      code: "update-churn",
      weight: 6,
      text: (row) => "历史上有 " + row.operations + " 次装/卸/更新记录，正是最容易触发整树 reconcile 的类型",
      hit: (row) => (row.operations ?? 0) >= 2
    },
    {
      code: "hardlink-shared",
      weight: 0,
      text: (row) =>
        row.fileSpec
          ? "本体是 file: 源（" + row.spec + "）：绝大部分字节与 .dsh\\plugins 下的本体硬链接共享，只迁 node_modules 一侧不会缩小 .dsh"
          : "真实占用里有 " + (row.size?.sharedHuman ?? "大部分") + " 与 pnpm store 硬链接共享，单独迁出不会释放这部分空间",
      hit: (row) => Number(row.size?.sharedBytes ?? 0) >= Math.max(1, Number(row.size?.bytes ?? 0)) * 0.9
    },
    {
      code: "client-half",
      weight: 3,
      text: () => "带界面半身；迁移后仍走同一条 Loader 解析链，客户端 bundle 按 mtime/size 热更新",
      hit: (row) => row.deps?.hasClient === true
    }
  ];
}

/** 统计每个插件在操作历史里出现的次数（用于 update-churn 规则）。 */
export function operationCounts(history = []) {
  const counts = new Map();
  for (const record of history) {
    const name = record?.plugin;
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function strengthOf(score) {
  if (score >= 55) return "strong";
  if (score >= 30) return "medium";
  if (score > 0) return "weak";
  return "none";
}

/**
 * rows: listPlugins(..., {withDeps:true}).rows
 * 返回 { candidates, blocked, ignored, rules }
 */
export function recommend(rows, { config = {}, history = [] } = {}) {
  const rules = defaultRules(config);
  const counts = operationCounts(history);
  const ignoredNames = new Set(
    Object.entries(config.plugins ?? {})
      .filter(([, value]) => value?.ignored === true)
      .map(([name]) => name)
  );
  const candidates = [];
  const blocked = [];
  const ignored = [];

  for (const row of rows) {
    const enriched = {
      ...row,
      operations: counts.get(row.name) ?? 0,
      nativeHeavy: row.nativeHeavy === true
    };
    if (row.ignored === true || ignoredNames.has(row.name)) {
      ignored.push({ ...enriched, reasons: [{ code: "ignored", weight: 0, text: "已被手动忽略" }] });
      continue;
    }
    const preconditions = [];
    if (row.protected) {
      preconditions.push({ code: "protected", text: "DSH 核心或安装侧自带的包，不允许迁出" });
    }
    if (!row.installed) {
      preconditions.push({ code: "not-installed", text: "当前并没有安装在 profile 里" });
    }
    if (row.location === "external") {
      preconditions.push({ code: "already-external", text: "已经在外置目录里了" });
    }
    if (row.deps && row.deps.ok === false) {
      const names = row.deps.risks.map((risk) => risk.name).join("、");
      preconditions.push({
        code: "implicit-deps",
        text: "存在未声明、只能靠 hoisted 白拿的依赖：" + names + "（迁出后会 MODULE_NOT_FOUND）"
      });
    }
    if (!config.root) {
      preconditions.push({ code: "no-root", text: "还没有设置插件安装根目录" });
    }
    if (!row.realPath) {
      preconditions.push({ code: "unreadable", text: "读不到插件目录" });
    }

    const reasons = rules
      .filter((rule) => {
        try {
          return rule.hit(enriched);
        } catch {
          return false;
        }
      })
      .map((rule) => ({ code: rule.code, weight: rule.weight, text: rule.text(enriched) }));

    const score = reasons.reduce((sum, reason) => sum + reason.weight, 0);
    const item = {
      ...enriched,
      score,
      strength: strengthOf(score),
      reasons,
      preconditions,
      blocked: preconditions.length > 0,
      estimatedExclusive: row.size?.exclusiveBytes ?? 0,
      estimatedExclusiveHuman: row.size?.exclusiveHuman ?? ((row.size?.exclusiveBytes ?? 0) / MB).toFixed(1) + " MB"
    };
    if (preconditions.length > 0) blocked.push(item);
    else candidates.push(item);
  }

  candidates.sort((a, b) => b.score - a.score);
  blocked.sort((a, b) => b.score - a.score);
  const gain = candidates.reduce((sum, item) => sum + (item.estimatedExclusive ?? 0), 0);
  return {
    candidates,
    blocked,
    ignored,
    rules: rules.map((rule) => ({ code: rule.code, weight: rule.weight })),
    summary: {
      candidateCount: candidates.length,
      blockedCount: blocked.length,
      ignoredCount: ignored.length,
      estimatedGainBytes: gain,
      estimatedGainHuman: (gain / MB).toFixed(1) + " MB",
      gainNote: "预计可释放 = 独占字节（nlink==1，只被这份插件引用）。与 pnpm store 或 .dsh 其它位置硬链接共享的字节，搬走也不会释放。"
    }
  };
}
