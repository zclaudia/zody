import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { VSBuffer } from "../src/buffer.js";
import { BufferReader, BufferWriter, serialize, deserialize } from "../src/serialization.js";

function roundtrip(data: any): any {
  const writer = new BufferWriter();
  serialize(writer, data);
  const reader = new BufferReader(writer.buffer);
  return deserialize(reader);
}

describe("serialization", () => {
  it("should roundtrip undefined", () => {
    expect(roundtrip(undefined)).toBeUndefined();
  });

  it("should roundtrip strings", () => {
    expect(roundtrip("")).toBe("");
    expect(roundtrip("hello")).toBe("hello");
    expect(roundtrip("你好🌍")).toBe("你好🌍");
  });

  it("should roundtrip integers", () => {
    expect(roundtrip(0)).toBe(0);
    expect(roundtrip(1)).toBe(1);
    expect(roundtrip(127)).toBe(127);
    expect(roundtrip(128)).toBe(128);
    expect(roundtrip(65535)).toBe(65535);
  });

  it("should roundtrip arrays", () => {
    expect(roundtrip([])).toEqual([]);
    expect(roundtrip([1, 2, 3])).toEqual([1, 2, 3]);
    expect(roundtrip(["a", "b"])).toEqual(["a", "b"]);
  });

  it("should roundtrip nested arrays", () => {
    expect(roundtrip([1, [2, 3], "four"])).toEqual([1, [2, 3], "four"]);
  });

  it("should roundtrip objects via JSON fallback", () => {
    expect(roundtrip({ a: 1, b: "two" })).toEqual({ a: 1, b: "two" });
  });

  it("should roundtrip VSBuffer", () => {
    const original = VSBuffer.fromString("binary data");
    const result = roundtrip(original);
    expect(result).toBeInstanceOf(VSBuffer);
    expect(result.toString()).toBe("binary data");
  });

  it("should roundtrip Uint8Array", () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const result = roundtrip(original);
    expect(result).toBeInstanceOf(Uint8Array);
    expect([...result]).toEqual([1, 2, 3, 4]);
  });

  it("should roundtrip floats via JSON fallback", () => {
    expect(roundtrip(3.14)).toBeCloseTo(3.14);
  });

  it("should roundtrip booleans via JSON fallback", () => {
    expect(roundtrip(true)).toBe(true);
    expect(roundtrip(false)).toBe(false);
  });

  it("should handle multiple serialize/deserialize in sequence", () => {
    const writer = new BufferWriter();
    serialize(writer, "hello");
    serialize(writer, 42);
    serialize(writer, [1, 2]);

    const reader = new BufferReader(writer.buffer);
    expect(deserialize(reader)).toBe("hello");
    expect(deserialize(reader)).toBe(42);
    expect(deserialize(reader)).toEqual([1, 2]);
  });
});

describe("BufferReader / BufferWriter", () => {
  it("should read sequentially", () => {
    const buf = VSBuffer.fromString("abcdef");
    const reader = new BufferReader(buf);
    expect(reader.read(3).toString()).toBe("abc");
    expect(reader.read(3).toString()).toBe("def");
  });

  it("BufferWriter should concat all writes", () => {
    const writer = new BufferWriter();
    writer.write(VSBuffer.fromString("hello"));
    writer.write(VSBuffer.fromString(" world"));
    expect(writer.buffer.toString()).toBe("hello world");
  });
});

// ============================================================================
// 嵌套二进制字段（上游 a60ba6a7 replacer 修复的反例与回归）
// ============================================================================
//
// 根因：JSON.stringify 先调用 toJSON 再调用 replacer。Node Buffer 是 Uint8Array 子类，
// 到达 replacer 时已被 toJSON 展开成 {type:"Buffer",data:[...]}，旧逻辑按普通对象编码，
// 归档体积约 3.6 倍且接收端拿不到二进制。修复后 replacer 按 holder 原值（this[key]）判定。
// 参考：上游 ZCode v3.17.1 packages/rpc/src/serialization.ts。

