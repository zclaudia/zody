export const CONTROL_PROTOCOL = "zody.cua.control";
export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_DIGEST_DOMAIN = "zody.cua.control.v1/digest";
export const CONTROL_SIGNATURE_DOMAIN = "zody.cua.control.v1/signature";

export const CONTROL_LIMITS = Object.freeze({
  maxCanonicalBytes: 64 * 1024,
  maxCanonicalNodes: 4096,
  maxDepth: 8,
  maxStringBytes: 4096,
  maxIdentifierBytes: 256,
  maxObjectKeys: 64,
  maxArrayLength: 32,
  maxReplayRecords: 1024,
  minReplayWindow: 1,
  maxReplayWindow: 1024,
  defaultReplayWindow: 64,
});

export class ControlProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ControlProtocolError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new ControlProtocolError(code, message);
}
