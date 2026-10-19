import { z } from "zod";

/** 文本材料只传递文件引用，不能因跨端上传而退回自动全文注入。 */
// fork（bots 移除）："topic-history"（bot 话题历史附件来源）随 bot channels 全量删除
// （specs/bot-channels-removal.md）；由 B5（CLI 协议摘除）补 B2 漏网收口，存量字段不再读取。
export const attachmentSourceKindSchema = z.enum(["clipboard-text"]);
export type AttachmentSourceKind = z.infer<typeof attachmentSourceKindSchema>;
