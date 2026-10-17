import { describe, expect, it } from "vitest";
import type { WebRemoteControlAppPayload } from "../src/web-remote-control.js";
import {
  WEB_REMOTE_CONTROL_APP_PROTOCOL_FEATURES,
  WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION,
  WEB_REMOTE_CONTROL_APP_PROTOCOL_MIN_VERSION,
  WEB_REMOTE_CONTROL_APP_PROTOCOL_RANGE,
  WEB_REMOTE_CONTROL_CHANNEL_CLOSE_ACK_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_CHANNEL_FRAME_TYPES,
  WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_INTERVAL_MS,
  WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_CHANNEL_HELLO_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_CHANNEL_KIND,
  WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES,
  WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION,
  type WebRemoteControlAppProtocolFeature,
  type WebRemoteControlChannelFrameOf,
  gateWebRemoteControlAppPayloadVersion,
  isWebRemoteControlChannelClosingFinished,
  isWebRemoteControlChannelHeartbeatExpired,
  isWebRemoteControlChannelInboundFrameAllowedWhileClosing,
  isWebRemoteControlChannelProtocolVersionSupported,
  negotiateWebRemoteControlAppProtocol,
  parseWebRemoteControlChannelFrame,
  parseWebRemoteControlChannelFrameJson,
  resolveWebRemoteControlAppProtocolVersion,
} from "../src/web-remote-control-channel.js";
import {
  parseWebRemoteControlAppPayload,
  webRemoteControlAppPayloadSchema,
} from "../src/validation.js";

/** 合法帧样例；每个 `type` 各一条，用来逐帧验证 strict schema。 */
const VALID_FRAMES = {
  hello: {
    type: "hello",
    protocolVersion: WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION,
    appProtocol: { min: 1, max: 1 },
    clientInstanceId: "client-1",
    clientName: "Pixel 8",
    appVersion: "1.2.3",
  },
  hello_ack: { type: "hello_ack", appProtocol: 1, desktopAppVersion: "3.15.1" },
  data: {
    type: "data",
    payload: { zcode_type: "bootstrap-request", requestId: "request-1" },
    client_ts: 1,
  },
  ping: { type: "ping", id: "1" },
  pong: { type: "pong", id: "1" },
  close: { type: "close", reason: "superseded" },
  close_ack: { type: "close_ack" },
  protocol_error: {
    type: "protocol_error",
    code: "unsupported-version",
    offendingType: "bootstrap-request",
  },
} as const satisfies Record<(typeof WEB_REMOTE_CONTROL_CHANNEL_FRAME_TYPES)[number], object>;

/** 每种帧删掉一个必需字段后必须不被接受。 */
const REQUIRED_FIELD_TO_DROP: Record<keyof typeof VALID_FRAMES, string> = {
  hello: "clientInstanceId",
  hello_ack: "appProtocol",
  data: "payload",
  ping: "id",
  pong: "id",
  close: "reason",
  close_ack: "type",
  protocol_error: "code",
};

interface ZodLikeIntrospection {
  options?: unknown[];
  shape?: Record<string, unknown>;
  def?: { values?: Set<unknown> };
}

function readShapeByZcodeType(): Map<string, Set<string>> {
  const union = webRemoteControlAppPayloadSchema as unknown as ZodLikeIntrospection;
  const shapeByType = new Map<string, Set<string>>();
  for (const option of union.options ?? []) {
    const shape = (option as ZodLikeIntrospection).shape ?? {};
    const literal = shape.zcode_type as ZodLikeIntrospection | undefined;
    for (const value of literal?.def?.values ?? []) {
      if (typeof value === "string") {
        // 同一个 zcode_type 可能由多个 schema 成员表达（例如 platform-response），字段取并集。
        const fields = shapeByType.get(value) ?? new Set<string>();
        for (const key of Object.keys(shape)) {
          fields.add(key);
        }
        shapeByType.set(value, fields);
      }
    }
  }
  return shapeByType;
}

