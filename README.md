# dsh-plugin-relocator

把 DSH 插件装到**你自己指定的目录**，并且给**每个插件一份独立的依赖目录**。
附带体检、智能推荐、迁出/恢复/一键回滚与完整操作日志。

面向 DSH 桌面版（Windows / macOS / Linux），宿主半身 + 界面半身一体的管理插件。

---

## 一、它对应的三个痛点

| 痛点 | 这个插件怎么解 |
| --- | --- |
| **`.dsh` 越来越大** | 体检页一次性扫出真实占用（按 inode 去重）、硬链接共享量、死数据清单；插件列表按大小排序，把 2 GB 级的巨无霸一眼挑出来迁到别的盘 |
| **装/更新插件很慢** | 外置工程是独立的小 pnpm 工程：装一个插件只解析它自己的几行依赖，不再对 profile 那份 500+ 条的 lockfile 做整份校验，也不再重排整棵 hoisted 依赖树 |
| **更新 A 却重装 B** | 每个插件独立目录 + 独立 lockfile + 独立 node_modules；A 的增删完全不动 B 的目录，也不再改写 profile 的依赖树（profile 里只留一行 link: 指向插件目录） |

---

## 二、安装

### 方式一：从 GitHub 装（推荐）

仓库地址：<https://github.com/qizhuxu/dsh-plugin-relocator>

**用 DSH 自己的插件安装器**（设置 → 插件 → 安装插件），把下面这一行贴进去：

~~~
github:qizhuxu/dsh-plugin-relocator
~~~

**或者**手改 profile 的 `package.json` 依赖：

~~~json
"dsh-plugin-relocator": "github:qizhuxu/dsh-plugin-relocator"
~~~

然后在 profile 目录执行一次 `pnpm install`，再重启 DSH。

> 想锁版本就在末尾加 commit sha，例如
> `github:qizhuxu/dsh-plugin-relocator#<sha>`。

### 方式二：脚本（本地源码 / 开发用）

~~~bash
# 预览将要做的改动，不写任何文件
node scripts/install.mjs --dry-run

# 真正安装到 desktop profile
node scripts/install.mjs

# 装到别的 profile
node scripts/install.mjs --profile myprofile

# 别的 DSH_HOME / 只改声明不跑 pnpm / 卸载
node scripts/install.mjs --dsh-home D:/x/.dsh
node scripts/install.mjs --no-install
node scripts/install.mjs --uninstall
~~~

`install.mjs` 会在写之前把 profile 的 `package.json` 备份成
`package.json.relocator-backup-<时间戳>`；`--uninstall` 会打印一条把备份 copy 回去的命令。
它会先检查本工程的 `exports["./client"]`（界面半身入口）是否真的存在，缺了就直接拒绝安装。

脚本做三件事，全部可回滚（先备份 profile 的 package.json / pnpm-lock.yaml）：

1. 在 profile 的 `package.json` 里加一条依赖：`"dsh-plugin-relocator": "link:<本仓库绝对路径>"`
2. 在 `dsh.profile.bundles` 里加上 `dsh-plugin-relocator`
3. 在该 profile 目录执行一次 `pnpm install`

装完**重启 DSH**（宿主半身与界面半身都在启动时装载），然后在
**设置 → 插件 → Plugin Relocator** 打开。

### 方式三：手动

在 `<DSH_HOME>/profiles/<profile>/` 下：

~~~yaml
# package.json
{
  "dependencies": { "dsh-plugin-relocator": "link:D:/path/to/dsh-plugin-relocator" },
  "dsh": { "profile": { "bundles": [ "dsh-plugin-relocator" ] } }
}
~~~

然后 `pnpm install`。

> 本项目还没发布到 npm registry；GitHub 直装、`link:`、`file:` 都可用。

---

## 三、目录布局

