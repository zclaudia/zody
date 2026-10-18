import type { ModelSelectionView } from "@zcode/provider";

/**
 * fork（F4.3）：原 offPeakSelectionView（隐藏 off-peak provider 双域视图）随闲时任务全链路删除。
 * 消费方只需要一个非空 Selection View 锁定 modelSelectionReadinessSource 的读取行为，
 * 改用普通 BYOK provider 视图，不携带账号域语义。
 */
export function testSelectionView(): ModelSelectionView {
  return {
    revision: 1,
    providers: [
      {
        providerId: "zai-api",
        config: { visibility: "visible" },
        models: ["GLM-5.2"].map((modelId) => ({
          modelId,
          config: {
            enabled: true,
            properties: {
              requiresMfjsToolSchema: false,
              contextWindow: 200000,
              inputFormat: {
                supportsText: true,
                supportsImage: false,
                supportsVideo: false,
                supportsAudio: false,
                supportsPdf: false,
              },
              outputFormat: { supportsText: true },
              supportsToolCall: true,
              supportsJsonSchemaOutput: false,
            },
          },
        })),
      },
    ],
  };
}