describe("web remote control channel frames", () => {
  it("按 spec 固定常量：kind、版本、超时、1 MiB 帧上限", () => {
    expect(WEB_REMOTE_CONTROL_CHANNEL_KIND).toBe("zcode-remote");
    expect(WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION).toBe(1);
    expect(WEB_REMOTE_CONTROL_APP_PROTOCOL_MIN_VERSION).toBe(1);
    expect(WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION).toBe(1);
    expect(WEB_REMOTE_CONTROL_APP_PROTOCOL_RANGE).toEqual({ min: 1, max: 1 });
    expect(WEB_REMOTE_CONTROL_CHANNEL_HELLO_TIMEOUT_MS).toBe(10_000);
    expect(WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_TIMEOUT_MS).toBe(45_000);
    expect(WEB_REMOTE_CONTROL_CHANNEL_CLOSE_ACK_TIMEOUT_MS).toBe(2_000);
    expect(WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES).toBe(1024 * 1024);
  });

  it("接受全部 8 种帧的合法形状", () => {
    for (const frame of Object.values(VALID_FRAMES)) {
      expect(parseWebRemoteControlChannelFrame(frame)).toEqual(frame);
    }
  });

  it("每帧的 schema 都是 strict：多余字段、缺失字段、未知类型一律丢弃", () => {
    for (const [type, frame] of Object.entries(VALID_FRAMES)) {
      expect(parseWebRemoteControlChannelFrame({ ...frame, extra: 1 })).toBeNull();

      const missing = { ...frame } as Record<string, unknown>;
      delete missing[REQUIRED_FIELD_TO_DROP[type as keyof typeof VALID_FRAMES]];
      expect(parseWebRemoteControlChannelFrame(missing)).toBeNull();
    }

    expect(parseWebRemoteControlChannelFrame({ type: "future_frame" })).toBeNull();
    expect(parseWebRemoteControlChannelFrame("hello")).toBeNull();
    expect(parseWebRemoteControlChannelFrame(null)).toBeNull();
    // 嵌套对象同样 strict：appProtocol 多一个字段就不能用
    expect(
      parseWebRemoteControlChannelFrame({
        ...VALID_FRAMES.hello,
        appProtocol: { min: 1, max: 1, patch: 2 },
      }),
    ).toBeNull();
    expect(
      parseWebRemoteControlChannelFrame({
        ...VALID_FRAMES.hello,
        appProtocol: { min: 2, max: 1 },
      }),
    ).toBeNull();
  });

  it("身份字段先 trim 再校验，避免两端算出不同的 clientInstanceId", () => {
    expect(
      parseWebRemoteControlChannelFrame({
        ...VALID_FRAMES.hello,
        clientInstanceId: "  client-1  ",
      }),
    ).toMatchObject({ clientInstanceId: "client-1" });
    expect(
      parseWebRemoteControlChannelFrame({ ...VALID_FRAMES.hello, clientInstanceId: "   " }),
    ).toBeNull();
    expect(parseWebRemoteControlChannelFrame({ ...VALID_FRAMES.data, client_ts: -1 })).toBeNull();
  });

  it("protocolVersion 不相等时仍解析出 hello，交给调用方回 close{incompatible-version}", () => {
    expect(
      parseWebRemoteControlChannelFrame({ ...VALID_FRAMES.hello, protocolVersion: 2 }),
    ).toMatchObject({ protocolVersion: 2 });
    expect(isWebRemoteControlChannelProtocolVersionSupported(2)).toBe(false);
    expect(
      isWebRemoteControlChannelProtocolVersionSupported(
        WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION,
      ),
    ).toBe(true);
    expect(
      parseWebRemoteControlChannelFrame({ ...VALID_FRAMES.hello, protocolVersion: 0 }),
    ).toBeNull();
  });

  it("close{incompatible-version} 必须带 upgrade，其他 close 原因不许带", () => {
    const parseClose = (frame: unknown) => parseWebRemoteControlChannelFrame(frame);
    expect(
      parseClose({ type: "close", reason: "incompatible-version", upgrade: "mobile" }),
    ).toEqual({ type: "close", reason: "incompatible-version", upgrade: "mobile" });
    expect(
      parseClose({ type: "close", reason: "incompatible-version", upgrade: "desktop" }),
    ).toEqual({
      type: "close",
      reason: "incompatible-version",
      upgrade: "desktop",
    });
    expect(parseClose({ type: "close", reason: "incompatible-version" })).toBeNull();
    expect(parseClose({ type: "close", reason: "superseded", upgrade: "desktop" })).toBeNull();
    expect(parseClose({ type: "close", reason: "kicked" })).toBeNull();
    for (const reason of ["superseded", "desktop-stopping", "client-leaving"]) {
      expect(parseClose({ type: "close", reason })).toEqual({ type: "close", reason });
    }
  });

  it("data 帧只校验信封：payload 的校验 owner 仍是应用层 parser", () => {
    const frame = parseWebRemoteControlChannelFrame({
      type: "data",
      payload: { zcode_type: "not-a-real-type" },
    });
    expect(frame).toMatchObject({ type: "data" });
    // 应用层 parser 才会拒绝它；channel 层不做重复校验（rpc-frame 不会二次解析 base64）。
    expect(parseWebRemoteControlAppPayload({ zcode_type: "not-a-real-type" })).toBeNull();
    expect(parseWebRemoteControlAppPayload((frame as { payload: unknown }).payload)).toBeNull();
  });
});