~~~
F:/DSH-Plugins/                     ← 你指定的安装根（任意盘，建议与 pnpm store 同盘）
  .store/v11/                       ← pnpm 内容寻址仓库，same-drive 时依赖靠硬链接共享
  dsh-infinite-gen-5/               ← 每个插件一个独立工程
    package.json                    ← 只有这个插件自己的依赖
    pnpm-lock.yaml                  ← 独立的 lockfile，改动不牵动别人
    pnpm-workspace.yaml             ← nodeLinker: isolated（依赖隔离的关键）
    .npmrc                          ← 钉死 registry 与 store-dir
    node_modules/                   ← 这个插件独占的依赖
    lib/ client.js ...              ← 插件本体
    .relocator.json                 ← 迁移元数据（原始 spec / 原路径 / 操作 id）

C:/Users/<你>/.dsh/
  plugin-relocator/
    config.json                     ← 全局设置
    journal.ndjson                  ← 操作历史（NDJSON，可 tail）
    locks.json                      ← 每插件的迁移锁
    size-cache.json                 ← 体积测量缓存
    doctor-report.json              ← 最近一次体检报告
    rollback/<opId>/                ← 回滚点：原目录的实体备份
    rollback/<opId>.json            ← 回滚点元数据
  profiles/desktop/
    package.json                    ← dependencies 里那行 "<name>": "link:F:/DSH-Plugins/<name>"
    node_modules/<name>             ← Windows junction ⇒ F:/DSH-Plugins/<name>
~~~

---

## 四、界面

设置页里多出 **Plugin Relocator** 一栏（order 16），四个页签：

### 1. 全局设置
- **安装根目录**：目录选择对话框（走 DSH 原生目录选择器）、当前盘符、剩余空间
- **同盘校验**：根目录与 pnpm store 是否同盘；不同盘会明确提示"失去硬链接去重、占用会翻倍"
- **store 路径**：默认 `<根>/.store/v11`
- **默认策略**：新插件默认放在 `.dsh` 内 / 默认外置
- **本体处理**（`bodyMode`）：迁移时把 `file:` 本体一起搬走（默认，推荐）/ 只搬依赖
- **逐插件安装根**：可以给某个插件单独指定安装根，不必都用全局那个
- **迁移成功后自动清空回收点**（默认关；开了就不保留回滚能力）
- **界面显示位置**：只放设置页 / 只放侧边栏 / 两者都放（保存后立即切换，无需刷新）
- **推荐阈值**：超过多少 MB 算"体积大"（默认 100）
- **严格模式**：隐式依赖是否作为迁出的硬性前置条件（默认开）
- **搬运方式**：`auto`（默认，同盘硬链接 / 跨盘自动复制）/ `link`（强制硬链接）/ `copy`（逐字节复制）

### 2. 插件列表
列出全部已装插件：名称、版本、**物理位置**、**真实占用（按 inode 去重）**、**独占**、**硬链接共享**、依赖体检结果、是否受保护。
每张卡片上：**迁出** / **恢复** / **忽略** / **打开目录**；卡片本身可点（打开插件目录）。
支持按名称/体积/风险筛选与排序。

三种口径一定要分清（界面上也写了）：

- **真实占用** = 按 inode 去重后的字节（同一份硬链接文件只算一次）
- **独占** = nlink == 1 的字节，删掉/搬走就真能腾出这么多
- **硬链接共享** = nlink > 1 的字节，移动它**不会**释放空间（多半和 pnpm store 共享）

### 3. 智能推荐
按可解释的加权规则给出"建议迁出"清单，每条都写明理由与预估收益，可一键采纳（=迁出）或忽略（忽略项持久化）。
不满足前置条件的插件进入 **blocked** 列表，并逐条列出原因（受保护 / 隐式依赖 / 根目录未设 等）。

### 4. 进度与日志
实时进度条（复制 → 校验 → 装依赖 → 切换 → 复检）、体检报告表、回滚点列表（一键回滚 / 清空）、操作历史。

### 5. 外置插件（0.2.x 新增）

