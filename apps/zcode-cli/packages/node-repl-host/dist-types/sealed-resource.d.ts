export interface ReadSealedResourceOptions {
    /** 固定同级资源名解析出的路径；只在打开时使用，校验后不再按路径执行。 */
    path: string;
    /** 封装构建钉住的原始字节 SHA-256（小写十六进制）。 */
    expectedSha256: string;
    /** 封装构建给出的资源字节上限。 */
    maxBytes: number;
    /** 所有权校验的期望 uid；默认取当前进程 uid。 */
    expectedUid?: number;
}
export interface SealedResourceSnapshot {
    /** 与已核验原始字节一一对应的 UTF-8 内容；字符串本身不可变。 */
    readonly source: string;
    readonly sha256: string;
    readonly size: number;
}
/**
 * 在同一个 O_NOFOLLOW 句柄上有界读取固定资源，校验元数据、上限、摘要和 UTF-8 无损性。
 *
 * 返回的 source 是同一份已核验字节的解码结果；调用方之后不得再按 path 打开执行。
 * 读取期间文件即使增长，也会在超过 maxBytes 时拒绝，而不是继续读入更多内容。
 */
export declare function readSealedResourceSnapshot(options: ReadSealedResourceOptions): Promise<SealedResourceSnapshot>;
/**
 * 有界读取：最多读 maxBytes + 1 字节，超过 maxBytes 立即失败。
 *
 * 独立导出是为了用可控 reader 确定性覆盖“读取期间增长”；生产路径只传入同一句柄的 read。
 */
export declare function readBoundedBytes(readChunk: (buffer: Buffer) => Promise<number>, maxBytes: number, chunkBytes?: number): Promise<Buffer>;
/**
 * 无损 UTF-8 解码；保留 BOM，并回编码校验原始字节完全一致，避免 U+FFFD 替换后执行别的内容。
 */
export declare function decodeUtf8Lossless(bytes: Buffer): string;
//# sourceMappingURL=sealed-resource.d.ts.map