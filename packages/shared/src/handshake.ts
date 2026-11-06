export const ZODY_RENAME_GENERATION = 2 as const;
export const ZODY_RENAME_GENERATION_HEADER = "x-zody-generation" as const;
export const ZODY_RENAME_WEBSOCKET_PROTOCOL = "zody-generation-2" as const;

export function checkRenameGeneration(
  value: unknown,
): { ok: true } | { ok: false; code: "incompatible-generation" } {
  return value === ZODY_RENAME_GENERATION
    ? { ok: true }
    : { ok: false, code: "incompatible-generation" };
}

export interface HelloMessage {
  type: "zody-hello";
  version: string;
  platform: string;
  arch: string;
  pid: number;
  generation: typeof ZODY_RENAME_GENERATION;
}

export interface HelloAckMessage {
  type: "zody-hello-ack";
  version: string;
  clientId: string;
  generation: typeof ZODY_RENAME_GENERATION;
}