安装根里的**每一个**插件都在这里，包括 profile 里已经没有引用的那些：

- **挂载状态**：`已挂载`（profile 里有一行 `link:` 指向它）/ `未挂载`（DSH 看不到它）/ `挂在别处`（profile 里同名依赖指向别的目录）/ `目录不完整`（缺 `dsh.bundle`/`dsh.client`/`exports["./client"]`）。
- **来源**：迁出时记下的原始写法（registry 版本号、Git 仓库、压缩包、本地目录），决定"检查更新"能不能自动做。
- **操作**：重新挂载 / 改指到这里 / 从 profile 摘除 / 检查更新 / 更新 / 打开目录 / 移入回收站；回收站单独一块，清空才真正释放空间。
- **重新挂载** = 写回 `link:` 声明 → 补进 `dsh.profile.bundles` → 在 profile 里跑一次 `pnpm install` 同步 lock → 校验 `node_modules` 链接与三处写法一致；任何一步失败都会把 profile 的 `package.json` / `pnpm-lock.yaml` 还原。
- 插件列表页顶部会在有未挂载插件时给一条提示，点一下直接跳到这一页。

### 6. 外观与主题（0.2.0 重做）

界面视觉按 dsh-taste 的 app-screen 规范重做过一轮，并桥接到宿主自己的主题令牌：

- **跟随宿主明暗主题**：所有颜色取自宿主主题包定义的 `--dsw-alias-*` 令牌（写死的十六进制只是兜底），所以浅色主题下不会再出现"面板是深色的、周围是白的"那种错位。
- **chrome 无彩色，蓝只给数据**：页签、按钮、筛选、表头全部中性灰；唯一的强调蓝只出现在体积条与「合计占用」那一格数值上。
- **一屏一个实心按钮**：「测量体积」是该页签的主操作，行内的「迁出 / 采纳 / 忽略」一律描边或幽灵按钮。
- **可读性**：正文 13px（最小 12.5px，全部 ≥11px）；数字统一 `tabular-nums` 右对齐；卡片边框用不透明灰（浅色 `#e8e8ea` / 暗色 `#2f2f33`），对比度约 1.2:1 —— 不刺眼，也不会糊成一片。
- **布局**：插件列表与智能推荐用自适应卡片网格（`repeat(auto-fill, minmax(…, 1fr))`），宽了多列、窄了单列；侧边栏面板模式下页头与工具栏吸顶、列表区域自己滚到底。
- **图标**：全部是内联描边 SVG，没有 emoji 字形。
- **无障碍**：页签支持 ←/→/Home/End，卡片可 Tab 聚焦、Enter/Space 打开目录，骨架屏带 `aria-busy`，进度条带 `progressbar` 角色与 `aria-valuenow`。

---

## 五、三条铁律

### 1. 同盘才能去重
外置根如果和 pnpm store 不在同一个盘，pnpm 无法硬链接，依赖会**真实复制一份**。
跨盘不是不能做——只是要先多占一份空间（界面会要求二次确认，API 上是 `force`）。

### 2. profile 里那一行 `link:` 不能删
DSH 按 profile 的 `package.json` 决定加载哪些 bundle。迁出后这一行会被改写成
`"<name>": "link:<外置绝对路径>"`——**它是插件的注册凭证**，删了插件就消失。
插件本身、源码、依赖全部在外置目录里，profile 侧只剩一个 junction 与一行声明。

### 3. 隐式依赖是迁出的天敌
profile 的 node_modules 是 **hoisted（扁平）** 布局：插件没声明过的包也能"顺手"从顶层拿到。
一迁走，顶层没了，启动就 `MODULE_NOT_FOUND`。

因此迁出前必须做体检，把源码里出现的每个裸模块名归类：