describe("web remote control channel frame parsing", () => {
  function dataFrameJson(codeUnits: number): string {
    const overhead = JSON.stringify({ type: "data", payload: { blob: "" } }).length;
    return JSON.stringify({ type: "data", payload: { blob: "x".repeat(codeUnits - overhead) } });
  }

  it("接受合法 JSON 并给出 UTF-8 字节数", () => {
    const raw = JSON.stringify(VALID_FRAMES.hello);
    expect(parseWebRemoteControlChannelFrameJson(raw)).toEqual({
      kind: "accepted",
      frame: VALID_FRAMES.hello,
      bytes: raw.length,
    });

    // 多字节 payload（手机标题、路径等都可能是中文）：字节数要按 UTF-8 算，不是 code unit 数
    const dataFrame: WebRemoteControlChannelFrameOf<"data"> = {
      type: "data",
      payload: { zcode_type: "app-error", reason: "unexpected-error", error: "打开项目失败" },
    };
    const dataRaw = JSON.stringify(dataFrame);
    expect(new TextEncoder().encode(dataRaw).byteLength).toBeGreaterThan(dataRaw.length);
    expect(parseWebRemoteControlChannelFrameJson(dataRaw)).toEqual({
      kind: "accepted",
      frame: dataFrame,
      bytes: new TextEncoder().encode(dataRaw).byteLength,
    });
  });

  it("1 MiB 边界：等于上限通过，超过 1 字节即丢弃", () => {
    const atLimit = dataFrameJson(WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES);
    expect(atLimit.length).toBe(WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES);
    expect(parseWebRemoteControlChannelFrameJson(atLimit)).toMatchObject({
      kind: "accepted",
      bytes: WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES,
    });

    const overLimit = dataFrameJson(WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES + 1);
    expect(parseWebRemoteControlChannelFrameJson(overLimit)).toEqual({
      kind: "discarded",
      reason: "oversize",
    });
    expect(
      parseWebRemoteControlChannelFrameJson(overLimit, {
        maxFrameBytes: WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES + 1,
      }),
    ).toMatchObject({ kind: "accepted", bytes: WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES + 1 });
  });

  it("帧上限按 UTF-8 字节算，不是 code unit 数", () => {
    // 每个 emoji 2 个 code unit 占 4 字节：按 code unit 判断会放过这一帧。
    const emojiCount = Math.floor(WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES / 4) + 1;
    const raw = JSON.stringify({ type: "data", payload: { blob: "😀".repeat(emojiCount) } });
    expect(raw.length).toBeLessThanOrEqual(WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES);
    expect(parseWebRemoteControlChannelFrameJson(raw)).toMatchObject({
      kind: "discarded",
      reason: "oversize",
    });
  });

  it("区分 malformed、unknown-type，并只记录安全元数据", () => {
    expect(parseWebRemoteControlChannelFrameJson("{")).toMatchObject({
      kind: "discarded",
      reason: "malformed",
      bytes: 1,
    });
    expect(parseWebRemoteControlChannelFrameJson(JSON.stringify({ type: "future_frame" }))).toEqual(
      {
        kind: "discarded",
        reason: "unknown-type",
        bytes: JSON.stringify({ type: "future_frame" }).length,
        frameType: "future_frame",
      },
    );
    expect(
      parseWebRemoteControlChannelFrameJson(JSON.stringify({ type: "ping", id: "1", extra: true })),
    ).toMatchObject({ kind: "discarded", reason: "malformed", frameType: "ping" });
    expect(parseWebRemoteControlChannelFrameJson(JSON.stringify(["hello"]))).toMatchObject({
      kind: "discarded",
      reason: "malformed",
    });
    // 类型名可能来自对端，非标识符形状不落日志
    const hostileType = JSON.stringify({ type: "../../etc/passwd" });
    expect(parseWebRemoteControlChannelFrameJson(hostileType)).toEqual({
      kind: "discarded",
      reason: "unknown-type",
      bytes: hostileType.length,
    });
    expect(
      parseWebRemoteControlChannelFrameJson(JSON.stringify({ type: "a".repeat(200) })),
    ).toMatchObject({ kind: "discarded", reason: "unknown-type" });
  });
});

