/**
 * dsh-plugin-relocator —— 界面半身（浏览器侧）。
 *
 * 契约（与 DSH 官方界面插件一致）：
 *   - 外层用 window.__ModuleLoader__.load({ id, factory }) 包装
 *   - factory 内可 require("react") 以及 DSH 注入的虚拟模块
 *   - 导出 apply(ctx) 与 inject = [cordis 服务名]
 *   - 注册 settings.section，id 必须与包名一致
 *
 * UI 设计来源：ui-ux-pro-max（dsh-upm skill）
 *   - Design System：Developer Tool / IDE 色板 + Dark Mode (OLED) 风格
 *   - 拨盘：variance 4（均衡）、motion 3（克制）、density 8（密集仪表盘）
 *   - 关键决定：令牌一律「DSH 主题变量优先、UPM 色板兜底」，绝不覆盖宿主主题；
 *     语义状态用「淡色底 + 边框 + 符号 + 文字」表达，不靠颜色单独传达（对比度由宿主主题保证）
 *   - 已落实的规则：可见焦点环、hover/active/disabled 三态、表格横向滚动容器、
 *     粘性表头、数字右对齐 + tabular-nums、空状态给行动、错误就近显示 + 顶部汇总、
 *     aria-live 播报、意图 role=progressbar、prefers-reduced-motion 降级、破坏性操作两步确认
 * ui-version: upm-taste-6（/dsh-taste app-screen：achromatic-ledger 墨色 chrome + 宿主 --dsw-alias-* 令牌桥接）
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-relocator",
  factory: (require) => {
    const React = require("react");
    const NS = "plugin-relocator";
    const ROUTE = "/api/dsh-plugin-relocator";
    const PANEL_ID = "plugin-relocator";
    const UI_VERSION = "upm-ext-8";
    const STYLE_ID = "dsh-plugin-relocator-ui";
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;
    /* 图标：内联 SVG（1.5 描边、currentColor），不用 emoji 字符（taste lint 判 FAIL）。 */
    const ICONS = {
      check: [["path", { d: "M3 8.5l3.1 3.1L13 5" }]],
      cross: [["path", { d: "M4 4l8 8" }], ["path", { d: "M12 4l-8 8" }]],
      warn: [["path", { d: "M8 2.8l5.3 9.4H2.7L8 2.8z" }], ["path", { d: "M8 6.6v3.1" }], ["path", { d: "M8 11.7h.01" }]],
      ext: [["path", { d: "M6.5 4H12v5.5" }], ["path", { d: "M11.8 4.2L4.6 11.4" }]],
      search: [["circle", { cx: "7", cy: "7", r: "4.2" }], ["path", { d: "M10.2 10.2L13.8 13.8" }]],
      dot: [["circle", { cx: "8", cy: "8", r: "3.4", fill: "currentColor", stroke: "none" }]],
      ring: [["circle", { cx: "8", cy: "8", r: "3.2" }]]
    };
    const Ico = (name) =>
      h("svg", { className: "dshr-ico", width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
        "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" },
        (ICONS[name] ?? []).map(([tag, attrs], index) => h(tag, { key: index, ...attrs })));
    const IcoText = (name, text) => h(React.Fragment, null, Ico(name), text);

    /* ------------------------------- 文案 ------------------------------- */
    const DICT = {
      zh: {
        nav: "插件搬家",
        title: "插件搬家（dsh-plugin-relocator）",
        subtitle: "把插件装到你自己指定的盘，每个插件一份独立的 node_modules / lockfile / .npmrc，并支持安全迁移与一键回滚。",
        tabSettings: "全局设置",
        tabPlugins: "插件列表",
        tabRecommend: "智能推荐",
        tabLogs: "进度与日志",
    tabExternal: "外置插件",
    extSubHint: "安装根里的插件都在这里，包括没有被 profile 引用的（在 DSH 插件列表里卸载过，它就会变成未挂载）。",
    extKpiTotal: "外置插件",
    extKpiMounted: "已挂载",
    extKpiUnmounted: "未挂载",
    extKpiTrash: "回收站",
    extMounted: "已挂载",
    extUnmounted: "未挂载",
    extElsewhere: "挂在别处",
    extBroken: "目录不完整",
    extMountedHint: "profile 里有一行 link: 指向它，DSH 启动时会加载它。",
    extUnmountedHint: "profile 里没有任何引用 —— DSH 看不到它；重新挂载即可恢复。",
    extElsewhereHint: "profile 里有同名依赖，但它指向别的目录。",
    extBrokenHint: "目录里缺少 dsh.bundle / dsh.client / exports[\"./client\"]，不是 DSH 插件。",
    extSource: "来源",
    extNoSource: "未记录来源",
    extDepsCount: "声明依赖",
    extFiles: "文件",
    extAttach: "重新挂载",
    extAttachQuestion: "把它重新挂回 profile",
    extTakeover: "改指到这里",
    extTakeoverQuestion: "覆盖 profile 里同名依赖的写法",
    extDetach: "从 profile 摘除",
    extDetachQuestion: "从 profile 摘除（外置目录保留）",
    extUpdate: "更新",
    extUpdateQuestion: "更新到最新版（旧版进回收站）",
    extCheck: "检查更新",
    extLatest: "最新",
    extHasUpdate: "有新版本",
    extUpToDate: "已是最新",
    extCheckUnsupported: "不支持自动检查",
    extOpen: "打开目录",
    extRemove: "移入回收站",
    extRemoveQuestion: "把外置目录移出安装根",
    extRescan: "重新扫描",
    extMeasure: "测量体积",
    extEmpty: "安装根里还没有外置插件。",
    extNoRoot: "还没有选择安装根目录，先到「全局设置」选一个。",
    extGoSettings: "去全局设置",
    extGoExternal: "查看外置插件",
    extUnmountedBanner: "个外置插件没有被 profile 引用",
    extRoots: "安装根",
    extTrashTitle: "回收站",
    extTrashHint: "这些目录已从安装根移出，清空才真正释放空间。",
    extPurge: "清空回收站",
    extPurgeQuestion: "清空回收站（不可逆）",
    extRestartTip: "更新/挂载完成后需要重启一次 DSH 才会生效。",
    extSetSource: "保存来源",
    extSourcePlaceholder: "例如 github:owner/repo 或 1.2.3",
    extSourceSaved: "来源已保存",
    extSourceHint: "来源失效或不对时，在这里更正；「检查更新」与「更新」都会用它。",
    extHostHint: "读不到外置清单：宿主半身可能还是旧版本，重启一次 DSH 后再试。",
    extMasked: "另有 N 个",
        tabsHint: "标签之间可用左右方向键切换",
        root: "插件安装根目录",
        rootHint: "新插件默认落在哪个盘的哪个目录。目录选择器由 DSH 提供。",
        rootPlaceholder: "F:/DSH-Plugins",
        rootRequired: "请先填写安装根目录，例如 F:/DSH-Plugins",
        rootNotAbsolute: "需要绝对路径：F:/... 、//server/share 或 /mnt/... 形式",
        rootBadChar: "路径里不能包含 * ? \" < > | 这些字符",
        rootTrailing: "路径末尾多余的分隔符会被自动去掉，建议现在改掉",
        pick: "选择目录",
        store: "pnpm store 目录",
        storeHint: "留空 = 安装根/.store/v11。必须与安装根同盘，否则无法硬链接去重。",
        registry: "npm 源",
        registryHint: "留空则跟随 DSH/pnpm 的全局设置。",
        policy: "新插件默认位置",
        policyInDsh: "留在 .dsh 内",
        policyExternal: "装到外置根目录",
        oversizeMB: "体积推荐阈值（MB）",
        strict: "严格检查隐式依赖（不满足则拒绝迁出）",
        save: "保存设置",
        saved: "已保存",
        surface: "界面显示位置",
        surfaceHint: "选“侧边栏”会把管理界面放进左侧栏主面板，空间更大、更适合看插件列表；保存后立即切换，不用刷新页面。",
        surfaceSettings: "设置页",
        surfaceSidebar: "侧边栏",
        surfaceBoth: "两处都显示",
        surfaceReload: "显示位置已改：刷新页面（Ctrl+R）后生效。",
  surfaceApplied: "显示位置正在切换…",
        kpiPlugins: "插件总数",
        kpiExternal: "已外置",
        kpiTotal: "合计占用",
        kpiRisk: "依赖风险",
        searchPlaceholder: "搜索插件名…",
        clearFilters: "清空筛选",
        noMatch: "没有符合筛选条件的插件。",
        countUnit: "个插件",
        check: "校验",
        sameDriveOk: "安装根与 store 同盘",
        sameDriveBad: "安装根与 store 不同盘",
        name: "插件",
        version: "版本",
        location: "位置",
        size: "真实占用",
        deps: "依赖体检",
        actions: "操作",
        inDsh: ".dsh 内",
        external: "外置",
        protectedTag: "受保护",
        measure: "测量体积",
        out: "迁出",
        restore: "恢复",
        ignore: "忽略",
        unignore: "取消忽略",
        openDir: "打开目录",
        filter: "筛选",
        sort: "排序",
        sortSize: "按体积",
        sortName: "按名称",
        onlyExternal: "只看外置",
        onlyRisk: "只看有风险",
        ok: "自洽",
        risk: "有风险",
        unknown: "未测量",
        files: "文件",
        exclusive: "独占",
        shared: "共享",
        recommendTitle: "建议迁出的插件",
        recommendHint: "每条推荐都给出可核对的理由；命中的信号越多、分数越高。",
        hardlinkTip: "为什么「预计可释放」常常是 0 B？",
        hardlinkBody: "pnpm 用硬链接把包从 store 链进 node_modules，同一批字节被两处引用；只搬走 node_modules 一侧不会释放磁盘。真正能腾出 C 盘的是把 pnpm store 或 file: 本体（例如 dsh-infinite-gen-5）一起搬走。",
        blockedTitle: "暂不能迁出",
        score: "分数",
        scoreStrong: "强烈建议",
        scoreMedium: "建议",
        scoreWeak: "可选",
        weightHint: "提示",
        reasons: "理由",
        gain: "预计可释放（独占字节）",
        adopt: "采纳（迁出）",
        refresh: "刷新",
        runDoctor: "运行体检",
        doctorTitle: "体检报告",
        reclaim: "可清理项",
        risk_safe: "安全",
        risk_review: "需确认",
        logsTitle: "操作历史",
        reloadLogs: "刷新历史",
        progressTitle: "当前进度",
        noProgress: "当前没有正在进行的操作",
        rollback: "一键回滚",
        rollbackable: "可回滚",
        purge: "清空回收点",
        rollbackPoints: "回滚点",
        rollbackHint: "迁移后原目录会先留在回收点，确认插件工作正常后再清空回收点即可释放空间。",
        confirm: "确认",
        cancel: "取消",
        confirmTimeout: "6 秒内不确认会自动取消",
        needConfirm: "该操作为破坏性操作，请确认",
        failed: "失败",
        done: "完成",
        running: "进行中",
        loading: "加载中…",
        empty: "暂无数据",
        home: ".dsh 主目录",
    targetDir: "目标目录",
        profile: "profile 目录",
        crossDriveWarn: "跨盘迁移会先多占一份空间，需二次确认。",
        driveTitle: "盘符检查",
        resultTitle: "校验结果",
        noProblem: "没有发现问题",
        kpiCandidate: "候选",
        kpiBlocked: "拦下",
        kpiIgnored: "已忽略",
        kpiGain: "预计可释放",
        noPlugins: "还没有读到插件列表。",
        noCandidate: "暂时没有值得搬家的插件（都很小，或依赖不完整，见下方「暂不能迁出」）。",
        noBlocked: "没有插件被拦下。",
        noHistory: "还没有操作记录。",
        noRollback: "没有待处理的回滚点。",
        errSummary: "有问题需要先解决",
        busy: "处理中…",
        statusLoading: "正在读取…",
        confirmOut: "确认把这个插件搬到外置根？",
        confirmRestore: "确认搬回 .dsh？",
        confirmRollback: "确认回滚这次迁移？",
        confirmPurge: "确认清空这个回收点？此操作不可撤销。",
        largestDirs: "最大的目录",
        reclaimSafe: "安全可清理合计",
        measuredSummary: ".dsh 共 {files} 个文件 / 去重后 {bytes}（逻辑 {logical}，其中硬链接共享 {shared}）",
        view: "查看",
        openCardHint: "点卡片或按 Enter 打开插件目录",
        blockedWhy: "拦截原因",
        /* —— 完全体迁移：本体徽标 / 全局进度 / 回收点体积 / 逐插件根 —— */
        bodyBadge: "file: 本体",
        bodyBadgeHint: "这个插件用 file: 装进 profile，本体还在 .dsh 里；迁出时可以连它一起搬。",
        bodyMissing: "本体缺失",
        bodyMissingHint: "profile 声明了 file: 本体，但那个目录已经不在了。",
        bodyKept: "只搬依赖",
        jobTitle: "当前操作",
        jobStageLabel: "阶段",
        jobFilesLabel: "文件",
        jobPercentLabel: "进度",
        jobQueueHead: "排队中：",
        jobDone: "操作完成",
        jobFailed: "操作失败",
        jobGo: "查看进度与日志",
        jobClose: "关闭",
        jobIdle: "当前没有正在进行的操作。",
        jobBodyMoved: "本体已随迁",
        reclaimable: "可释放",
        stillLinked: "还链着",
        bodyMode: "file: 本体处理",
        bodyModeMove: "本体随迁（推荐）",
        bodyModeKeep: "只搬依赖",
        bodyModeHint: "file: 安装的插件，本体会留在 .dsh 里占空间。「本体随迁」把它一起搬到外置根，原位置不再保留数据；「只搬依赖」只动 node_modules 一侧。",
        autoPurge: "迁移成功后自动清空回收点",
        autoPurgeHint: "默认关闭。关闭时迁移完成后保留回收点，确认没问题再一键清空；开启则迁移成功即删除回收点，回滚能力随之消失。",
        perPluginRoot: "逐插件安装根目录",
        perPluginRootHint: "留空表示跟随上面的全局安装根。",
        savePluginRoot: "保存到该插件",
        followGlobal: "跟随全局",
        bodySection: "孤儿本体（迁移残骸）",
        bodyScan: "扫描孤儿本体",
        bodyScanHint: "找出 .dsh 下 plugins 目录里已经没有任何 profile 引用的 file: 本体，确认后再清理。",
        noOrphan: "没有发现孤儿本体。",
        orphanReferencedPrefix: "仍被引用于：",
        purgeOrphan: "清理",
        confirmPurgeOrphan: "清理时会把这些 profile 的声明改指向外置副本，然后删除旧本体。确认继续？",
        confirmOutBody: "会把本体与 node_modules 侧一起移入回收点；迁移完整成功前不删任何数据；失败自动回滚。",
        confirmOutDeps: "会把插件搬进目标根，并在那里装一份独立的依赖目录；原位置数据先移入回收点。",
        purgedSummary: "已释放",
        rollbackKept: "回收点仍占",
        orphanTotalLabel: "合计",
        relinkOrphan: "同时把这些 profile 的声明改指向外置副本",
        confirmPurgeBody: "确认删除这个孤儿本体？此操作不可撤销。"
      },
      en: {
        nav: "Relocator",
        title: "dsh-plugin-relocator",
        subtitle: "Install plugins on a drive you choose, give each its own node_modules / lockfile / .npmrc, and move them safely with one-click rollback.",
        tabSettings: "Settings",
        tabPlugins: "Plugins",
        tabRecommend: "Suggestions",
        tabLogs: "Progress & log",
    tabExternal: "External",
    extSubHint: "Every plugin under your install root, including ones the profile no longer references.",
    extKpiTotal: "External",
    extKpiMounted: "Mounted",
    extKpiUnmounted: "Unmounted",
    extKpiTrash: "Trash",
    extMounted: "Mounted",
    extUnmounted: "Unmounted",
    extElsewhere: "Mounted elsewhere",
    extBroken: "Incomplete",
    extMountedHint: "The profile links to it, so DSH loads it on startup.",
    extUnmountedHint: "Nothing in the profile references it — DSH cannot see it. Attach to restore.",
    extElsewhereHint: "The profile has a dependency with this name, but it points somewhere else.",
    extBrokenHint: "No dsh.bundle / dsh.client / exports[\"./client\"]: not a DSH plugin.",
    extSource: "Source",
    extNoSource: "no recorded source",
    extDepsCount: "declared deps",
    extFiles: "files",
    extAttach: "Attach",
    extAttachQuestion: "Attach it back into the profile",
    extTakeover: "Point here",
    extTakeoverQuestion: "Rewrite the profile dependency",
    extDetach: "Detach",
    extDetachQuestion: "Detach from the profile (keep the directory)",
    extUpdate: "Update",
    extUpdateQuestion: "Update to the latest version",
    extCheck: "Check update",
    extLatest: "latest",
    extHasUpdate: "update available",
    extUpToDate: "up to date",
    extCheckUnsupported: "no automatic check",
    extOpen: "Open folder",
    extRemove: "Move to trash",
    extRemoveQuestion: "Move the directory out of the install root",
    extRescan: "Rescan",
    extMeasure: "Measure",
    extEmpty: "No external plugin under the install root yet.",
    extNoRoot: "No install root chosen yet — pick one in Settings.",
    extGoSettings: "Open settings",
    extGoExternal: "See external plugins",
    extUnmountedBanner: "external plugin(s) not referenced by the profile",
    extRoots: "Install roots",
    extTrashTitle: "Trash",
    extTrashHint: "These directories left the install root; purge to actually free the space.",
    extPurge: "Purge trash",
    extPurgeQuestion: "Purge the trash (irreversible)",
    extRestartTip: "Restart DSH once after an update/attach for it to take effect.",
    extSetSource: "Save source",
    extSourcePlaceholder: "e.g. github:owner/repo or 1.2.3",
    extSourceSaved: "Source saved",
    extSourceHint: "Point the plugin at the right source here; check and update use it.",
    extHostHint: "Cannot read the external inventory: the host half is probably still the old build. Restart DSH.",
    extMasked: "plus N more",
        save: "Save",
        saved: "Saved",
        surface: "Placement",
        surfaceHint: "Sidebar puts the manager into the left rail main panel (more room for the plugin list). Switching applies immediately, no refresh needed.",
        surfaceSettings: "Settings page",
        surfaceSidebar: "Sidebar",
        surfaceBoth: "Both",
        surfaceReload: "Placement changed: refresh the page (Ctrl+R) to apply.",
  surfaceApplied: "Switching placement now…",
        kpiPlugins: "Plugins",
        kpiExternal: "External",
        kpiTotal: "Total size",
        kpiRisk: "Dependency risks",
        searchPlaceholder: "Search plugins…",
        clearFilters: "Clear filters",
        noMatch: "No plugin matches the filters.",
        countUnit: "plugins",
        refresh: "Refresh",
        empty: "No data",
        cancel: "Cancel",
        confirm: "Confirm",
        check: "Validate",
        measure: "Measure",
        out: "Move out",
        restore: "Restore",
        ignore: "Ignore",
        unignore: "Unignore",
        openDir: "Open folder",
        loading: "Loading…",
        view: "Open",
        openCardHint: "Click the card (or press Enter) to open the plugin folder",
        blockedWhy: "Blocked because",
        bodyBadge: "file: body",
        bodyBadgeHint: "Installed into the profile with file:, so its body still lives inside .dsh; it can move out together.",
        bodyMissing: "body missing",
        bodyMissingHint: "The profile declares a file: body, but that folder is gone.",
        bodyKept: "deps only",
        jobTitle: "Current operation",
        jobStageLabel: "Stage",
        jobFilesLabel: "Files",
        jobPercentLabel: "Progress",
        jobQueueHead: "Queued:",
        jobDone: "Operation finished",
        jobFailed: "Operation failed",
        jobGo: "Open progress & log",
        jobClose: "Close",
        jobIdle: "Nothing is running right now.",
        jobBodyMoved: "body moved",
        reclaimable: "reclaimable",
        stillLinked: "still linked",
        bodyMode: "file: body handling",
        bodyModeMove: "Move the body (recommended)",
        bodyModeKeep: "Dependencies only",
        bodyModeHint: "Plugins installed with file: keep their body inside .dsh. Moving the body takes it to the external root and leaves nothing behind; dependencies-only touches just the node_modules side.",
        autoPurge: "Clear the rollback point after a successful move",
        autoPurgeHint: "Off by default: the rollback point is kept so you can still undo, then cleared on demand. On: a successful move deletes it immediately and undo is lost.",
        perPluginRoot: "Per-plugin install root",
        perPluginRootHint: "Empty means follow the global install root above.",
        savePluginRoot: "Save for this plugin",
        followGlobal: "follow global",
        bodySection: "Orphan bodies (move leftovers)",
        bodyScan: "Scan orphan bodies",
        bodyScanHint: "Finds file: bodies under .dsh plugins that no profile references any more, so you can clear them.",
        noOrphan: "No orphan body found.",
        orphanReferencedPrefix: "Still referenced by: ",
        purgeOrphan: "Clear",
        confirmPurgeOrphan: "Clearing repoints those profiles at the external copy, then deletes the old body. Continue?",
        confirmOutBody: "The body and the node_modules copy both go to the rollback point; nothing is deleted before the move fully succeeds; failures roll back automatically.",
        confirmOutDeps: "The plugin moves into the target root and gets its own dependency folder there; the old data goes to the rollback point first.",
        purgedSummary: "Freed",
        rollbackKept: "rollback still holds",
        orphanTotalLabel: "Total",
        relinkOrphan: "Also repoint those profiles at the external copy",
        confirmPurgeBody: "Delete this orphan body? This cannot be undone."
      }
    };

    /* ---------------------- 样式：注入一次，类名驱动 ---------------------- */
    /* 用数组拼 CSS，避免在源码里出现模板字符串（浏览器端无需转译）。 */
    const CSS = [
      "/* achromatic-ledger：chrome 一律墨色/中性，唯一数据色（一抹蓝）只给体积条与关键占用数字。 */",
      "/* 颜色一律桥到宿主 --dsw-alias-*（明暗自动适配），兜底值按浅色写；不写 Tailwind 原色 hex。 */",
      ".dshr{--dshr-fg:var(--dsw-alias-label-primary,#0f1115);--dshr-muted-fg:var(--dsw-alias-label-secondary,#61666b);",
      "--dshr-faint:#6b7078;--dshr-surface:var(--dsw-alias-settings-card-fill,#fff);",
      "--dshr-raised:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));--dshr-sunk:var(--dsw-alias-bg-module-platform,#f5f6f7);",
      "--dshr-border:#e8e8ea;--dshr-rule:var(--dsw-alias-border-l1,rgba(0,0,0,.06));",
      "--dshr-control:var(--dsw-alias-border-l3,rgba(0,0,0,.12));--dshr-accent:var(--dsw-alias-link,#4176e6);--dshr-accent-text:#1d5fbf;",
      "--dshr-accent-soft:color-mix(in srgb,var(--dshr-accent) 14%,transparent);--dshr-accent-line:color-mix(in srgb,var(--dshr-accent) 40%,transparent);",
      "--dshr-primary-fill:var(--dsw-alias-button-primary-fill,#0f1115);--dshr-primary-hover:var(--dsw-alias-button-primary-hover,#353638);",
      "--dshr-on-primary:#fff;--dshr-ok:var(--dsw-alias-state-success-primary,#2e7d32);--dshr-bad:var(--dsw-alias-state-error-primary,#c4242a);",
      "--dshr-warn:var(--dsw-alias-state-warn-primary,#92400e);--dshr-gap:12px;--dshr-radius:8px;--dshr-radius-control:6px;--dshr-control-h:32px;",
      "color:var(--dshr-fg);font-family:var(--dsw-font-family,system-ui,sans-serif);font-size:13px;line-height:1.5;",
      "display:flex;flex-direction:column;gap:var(--dshr-gap);padding:2px 2px 20px;container-type:inline-size}",
      "body[data-ds-dark-theme] .dshr{--dshr-on-primary:#0f1115;--dshr-border:#2f2f33;--dshr-faint:#9aa0a8;--dshr-accent-text:#7aaaff}",
      ".dshr *,.dshr *::before,.dshr *::after{box-sizing:border-box}",
      ".dshr :focus-visible,.dshr-ccard:focus-visible{outline:2px solid var(--dshr-accent);outline-offset:2px;border-radius:var(--dshr-radius-control)}",
      "/* 排版刻度：12.5 / 13 / 13.5 / 15 / 16 / 18 / 20 / 22 / 30（正文 13px，最小 12.5px） */",
      ".dshr h1,.dshr-h1{margin:0;font-size:20px;font-weight:600;line-height:1.25;letter-spacing:0}",
      ".dshr h2,.dshr h3,.dshr-h2{margin:0;font-size:16px;font-weight:600;line-height:1.3;letter-spacing:0}",
      ".dshr p{margin:0}",
      ".dshr-sub{color:var(--dshr-muted-fg);max-width:78ch;font-size:13px}",
      ".dshr-sub2{color:var(--dshr-muted-fg);font-size:13px}",
      ".dshr-soft{color:var(--dshr-muted-fg);font-size:13px}",
      ".dshr-muted{color:var(--dshr-faint)}",
      ".dshr-name{font-weight:500;font-size:13px}",
      ".dshr-mono{font-family:var(--dsw-font-family-code,ui-monospace,Menlo,Consolas,monospace);font-size:13px}",
      ".dshr-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".dshr-ico{display:inline-block;vertical-align:-2px;margin-right:5px;flex:none}",
      ".dshr-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshr-row--tight{gap:4px;margin-top:3px}",
      "/* 页头：每屏一个标题，下面一行灰字讲对象 */",
      ".dshr-pagehead{display:flex;flex-direction:column;gap:2px;padding:0 0 10px;border-bottom:1px solid var(--dshr-rule)}",
      "/* 下划线 tabs 坐在贯穿 1px 规则线上，指示条 2px 墨色 */",
      ".dshr-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dshr-rule);overflow-x:auto;scrollbar-width:none}",
      ".dshr-tabs::-webkit-scrollbar{display:none}",
      ".dshr-tab{appearance:none;font:inherit;font-size:13px;color:var(--dshr-muted-fg);background:transparent;border:0;",
      "border-bottom:2px solid transparent;margin-bottom:-1px;padding:6px 10px 7px;min-height:32px;cursor:pointer;white-space:nowrap;",
      "display:inline-flex;align-items:center;transition:color .16s ease-out,border-color .16s ease-out}",
      ".dshr-tab:hover{color:var(--dshr-fg)}",
      ".dshr-tab[aria-selected=true]{color:var(--dshr-fg);font-weight:500;border-bottom-color:var(--dshr-fg)}",
      ".dshr-tab__dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dshr-accent);margin-left:5px;vertical-align:middle}",
      "/* 控件：一个高度 32、一套圆角 6；填充主按钮近黑 */",
      ".dshr-btn{appearance:none;font:inherit;font-size:13px;font-weight:500;color:var(--dshr-fg);background:var(--dshr-surface);",
      "border:1px solid var(--dshr-control);border-radius:var(--dshr-radius-control);height:var(--dshr-control-h);padding:0 12px;",
      "cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;",
      "transition:background-color .16s ease-out,border-color .16s ease-out,color .16s ease-out}",
      ".dshr-btn:hover:not(:disabled){background:var(--dshr-raised)}",
      ".dshr-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.1))}",
      ".dshr-btn:disabled{opacity:.45;cursor:default}",
      ".dshr-btn--primary{background:var(--dshr-primary-fill);border-color:var(--dshr-primary-fill);color:var(--dshr-on-primary)}",
      ".dshr-btn--primary:hover:not(:disabled){background:var(--dshr-primary-hover);border-color:var(--dshr-primary-hover)}",
      ".dshr-btn--ghost{background:transparent;border-color:transparent;padding:0 8px}",
      ".dshr-btn--ghost:hover:not(:disabled){background:var(--dshr-raised)}",
      ".dshr-btn--danger{color:var(--dshr-bad);border-color:color-mix(in srgb,var(--dshr-bad) 45%,transparent);background:transparent}",
      ".dshr-btn--danger:hover:not(:disabled){background:color-mix(in srgb,var(--dshr-bad) 10%,transparent)}",
      ".dshr-input{font:inherit;font-size:13px;color:var(--dshr-fg);background:var(--dshr-surface);border:1px solid var(--dshr-control);",
      "border-radius:var(--dshr-radius-control);height:var(--dshr-control-h);width:100%;padding:0 10px;min-width:0;transition:border-color .16s ease-out}",
      ".dshr-input:focus{border-color:var(--dshr-accent)}",
      ".dshr-input[aria-invalid=true]{border-color:var(--dshr-bad)}",
      ".dshr-input--sm{height:28px;font-size:13px;width:auto;min-width:96px}",
      ".dshr-seg{display:inline-flex;padding:2px;gap:2px;border:1px solid var(--dshr-control);border-radius:var(--dshr-radius-control);background:var(--dshr-sunk)}",
      ".dshr-seg__item{appearance:none;font:inherit;font-size:13px;color:var(--dshr-muted-fg);background:transparent;border:0;",
      "border-radius:4px;height:26px;padding:0 10px;cursor:pointer;white-space:nowrap}",
      ".dshr-seg__item.is-on{background:var(--dshr-surface);color:var(--dshr-fg);font-weight:500;}",
      ".dshr-chip{appearance:none;font:inherit;font-size:13px;color:var(--dshr-muted-fg);background:transparent;border:1px solid var(--dshr-control);",
      "border-radius:14px;height:28px;padding:0 11px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}",
      ".dshr-chip:hover{color:var(--dshr-fg)}",
      ".dshr-chip.is-on{background:var(--dshr-raised);border-color:var(--dshr-control);color:var(--dshr-fg);font-weight:500}",
      ".dshr-chip--ghost{border-color:transparent}",
      ".dshr-chip--ghost:hover{border-color:var(--dshr-control)}",
      "/* 徽标：淡底 + 同色深字，不靠纯色填充表达状态 */",
      ".dshr-badge{display:inline-flex;align-items:center;gap:4px;flex:none;white-space:nowrap;height:20px;padding:0 7px;border-radius:6px;",
      "font-size:12.5px;font-weight:500;background:var(--dshr-raised);color:var(--dshr-muted-fg)}",
      ".dshr-badge--ok{background:color-mix(in srgb,var(--dshr-ok) 16%,transparent);color:color-mix(in srgb,var(--dshr-ok) 55%,var(--dshr-fg))}",
      ".dshr-badge--warn{background:color-mix(in srgb,var(--dshr-warn) 16%,transparent);color:color-mix(in srgb,var(--dshr-warn) 55%,var(--dshr-fg))}",
      ".dshr-badge--bad{background:color-mix(in srgb,var(--dshr-bad) 16%,transparent);color:color-mix(in srgb,var(--dshr-bad) 55%,var(--dshr-fg))}",
      "/* 占用条：全局唯一的数据色 */",
      ".dshr-bar{height:6px;border-radius:99px;background:var(--dshr-raised);overflow:hidden}",
      ".dshr-bar>i{display:block;height:100%;border-radius:99px;background:var(--dshr-accent);min-width:2px;transition:width .3s ease-out}",
      ".dshr-bar--mini{width:96px;height:5px}",
      ".dshr-sizecell{display:flex;flex-direction:column;gap:4px;align-items:flex-end;min-width:104px}",
      "/* 卡片：1px 线、静止无阴影 */",
      ".dshr-card{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--dshr-border);",
      "border-radius:var(--dshr-radius);background:var(--dshr-surface)}",
      ".dshr-card__head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px}",
      ".dshr-card__head strong,.dshr-sectionlabel strong{font-size:16px;font-weight:600}",
      ".dshr-sectionlabel{display:flex;align-items:center;gap:8px;padding:4px 0 0}",
      "/* 表单：字段间 16，label 在上 */",
      ".dshr-grid{display:grid;gap:10px 16px}",
      ".dshr-grid__span{grid-column:1 / -1}",
      ".dshr-field__label{font-size:13px;font-weight:500;color:var(--dshr-fg)}",
      ".dshr-field__hint{font-size:13px;color:var(--dshr-muted-fg)}",
      ".dshr-field__error{font-size:13px;color:var(--dshr-bad)}",
      "/* KPI：一个容器 + 1px 分隔线，标签在上值在下 */",
      ".dshr-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--dshr-border);",
      "border-radius:var(--dshr-radius);background:var(--dshr-surface);overflow:hidden}",
      ".dshr-kpi{display:flex;flex-direction:column;gap:2px;padding:10px 14px;min-width:0}",
      ".dshr-kpi+.dshr-kpi{border-left:1px solid var(--dshr-rule)}",
      ".dshr-kpi>span{font-size:12.5px;color:var(--dshr-muted-fg)}",
      ".dshr-kpi>b{font-size:22px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshr-kpi--key>b{font-size:30px;color:var(--dshr-accent-text)}",
      ".dshr-kpi.is-bad>b{color:var(--dshr-bad)}",
      ".dshr-kpis--bare{border:0;background:transparent;grid-template-columns:repeat(3,minmax(0,1fr));flex:1 1 auto}",
      ".dshr-kpis--bare .dshr-kpi{padding:0 16px 0 0}",
      ".dshr-kpis--bare .dshr-kpi+.dshr-kpi{border-left:0}",
      ".dshr-kpis--bare .dshr-kpi>b{font-size:18px}",
      "/* 表格（体检报告 / 历史）：靠规则线与对齐，无斑马纹 */",
      ".dshr-tablewrap{overflow-x:auto;border:1px solid var(--dshr-border);border-radius:var(--dshr-radius)}",
      ".dshr-table{width:100%;border-collapse:collapse;font-size:13px}",
      ".dshr-table th{text-align:left;font-size:13px;font-weight:400;color:var(--dshr-muted-fg);padding:8px 10px;border-bottom:1px solid var(--dshr-border);white-space:nowrap}",
      ".dshr-table td{padding:8px 10px;border-bottom:1px solid var(--dshr-rule);vertical-align:top}",
      ".dshr-table tbody tr:last-child td{border-bottom:0}",
      ".dshr-table tbody tr:hover{background:var(--dshr-raised)}",
      ".dshr-table .dshr-num{text-align:right;font-variant-numeric:tabular-nums}",
      "/* 状态：空 / 骨架 / 错误 / 待确认 */",
      ".dshr-empty{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:16px;border:1px dashed var(--dshr-control);",
      "border-radius:var(--dshr-radius);color:var(--dshr-muted-fg);font-size:13px}",
      ".dshr-skel{background:var(--dsw-alias-bg-skeleton,rgba(0,0,0,.05));border-radius:4px;animation:dshr-pulse 1.4s ease-in-out infinite}",
      ".dshr-alert{border:1px solid color-mix(in srgb,var(--dshr-bad) 26%,transparent);background:color-mix(in srgb,var(--dshr-bad) 9%,transparent);",
      "border-radius:var(--dshr-radius-control);padding:8px 10px;font-size:13px;color:var(--dshr-fg)}",
      ".dshr-confirm{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;border:1px solid color-mix(in srgb,var(--dshr-bad) 32%,transparent);",
      "border-radius:var(--dshr-radius-control);padding:3px 8px}",
      ".dshr-confirm__text{font-size:13px;color:var(--dshr-muted-fg)}",
      ".dshr-pre{margin:0;padding:8px 10px;background:var(--dshr-sunk);border-radius:var(--dshr-radius-control);max-height:280px;overflow:auto;",
      "font-size:13px;white-space:pre-wrap;word-break:break-all}",
      ".dshr-details{font-size:13px;color:var(--dshr-muted-fg)}",
      ".dshr-details summary{cursor:pointer;color:var(--dshr-fg);font-size:13px}",
      ".dshr-timeline{display:flex;flex-direction:column;gap:10px}",
      ".dshr-timeline__item{border-left:1px solid var(--dshr-rule);padding-left:10px}",
      ".dshr-progress-meta{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--dshr-muted-fg);min-width:0}",
      "/* 工具栏：左范围与筛选，右工具与刷新 */",
      ".dshr-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:var(--dshr-control-h)}",
      ".dshr-toolbar__search{position:relative;display:flex;align-items:center;flex:0 1 264px;min-width:180px}",
      ".dshr-toolbar__search .dshr-toolbar__icon{position:absolute;left:9px;display:inline-flex;color:var(--dshr-faint);pointer-events:none}",
      ".dshr-toolbar__search .dshr-input{padding-left:28px}",
      ".dshr-toolbar__spacer{flex:1 1 auto;min-width:0}",
      "/* 紧凑卡片网格：同行同底边（不写 align-items:start），窄容器单列 */",
      ".dshr-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:var(--dshr-gap);min-height:0}",
      ".dshr-cards--wide{grid-template-columns:repeat(auto-fill,minmax(292px,1fr))}",
      ".dshr-cards__span{grid-column:1 / -1}",
      ".dshr-cards>.dshr-ccard{min-width:0}",
      ".dshr-ccard{position:relative;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dshr-border);",
      "border-radius:var(--dshr-radius);background:var(--dshr-surface);transition:border-color .16s ease-out,background-color .16s ease-out}",
      ".dshr-ccard.is-clickable{cursor:pointer}",
      ".dshr-ccard.is-clickable:hover{border-color:var(--dshr-control);background:var(--dshr-raised)}",
      ".dshr-ccard.is-risk{border-left:2px solid var(--dshr-bad)}",
      ".dshr-ccard--blocked{border-style:dashed;background:transparent}",
      ".dshr-ccard--blocked:hover{border-color:var(--dshr-border)}",
      ".dshr-ccard__head{display:flex;align-items:baseline;gap:8px;min-width:0}",
      ".dshr-ccard__name{flex:0 1 auto;min-width:0;font-weight:600;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshr-ccard__ver{flex:0 0 auto;margin-left:auto;font-size:12.5px;color:var(--dshr-faint);font-variant-numeric:tabular-nums}",
      ".dshr-ccard__tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0}",
      ".dshr-ccard__size{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dshr-ccard__size>b{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".dshr-ccard__bar{flex:1 1 auto;width:auto;min-width:36px}",
      ".dshr-ccard__facts{font-size:13px;color:var(--dshr-muted-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}",
      ".dshr-ccard__foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px}",
      ".dshr-ccard__acts{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-left:auto}",
      ".dshr-ccard__acts .dshr-btn{height:28px;font-size:13px;padding:0 9px}",
      ".dshr-ccard__why{display:flex;flex-direction:column;gap:3px;min-width:0}",
      ".dshr-reasons{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}",
      ".dshr-reasons li{display:flex;gap:8px;align-items:flex-start}",
      ".dshr-reasons .w{flex:0 0 auto;min-width:36px;text-align:right;color:var(--dshr-faint);font-size:12.5px;font-variant-numeric:tabular-nums}",
      ".dshr-ccard__why .dshr-reasons{margin:0}",
      ".dshr-reasons--flow{display:flex;flex-wrap:wrap;gap:2px 12px;margin:0}",
      ".dshr-reasons--flow li{display:inline-flex;align-items:baseline;gap:4px;font-size:13px;line-height:1.3;max-width:100%;min-width:0}",
      ".dshr-reasons--flow li>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshr-reasons--flow .w{min-width:0;font-size:12.5px;flex:0 0 auto}",
      "/* 逐插件安装根 / 孤儿本体 */",
      ".dshr-roots{display:flex;flex-direction:column;gap:8px}",
      ".dshr-roots__row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshr-roots__name{flex:0 0 168px;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshr-orphan{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dshr-border);border-radius:var(--dshr-radius);background:var(--dshr-surface)}",
      ".dshr-orphan__head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshr-orphan__path{font-size:13px;color:var(--dshr-muted-fg);word-break:break-all}",
      ".dshr-orphan__acts{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      "/* 全局作业条：任意页签都可见 */",
      ".dshr-jobstrip{display:flex;flex-direction:column;gap:8px;flex:0 0 auto;padding:10px 12px;border:1px solid var(--dshr-border);",
      "border-radius:var(--dshr-radius);background:var(--dshr-surface)}",
      ".dshr-jobstrip__head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}",
      ".dshr-job{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".dshr-job__top{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px}",
      ".dshr-job__name{font-weight:500;flex:0 0 auto;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshr-job__msg{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dshr-muted-fg)}",
      ".dshr-jobstrip .dshr-bar{height:5px}",
      "/* 结果提示：浮层（唯一允许阴影的地方） */",
      ".dshr-toast{position:fixed;right:16px;bottom:16px;z-index:60;max-width:min(360px,calc(100vw - 32px));display:flex;flex-direction:column;gap:6px;",
      "padding:12px 14px;border:1px solid var(--dshr-border);border-radius:var(--dshr-radius);background:var(--dshr-surface);",
      "box-shadow:0 8px 24px rgba(0,0,0,.14);font-size:13px}",
      ".dshr-toast__top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshr-toast__top strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshr-toast__body{display:flex;flex-direction:column;gap:2px;word-break:break-all}",
      "@keyframes dshr-pulse{0%,100%{opacity:1}50%{opacity:.55}}",
      "@media (prefers-reduced-motion:reduce){.dshr *,.dshr *::before,.dshr *::after{animation-duration:.001ms !important;transition-duration:.001ms !important}}",
      "/* 侧栏主面板：外壳是 overflow:hidden 的 flex 列，插件必须自己成为滚动容器 */",
      ".dshr--panel{flex:1 1 auto;min-height:0;height:100%;gap:10px;padding:10px 12px 20px}",
      ".dshr--panel .dshr-pagehead{padding-bottom:8px}",
      ".dshr--panel .dshr-panelbody{flex:1 1 auto;min-height:0;max-height:calc(100vh - 232px);overflow:auto;overscroll-behavior:contain;",
      "padding:0 4px 8px 0;display:flex;flex-direction:column;gap:12px}",
      ".dshr--panel .dshr-toolbar{position:sticky;top:-1px;z-index:3;background:var(--dshr-surface);padding:6px 0;border-bottom:1px solid var(--dshr-rule)}",
      ".dshr--panel .dshr-plist{flex:0 0 auto;min-height:0}",
      "/* 设置面板：区块只留 1px 上分隔线，字段两栏（label 左、控件右） */",
      ".dshr--settings{gap:16px;max-width:1080px}",
      ".dshr--settings .dshr-grid{grid-template-columns:minmax(180px,400px) minmax(0,1fr);align-items:start}",
      ".dshr--settings .dshr-field__label{padding-top:7px}",
      ".dshr--settings .dshr-cards{grid-template-columns:repeat(auto-fill,minmax(232px,1fr))}",
      ".dshr--settings .dshr-cards--wide{grid-template-columns:repeat(auto-fill,minmax(264px,1fr))}",
      ".dshr--settings .dshr-card{border:0;border-top:1px solid var(--dshr-rule);border-radius:0;background:transparent;padding:16px 0 0;gap:10px}",
      "@container (max-width:840px){.dshr-kpis:not(.dshr-kpis--bare){grid-template-columns:repeat(2,minmax(0,1fr))}.dshr-kpis:not(.dshr-kpis--bare)>.dshr-kpi:nth-child(odd){border-left:0}}",
      "@container (max-width:480px){.dshr-cards,.dshr-cards--wide{grid-template-columns:1fr}}",
    "@container (max-width:640px){.dshr-toolbar__search{flex:1 1 100%;max-width:none}}",
      ".dshr--settings .dshr-grid{grid-template-columns:1fr}.dshr--settings .dshr-field__label{padding-top:0}.dshr-sizecell{min-width:0}",
      ".dshr-btn{height:36px}.dshr-tab{min-height:40px}.dshr-job__name{max-width:100%}",
      ".dshr-toast{right:8px;left:8px;bottom:8px;max-width:none}}",
      ".dshr-ccard__src{display:flex;gap:6px;align-items:center}",
      ".dshr-ccard__src .dshr-input{flex:1 1 auto;min-width:0}",
    ].join("\n");

    const ensureStyle = () => {
      try {
        if (typeof document === "undefined") return;
        if (document.getElementById(STYLE_ID)) return;
        const el = document.createElement("style");
        el.id = STYLE_ID;
        el.textContent = CSS;
        document.head.appendChild(el);
      } catch (problem) {
        /* 没有 DOM（例如单测）时忽略 */
      }
    };
    ensureStyle();

    /* ------------------------------ 基础件 ------------------------------ */
    const api = async (action, body, method) => {
      const verb = method === "GET" ? "GET" : "POST";
      const response = await fetch(ROUTE + "/" + action, {
        method: verb,
        headers: verb === "POST" ? { "content-type": "application/json" } : undefined,
        credentials: "same-origin",
        body: verb === "POST" ? JSON.stringify(body ?? {}) : undefined
      });
      const payload = await response.json().catch(() => ({ ok: false, error: "HTTP " + response.status }));
      if (!payload.ok) throw new Error(payload.error ?? "HTTP " + response.status);
      return payload;
    };

    const bytes = (value) => {
      if (value === null || value === undefined) return "—";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let index = 0;
      let size = Number(value);
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      return size.toFixed(size >= 100 || index === 0 ? 0 : 1) + " " + units[index];
    };

    /** 路径校验：返回 { error, warning }，都为空表示通过。 */
    const validateRootPath = (t, value) => {
      const raw = String(value ?? "");
      const trimmed = raw.trim();
      if (!trimmed) return { error: t.rootRequired, warning: null };
      const drive = /^[A-Za-z]:[\\/]/.test(trimmed);
      const unc = trimmed.startsWith("\\\\");
      const posix = trimmed.startsWith("/");
      if (!drive && !unc && !posix) return { error: t.rootNotAbsolute, warning: null };
      if (/[*?"<>|]/.test(trimmed)) return { error: t.rootBadChar, warning: null };
      if (/[\\/]$/.test(trimmed)) return { error: null, warning: t.rootTrailing };
      return { error: null, warning: null };
    };

    const Btn = ({ children, onClick, disabled, kind, busy, title, ariaLabel }) =>
      h(
        "button",
        {
          type: "button",
          className: "dshr-btn" + (kind && kind !== "default" ? " dshr-btn--" + kind : ""),
          disabled: disabled || busy,
          onClick,
          title,
          "aria-label": ariaLabel,
          "aria-busy": busy ? "true" : undefined
        },
        busy ? h("span", { className: "dshr-muted", "aria-hidden": "true" }, "…") : null,
        children
      );

    const Badge = ({ tone, children, title }) =>
      h("span", { className: "dshr-badge" + (tone ? " dshr-badge--" + tone : ""), title }, children);

    const Skeleton = ({ w, h: height }) => h("div", { className: "dshr-skel", style: { width: w ?? "100%", height: height ?? 14 } });

    const Empty = ({ text, action }) => h("div", { className: "dshr-empty" }, h("div", null, text), action ?? null);

    /* KPI 单元格：标签在上、值在下；--key 那格用数据蓝（唯一的彩色数据信号）。 */
    const kpi = (label, value, cls) => h("div", { className: "dshr-kpi" + (cls ? " " + cls : "") }, h("span", null, label), h("b", null, value));

    const Field = ({ id, label, hint, error, children }) =>
      h(
        React.Fragment,
        null,
        h("label", { className: "dshr-field__label", htmlFor: id }, label),
        h("div", null, children),
        hint || error
          ? h(
              "div",
              { className: "dshr-grid__span" },
              hint ? h("div", { className: "dshr-field__hint", id: id + "-hint" }, hint) : null,
              error ? h("div", { className: "dshr-field__error", id: id + "-error" }, Ico("cross"), error) : null
            )
          : null
      );

    function useArm() {
      const [armed, setArmed] = useState(false);
      const timer = useRef(null);
      useEffect(() => {
        if (!armed) return undefined;
        timer.current = setTimeout(() => setArmed(false), 6000);
        const onKey = (event) => {
          if (event.key === "Escape") setArmed(false);
        };
        if (typeof window !== "undefined") window.addEventListener("keydown", onKey);
        return () => {
          clearTimeout(timer.current);
          if (typeof window !== "undefined") window.removeEventListener("keydown", onKey);
        };
      }, [armed]);
      return [armed, setArmed];
    }

    const ConfirmButton = ({ t, label, question, confirmLabel, kind, onConfirm, disabled, busy, title }) => {
      const [armed, setArmed] = useArm();
      if (!armed) return h(Btn, { kind, disabled, busy, title, onClick: () => setArmed(true) }, label);
      return h(
        "span",
        { className: "dshr-confirm" },
        h("span", { className: "dshr-confirm__text" }, (question ?? t.needConfirm) + "（" + t.confirmTimeout + "）"),
        h(Btn, { kind: "danger", onClick: () => { setArmed(false); onConfirm(); } }, confirmLabel ?? t.confirm),
        h(Btn, { kind: "ghost", onClick: () => setArmed(false) }, t.cancel)
      );
    };

    function useApiCall() {
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const run = useCallback(async (action, body, method) => {
        setBusy(true);
        setError(null);
        try {
          return await api(action, body, method);
        } catch (problem) {
          setError(String(problem?.message ?? problem));
          return null;
        } finally {
          setBusy(false);
        }
      }, []);
      return { busy, error, run, setError };
    }

    /* 逐插件安装根目录：一行一个插件，留空 = 跟随全局根。 */
    function PluginRootRow({ t, row, value, globalRoot, onDone }) {
      const { busy, error, run } = useApiCall();
      const [text, setText] = useState(value ?? "");
      const [saved, setSaved] = useState(false);
      const save = async () => {
        setSaved(false);
        const payload = await run("root/set", { name: row.name, root: text.trim(), create: true });
        if (payload) { setSaved(true); onDone?.(); }
      };
      return h(
        "div",
        { className: "dshr-roots__row" },
        h("span", { className: "dshr-roots__name", title: row.name }, row.name),
        h("input", {
          className: "dshr-input dshr-input--sm",
          value: text,
          "aria-label": t.perPluginRoot + " · " + row.name,
          placeholder: t.followGlobal + (globalRoot ? "：" + globalRoot : ""),
          onChange: (event) => { setText(event.target.value); setSaved(false); },
          onKeyDown: (event) => { if (event.key === "Enter") save(); }
        }),
        h(Btn, { onClick: save, busy, kind: text.trim() ? "default" : "ghost" }, t.savePluginRoot),
        saved ? h("span", { className: "dshr-muted", role: "status" }, t.saved) : null,
        error ? h("span", { className: "dshr-field__error" }, Ico("cross"), error) : null
      );
    }

    /* 孤儿本体清理：扫描 → 列出体积与残留引用 → 清理（可选改写残留引用）。 */
    function BodyCleanupCard({ t, onRefresh }) {
      const { busy, error, run } = useApiCall();
      const [data, setData] = useState(null);
      const [relink, setRelink] = useState(true);
      const scan = async () => {
        const payload = await run("body/scan", {});
        if (payload) setData(payload);
      };
      const purge = async (item) => {
        const payload = await run("body/purge", { paths: [item.dir], relinkReferencing: relink });
        if (payload) { setData(null); await scan(); onRefresh?.(); }
      };
      const orphans = data?.orphans ?? [];
      return h(
        "div",
        { className: "dshr-card" },
        h(
          "div",
          { className: "dshr-card__head" },
          h("strong", null, t.bodySection),
          data && orphans.length ? h(Badge, { tone: "warn" }, t.orphanTotalLabel + " " + bytes(data.totalBytes ?? 0)) : null,
          h("span", { className: "dshr-toolbar__spacer" }),
          h(Btn, { onClick: scan, busy }, data ? t.refresh : t.bodyScan)
        ),
        h("div", { className: "dshr-sub2" }, t.bodyScanHint),
        error ? h("div", { className: "dshr-alert", role: "alert" }, Ico("cross"), error) : null,
        data && orphans.length === 0 ? h("div", { className: "dshr-sub2" }, t.noOrphan) : null,
        data && orphans.length
          ? h("label", { className: "dshr-row", style: { gap: 6 } },
              h("input", { type: "checkbox", checked: relink, onChange: (event) => setRelink(event.target.checked) }),
              h("span", { className: "dshr-sub2" }, t.relinkOrphan)
            )
          : null,
        orphans.map((item) =>
          h(
            "div",
            { key: item.dir, className: "dshr-orphan" },
            h(
              "div",
              { className: "dshr-orphan__head" },
              h("strong", null, item.name),
              h(Badge, { tone: "warn" }, item.human ?? bytes(item.bytes ?? 0)),
              item.files ? h("span", { className: "dshr-sub2" }, item.files.toLocaleString("en-US") + " " + t.files) : null
            ),
            h("div", { className: "dshr-orphan__path", title: item.dir }, item.dir),
            item.referenceCount
              ? h("div", { className: "dshr-sub2" }, t.orphanReferencedPrefix + (item.referencedBy ?? []).join("、"))
              : null,
            h(
              "div",
              { className: "dshr-orphan__acts" },
              h(ConfirmButton, {
                t,
                label: t.purgeOrphan,
                question: item.referenceCount ? t.confirmPurgeOrphan : t.confirmPurgeBody,
                kind: "danger",
                onConfirm: () => purge(item)
              })
            )
          )
        )
      );
    }

    /* ------------------------------ 全局设置 ------------------------------ */
    function SettingsTab({ t, status, onRefresh, uiWorkspace, rows }) {
      const { busy, error, run } = useApiCall();
      const [draft, setDraft] = useState(null);
      const [check, setCheck] = useState(null);
      const [notice, setNotice] = useState(null);
      const [touched, setTouched] = useState({});
      const config = draft ?? status?.config ?? {};
      const rootState = validateRootPath(t, config.root);

      const update = (patch) => {
        setDraft({ ...config, ...patch });
        setNotice(null);
      };
      const markTouched = (key) => setTouched((previous) => ({ ...previous, [key]: true }));

      const pick = async () => {
        try {
          const picker = uiWorkspace ?? ctxRef?.uiWorkspace;
          const picked = picker && typeof picker.pickDirectory === "function" ? await picker.pickDirectory() : null;
          if (picked) {
            update({ root: String(picked) });
            markTouched("root");
          }
        } catch (problem) {
          setNotice("目录选择器失败：" + String(problem?.message ?? problem));
        }
      };

      const validate = async () => {
        markTouched("root");
        if (rootState.error) return;
        const payload = await run("config/validate", { root: config.root, storeDir: config.storeDir, create: false });
        if (payload) setCheck(payload.check);
      };

      const save = async () => {
        markTouched("root");
        if (rootState.error) return;
        const payload = await run("config/set", { config });
        if (payload) {
          setCheck(payload.check);
          setDraft(null);
          const surfaceBefore = status?.config?.surface ?? "settings";
          const surfaceAfter = payload.config?.surface ?? config.surface ?? "settings";
          if (surfaceAfter !== surfaceBefore && typeof applySurfaceLive === "function") {
            /* 设置页自己可能马上被注销，所以先把提示渲染出来，再延时切换席位。 */
            setNotice(t.saved + " " + t.surfaceApplied);
            const target = surfaceAfter;
            setTimeout(() => {
              try {
                applySurfaceLive(target);
              } catch (problem) {
                /* 切换失败时下面的刷新仍会把宿主状态带回来 */
              }
            }, 900);
          } else {
            setNotice(surfaceAfter === surfaceBefore ? t.saved : t.saved + " " + t.surfaceReload);
          }
          onRefresh?.();
        }
      };

      const drives = status?.drives;
      /* 仅用于界面提示：宿主才是权威（相对 storeDir 一律按安装根解析）。 */
      const effectiveStore = (() => {
        const root = String(config.root ?? "").trim().replace(/[\\/]+$/, "");
        const raw = String(config.storeDir ?? "").trim();
        if (!raw) return root ? root + "/.store/v11" : "";
        if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/")) return raw;
        return root ? root + "/" + raw.replace(/^[\\/]+/, "") : raw;
      })();

      const problems = check?.problems ?? [];
      const warnings = check?.warnings ?? [];

      return h(
        "div",
        { className: "dshr dshr--settings" },
        h("div", { className: "dshr-sub" }, t.subtitle),
        error ? h("div", { className: "dshr-alert", role: "alert" }, Ico("cross"), error) : null,
        !status
          ? h("div", { className: "dshr-card" }, h(Skeleton, { w: "30%" }), h(Skeleton, null), h(Skeleton, { w: "70%" }))
          : h(
              "div",
              { className: "dshr-card" },
              h("div", { className: "dshr-grid" },
                h(Field, { id: "root", label: t.root, hint: t.rootHint, error: touched.root ? rootState.error : null },
                  h("div", { className: "dshr-row" },
                    h("input", {
                      id: "root",
                      className: "dshr-input",
                      style: { flex: 1, minWidth: 240 },
                      value: config.root ?? "",
                      placeholder: t.rootPlaceholder,
                      "aria-invalid": touched.root && rootState.error ? "true" : undefined,
                      "aria-describedby": "root-hint",
                      onBlur: () => markTouched("root"),
                      onChange: (event) => update({ root: event.target.value })
                    }),
                    h(Btn, { onClick: pick }, t.pick),
                    h(Btn, { onClick: validate, busy, disabled: Boolean(rootState.error) }, t.check)
                  ),
                  touched.root && !rootState.error && rootState.warning ? h("div", { className: "dshr-field__hint" }, Ico("warn"), rootState.warning) : null
                ),
                h(Field, { id: "store", label: t.store, hint: t.storeHint },
                  h("input", {
                    id: "store",
                    className: "dshr-input",
                    value: config.storeDir ?? "",
                    placeholder: "安装根/.store/v11",
                    "aria-describedby": "store-hint",
                    onChange: (event) => update({ storeDir: event.target.value })
                  })
                ),
                effectiveStore ? h("div", { className: "dshr-grid__span dshr-sub2" }, "实际生效：" + effectiveStore) : null,
                h(Field, { id: "surface", label: t.surface, hint: t.surfaceHint },
                  h("div", { className: "dshr-seg", role: "radiogroup", "aria-label": t.surface },
                    [["settings", t.surfaceSettings], ["sidebar", t.surfaceSidebar], ["both", t.surfaceBoth]].map(([value, label]) =>
                      h("button", {
                        key: value,
                        type: "button",
                        role: "radio",
                        "aria-checked": (config.surface ?? "settings") === value ? "true" : "false",
                        className: "dshr-seg__item" + ((config.surface ?? "settings") === value ? " is-on" : ""),
                        onClick: () => update({ surface: value })
                      }, label)))),
                h(Field, { id: "registry", label: t.registry, hint: t.registryHint },
                  h("input", { id: "registry", className: "dshr-input", value: config.registry ?? "", "aria-describedby": "registry-hint", onChange: (event) => update({ registry: event.target.value }) })
                ),
                h(Field, { id: "policy", label: t.policy },
                  h("select", { id: "policy", className: "dshr-input dshr-input--sm", value: config.defaultPolicy ?? "inDsh", onChange: (event) => update({ defaultPolicy: event.target.value }) },
                    h("option", { value: "inDsh" }, t.policyInDsh),
                    h("option", { value: "external" }, t.policyExternal))
                ),
                h(Field, { id: "oversize", label: t.oversizeMB },
                  h("div", { className: "dshr-row" },
                    h("input", { id: "oversize", className: "dshr-input dshr-input--sm", type: "number", min: 1, value: config.oversizeMB ?? 100, onChange: (event) => update({ oversizeMB: Number(event.target.value) }) }),
                    h("label", { className: "dshr-row", style: { gap: 6 } },
                      h("input", { type: "checkbox", checked: config.strictImplicitDeps !== false, onChange: (event) => update({ strictImplicitDeps: event.target.checked }) }),
                      h("span", null, t.strict))
                  )
                )
                ,
                h(Field, { id: "bodymode", label: t.bodyMode, hint: t.bodyModeHint },
                  h("select", { id: "bodymode", className: "dshr-input dshr-input--sm", value: config.bodyMode ?? "move", onChange: (event) => update({ bodyMode: event.target.value }) },
                    h("option", { value: "move" }, t.bodyModeMove),
                    h("option", { value: "keep" }, t.bodyModeKeep))
                ),
                h(Field, { id: "autopurge", label: t.autoPurge, hint: t.autoPurgeHint },
                  h("label", { className: "dshr-row", style: { gap: 6 } },
                    h("input", { id: "autopurge", type: "checkbox", checked: config.autoPurgeRollback === true, onChange: (event) => update({ autoPurgeRollback: event.target.checked }) })
                  )
                )
              ),
              h("div", { className: "dshr-row" },
                h(Btn, { kind: "primary", onClick: save, busy, disabled: !draft || Boolean(rootState.error) }, t.save),
                notice ? h("span", { className: "dshr-muted", role: "status" }, notice) : null
              )
            ),
        drives
          ? h(
              "div",
              { className: "dshr-card" },
              h("div", { className: "dshr-card__head" }, h("strong", null, t.driveTitle),
                h(Badge, { tone: drives.rootStoreSameDrive ? "ok" : "warn" }, drives.rootStoreSameDrive ? IcoText("check", t.sameDriveOk) : IcoText("warn", t.sameDriveBad))),
              h("div", { className: "dshr-sub2" }, "安装根 " + (drives.rootDrive ?? "?") + "　·　store " + (drives.storeDrive ?? "?") + "　·　.dsh " + (drives.homeDrive ?? "?")),
              h("div", { className: "dshr-sub2" }, drives.rootHomeSameDrive ? "安装根与 .dsh 同盘 ⇒ 迁移用硬链接瞬间完成。" : "安装根与 .dsh 不同盘 ⇒ 迁移会逐字节复制，先多占一份空间。"),
              (drives.notes ?? []).map((note, index) => h("div", { key: index, className: "dshr-sub2" }, "• " + note)),
              h("div", { className: "dshr-sub2" }, t.crossDriveWarn)
            )
          : null,
        check
          ? h(
              "div",
              { className: "dshr-card" },
              h("div", { className: "dshr-card__head" }, h("strong", null, t.resultTitle),
                problems.length ? h(Badge, { tone: "bad" }, t.errSummary + " " + problems.length) : h(Badge, { tone: "ok" }, Ico("check"), t.noProblem)),
              problems.length ? h("div", { className: "dshr-alert", role: "alert" }, problems.map((problem, index) => h("div", { key: "p" + index }, Ico("cross"), (problem.message ?? problem.code)))) : null,
              warnings.map((warning, index) => h("div", { key: "w" + index, className: "dshr-soft" }, Ico("warn"), (warning.message ?? warning.code)))
            )
          : null,
        rows && rows.length
          ? h(
              "div",
              { className: "dshr-card" },
              h("div", { className: "dshr-card__head" }, h("strong", null, t.perPluginRoot), h("span", { className: "dshr-sub2" }, t.perPluginRootHint)),
              h(
                "div",
                { className: "dshr-roots" },
                rows.map((row) =>
                  h(PluginRootRow, {
                    key: row.name,
                    t,
                    row,
                    value: (status?.config?.roots ?? {})[row.name] ?? "",
                    globalRoot: config.root ?? "",
                    onDone: onRefresh
                  })
                )
              )
            )
          : null,
        h(BodyCleanupCard, { t, onRefresh }),
        h("div", { className: "dshr-sub2" }, t.home + "：" + (status?.home ?? "…") + "　·　" + t.profile + "：" + (status?.profileDir ?? "…") + "　·　UI " + UI_VERSION)
      );
    }

    /* ------------------------------ 插件列表 ------------------------------ */
    function PluginsTab({ t, rows, onRefresh, run, loading, external, onOpenExternal }) {
      const [filter, setFilter] = useState("");
      const [sort, setSort] = useState("size");
      const [onlyExternal, setOnlyExternal] = useState(false);
      const [onlyRisk, setOnlyRisk] = useState(false);
      const [busyName, setBusyName] = useState(null);

      const all = rows ?? [];
      const needle = filter.trim().toLowerCase();
      let list = all.slice();
      if (needle) list = list.filter((row) => row.name.toLowerCase().includes(needle));
      if (onlyExternal) list = list.filter((row) => row.location === "external");
      if (onlyRisk) list = list.filter((row) => row.deps && row.deps.ok === false);
      list.sort((a, b) => (sort === "size" ? (b.size?.bytes ?? -1) - (a.size?.bytes ?? -1) : a.name.localeCompare(b.name)));

      const act = async (name, action, body) => {
        setBusyName(name);
        try {
          await run(action, { name, ...(body ?? {}) });
        } finally {
          setBusyName(null);
        }
      };

      const resetFilters = () => { setFilter(""); setOnlyExternal(false); setOnlyRisk(false); };
      const anyFilter = Boolean(needle) || onlyExternal || onlyRisk;
      const measured = all.filter((row) => row.size && typeof row.size.bytes === "number");
      const totalBytes = measured.reduce((sum, row) => sum + (row.size.bytes ?? 0), 0);
      const largest = measured.reduce((max, row) => Math.max(max, row.size.bytes ?? 0), 0) || 1;
      const externalCount = all.filter((row) => row.location === "external").length;
      const riskCount = all.filter((row) => row.deps && row.deps.ok === false).length;


      const depsCell = (row) => {
        if (!row.deps) return h("span", { className: "dshr-muted" }, "—");
        if (row.deps.ok) return h(Badge, { tone: "ok" }, Ico("check"), t.ok);
        const risks = row.deps.risks ?? [];
        return h(
          Badge,
          { tone: "bad", title: risks.map((risk) => risk.name + " @ " + risk.file + ":" + risk.line).join("\n") },
          Ico("cross"), t.risk + "：" + risks.map((risk) => risk.name).join("、")
        );
      };

      const actionsCell = (row) =>
        h(
          "div",
          { className: "dshr-row dshr-row--tight" },
          row.location === "external"
            ? h(ConfirmButton, { t, label: t.restore, question: t.confirmRestore, busy: busyName === row.name, onConfirm: () => act(row.name, "migrate/restore") })
            : h(ConfirmButton, { t, label: t.out, question: row.bodyExists ? t.confirmOutBody : t.confirmOutDeps, busy: busyName === row.name, disabled: row.protected, onConfirm: () => act(row.name, "migrate/out") }),
          h(Btn, { kind: "ghost", onClick: () => run("ignore/set", { name: row.name, ignored: !(row.ignored === true) }) }, row.ignored ? t.unignore : t.ignore),
          h(Btn, { kind: "ghost", onClick: () => run("open/path", { path: row.realPath ?? row.dir }) }, t.openDir)
        );

      const cardHtml = (row) => {
        const risky = row.deps && row.deps.ok === false;
        const share = row.size ? Math.max(2, Math.round(((row.size.bytes ?? 0) / largest) * 100)) : 0;
        const facts = row.size
          ? row.size.files.toLocaleString("en-US") + " " + t.files + " · " + t.exclusive + " " + bytes(row.size.exclusiveBytes ?? 0) + (row.size.sharedHuman ? " · " + t.shared + " " + row.size.sharedHuman : "")
          : "";
        const open = () => run("open/path", { path: row.realPath ?? row.dir });
        const fromButton = (event) => Boolean(event.target && event.target.closest && event.target.closest("button"));
        return h(
          "article",
          {
            key: row.name,
            className: "dshr-ccard is-clickable" + (risky ? " is-risk" : ""),
            tabIndex: 0,
            role: "group",
            "aria-label": row.name + " · " + (row.size ? bytes(row.size.bytes) : t.unknown),
            title: t.openCardHint,
            onClick: (event) => { if (!fromButton(event)) open(); },
            onKeyDown: (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              if (fromButton(event)) return;
              event.preventDefault();
              open();
            }
          },
          h(
            "div",
            { className: "dshr-ccard__head" },
            h("span", { className: "dshr-ccard__name", title: row.name }, row.name),
            h("span", { className: "dshr-ccard__ver" }, row.version ? "v" + row.version : "—")
          ),
          h(
            "div",
            { className: "dshr-ccard__tags" },
            row.isBundle ? h(Badge, null, "bundle") : null,
            row.location === "external" ? h(Badge, { tone: "ok" }, Ico("ext"), t.external) : h(Badge, null, t.inDsh),
            row.bodySpec || row.bodyExists ? h(Badge, { tone: row.bodyExists ? "warn" : "bad", title: (row.bodyExists ? t.bodyBadgeHint : t.bodyMissingHint) + "\n" + (row.bodySpec ?? "") }, row.bodyExists ? t.bodyBadge : t.bodyMissing) : null,
            row.protected ? h(Badge, { tone: "warn" }, t.protectedTag) : null,
            row.policy && row.policy !== "inherit" ? h(Badge, null, row.policy) : null,
            row.ignored ? h(Badge, { tone: "warn" }, t.ignore) : null
          ),
          row.size
            ? h(
                "div",
                { className: "dshr-ccard__size" },
                h("b", null, bytes(row.size.bytes)),
                h(
                  "div",
                  { className: "dshr-bar dshr-bar--mini dshr-ccard__bar", title: Math.round(((row.size.bytes ?? 0) / largest) * 100) + "%" },
                  h("i", { style: { width: share + "%" } })
                )
              )
            : h("div", { className: "dshr-ccard__size" }, h("span", { className: "dshr-muted" }, t.unknown)),
          row.size ? h("div", { className: "dshr-ccard__facts", title: facts }, facts) : null,
          h("div", { className: "dshr-ccard__foot" }, depsCell(row), h("div", { className: "dshr-ccard__acts" }, actionsCell(row)))
        );
      };

      /* 骨架卡：与真卡片同网格，避免加载完成时跳动 */
      const cardsLoading = [0, 1, 2, 3, 4, 5].map((index) =>
        h("div", { key: "s" + index, className: "dshr-ccard", "aria-busy": "true" }, h(Skeleton, null), h(Skeleton, { w: "60%" }))
      );

      const body =
        loading && list.length === 0
          ? cardsLoading
          : list.length === 0
            ? h(
                "div",
                { className: "dshr-cards__span" },
                h(Empty, {
                  text: all.length === 0 ? t.noPlugins : anyFilter ? t.noMatch : t.empty,
                  action: anyFilter ? h(Btn, { onClick: resetFilters }, t.clearFilters) : h(Btn, { onClick: () => run("plugins/measure", {}) }, t.measure)
                })
              )
            : list.map(cardHtml);

      return h(
        "div",
        { className: "dshr dshr-plist" },
        h(
          "div",
          { className: "dshr-kpis" },
          kpi(t.kpiPlugins, String(all.length)),
          kpi(t.kpiExternal, String(externalCount)),
          kpi(t.kpiTotal, measured.length ? bytes(totalBytes) : t.unknown, measured.length ? "dshr-kpi--key" : null),
          kpi(t.kpiRisk, String(riskCount), riskCount > 0 ? "is-bad" : null)
        ),
        external?.counts?.unmounted > 0
          ? h(
              "div",
              { className: "dshr-alert" },
              Ico("warn"),
              h("span", null, external.counts.unmounted + " " + t.extUnmountedBanner),
              h("span", { className: "dshr-toolbar__spacer" }),
              h(Btn, { kind: "ghost", onClick: onOpenExternal }, t.extGoExternal)
            )
          : null,
        h(
          "div",
          { className: "dshr-toolbar" },
          h(
            "div",
            { className: "dshr-toolbar__search" },
            h("span", { className: "dshr-toolbar__icon", "aria-hidden": "true" }, Ico("search")),
            h("input", { className: "dshr-input", placeholder: t.searchPlaceholder, value: filter, "aria-label": t.filter, onChange: (event) => setFilter(event.target.value) })
          ),
          h(
            "div",
            { className: "dshr-seg", role: "group", "aria-label": t.sort },
            [["size", t.sortSize], ["name", t.sortName]].map(([value, label]) =>
              h("button", { key: value, type: "button", className: "dshr-seg__item" + (sort === value ? " is-on" : ""), "aria-pressed": sort === value ? "true" : "false", onClick: () => setSort(value) }, label))
          ),
          h("button", { type: "button", className: "dshr-chip" + (onlyExternal ? " is-on" : ""), "aria-pressed": onlyExternal ? "true" : "false", onClick: () => setOnlyExternal(!onlyExternal) }, t.onlyExternal),
          h("button", { type: "button", className: "dshr-chip" + (onlyRisk ? " is-on" : ""), "aria-pressed": onlyRisk ? "true" : "false", onClick: () => setOnlyRisk(!onlyRisk) }, t.onlyRisk),
          anyFilter ? h("button", { type: "button", className: "dshr-chip dshr-chip--ghost", onClick: resetFilters }, Ico("cross"), t.clearFilters) : null,
          h("span", { className: "dshr-toolbar__spacer" }),
          h(Btn, { kind: "primary", onClick: () => run("plugins/measure", {}) }, t.measure),
          h(Btn, { onClick: onRefresh, busy: loading }, t.refresh)
        ),
        h("div", { className: "dshr-cards", "aria-busy": loading ? "true" : "false" }, body),
        h("div", { className: "dshr-sub2" }, "共 " + list.length + " / " + all.length + " " + t.countUnit + (measured.length ? "　·　" + t.kpiTotal + " " + bytes(totalBytes) : ""))
      );
    }
    /* ------------------------------ 外置插件 ------------------------------ */
    function ExternalTab({ t, data, trash, run, onRefresh, loading, onOpenSettings }) {
      const items = data?.items ?? [];
      const counts = data?.counts ?? { total: 0, mounted: 0, unmounted: 0, mountedElsewhere: 0, broken: 0 };
      const roots = data?.roots ?? [];
      const trashItems = trash?.items ?? [];
      const trashCounts = trash?.counts ?? { total: 0, human: "0 B" };
      const [checks, setChecks] = useState({});
      const [drafts, setDrafts] = useState({});
      const [sourceNote, setSourceNote] = useState(null);

      const line = (ico, text) => h(React.Fragment, null, Ico(ico), " " + text);

      const mountBadge = (item) => {
        if (item.mount.state === "mounted") return h(Badge, { key: "m", tone: "ok", title: t.extMountedHint }, t.extMounted);
        if (item.mount.state === "unmounted") return h(Badge, { key: "m", tone: "warn", title: t.extUnmountedHint }, t.extUnmounted);
        if (item.mount.state === "mounted-elsewhere") return h(Badge, { key: "m", tone: "warn", title: t.extElsewhereHint }, t.extElsewhere);
        return h(Badge, { key: "m", tone: "bad", title: t.extBrokenHint }, t.extBroken);
      };

      const doCheck = async (name) => {
        const payload = await run("external/check", { name });
        if (payload?.check) setChecks((previous) => ({ ...previous, [name]: payload.check }));
      };
      const saveSource = async (name) => {
        const spec = String(drafts[name] ?? "").trim();
        if (!spec) return;
        const payload = await run("external/source", { name, spec });
        if (payload) {
          setDrafts((previous) => ({ ...previous, [name]: "" }));
          setSourceNote(name + " " + t.extSourceSaved);
          onRefresh?.();
        }
      };

      const act = async (name, verb, body) => {
        await run("external/" + verb, { name, ...(body ?? {}) });
        onRefresh?.();
      };

      const checkLine = (item) => {
        const check = checks[item.name];
        if (!check) return null;
        if (check.ok === false) return line("cross", check.error ?? t.extCheckUnsupported);
        if (check.supported === false) return line("warn", check.reason);
        if (check.hasUpdate) return line("dot", t.extHasUpdate + "：" + (check.latest ?? check.remoteHead));
        return line("check", t.extUpToDate + (check.latest ? "（" + check.latest + "）" : ""));
      };

      const card = (item) => {
        const canUpdate = ["registry", "git", "tarball", "url"].includes(item.source?.kind);
        const check = checks[item.name];
        const acts = [];
        if (item.mount.state === "unmounted") acts.push(h(ConfirmButton, { key: "attach", t, label: t.extAttach, question: t.extAttachQuestion, confirmLabel: t.extAttach, onConfirm: () => act(item.name, "attach") }));
        if (item.mount.state === "mounted-elsewhere") acts.push(h(ConfirmButton, { key: "takeover", t, label: t.extTakeover, question: t.extTakeoverQuestion, confirmLabel: t.extTakeover, onConfirm: () => act(item.name, "attach", { force: true }) }));
        if (item.mount.state === "mounted") acts.push(h(ConfirmButton, { key: "detach", t, label: t.extDetach, question: t.extDetachQuestion, confirmLabel: t.extDetach, onConfirm: () => act(item.name, "detach") }));
        if (canUpdate) {
          acts.push(h(Btn, { key: "check", kind: "ghost", onClick: () => doCheck(item.name) }, t.extCheck));
          if (check?.hasUpdate) acts.push(h(ConfirmButton, { key: "update", t, label: t.extUpdate + " " + (check.latest ?? ""), question: t.extUpdateQuestion, confirmLabel: t.extUpdate, onConfirm: () => act(item.name, "update") }));
        }
        acts.push(h(Btn, { key: "open", kind: "ghost", onClick: () => run("open/path", { path: item.dir }) }, t.extOpen));
        acts.push(h(ConfirmButton, { key: "remove", t, label: t.extRemove, question: t.extRemoveQuestion, confirmLabel: t.extRemove, onConfirm: () => act(item.name, "remove") }));
        return h(
          "article",
          { key: item.name, className: "dshr-ccard" + (item.mount.state === "broken" ? " dshr-ccard--blocked" : ""), role: "group", "aria-label": item.name },
          h(
            "div",
            { className: "dshr-ccard__head" },
            h("span", { className: "dshr-ccard__name", title: item.dir }, item.name),
            h("span", { className: "dshr-ccard__ver" }, item.version ? "v" + item.version : "—")
          ),
          h("div", { className: "dshr-ccard__tags" }, mountBadge(item), h(Badge, { key: "s", title: item.dir }, t.extSource + "：" + (item.originalSpec ?? t.extNoSource))),
          item.description ? h("div", { className: "dshr-ccard__facts", title: item.description }, item.description) : null,
          h("div", { className: "dshr-ccard__facts dshr-mono", title: item.dir }, item.dir),
          h(
            "div",
            { className: "dshr-ccard__facts" },
            t.extDepsCount + " " + (item.declared?.length ?? 0) + (item.size ? "　·　" + bytes(item.size.bytes) + "　·　" + item.size.files + " " + t.extFiles : "")
          ),
          h(
            "div",
            { className: "dshr-ccard__facts dshr-ccard__src" },
            h("input", {
              className: "dshr-input dshr-input--sm",
              value: drafts[item.name] ?? "",
              placeholder: item.originalSpec ?? t.extSourcePlaceholder,
              title: t.extSourceHint,
              "aria-label": t.extSource + " · " + item.name,
              onChange: (event) => setDrafts((previous) => ({ ...previous, [item.name]: event.target.value })),
              onKeyDown: (event) => { if (event.key === "Enter") saveSource(item.name); }
            }),
            h(Btn, { kind: "ghost", disabled: !String(drafts[item.name] ?? "").trim(), onClick: () => saveSource(item.name) }, t.extSetSource)
          ),
          checkLine(item) ? h("div", { className: "dshr-ccard__facts", role: "status" }, checkLine(item)) : null,
          h("div", { className: "dshr-ccard__foot" }, h("div", { className: "dshr-ccard__acts" }, acts))
        );
      };

      const skeletons = [0, 1, 2].map((index) =>
        h("div", { key: "es" + index, className: "dshr-ccard", "aria-busy": "true" }, h(Skeleton, null), h(Skeleton, { w: "60%" }))
      );

      const body = loading && items.length === 0
        ? skeletons
        : data === null
          ? h("div", { className: "dshr-cards__span" }, h("div", { className: "dshr-alert" }, Ico("warn"), h("span", null, t.extHostHint)))
          : items.length === 0
          ? h("div", { className: "dshr-cards__span" }, h(Empty, { text: roots.length ? t.extEmpty : t.extNoRoot, action: roots.length ? null : h(Btn, { onClick: onOpenSettings }, t.extGoSettings) }))
          : items.map(card);

      return h(
        "div",
        { className: "dshr dshr-plist" },
        h(
          "div",
          { className: "dshr-kpis" },
          kpi(t.extKpiTotal, String(counts.total)),
          kpi(t.extKpiMounted, String(counts.mounted), counts.mounted > 0 ? "dshr-kpi--key" : null),
          kpi(t.extKpiUnmounted, String(counts.unmounted), counts.unmounted > 0 ? "is-bad" : null),
          kpi(t.extKpiTrash, trashCounts.human)
        ),
        h(
          "div",
          { className: "dshr-toolbar" },
          h("div", { className: "dshr-sub2" }, t.extSubHint),
          h("span", { className: "dshr-toolbar__spacer" }),
          h(Btn, { kind: "primary", onClick: async () => { await run("external/scan", { measure: true }); onRefresh?.(); } }, t.extMeasure),
          h(Btn, { onClick: onRefresh, busy: loading }, t.extRescan)
        ),
        roots.length ? h("div", { className: "dshr-sub2" }, t.extRoots + "：" + roots.join("　·　")) : null,
        h("div", { className: "dshr-cards dshr-cards--wide", "aria-busy": loading ? "true" : "false" }, body),
        trashCounts.total > 0
          ? h(
              React.Fragment,
              null,
              h("div", { className: "dshr-sectionlabel" }, t.extTrashTitle + "（" + trashCounts.total + "）"),
              h("div", { className: "dshr-sub2" }, t.extTrashHint),
              h(
                "div",
                { className: "dshr-cards" },
                trashItems.map((item) =>
                  h(
                    "article",
                    { key: item.dir, className: "dshr-ccard" },
                    h(
                      "div",
                      { className: "dshr-ccard__head" },
                      h("span", { className: "dshr-ccard__name", title: item.dir }, item.name),
                      h("span", { className: "dshr-ccard__ver" }, item.human)
                    ),
                    h(
                      "div",
                      { className: "dshr-ccard__foot" },
                      h(
                        "div",
                        { className: "dshr-ccard__acts" },
                        h(ConfirmButton, {
                          t,
                          label: t.extPurge,
                          question: t.extPurgeQuestion,
                          confirmLabel: t.extPurge,
                          onConfirm: async () => {
                            await run("external/trash/purge", { confirm: true, names: [item.name] });
                            onRefresh?.();
                          }
                        })
                      )
                    )
                  )
                )
              )
            )
          : null,
        sourceNote ? h("div", { className: "dshr-sub2", role: "status" }, sourceNote) : null,
        h("div", { className: "dshr-sub2" }, t.extRestartTip)
      );
    }

    /* ------------------------------ 智能推荐 ------------------------------ */
    function RecommendTab({ t, data, run, onRefresh, loading }) {
      const summary = data?.summary;
      const candidates = data?.candidates ?? [];
      const blocked = data?.blocked ?? [];
      const ignored = data?.ignored ?? [];
      const tone = (strength) => (strength === "strong" ? "ok" : strength === "medium" ? "warn" : null);
      const tierLabel = (strength) => (strength === "strong" ? t.scoreStrong : strength === "medium" ? t.scoreMedium : t.scoreWeak);

      const openRow = (item) => run("open/path", { path: item.realPath ?? item.dir });
      const hasDir = (item) => Boolean(item.realPath || item.dir);

      /* 候选卡：与小卡片同一套组件与栅格，缩到 3～4 行文本高度 */
      const candidateCard = (item) =>
        h(
          "article",
          { key: item.name, className: "dshr-ccard" },
          h(
            "div",
            { className: "dshr-ccard__head" },
            h("span", { className: "dshr-ccard__name", title: item.name }, item.name),
            h(
              "span",
              { className: "dshr-ccard__ver" },
              h(Badge, { tone: tone(item.strength) }, IcoText(item.strength === "strong" ? "dot" : "ring", tierLabel(item.strength) + " " + item.score))
            )
          ),
          h(
            "div",
            { className: "dshr-ccard__tags" },
            h(Badge, null, t.size + " " + (item.size ? bytes(item.size.bytes ?? 0) : t.unknown)),
            h(Badge, null, t.gain + " " + (item.size ? (item.estimatedExclusiveHuman ?? "0 B") : t.unknown))
          ),
          h(
            "div",
            { className: "dshr-ccard__why" },
            h(
              "ul",
              { className: "dshr-reasons dshr-reasons--flow" },
              item.reasons.map((reason, index) =>
                h(
                  "li",
                  { key: index, title: reason.text },
                  h("span", { className: "w" }, reason.weight ? "+" + reason.weight : t.weightHint),
                  h("span", null, reason.text)
                )
              )
            )
          ),
          h(
            "div",
            { className: "dshr-ccard__foot" },
            h("span", { className: "dshr-sub2" }, t.reasons + " " + item.reasons.length),
            h(
              "div",
              { className: "dshr-ccard__acts" },
              h(ConfirmButton, { t, label: t.adopt, question: t.confirmOut, onConfirm: () => run("migrate/out", { name: item.name }) }),
              hasDir(item) ? h(Btn, { kind: "ghost", title: t.openDir, onClick: () => openRow(item) }, t.view) : null,
              h(Btn, { kind: "ghost", onClick: () => run("ignore/set", { name: item.name, ignored: true }) }, t.ignore)
            )
          )
        );

      /* 拦下的候选：同款小卡片，但降饱和 + 虚线边框，并保留每条拦截原因 */
      const blockedCard = (item) =>
        h(
          "article",
          { key: item.name, className: "dshr-ccard dshr-ccard--blocked" },
          h(
            "div",
            { className: "dshr-ccard__head" },
            h("span", { className: "dshr-ccard__name", title: item.name }, item.name),
            h("span", { className: "dshr-ccard__ver" }, t.score + " " + item.score)
          ),
          h(
            "div",
            { className: "dshr-ccard__tags" },
            h(Badge, { tone: "warn" }, t.kpiBlocked),
            item.size ? h(Badge, null, t.size + " " + bytes(item.size.bytes ?? 0)) : null
          ),
          h(
            "div",
            { className: "dshr-ccard__why" },
            h("div", { className: "dshr-sub2" }, t.blockedWhy),
            item.preconditions.map((condition, index) => h("div", { key: index, className: "dshr-alert" }, Ico("cross"), condition.text)),
            (item.reasons ?? []).map((reason, index) => h("div", { key: "r" + index, className: "dshr-sub2" }, "• " + reason.text))
          ),
          hasDir(item)
            ? h(
                "div",
                { className: "dshr-ccard__foot" },
                h("div", { className: "dshr-ccard__acts" }, h(Btn, { kind: "ghost", title: t.openDir, onClick: () => openRow(item) }, t.view))
              )
            : null
        );

      return h(
        "div",
        { className: "dshr" },
        h("div", { className: "dshr-sub" }, t.recommendHint),
        h(
          "div",
          { className: "dshr-toolbar" },
          summary
            ? h(
                "div",
                { className: "dshr-kpis dshr-kpis--bare" },
                h("div", { className: "dshr-kpi" }, h("span", null, t.kpiCandidate), h("b", null, String(summary.candidateCount))),
                h("div", { className: "dshr-kpi" }, h("span", null, t.kpiBlocked), h("b", null, String(summary.blockedCount))),
                h("div", { className: "dshr-kpi" + (Number(summary.estimatedGainBytes ?? 0) > 0 ? " dshr-kpi--key" : "") }, h("span", null, t.kpiGain), h("b", null, summary.estimatedGainHuman))
              )
            : h("div", { className: "dshr-sub2" }, loading ? t.statusLoading : t.empty),
          h("span", { className: "dshr-toolbar__spacer" }),
          h(Btn, { kind: "primary", onClick: () => run("plugins/measure", {}) }, t.measure),
          h(Btn, { onClick: onRefresh, busy: loading }, t.refresh)
        ),
        h(
          "details",
          { className: "dshr-details" },
          h("summary", null, t.hardlinkTip),
          h("div", { className: "dshr-sub2", style: { marginTop: 6 } }, t.hardlinkBody)
        ),
        h("div", { className: "dshr-sectionlabel" }, h("strong", null, t.recommendTitle), h(Badge, null, String(candidates.length))),
        loading && candidates.length === 0
          ? h(
              "div",
              { className: "dshr-cards dshr-cards--wide", "aria-busy": "true" },
              [0, 1, 2, 3].map((index) => h("div", { key: "s" + index, className: "dshr-ccard" }, h(Skeleton, null), h(Skeleton, { w: "70%" })))
            )
          : null,
        !loading && candidates.length === 0 ? h("div", { className: "dshr-card" }, h(Empty, { text: t.noCandidate })) : null,
        candidates.length ? h("div", { className: "dshr-cards dshr-cards--wide" }, candidates.map(candidateCard)) : null,
        h("div", { className: "dshr-sectionlabel" }, h("strong", null, t.blockedTitle), h(Badge, null, String(blocked.length))),
        blocked.length === 0
          ? h("div", { className: "dshr-sub2" }, t.noBlocked)
          : h("div", { className: "dshr-cards dshr-cards--wide" }, blocked.map(blockedCard)),
        ignored.length
          ? h("div", { className: "dshr-sub2" }, t.kpiIgnored + " " + ignored.length + " · " + ignored.map((item) => item.name).join("、"))
          : null
      );
    }

    /* ------------------------------ 进度与日志 ------------------------------ */
    function LogsTab({ t, status, run, onRefresh }) {
      const [history, setHistory] = useState([]);
      const [rollbacks, setRollbacks] = useState([]);
      const [report, setReport] = useState(null);
      const [busy, setBusy] = useState(null);
      const active = status?.journal?.active;

      const load = useCallback(async () => {
        setBusy("load");
        try {
          const payload = await run("history", { limit: 50 });
          if (payload) setHistory(payload.items ?? []);
          const points = await run("rollback/list", {});
          if (points) setRollbacks(points.items ?? []);
        } finally {
          setBusy(null);
        }
      }, [run]);

      useEffect(() => {
        load();
      }, [load]);

      const loadReport = async () => {
        setBusy("report");
        try {
          const payload = await run("doctor/report", {});
          if (payload?.report) setReport(payload.report);
        } finally {
          setBusy(null);
        }
      };

      const runDoctor = async () => {
        setBusy("doctor");
        try {
          await run("doctor/run", {});
          onRefresh?.();
        } finally {
          setBusy(null);
        }
      };

      return h(
        "div",
        { className: "dshr" },
        active
          ? h(
              "div",
              { className: "dshr-card" },
              h("div", { className: "dshr-card__head" }, h("strong", null, t.progressTitle), h(Badge, { tone: "ok" }, active.op + (active.plugin ? " · " + active.plugin : ""))),
              h(
                "div",
                { className: "dshr-bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": active.percent ?? 0 },
                h("i", { style: { width: Math.max(0, Math.min(100, active.percent ?? 0)) + "%" } })
              ),
              h("div", { className: "dshr-progress-meta" }, h("span", null, (active.percent ?? 0) + "%"), h("span", null, active.message ?? ""))
            )
          : h("div", { className: "dshr-card" }, h("strong", null, t.progressTitle), h("div", { className: "dshr-sub2" }, t.noProgress)),
        h(
          "div",
          { className: "dshr-row" },
          h(Btn, { onClick: onRefresh }, t.refresh),
          h(Btn, { onClick: runDoctor, busy: busy === "doctor" }, t.runDoctor),
          h(Btn, { onClick: loadReport, busy: busy === "report" }, t.doctorTitle),
          h(Btn, { onClick: load, busy: busy === "load" }, t.reloadLogs)
        ),
        rollbacks.length
          ? h(
              "div",
              { className: "dshr-card" },
              h("div", { className: "dshr-card__head" }, h("strong", null, t.rollbackPoints), h(Badge, null, String(rollbacks.length))),
              h("div", { className: "dshr-sub2" }, t.rollbackHint),
              rollbacks.map((point) =>
                h(
                  "div",
                  { key: point.opId, className: "dshr-row", style: { marginTop: 4 } },
                  h("span", null, (point.mode === "out" ? t.out : t.restore) + " " + point.plugin + "　" + new Date(point.at).toLocaleString()),
                  h(Badge, { tone: point.undone ? "ok" : null }, point.undone ? t.done : t.rollbackable),
                  h(Badge, { tone: "ok", title: t.reclaimable }, t.reclaimable + " " + (point.freedHuman ?? "0 B")),
                  point.sharedBytes ? h(Badge, { tone: "warn", title: t.stillLinked }, t.stillLinked + " " + bytes(point.sharedBytes)) : null,
                  point.backupExists ? h(ConfirmButton, { t, label: t.purge, question: t.confirmPurge, onConfirm: () => run("migrate/purge", { opId: point.opId }).then(load) }) : null,
                  !point.undone ? h(ConfirmButton, { t, label: t.rollback, question: t.confirmRollback, kind: "danger", onConfirm: () => run("migrate/rollback", { opId: point.opId }).then(load) }) : null
                )
              )
            )
          : h("div", { className: "dshr-card" }, h("strong", null, t.rollbackPoints), h("div", { className: "dshr-sub2" }, t.noRollback)),
        report
          ? h(
              "div",
              { className: "dshr-card" },
              h("strong", null, t.doctorTitle),
              h(
                "div",
                { className: "dshr-sub2" },
                ".dsh 共 " + report.totals.files.toLocaleString("en-US") + " 个文件 / 去重后 " + bytes(report.totals.bytes) + "（逻辑 " + bytes(report.totals.logicalBytes) + "，硬链接共享 " + bytes(report.totals.sharedBytes) + "）"
              ),
              h("div", null, t.reclaimSafe + "：" + report.reclaimSafeHuman),
              h(
                "div",
                { className: "dshr-tablewrap" },
                h(
                  "table",
                  { className: "dshr-table" },
                  h("thead", null, h("tr", null, h("th", { scope: "col" }, t.reclaim), h("th", { scope: "col", className: "dshr-num" }, t.size), h("th", { scope: "col" }, t.risk))),
                  h(
                    "tbody",
                    null,
                    report.reclaim.map((item) =>
                      h(
                        "tr",
                        { key: item.id },
                        h("td", null, h("div", { className: "dshr-name" }, item.label), h("div", { className: "dshr-sub2 dshr-mono" }, item.path)),
                        h("td", { className: "dshr-num" }, item.human ?? "—"),
                        h("td", null, h(Badge, { tone: item.risk === "safe" ? "ok" : "warn" }, item.risk === "safe" ? t.risk_safe : t.risk_review))
                      )
                    )
                  )
                )
              ),
              h("strong", null, t.largestDirs),
              h(
                "div",
                { className: "dshr-tablewrap" },
                h(
                  "table",
                  { className: "dshr-table" },
                  h("thead", null, h("tr", null, h("th", { scope: "col" }, "目录"), h("th", { scope: "col", className: "dshr-num" }, t.size), h("th", { scope: "col", className: "dshr-num" }, t.exclusive))),
                  h(
                    "tbody",
                    null,
                    report.rows.slice(0, 12).map((row) =>
                      h(
                        "tr",
                        { key: row.key },
                        h("td", { className: "dshr-mono" }, row.key),
                        h("td", { className: "dshr-num" }, bytes(row.bytes)),
                        h("td", { className: "dshr-num" }, bytes(row.exclusiveBytes))
                      )
                    )
                  )
                )
              )
            )
          : null,
        h(
          "div",
          { className: "dshr-card" },
          h("strong", null, t.logsTitle),
          history.length === 0
            ? h(Empty, { text: t.noHistory })
            : h(
                "div",
                { className: "dshr-timeline" },
                history.map((record) =>
                  h(
                    "div",
                    { key: record.id, className: "dshr-timeline__item" },
                    h(
                      "div",
                      { className: "dshr-row" },
                      h(Badge, { tone: record.status === "ok" ? "ok" : record.status === "failed" ? "bad" : null }, record.status === "ok" ? IcoText("check", t.done) : record.status === "failed" ? IcoText("cross", t.failed) : record.status),
                      h("span", null, record.op + " " + (record.plugin ?? "")),
                      h("span", { className: "dshr-sub2" }, new Date(record.startedAt).toLocaleString())
                    ),
                    record.error ? h("div", { className: "dshr-alert", style: { marginTop: 4 } }, record.error) : null,
                    record.steps?.length ? h("div", { className: "dshr-sub2" }, record.steps.map((step) => step.name + "(" + step.status + " " + step.ms + "ms)").join("　")) : null
                  )
                )
              )
        )
      );
    }

    /* ------------------------------ 主界面 ------------------------------ */
    function RelocatorSection(props) {
      const t = props.t ?? ((key) => DICT.zh[key] ?? key);
      const [tab, setTab] = useState(props.surface === "main" ? "plugins" : "settings");
      const [status, setStatus] = useState(null);
      const [rows, setRows] = useState([]);
      const [suggestions, setSuggestions] = useState(null);
      const [external, setExternal] = useState(null);
      const [externalTrash, setExternalTrash] = useState(null);
      const [loading, setLoading] = useState(true);
      const { run, error } = useApiCall();
      const tabRefs = useRef([]);

      const loadAll = useCallback(async () => {
        setLoading(true);
        try {
          const statusPayload = await run("status", {}, "GET");
          if (statusPayload) setStatus(statusPayload);
          const listPayload = await run("plugins/list", { withDeps: true, measure: false });
          if (listPayload) setRows(listPayload.rows ?? []);
          const extPayload = await run("external/scan", {});
          setExternal(extPayload ?? null);
          if (tab === "external") {
            const trashPayload = await run("external/trash", {});
            if (trashPayload) setExternalTrash(trashPayload);
          }
          if (tab === "recommend") {
            const payload = await run("recommend", { measure: false });
            if (payload) setSuggestions(payload);
          }
        } finally {
          setLoading(false);
        }
      }, [run, tab]);

      useEffect(() => {
        loadAll();
      }, [loadAll]);

      useEffect(() => {
        const timer = setInterval(async () => {
          const payload = await run("progress", {});
          if (payload) setStatus((previous) => ({ ...(previous ?? {}), journal: payload }));
        }, 1500);
        return () => clearInterval(timer);
      }, [run]);

      const journal = status?.journal ?? {};
      const jobs = Array.isArray(journal.actives) && journal.actives.length
        ? journal.actives
        : journal.active
          ? [journal.active]
          : [];
      const lastRecord = journal.last ?? null;
      const [toast, setToast] = useState(null);
      const lastSeen = useRef(null);
      /* 打开界面前就已经结束的历史记录不弹提示，只提示本次打开后完成的作业。 */
      const mountedAt = useRef(Date.now());

      useEffect(() => {
        if (!lastRecord || !lastRecord.id) return;
        if (lastSeen.current === lastRecord.id) return;
        lastSeen.current = lastRecord.id;
        if (lastRecord.status !== "ok" && lastRecord.status !== "failed") return;
        const finished = Number(lastRecord.finishedAt ?? 0);
        if (finished && finished <= mountedAt.current) return;
        setToast({ record: lastRecord, at: Date.now() });
      }, [lastRecord?.id, lastRecord?.status]);

      useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(null), 12000);
        return () => clearTimeout(timer);
      }, [toast]);

      const jobStrip = jobs.length
        ? h(
            "div",
            { className: "dshr-jobstrip", role: "status", "aria-live": "polite" },
            h(
              "div",
              { className: "dshr-jobstrip__head" },
              h("strong", null, t.jobTitle),
              jobs.length > 1 ? h(Badge, null, t.jobQueueHead + " " + jobs.length) : null,
              h("span", { className: "dshr-toolbar__spacer" }),
              h(Btn, { kind: "ghost", onClick: () => setTab("logs") }, t.jobGo)
            ),
            jobs.map((job) =>
              h(
                "div",
                { key: job.opId ?? job.id, className: "dshr-job" },
                h(
                  "div",
                  { className: "dshr-job__top" },
                  h("span", { className: "dshr-job__name" }, (job.op ?? "") + (job.plugin ? " · " + job.plugin : "")),
                  h("span", { className: "dshr-sub2" }, job.phase ?? ""),
                  h("span", { className: "dshr-toolbar__spacer" }),
                  h("span", { className: "dshr-num" }, (job.percent ?? 0) + "%")
                ),
                h(
                  "div",
                  { className: "dshr-bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": job.percent ?? 0 },
                  h("i", { style: { width: Math.max(0, Math.min(100, job.percent ?? 0)) + "%" } })
                ),
                h(
                  "div",
                  { className: "dshr-progress-meta" },
                  job.totalFiles
                    ? h("span", null, t.jobFilesLabel + " " + (job.files ?? 0).toLocaleString("en-US") + " / " + job.totalFiles.toLocaleString("en-US"))
                    : null,
                  h("span", { className: "dshr-job__msg", title: job.message ?? "" }, job.message ?? "")
                )
              )
            )
          )
        : null;

      const toastNode = toast
        ? h(
            "div",
            { className: "dshr-toast", role: "status" },
            h(
              "div",
              { className: "dshr-toast__top" },
              h(Badge, { tone: toast.record?.status === "ok" ? "ok" : "bad" }, toast.record?.status === "ok" ? IcoText("check", t.jobDone) : IcoText("cross", t.jobFailed)),
              h("strong", null, ((toast.record?.op ?? "") + " " + (toast.record?.plugin ?? "")).trim()),
              h("span", { className: "dshr-toolbar__spacer" }),
              h(Btn, { kind: "ghost", onClick: () => { setTab("logs"); setToast(null); } }, t.jobGo),
              h(Btn, { kind: "ghost", onClick: () => setToast(null) }, t.jobClose)
            ),
            toast.record?.status === "ok" && toast.record?.result
              ? h(
                  "div",
                  { className: "dshr-toast__body" },
                  h("div", null, t.reclaimable + "：" + (toast.record.result.freed?.fullyFreedHuman ?? "0 B")),
                  toast.record.result.freed?.stillLinkedHuman && toast.record.result.freed.stillLinkedHuman !== "0 B"
                    ? h("div", { className: "dshr-sub2" }, t.stillLinked + "：" + toast.record.result.freed.stillLinkedHuman)
                    : null,
                  toast.record.result.targetDir ? h("div", { className: "dshr-sub2" }, t.targetDir + "：" + toast.record.result.targetDir) : null,
                  toast.record.result.rollback?.fullyFreedHuman
                    ? h("div", { className: "dshr-sub2" }, t.rollbackKept + "：" + toast.record.result.rollback.fullyFreedHuman)
                    : null
                )
              : h("div", { className: "dshr-toast__body dshr-sub2" }, toast.record?.error ?? t.jobFailed)
          )
        : null;

      const tabs = [
        ["settings", t.tabSettings],
        ["plugins", t.tabPlugins],
        ["recommend", t.tabRecommend],
        ["external", t.tabExternal],
        ["logs", t.tabLogs]
      ];

      const onTabKey = (event) => {
        const index = tabs.findIndex(([key]) => key === tab);
        let next = null;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        if (next === null) return;
        event.preventDefault();
        setTab(tabs[next][0]);
        const node = tabRefs.current[next];
        if (node && node.focus) node.focus();
      };

      const panel = (key) => {
        if (key === "settings") return h(SettingsTab, { t, status, onRefresh: loadAll, uiWorkspace: props.uiWorkspace, rows });
        if (key === "plugins") return h(PluginsTab, { t, rows, onRefresh: loadAll, run, loading, external, onOpenExternal: () => setTab("external") });
        if (key === "recommend") return h(RecommendTab, { t, data: suggestions, run, onRefresh: loadAll, loading });
        if (key === "external") return h(ExternalTab, { t, data: external, trash: externalTrash, run, onRefresh: loadAll, loading, onOpenSettings: () => setTab("settings") });
        return h(LogsTab, { t, status, run, onRefresh: loadAll });
      };

      return h(
        "div",
        { className: props.surface === "main" ? "dshr dshr--panel" : props.surface === "settings" ? "dshr dshr--settings" : "dshr" },
        props.surface === "main"
          ? h("header", { className: "dshr-pagehead" }, h("h1", { className: "dshr-h1" }, t.title), h("p", { className: "dshr-sub", style: { margin: 0 } }, t.subtitle))
          : h("h1", { className: "dshr-h1" }, t.title),
        h(
          "div",
          { className: "dshr-tabs", role: "tablist", "aria-label": t.nav, title: t.tabsHint, onKeyDown: onTabKey },
          tabs.map(([key, label], index) =>
            h(
              "button",
              {
                key,
                type: "button",
                ref: (node) => {
                  tabRefs.current[index] = node;
                },
                className: "dshr-tab",
                role: "tab",
                "aria-selected": tab === key,
                tabIndex: tab === key ? 0 : -1,
                onClick: () => setTab(key)
              },
              jobs.length && key === "logs" ? [label, h("span", { key: "dot", className: "dshr-tab__dot", "aria-hidden": "true" })] : label
            )
          )
        ),
        jobStrip,
        error ? h("div", { className: "dshr-alert", role: "alert" }, Ico("cross"), error) : null,
        h("div", { className: "dshr-panelbody", role: "tabpanel", "aria-label": tabs.find(([key]) => key === tab)?.[1] }, panel(tab)),
        toastNode
      );
    }

    let ctxRef = null;
    /* 座位账本：槽位名 → 注销函数数组，由 apply 里的 mountSeat/disposeSeat 维护。
       放模块级是为了让设置页能通过 applySurfaceLive 立刻换席位，不必刷新页面。 */
    const seatOffs = { "settings.section": [], "sidebar.panellist": [], main: [] };
    let applySurfaceLive = null;
    const apply = async (ctx) => {
      ctxRef = ctx;
      ensureStyle();
      if (ctx.locale?.register) {
        try {
          ctx.locale.register(NS, DICT);
        } catch (problem) {
          /* 重复注册忽略 */
        }
      }
      /* 自建 t：宿主槽位注入的 t 对插件命名空间不可靠（实测全部返回 undefined），
         这里始终用自己 bind 到 NS 的翻译器，翻译缺失时回落到 DICT.zh。 */
      const bound = ctx.locale && typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : null;
      const translate = (key, vars) => {
        let value;
        if (bound) {
          try {
            value = bound(key, vars);
          } catch (problem) {
            value = undefined;
          }
        }
        if (value === undefined || value === null || value === "") value = DICT.zh[key];
        return value === undefined ? key : value;
      };
      /* 组件里既有 t("key") 也有 t.key 两种写法；给函数挂上同名只读属性，两种写法都成立。 */
      for (const key of Object.keys(DICT.zh)) {
        /* 注意：函数自带的 name/length 是自有属性，必须覆盖掉，否则 t.name 会返回 "translate"。 */
        Object.defineProperty(translate, key, {
          get: () => translate(key),
          enumerable: true,
          configurable: true
        });
      }
      /* 显示位置：settings（设置页）| sidebar（左侧栏主面板）| both。
         宿主半身写下的 config.json 是权威；apply 时读一次，读不到就退回设置页。 */
      let surface = "settings";
      try {
        const payload = await api("status", null, "GET");
        const value = payload?.config?.surface;
        if (value === "settings" || value === "sidebar" || value === "both") surface = value;
      } catch (problem) {
        /* 读取失败保持默认 */
      }
      /* 插槽注册可以注销：register 与 inject 都返回注销函数，按座位记账，切换显示位置时逆序调用。 */
      const disposeSeat = (name) => {
        const collected = seatOffs[name];
        seatOffs[name] = [];
        for (const off of collected.slice().reverse()) {
          try {
            if (typeof off === "function") off();
          } catch (problem) {
            /* 注销失败不阻断其它座位 */
          }
        }
      };
      const mountSeat = (name, build) => {
        if (seatOffs[name].length) return;
        const collected = [];
        const off = ctx.slots.inject(name, () => {
          const registered = build();
          if (typeof registered === "function") collected.push(registered);
          return registered;
        });
        if (typeof off === "function") collected.push(off);
        seatOffs[name] = collected;
      };
      const readService = (name) => {
        try {
          if (typeof ctx.get === "function") {
            const value = ctx.get(name);
            if (value) return value;
          }
        } catch (problem) {
          /* 反射取不到就走属性访问 */
        }
        try {
          return ctx[name] ?? null;
        } catch (problem) {
          return null;
        }
      };

      const mountSettingsSeat = () => {
        mountSeat("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "plugin-relocator",
              order: 16,
              label: () => translate("nav"),
              locale: NS,
              inject: () => ({ uiWorkspace: ctx.uiWorkspace, t: translate })
            },
            (props) => h(RelocatorSection, { ...props, t: translate, surface: "settings" })
          )
        );
      };
      const mountSidebarSeat = () => {
        /* 左侧栏图标行 + main keyed 主面板：同一个 id 把两边配对（dsh-client-ui-sidebar 的席位契约）。 */
        mountSeat("sidebar.panellist", () =>
          ctx.slots.register(
            { name: "sidebar.panellist", id: PANEL_ID, order: 44, label: () => translate("nav") },
            (iconProps) =>
              h(
                "svg",
                { width: (iconProps && iconProps.size) || 16, height: (iconProps && iconProps.size) || 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linejoin": "round", "aria-hidden": "true", "data-active": iconProps && iconProps.active ? "true" : "false" },
                h("rect", { x: 2.2, y: 2.6, width: 4.4, height: 4.4, rx: 1 }),
                h("rect", { x: 2.2, y: 9, width: 4.4, height: 4.4, rx: 1 }),
                h("path", { d: "M9.2 3.4h4.6M9.2 6.4h4.6M9.2 8.2h4.6M9.2 11.2h4.6" })
              )
          )
        );
        mountSeat("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, (props) => h(RelocatorSection, { ...props, t: translate, surface: "main" })));
      };

      const setSurface = (next) => {
        const value = next === "sidebar" || next === "both" ? next : "settings";
        if (value !== "sidebar") mountSettingsSeat();
        else if (seatOffs["settings.section"].length) disposeSeat("settings.section");

        if (value !== "settings") {
          mountSidebarSeat();
          return;
        }
        if (!seatOffs["main"].length && !seatOffs["sidebar.panellist"].length) return;
        /* 先离开本面板，再注销 main 与侧栏图标：布局仍指向一个已不存在的条目会保留选中态。 */
        try {
          const layout = readService("layout");
          const others = ctx.slots
            .entries("main")
            .map((entry) => entry?.options?.key)
            .filter((key) => typeof key === "string" && key !== PANEL_ID);
          if (layout && typeof layout.selectPanel === "function") layout.selectPanel(others[0] ?? "conversation");
        } catch (problem) {
          /* 目标 id 不存在时忽略：注销本身仍会完成 */
        }
        disposeSeat("main");
        disposeSeat("sidebar.panellist");
      };

      applySurfaceLive = setSurface;
      setSurface(surface);
    };

    return { apply, inject: ["slots", "locale", "uiWorkspace"] };
  }
});
