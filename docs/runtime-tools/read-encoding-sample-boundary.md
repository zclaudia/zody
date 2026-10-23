# 大文件读取的编码探测样本边界

## 背景

`FileSystemPort.readTextFileRange` 对超过 10MB 的文件走流式读取；请求未显式给 `encoding` 时，先由
`apps/zcode-cli/packages/adapters/src/fs/text-range-reader.ts` 的 `detectEncodingFromHead`
读取文件头部 4096 字节，再交给 `text-metadata.ts` 的 `detectTextEncoding` 判定。

本文只记录「探测样本如何取满、样本尾部如何处理」这一处差异；解码、行尾归一化、GBK 往返校验等既有规则
仍以 `text-metadata.ts` 的实现和既有测试为准，不在此重复。

现状有两个缺口：

1. `text-range-reader.ts:163-176` 只调用一次 `handle.read`，把返回值当作完整样本。Node 的
   `FileHandle.read` 允许短读（返回字节数少于请求长度），一次读到的可能远小于 4096 字节。
2. 4096 字节边界可能切断一个 UTF-8 多字节字符的尾部。`text-metadata.ts:39-41` 的 `isValidUtf8`
   用 fatal 解码，截断尾部会判为非法；随后 `:131-144` 的 GBK 往返仅容忍最多 3 字节尾部丢弃，
   于是「合法 UTF-8 前缀 + 被切断的多字节字符」会被误判成 GBK/GB2312。

## 范围

- 仅流式读取路径（`info.size > 10MB`）中、调用方未指定 `encoding` 时的探测样本。
- 样本读取的补齐循环、EOF 终止、取消语义与文件句柄生命周期。
- 样本尾部不完整 UTF-8 序列的容忍判定。

## 非范围

- 快路径（`<= 10MB`，整文件读入后整块探测）的判定规则不变。
- 调用方显式传入 `encoding` 时不做探测，行为不变。
- BOM 优先级、二进制判定、GBK 往返规则本身不变。
- 不改变 `readTextFileRange` 的返回结构、行选择语义与 `bytesRead/sizeBytes` 口径。

## 规则

### 所有者与接口

- 唯一所有者：`detectEncodingFromHead(path, signal)`。它是探测样本的唯一读取者，不向
  `readRangeStreaming` 暴露样本，也不把样本写进返回内容。
- 探测使用独立文件句柄，与随后的内容流（`createReadStream`）彻底分离；样本字节不得混入
  `content`、`bytesRead` 或行计数。
- 唯一输出：`FileSystemTextEncoding`，作为整份文件后续流式解码器的编码。

### 样本读取

1. 样本容量固定为 4096 字节。
2. 用循环补齐：每轮读取「剩余容量」，直到读满 4096 字节，或某次 `read` 返回 `bytesRead === 0`
   （EOF）为止。短读不视为结束，也不视为错误；不得把未写入区域当作样本内容。
3. 同一组文件字节，无论被读成一次还是多次、每次多少字节，探测结果必须相同（分块无关性）。
4. 循环每一轮前检查 `AbortSignal`；已取消时抛出 AbortError，由端口层映射为 `cancelled`。
5. 文件句柄在 `finally` 中关闭：正常、取消、探测抛错（如二进制/不支持编码）三条路径都不得泄漏。

### UTF-8 尾部

1. 样本末尾的 UTF-8 多字节序列被边界切断时，必须结合边界之后的真实字节补齐该字符后再判定；
   UTF-8 单字符最长 4 字节，因此至多再读 3 个字节即可完成。
2. 只有补齐后构成合法 UTF-8 才判为 `utf8`。若边界后的字节不能补成合法 UTF-8（例如它是 GBK
   双字节字符的首字节），不得仅因「样本尾部缺字节」改判 UTF-8，必须继续既有 GBK 判定。
3. 补齐读取的字节只用于判定，不得进入返回内容、`bytesRead` 或行计数；探测句柄与内容流保持分离。
4. 在补齐到完整字符前到达 EOF 时，以实际读到的字节判定；不得用零填充或重复字节凑样本。
5. 该容忍只作用于样本末尾；样本中间出现非法序列仍判为非法 UTF-8，BOM 判定与 GBK 往返规则本身不变。

### 判定顺序（不变）

UTF-8 BOM → UTF-16LE BOM → 二进制 → UTF-8（含尾部容忍）→ 三种 GBK 变体 → `unsupported`。

## 时序

```text
readTextFileRange(no encoding, size > 10MB)
  → stat / 路径校验
  → throwIfAborted
  → open(探测句柄)
      → loop: read(剩余容量)
          → abort? → AbortError
          → bytesRead === 0? → EOF，结束循环
          → 累加 bytesRead，未满且未 EOF → 继续
      → detectTextEncoding(样本前 bytesRead 字节)
  → finally: close(探测句柄)
  → createStreamingTextDecoder(encoding) 读取同一文件
  → 返回 content / encoding / lineEndings / bytesRead / totalLines
```

## 验收场景

| ID     | 场景                                                                       | 期望                                                                 |
| ------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| ENC-S1 | `a*4095 + "中"` 开头、整体 >10MB 的 UTF-8 文件，探测样本止于「中」的首字节 | `encoding === "utf8"`，选中行内容为原文，不出现 GBK 乱码             |
| ENC-S2 | 同上，边界切断的是 4 字节 UTF-8 字符（如 emoji）                           | `encoding === "utf8"`，内容正确                                      |
| ENC-S3 | >10MB 的 UTF-16LE 文件，`FileHandle.read` 每次只返回 1 字节                | 探测补齐到 4096 字节，`encoding === "utf16le"`，内容与行尾元数据正确 |
| ENC-S4 | 两次 1 字节短读组成 BOM 前缀、随后 `bytesRead === 0`                       | 循环以 EOF 结束，不空转；按已读字节判定（UTF-16LE BOM → `utf16le`）  |
| ENC-S5 | >10MB 的 UTF-16LE 文件，UTF-16 代理对跨样本边界                            | 对照：BOM 直判，`encoding === "utf16le"`，内容不含替换字符           |
| ENC-S6 | >10MB 的 GBK 文件，样本止于双字节字符首字节                                | 对照：仍判为 `gb2312`，内容按 GBK 正确解码                           |
| ENC-S7 | 探测读取过程中触发取消                                                     | 拒绝并映射为 `cancelled`，不返回部分结果                             |
| ENC-S8 | 探测判定失败（如 >10MB 的二进制文件）                                      | 拒绝为 `unsupported`，且探测句柄已关闭（`close` 恰好调用一次）       |

对应测试：`apps/zcode-cli/packages/adapters/tests/fs-context.test.ts`。