| 分类 | 含义 | 迁出后 |
| --- | --- | --- |
| `explicit` | 插件自己 package.json 里声明了 | 装进它自己的 node_modules，安全 |
| `private` | 没声明，但插件自己的 node_modules 里就有实体 | 跟着目录一起搬，安全 |
| `dsh-singleton` | `@deepseek-ai/*` / react / electron 等安装侧单例 | DSH 加载器拦截层解析，安全 |
| `hoisted` | 没声明，只是从 profile 顶层白拿 | **风险**：迁出后大概率找不到 |
| `absent` | 哪都没有 | **风险**：本来就是坏的 |

出现 `hoisted` / `absent` 时默认**拦下**并列出 文件:行 证据；确认要冒险可以加 `force`。

---

## 六、迁出流程（原子 + 可回滚）

~~~
① 前置校验   受保护？已外置？根目录存在？跨盘？隐式依赖？
② 加锁       同一插件不允许并发迁移（locks.json，30 分钟过期自动回收）
③ 测量       记录文件数 / 字节 / 硬链接数
④ 传输       同盘用硬链接（瞬时、零额外占用），跨盘自动退化为逐文件复制
⑤ 校验       文件数 + 抽样 32 个文件哈希比对
⑥ 装依赖     在外置工程里 pnpm install（写独立 .npmrc / pnpm-workspace.yaml）
⑦ 写元数据   <外置目录>/.relocator.json
⑧ 原子切换   原目录 rename 进回滚点 → 原路径建 junction → profile 声明改写为 link:
⑨ 复检       realpath 必须指向外置目录；迁出前后依赖体检结论必须一致
~~~

任何一步失败：按 声明 → junction → rename 的逆序还原，`.dsh` 保持可用。

**恢复**：反向执行（搬回 staging → 校验 → junction 让位 → staging 归位 → 声明还原 → 清理元数据）。
恢复完成后，外置目录会被 **rename 到 `<外置目录>.relocator-backup-<opId>`**（同盘瞬时、不额外占空间），
所以"恢复"这一步本身也能一键回滚。若外置目录被占用 / 跨盘导致 rename 失败，就原地保留并记一条警告（`backupInPlace: true`）。
**回滚**：`rollback/<opId>/` 里保留着原目录实体，一键恢复；回滚记录标记 `undone: true`。
**清空回滚点**：确认稳定后释放那部分空间（会同时删掉备份目录）。

### 关于 `transferMode` 与硬链接
同盘 + `auto`（默认）时，外置副本与 `.dsh` 侧原目录**共享同一批 inode**：
搬运是瞬时的、不额外占空间，删除任一侧都不影响另一侧，但**"原地改写"同一个文件会两边一起变**。
真实安装器都是"写临时文件再改名"，所以正常使用不受影响；如果你要的是两份彻底独立的字节，把
`transferMode` 设成 `copy`（代价：先多占一整份空间，回滚点也因此真正独立）。

---

## 七、体检（doctor）

只读扫描整个 `.dsh`，**不做任何修改**：

- 单次遍历 + 按 `dev:ino` 跨子树去重 → 逻辑占用 / 真实占用 / 独占 / 硬链接共享 四个口径
- 按顶层目录归账（attachments / profiles / dsh-ops / cache / sessions ...）
- 最大的 20 个文件、硬链接样例
- **可回收清单**，每条标注 `safe`（零风险）或 `review`（需要你自己判断）：
  - `dsh-ops/bash-ipc` 历史代：每代约 392 MB。判定方式是**复算 identity**——用
    `<profile>/node_modules/dsh-ops/runtime/win32-x64/bash-ipc/provenance.json` 里的
    `msysSha256` + `files{opsipc.dll,opsnt.dll}` 与 bash 根目录，按
    `sha256(JSON.stringify({root, msys, files})).slice(0,24)` 算出当前 identity，
    与目录名比对；**算不出匹配时一律只报告、不推荐删除**（fail-safe）
  - `cache/attachments`、`cache/dsh-image-gen`、`storages/session_projcache`
  - `profiles/<p>/.dsh-market/discovery-*.json`（市场索引缓存，会自动重建）
  - `profiles/<p>/.plugin-manager/logs`（每次操作一份 pnpm 日志）
  - `attachments` 与 `ig5` 标 `review`：是真实数据，删了不可逆

