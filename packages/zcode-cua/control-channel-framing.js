import { TextDecoder } from "node:util";

import { ControlChannelError } from "./control-channel-errors.js";

const NEWLINE = 0x0a;

function isBytes(value) {
  return value instanceof Uint8Array;
}

export function createControlFrameReader({ maxFrameBytes, maxFramesPerChunk, onFrame, onError }) {
  let parts = [];
  let bufferedBytes = 0;
  let failed = false;

  function fail(error) {
    if (failed) {
      return false;
    }
    failed = true;
    onError(error);
    return false;
  }

  function append(piece) {
    if (piece.length === 0) {
      return true;
    }
    if (bufferedBytes + piece.length > maxFrameBytes) {
      return fail(
        new ControlChannelError(
          "frame_too_large",
          "control channel frame exceeds maxFrameBytes before newline",
        ),
      );
    }
    parts.push(piece);
    bufferedBytes += piece.length;
    return true;
  }

  function take() {
    const frame = Buffer.concat(parts, bufferedBytes);
    parts = [];
    bufferedBytes = 0;
    return frame;
  }

  function stop() {
    failed = true;
    parts = [];
    bufferedBytes = 0;
  }

  function processFrame(frame) {
    if (frame.length === 0) {
      return fail(new ControlChannelError("empty_frame", "control channel frame is empty"));
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(frame);
    } catch {
      return fail(new ControlChannelError("invalid_utf8", "control channel frame is not UTF-8"));
    }
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      return fail(new ControlChannelError("invalid_json", "control channel frame is not JSON"));
    }
    try {
      onFrame(envelope);
    } catch (error) {
      return fail(error);
    }
    return true;
  }

  return Object.freeze({
    push(chunk) {
      if (failed) {
        return false;
      }
      if (!isBytes(chunk)) {
        return fail(
          new ControlChannelError("invalid_chunk", "control channel received a non-buffer chunk"),
        );
      }
      let offset = 0;
      let frames = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(NEWLINE, offset);
        if (newline === -1) {
          return append(chunk.subarray(offset));
        }
        if (!append(chunk.subarray(offset, newline))) {
          return false;
        }
        frames += 1;
        if (frames > maxFramesPerChunk) {
          return fail(
            new ControlChannelError(
              "frame_overflow",
              "control channel chunk contains too many frames",
            ),
          );
        }
        const frame = take();
        if (!processFrame(frame)) {
          return false;
        }
        offset = newline + 1;
      }
      return true;
    },
    end() {
      if (failed) {
        return;
      }
      if (bufferedBytes !== 0) {
        fail(
          new ControlChannelError(
            "incomplete_frame",
            "control channel ended with an incomplete frame",
          ),
        );
      }
    },
    stop,
  });
}
