/**
 * dsh-plugin-relocator —— 界面半身类型声明。
 * 浏览器侧通过 __ModuleLoader__.load 注册，导出 cordis 插件形态的 apply / inject。
 */
export declare const apply: (ctx: any) => void;
export declare const inject: ["slots", "locale", "uiWorkspace"];