---

## 八、已知限制

1. **profile 侧仍保留一行 `link:` 声明**——这是 DSH 的加载契约，绕不开。收益不在"profile 里什么都没有"，而在"profile 的依赖树不再被插件改动"。
2. **迁移期间插件不能正在加载**。Windows 上文件被占用会失败；插件会检测并提示先重启 DSH 再迁，或迁不常用的插件。
3. **peer 依赖永远解析到安装侧单例**（cordis / schemastery / react / electron）。迁移不会复制它们——这正是目的：避免出现两份 cordis。DSH 的加载器拦截层负责这条解析链。
4. **界面半身热更新**：客户端 bundle 走 `locatePkgJson` + `exports["./client"]`，DSH 按 mtime/size 计算版本。改了外置目录里的 client.js，刷新页面即可生效。
5. **不接管 pnpm store 的垃圾回收**。外置根下的 `.store` 会持续增长；需要清理时用 pnpm 自己的 prune。
6. **只处理 profile 里声明过的插件**。DSH 自带包（`@deepseek-ai/*`）、以及在 bundles 里但不在 dependencies 里的包被视为受保护，禁止迁出；插件自身也禁止迁出。
7. **Windows 路径长度**：外置根越浅越好（`F:/DSH-Plugins` 而不是 `F:/a/b/c/...`），否则深层 node_modules 可能撞上 260 字符上限。
8. **isolated linker 的代价**：同名依赖在不同插件之间不再共享目录项（同盘时仍靠 store 硬链接共享字节）。这是"独立依赖"的定义，不是缺陷。

---

## 九、自测

~~~bash
# 1) 实验室自测：一次性 profile，验证三项断言 + 迁移/回滚/恢复，全程不碰真实 .dsh
node test/self-test.mjs

# 2) HTTP 冒烟：在内存里启动宿主半身，用真实 HTTP 请求打通所有只读接口
node test/http-smoke.mjs
~~~

`self-test.mjs` 断言：

- **A. 私有依赖留在插件自身 node_modules** —— 迁移后用 `createRequire` 从插件入口真的解析到 `<外置目录>/node_modules/my-private-dep`
- **B. peer 依赖仍是安装侧单例** —— 插件目录里不存在第二份 `@deepseek-ai/cordis`；安装侧恰好一份
- **C. 界面半身契约完好** —— `exports["./client"]` 存在，bundle 用 `__ModuleLoader__.load({ id: <包名> })` 包装，在 vm 里 stub 掉 loader 后能拿到 `{ apply, inject }`
- **D. 完全体迁移** —— 本体随迁 + 独立依赖目录 + 迁移后 `pnpm install --frozen-lockfile` 能通过（package.json / pnpm-lock.yaml / .modules.yaml 三者一致）
- **F. 外置插件清单与生命周期（external.js）** —— 来源分类、版本比较与 range、DSH 插件契约判定、安装根扫描（含 @scope 两级、跳过回收站）、四种挂载状态、bundles 增删、attach 的拒绝路径与真实 pnpm 下的 attach/detach、remove 与回收站清空
- **E. 孤儿本体与跨 profile 引用** —— `bodyReferences` 扫全部 profile 的 `file:` 引用；清理时可用 `relinkReferencing` 把别的 profile 改指到新位置
- 以及：迁移后 junction / realpath / profile 声明正确；迁移→回滚 完全还原（文件数、声明、原路径）；迁移→恢复 回到 `.dsh`；`transferTree` + `verifyTrees` 往返校验通过；跨盘时 `checkDrives` 给出警告