describe("web remote control channel heartbeat and closing rules", () => {
  it("45 秒没有入站帧才判死，时钟回拨或非法输入不判死", () => {
    expect(isWebRemoteControlChannelHeartbeatExpired(0, 44_999)).toBe(false);
    expect(isWebRemoteControlChannelHeartbeatExpired(0, 45_000)).toBe(true);
    expect(isWebRemoteControlChannelHeartbeatExpired(45_000, 0)).toBe(false);
    expect(isWebRemoteControlChannelHeartbeatExpired(Number.NaN, 45_000)).toBe(false);
    expect(isWebRemoteControlChannelHeartbeatExpired(0, 999, 1_000)).toBe(false);
    expect(isWebRemoteControlChannelHeartbeatExpired(0, 1_000, 1_000)).toBe(true);
    expect(isWebRemoteControlChannelHeartbeatExpired(0, 999, 0)).toBe(false);
    expect(isWebRemoteControlChannelHeartbeatExpired(0, 44_999, 0)).toBe(false);
  });

  it("closing 期间只放行 close_ack，其他入站帧一律丢弃", () => {
    for (const frameType of WEB_REMOTE_CONTROL_CHANNEL_FRAME_TYPES) {
      expect(isWebRemoteControlChannelInboundFrameAllowedWhileClosing(frameType)).toBe(
        frameType === "close_ack",
      );
    }
  });

  it("旧版本对端丢掉 close_ack 时，桌面 2 秒超时后仍关闭旧 channel", () => {
    const startedAtMs = 10_000;
    expect(
      isWebRemoteControlChannelClosingFinished({ startedAtMs, nowMs: startedAtMs + 1_999 }),
    ).toBe(false);
    expect(
      isWebRemoteControlChannelClosingFinished({ startedAtMs, nowMs: startedAtMs + 2_000 }),
    ).toBe(true);
    expect(
      isWebRemoteControlChannelClosingFinished({
        startedAtMs,
        closeAckAtMs: startedAtMs + 10,
        nowMs: startedAtMs + 10,
      }),
    ).toBe(true);
  });
});