describe("nested binary fields in JSON fallback objects", () => {
  const NESTED_MARKER = "__zcode_rpc_nested_uint8array_v1";

  function makeBytes(length: number): Uint8Array {
    const raw = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      raw[i] = (i * 7 + 13) & 0xff;
    }
    return raw;
  }

  /** 取出 Object JSON fallback 帧的标签与 JSON 正文（跳过 VQL 长度头） */
  function encodeObjectFrameJson(data: unknown): { tag: number; json: string } {
    const writer = new BufferWriter();
    serialize(writer, data);
    const bytes = writer.buffer;
    const tag = bytes.buffer[0];
    let length = 0;
    let shift = 0;
    let offset = 1;
    for (;;) {
      const byte = bytes.buffer[offset];
      offset += 1;
      length |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) {
        break;
      }
    }
    expect(length).toBe(bytes.byteLength - offset);
    return { tag, json: bytes.slice(offset).toString() };
  }

  it("encodes nested Node Buffer fields as the base64 marker form", () => {
    const raw = makeBytes(1024);
    const { tag, json } = encodeObjectFrameJson({ archive: Buffer.from(raw) });

    // 仍走 Object JSON fallback 分支，既有 wire 形态不变
    expect(tag).toBe(5);
    const parsed = JSON.parse(json) as { archive: unknown };
    // 修复前：toJSON 展开成 {type:"Buffer",data:[...1024 个数字]}；修复后：base64 标记形态
    expect(parsed.archive).toEqual({
      [NESTED_MARKER]: true,
      base64: Buffer.from(raw).toString("base64"),
    });
  });

  it("encodes nested Node Buffer archives significantly smaller than the toJSON expansion", () => {
    const raw = makeBytes(1024);
    const { json } = encodeObjectFrameJson({ archive: Buffer.from(raw) });
    // 修复前的实际输出形态（JSON.stringify 对 Buffer 的 toJSON 展开）
    const legacyExpansion = JSON.stringify({ archive: { type: "Buffer", data: Array.from(raw) } });

    // base64 标记形态约为原始体积的 1.4 倍，必须显著小于 toJSON 展开的 ~3.8 倍
    expect(json.length).toBeLessThan(raw.length * 2);
    expect(json.length * 2).toBeLessThan(legacyExpansion.length);
  });

  it("roundtrips nested Node Buffer fields back to binary with identical content", () => {
    const raw = makeBytes(1024);
    const result = roundtrip({ archive: Buffer.from(raw), name: "plugin-archive" });

    expect(result.archive).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.archive as Uint8Array)).toEqual(Array.from(raw));
    expect(result.name).toBe("plugin-archive");
  });

  it("roundtrips Node Buffer nested inside arrays", () => {
    const raw = makeBytes(256);
    const result = roundtrip({ items: [Buffer.from(raw), "tail"] });

    expect(result.items[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.items[0] as Uint8Array)).toEqual(Array.from(raw));
    expect(result.items[1]).toBe("tail");
  });

  it("keeps nested plain Uint8Array (no toJSON) roundtrip unchanged", () => {
    const result = roundtrip({ data: new Uint8Array([1, 2, 3]), label: 7 });

    expect(result.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.data as Uint8Array)).toEqual([1, 2, 3]);
    expect(result.label).toBe(7);
  });

  it("keeps top-level Uint8Array / VSBuffer wire tags unchanged", () => {
    const uint8Writer = new BufferWriter();
    serialize(uint8Writer, new Uint8Array([9, 8, 7]));
    expect(uint8Writer.buffer.buffer[0]).toBe(2); // DataType.Buffer
    expect(roundtrip(new Uint8Array([9, 8, 7]))).toBeInstanceOf(Uint8Array);

    const vsWriter = new BufferWriter();
    serialize(vsWriter, VSBuffer.fromString("vs"));
    expect(vsWriter.buffer.buffer[0]).toBe(3); // DataType.VSBuffer
    expect(roundtrip(VSBuffer.fromString("vs"))).toBeInstanceOf(VSBuffer);
  });
});