`http-smoke.mjs` 断言（38 项）：路由注册契约（prefix + 路径 + effect 释放）、
只读接口（`/status` `/config/*` `/plugins/list` `/recommend`）、迁出 → 回滚点 → 一键回滚全链路、
体检任务（`/doctor/run` 受理 → 留痕 → `/doctor/report` 有 `reclaim`）、握手边界
（异源 403 `origin-rejected` / 缺 content-type 415 / 未知接口 404 / 坏 JSON 400 / 缺参数 502）。

**当前实测：`self-test.mjs` 123 项全绿，`http-smoke.mjs` 38 项全绿。**

> 两条脚本都必须用真正的 Node 跑。在 DSH 自己的 `run_code` 里 `process.execPath` 是
> `DeepSeek Harness.exe`（Electron），spawn 它会静默变成开 GUI。用内置运行时：
> `C:\Users\<你>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。

它**不能**证明的：真实 DSH 加载器在运行中的应用里的解析行为（那需要在跑起来的 DSH 里验证）。脚本会在结尾明确打印这句话。

---

## 十、HTTP 接口（宿主半身）

前缀 `/api/dsh-plugin-relocator`，全部 POST + JSON，同源校验。

`/status` `/config/get` `/config/set` `/config/validate` `/plugins/list` `/plugins/measure`
`/recommend` `/ignore/set` `/policy/set` `/migrate/out` `/migrate/restore` `/migrate/rollback`
`/migrate/purge` `/rollback/list` `/doctor/run` `/doctor/report` `/progress` `/history` `/open/path`
`/external/scan` `/external/attach` `/external/detach` `/external/check` `/external/update` `/external/remove` `/external/trash` `/external/trash/purge`

长任务（全量测量、迁移、恢复、回滚、体检）一律后台执行并立即返回 `{started:true,key}`，
界面侧轮询 `/progress` 与 `/history`。

## 十一、外置插件的更新与"找回"

外置插件在 DSH 自带插件管理器里会被当成**本地开发目录**，因而既没有更新按钮、也不能更新 —— 这不是配置错了，而是官方安装器的规则：它只对 `registry` 写法的依赖提供更新（内部判据是"这个包必须是从 registry 装的、且包名与依赖名一致"）。迁出后 profile 里那行是 `link:`，自然被排除在外。

本插件的做法是**不欺骗官方管理器**（把写法改回 registry 会让 pnpm 把插件实体重新装进 profile，外置就白做了），而是**由外置工程自己更新**：

~~~
① 检查更新    registry → 读 dist-tags.latest 与"原 range 内最高版本"；Git → git ls-remote 取远端 HEAD
② 更新        在 <安装根>/.relocator-tmp/<opId> 建临时工程 → pnpm add <来源> → 校验新版确实是 DSH 插件且版本更高
③ 备份        旧本体 rename 到 <安装根>/.relocator-trash/<name>-<时间戳>（同盘瞬时）
④ 就位        新版覆盖到外置目录，.relocator.json 追加 updateFrom/updateTo/lastSpec
⑤ 独立依赖    按新 package.json 在外置目录里装依赖（老的 deps 判定规则不变）
⑥ 校验        主入口在位、DSH 插件契约仍在；失败就把旧本体搬回来
~~~

更新完成后需要**重启一次 DSH** 才会加载新版本（宿主半身与界面半身都是启动时装载的）。

**"插件列表里删掉之后外置目录还在，但列表里没了"怎么办？**

那是官方卸载的正常行为：它只删 profile 侧的依赖与 junction，不会去动外置目录（那是它不认识的文件）。这时插件会出现在**外置插件**页的"未挂载"分组里，点「重新挂载」即可恢复；也可以先「检查更新」再挂载回来。

**删除**：外置插件页的「移入回收站」会先把插件从 profile 摘除，再把目录 rename 到 `<安装根>/.relocator-trash/`。回收站里的东西不再被 DSH 看见，但还占着磁盘 —— 确认不要了再「清空回收站」。

## 十二、许可证

MIT
