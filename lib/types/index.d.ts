/**
 * dsh-plugin-relocator —— 宿主半身（Node 侧）类型声明。
 * 仅供编辑器提示；运行时不受影响。
 */
import type { ServerResponse, IncomingMessage } from "node:http";

export declare const name = "dsh-plugin-relocator";
export declare const inject: ["webServer"];

export interface RelocatorConfig {
  /** 外置安装根目录，例如 "F:/DSH-Plugins" */
  root: string;
  /** pnpm 内容寻址仓库；留空表示 <root>/.store/v11 */
  storeDir: string;
  /** 独立工程使用的 registry */
  registry: string;
  /** 新插件默认策略：留在 .dsh 内，或默认外置 */
  defaultPolicy: "inDsh" | "external";
  /** 体积推荐阈值（MB） */
  oversizeMB: number;
  /** 隐式依赖是否作为迁出的硬性前置条件 */
  strictImplicitDeps: boolean;
  /** 允许从 profile 顶层 node_modules 兜底解析未声明依赖（默认关） */
  allowHoistFallback: boolean;
  /** 迁移后是否同步 profile 的 lockfile 说明 */
  syncProfileLockfile: boolean;
  /** 每插件覆盖与忽略列表 */
  plugins: Record<string, { policy?: "inDsh" | "external"; ignored?: boolean }>;
}

export interface TransferStats {
  files: number;
  dirs: number;
  linked: number;
  copied: number;
  bytes: number;
  skipped: number;
  mode: "link" | "copy";
  ms: number;
  human: string;
}

export interface DriveCheck {
  root: string;
  store: string;
  rootStoreSameDrive: boolean;
  rootHomeSameDrive: boolean;
  rootDrive: string;
  homeDrive: string;
  storeDrive: string;
  notes: string[];
}

export interface MigrateResult {
  opId: string;
  name: string;
  mode: "out" | "restore";
  targetDir: string;
  backupDir: string;
  transferred: TransferStats;
  deps: { ok?: boolean; skipped?: boolean; output?: string };
  drives: DriveCheck;
  canRollback: boolean;
}

export declare function apply(ctx: any, pluginConfig?: Partial<RelocatorConfig>): {
  migrator: unknown;
  journal: unknown;
  locks: unknown;
  sizeCache: unknown;
  route: string;
};

export declare function parseInstallSpec(spec: string): { path: string; name: string };

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
