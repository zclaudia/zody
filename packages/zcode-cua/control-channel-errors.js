export class ControlChannelError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ControlChannelError";
    this.code = code;
  }
}

export class ControlChannelClosedError extends ControlChannelError {
  constructor(closeCode, message, options) {
    super("channel_closed", message, options);
    this.name = "ControlChannelClosedError";
    this.closeCode = closeCode;
  }
}

export function asError(value) {
  if (value instanceof Error) {
    return value;
  }
  return new Error(typeof value === "string" ? value : "unknown control channel error");
}