describe("appProtocol negotiation", () => {
  it("取交集里最大的值", () => {
    expect(negotiateWebRemoteControlAppProtocol({ min: 1, max: 3 }, { min: 2, max: 5 })).toEqual({
      ok: true,
      appProtocol: 3,
    });
    expect(negotiateWebRemoteControlAppProtocol({ min: 1, max: 5 }, { min: 3, max: 3 })).toEqual({
      ok: true,
      appProtocol: 3,
    });
    expect(negotiateWebRemoteControlAppProtocol({ min: 2, max: 2 }, { min: 2, max: 2 })).toEqual({
      ok: true,
      appProtocol: 2,
    });
  });

  it("交集为空时 upgrade 指向需要升级的一端", () => {
    // 手机 max 小于桌面 min：升级手机
    expect(negotiateWebRemoteControlAppProtocol({ min: 3, max: 5 }, { min: 1, max: 2 })).toEqual({
      ok: false,
      upgrade: "mobile",
    });
    expect(negotiateWebRemoteControlAppProtocol({ min: 2, max: 5 }, { min: 1, max: 1 })).toEqual({
      ok: false,
      upgrade: "mobile",
    });
    // 桌面 max 小于手机 min：升级桌面
    expect(negotiateWebRemoteControlAppProtocol({ min: 1, max: 2 }, { min: 3, max: 5 })).toEqual({
      ok: false,
      upgrade: "desktop",
    });
    expect(
      negotiateWebRemoteControlAppProtocol(WEB_REMOTE_CONTROL_APP_PROTOCOL_RANGE, {
        min: 2,
        max: 3,
      }),
    ).toEqual({ ok: false, upgrade: "desktop" });
    expect(
      negotiateWebRemoteControlAppProtocol(WEB_REMOTE_CONTROL_APP_PROTOCOL_RANGE, {
        min: 1,
        max: 1,
      }),
    ).toEqual({ ok: true, appProtocol: 1 });
  });
});

describe("appProtocol manifest", () => {
  it("类型清单与 app payload schema 的 zcode_type 完全一致", () => {
    const shapeByType = readShapeByZcodeType();
    const schemaTypes = [...shapeByType.keys()].sort();
    // 防呆：schema 结构变化导致 introspect 失败时，不能让这条用例静默通过。
    expect(schemaTypes.length).toBeGreaterThan(0);
    expect(schemaTypes).toContain("bootstrap-request");

    const manifestTypes = WEB_REMOTE_CONTROL_APP_PROTOCOL_FEATURES.filter(
      (feature) => feature.field === undefined,
    )
      .map((feature) => feature.zcodeType)
      .sort();
    expect(manifestTypes).toEqual(schemaTypes);
    expect(manifestTypes.length).toBe(new Set(manifestTypes).size);
  });

  it("字段清单只登记真实存在的字段，且不早于所属类型的引入版本", () => {
    const shapeByType = readShapeByZcodeType();
    for (const feature of WEB_REMOTE_CONTROL_APP_PROTOCOL_FEATURES) {
      expect(Number.isSafeInteger(feature.introducedIn)).toBe(true);
      expect(feature.introducedIn).toBeGreaterThanOrEqual(
        WEB_REMOTE_CONTROL_APP_PROTOCOL_MIN_VERSION,
      );
      expect(feature.introducedIn).toBeLessThanOrEqual(WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION);
      expect(shapeByType.has(feature.zcodeType)).toBe(true);

      if (feature.field === undefined) {
        continue;
      }
      expect(shapeByType.get(feature.zcodeType)?.has(feature.field)).toBe(true);
      expect(feature.introducedIn).toBeGreaterThanOrEqual(
        resolveWebRemoteControlAppProtocolVersion(feature.zcodeType) ?? 0,
      );
    }
  });

  it("字段引入版本：未登记的字段随所属类型引入", () => {
    expect(resolveWebRemoteControlAppProtocolVersion("bootstrap-response")).toBe(1);
    expect(resolveWebRemoteControlAppProtocolVersion("not-a-real-type")).toBeNull();
    expect(resolveWebRemoteControlAppProtocolVersion("bootstrap-response", "workspaces")).toBe(1);
    expect(resolveWebRemoteControlAppProtocolVersion("not-a-real-type", "workspaces")).toBeNull();

    const features: WebRemoteControlAppProtocolFeature[] = [
      ...WEB_REMOTE_CONTROL_APP_PROTOCOL_FEATURES,
      { zcodeType: "bootstrap-response", field: "recentProjects", introducedIn: 2 },
    ];
    expect(
      resolveWebRemoteControlAppProtocolVersion("bootstrap-response", "recentProjects", features),
    ).toBe(2);
  });
});

