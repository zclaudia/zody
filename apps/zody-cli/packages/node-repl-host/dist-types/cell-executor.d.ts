export declare function isCellInvocation(argv: readonly string[]): boolean;
/**
 * cell 子进程入口：fd3 只读一次并等待 close 后才执行模型代码，结果只写 fd4 并等待 close
 * 后才退出。stdout/stderr 留给有界诊断，既不是 MCP stdout 也不是本协议的一部分。
 */
export declare function runCellMain(): Promise<number>;
//# sourceMappingURL=cell-executor.d.ts.map