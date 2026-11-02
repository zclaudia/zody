export declare const CELL_ENV_ALLOWLIST: readonly ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "HOMEDRIVE", "HOMEPATH", "USERPROFILE"];
export interface CellLaunch {
    command: string;
    args: string[];
}
/**
 * 复用现有 single bundle：SEA 走 __zcode-plugin-host，开发 bundle 直接执行 server.js。
 * 不传 process.execArgv，避免 inspector/loader 等调试入口进入 cell。
 */
export declare function resolveCellLaunch(input: {
    execPath: string;
    serverPath: string;
    sea: boolean;
    /** 仅显式可信 composition 开启；缺省/SEA 保持既有启动语义。 */
    jitless?: boolean;
}): CellLaunch;
/**
 * 快照 cell 的固定启动形状：execPath --jitless --input-type=module - CELL_RUN_FLAG。
 *
 * 源码由父进程写入 stdin；serverPath 不再参与执行，避免校验后按路径重开形成 TOCTOU。
 */
export declare function resolveCellSnapshotLaunch(input: {
    execPath: string;
}): CellLaunch;
export declare function buildCellEnvironment(source: NodeJS.ProcessEnv, platform?: NodeJS.Platform): NodeJS.ProcessEnv;
export declare function isSeaRuntime(): boolean;
//# sourceMappingURL=subprocess-launch.d.ts.map