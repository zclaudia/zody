import { createControlReplayWindow, createControlRequest } from "./control-protocol.js";
import {
  ControlChannelClosedError,
  ControlChannelError,
  asError,
} from "./control-channel-errors.js";
import { buildControlAckEnvelope, encodeControlFrame } from "./control-channel-codec.js";
import { createControlDispatcher } from "./control-channel-dispatcher.js";
import { createControlFrameReader } from "./control-channel-framing.js";
import { createInboundRequestController } from "./control-channel-inbound.js";
import { createDuplicateHandler, createIncomingAckHandler } from "./control-channel-inbound-ack.js";
import { CONTROL_CHANNEL_LIMITS } from "./control-channel-limits.js";
import { normalizeControlChannelOptions } from "./control-channel-options.js";
import { createControlRequestSender } from "./control-channel-request.js";
import { createControlWriter } from "./control-channel-writer.js";

export { CONTROL_CHANNEL_LIMITS } from "./control-channel-limits.js";
export { ControlChannelClosedError, ControlChannelError } from "./control-channel-errors.js";

export function createControlChannel(rawOptions) {
  const options = normalizeControlChannelOptions(rawOptions);
  const {
    duplex,
    role,
    directions,
    binding,
    keyId,
    privateKey,
    trustedKeys,
    onRequest,
    onClosed,
    replayWindowSize,
    maxPendingRequests,
    maxIncomingRequests,
    maxAckCache,
    maxFrameBytes,
    maxOutboundBytes,
    requestTimeoutMs,
  } = options;

  let closed = false;
  let closeCode = null;
  let closeCause = null;
  let resolveClosed;
  let rejectClosed;
  const closedPromise = new Promise((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const closeController = new AbortController();
  let replay = createControlReplayWindow({
    windowSize: replayWindowSize,
    binding,
    direction: directions.incoming,
  });
  let outgoingSequence = 1;
  const pending = new Map();
  const ackCache = new Map();
  let writer = null;
  let reader = null;

  function cleanupPending(entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.signal !== null && entry.onAbort !== null) {
      entry.signal.removeEventListener("abort", entry.onAbort);
      entry.onAbort = null;
    }
  }

  function closedError(code, cause, pendingCount) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    return new ControlChannelClosedError(
      code,
      `control channel closed (${code}, ${pendingCount} pending)${detail}`,
      { cause: cause instanceof Error ? cause : undefined },
    );
  }

  function rejectAllPending(code, cause) {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      cleanupPending(entry);
      entry.reject(closedError(code, cause, entries.length));
    }
    return entries.length;
  }

  function notifyClosed(event) {
    if (typeof onClosed !== "function") {
      return;
    }
    try {
      const result = onClosed(event);
      if (result !== null && typeof result === "object" && typeof result.then === "function") {
        result.then(undefined, () => {});
      }
    } catch {
      // owner callback failures cannot reopen a latched channel.
    }
  }

  function waitForTransportClose() {
    if (duplex.closed === true) {
      return { promise: Promise.resolve(), reject: () => {} };
    }
    let rejectWait = () => {};
    const promise = new Promise((resolve, reject) => {
      let settled = false;
      const onClose = () => {
        if (settled) {
          return;
        }
        settled = true;
        duplex.off("close", onClose);
        resolve();
      };
      rejectWait = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        duplex.off("close", onClose);
        reject(error);
      };
      duplex.once("close", onClose);
    });
    return { promise, reject: rejectWait };
  }

  function ignoreTransportError() {}

  function detachReadListeners() {
    duplex.off("data", onData);
    duplex.off("end", onEnd);
    duplex.off("close", onClose);
    duplex.off("error", onError);
    duplex.on("error", ignoreTransportError);
  }

  function closeInternal(code, cause) {
    if (closed) {
      return closedPromise;
    }
    const transportClose = waitForTransportClose();
    closed = true;
    closeCode = code;
    closeCause = cause === undefined || cause === null ? null : asError(cause);
    if (writer !== null) {
      writer.clear();
    }
    if (reader !== null) {
      reader.stop();
    }
    inbound.clear();
    ackCache.clear();
    detachReadListeners();
    try {
      closeController.abort(closeCause ?? undefined);
    } catch {
      // AbortController.abort only throws for hostile custom reasons; state is already latched.
    }
    const pendingCount = rejectAllPending(code, closeCause);
    notifyClosed(
      Object.freeze({
        code,
        message: closeCause === null ? `control channel closed: ${code}` : closeCause.message,
        cause: closeCause,
        pendingRequests: pendingCount,
      }),
    );
    try {
      duplex.destroy();
    } catch (error) {
      transportClose.reject(asError(error));
    }
    transportClose.promise.then(resolveClosed, rejectClosed);
    return closedPromise;
  }

  function closeDetached(code, cause) {
    const closing = closeInternal(code, cause);
    closing.catch(() => {});
    return closing;
  }

  writer = createControlWriter({
    duplex,
    maxOutboundBytes,
    onOverflow: (error) => closeDetached("outbound_overflow", error),
    onError: (error) => closeDetached("transport_error", error),
  });

  function enqueueEnvelope(envelope) {
    if (closed) {
      return false;
    }
    let frame;
    try {
      frame = encodeControlFrame(envelope);
    } catch (error) {
      closeDetached("protocol_error", asError(error));
      return false;
    }
    if (frame.length > maxFrameBytes) {
      closeDetached(
        "protocol_error",
        new ControlChannelError("frame_too_large", "outbound control frame exceeds maxFrameBytes"),
      );
      return false;
    }
    return writer.enqueue(frame);
  }

  function cacheAck(sequence, messageId, bodyDigest, envelope) {
    ackCache.set(sequence, { messageId, bodyDigest, envelope });
    while (ackCache.size > maxAckCache) {
      ackCache.delete(ackCache.keys().next().value);
    }
  }

  function buildAck(request, result) {
    const sequence = outgoingSequence;
    if (!Number.isSafeInteger(sequence)) {
      throw new ControlChannelError(
        "sequence_exhausted",
        "control channel outbound sequence is exhausted",
      );
    }
    const envelope = buildControlAckEnvelope({
      request,
      result,
      keyId,
      direction: directions.outgoing,
      binding,
      sequence,
      role,
      privateKey,
    });
    outgoingSequence = sequence + 1;
    return envelope;
  }

  const inbound = createInboundRequestController({
    onRequest,
    buildAck,
    enqueueEnvelope,
    cacheAck,
    close: closeDetached,
    isClosed: () => closed,
    getSignal: () => closeController.signal,
    maxIncomingRequests,
  });

  const handleIncomingAck = createIncomingAckHandler({
    pending,
    cleanupPending,
    close: (error) => closeDetached("protocol_error", error),
    isClosed: () => closed,
  });

  const handleDuplicate = createDuplicateHandler({
    ackCache,
    isInFlight: (sequence) => inbound.isInFlight(sequence),
    requestResend: (sequence) => inbound.requestResend(sequence),
    enqueueEnvelope,
    close: (error) => closeDetached("protocol_error", error),
    isClosed: () => closed,
  });

  const dispatcher = createControlDispatcher({
    trustedKeys,
    binding,
    direction: directions.incoming,
    getReplay: () => replay,
    setReplay: (state) => {
      replay = state;
    },
    onRequest: (verified) => inbound.handle(verified),
    onAck: handleIncomingAck,
    onDuplicate: handleDuplicate,
    close: (error) => closeDetached("protocol_error", error),
    isClosed: () => closed,
  });

  reader = createControlFrameReader({
    maxFrameBytes,
    maxFramesPerChunk: CONTROL_CHANNEL_LIMITS.maxFramesPerChunk,
    onFrame: (envelope) => dispatcher.process(envelope),
    onError: (error) => {
      const code = error instanceof ControlChannelError ? error.code : "protocol_error";
      closeDetached(
        code === "frame_too_large" ? "frame_too_large" : "protocol_error",
        asError(error),
      );
    },
  });

  function onData(chunk) {
    if (!closed) {
      reader.push(chunk);
    }
  }

  function onEnd() {
    if (closed) {
      return;
    }
    reader.end();
    if (!closed) {
      closeDetached("peer_eof", null);
    }
  }

  function onError(error) {
    closeDetached("transport_error", asError(error));
  }

  function onClose() {
    closeDetached("transport_closed", null);
  }

  duplex.on("data", onData);
  duplex.on("end", onEnd);
  duplex.on("error", onError);
  duplex.on("close", onClose);

  const request = createControlRequestSender({
    createRequest: createControlRequest,
    privateKey,
    keyId,
    role,
    direction: directions.outgoing,
    binding,
    pending,
    maxPendingRequests,
    requestTimeoutMs,
    enqueueEnvelope,
    close: closeDetached,
    closedError: () => closedError(closeCode ?? "local_close", closeCause, 0),
    getSequence: () => outgoingSequence,
    commitSequence: (sequence) => {
      outgoingSequence = sequence + 1;
    },
    isClosed: () => closed,
  });

  return Object.freeze({
    role,
    binding,
    get closed() {
      return closed;
    },
    get closeCode() {
      return closeCode;
    },
    request,
    close() {
      return closeInternal("local_close", null);
    },
    dispose() {
      return closeInternal("disposed", null);
    },
  });
}