describe("appProtocol version gate", () => {
  const bootstrapRequest = {
    zcode_type: "bootstrap-request",
    requestId: "request-1",
  } as WebRemoteControlAppPayload;

  it("协商版本之外的类型被丢弃，并回 protocol_error{unsupported-version}", () => {
    // 协商版本 0 低于本端任何已登记类型：机制等价于「对端发来协商窗口之外的类型」。
    const gate = gateWebRemoteControlAppPayloadVersion(bootstrapRequest, 0);
    expect(gate).toEqual({
      kind: "unsupported-version",
      offendingType: "bootstrap-request",
      protocolError: {
        type: "protocol_error",
        code: "unsupported-version",
        offendingType: "bootstrap-request",
      },
    });
    // 结果里只有诊断帧：没有任何会改变连接状态或页面的指令
    expect(Object.keys(gate).sort()).toEqual(["kind", "offendingType", "protocolError"]);
  });

  it("协商版本内的类型通过", () => {
    expect(
      gateWebRemoteControlAppPayloadVersion(
        bootstrapRequest,
        WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION,
      ),
    ).toEqual({ kind: "accepted" });
  });

  it("协商版本之外的字段被丢弃，协商版本达到引入版本后通过", () => {
    const features: WebRemoteControlAppProtocolFeature[] = [
      ...WEB_REMOTE_CONTROL_APP_PROTOCOL_FEATURES,
      { zcodeType: "bootstrap-response", field: "recentProjects", introducedIn: 2 },
    ];
    const withField = {
      zcode_type: "bootstrap-response",
      requestId: "request-1",
      success: true,
      result: {},
      recentProjects: [],
    } as unknown as WebRemoteControlAppPayload;
    const withoutField = {
      zcode_type: "bootstrap-response",
      requestId: "request-1",
      success: true,
      result: {},
    } as unknown as WebRemoteControlAppPayload;

    expect(gateWebRemoteControlAppPayloadVersion(withField, 1, features)).toEqual({
      kind: "unsupported-version",
      offendingType: "bootstrap-response",
      offendingField: "recentProjects",
      protocolError: {
        type: "protocol_error",
        code: "unsupported-version",
        offendingType: "bootstrap-response",
      },
    });
    expect(gateWebRemoteControlAppPayloadVersion(withField, 2, features)).toEqual({
      kind: "accepted",
    });
    // 字段缺席时不做版本判定，旧对端缺字段不会被打回
    expect(gateWebRemoteControlAppPayloadVersion(withoutField, 1, features)).toEqual({
      kind: "accepted",
    });
  });

  it("未登记的类型由应用层 schema 丢弃，不属于版本闸门", () => {
    expect(
      gateWebRemoteControlAppPayloadVersion({ zcode_type: "not-a-real-type" } as never, 1),
    ).toEqual({ kind: "accepted" });
  });

  it("是纯函数：不改入参、可重复调用（因此不会改变页面与连接状态）", () => {
    const payload = { ...bootstrapRequest } as WebRemoteControlAppPayload;
    const snapshot = JSON.stringify(payload);
    const first = gateWebRemoteControlAppPayloadVersion(payload, 0);
    const second = gateWebRemoteControlAppPayloadVersion(payload, 0);
    expect(JSON.stringify(payload)).toBe(snapshot);
    expect(second).toEqual(first);
  });
});
