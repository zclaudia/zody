import { ControlChannelError } from "./control-channel-errors.js";

export function createControlWriter({ duplex, maxOutboundBytes, onOverflow, onError }) {
  let queue = [];
  let queuedBytes = 0;
  let pumping = false;
  let stopped = false;
  let drainWait = null;

  function clear() {
    stopped = true;
    queue = [];
    queuedBytes = 0;
    const finishDrain = drainWait;
    drainWait = null;
    if (finishDrain !== null) {
      finishDrain();
    }
  }

  function waitForDrain() {
    return new Promise((resolve) => {
      let active = true;
      const finish = () => {
        if (!active) {
          return;
        }
        active = false;
        duplex.off("drain", finish);
        duplex.off("close", finish);
        duplex.off("error", finish);
        if (drainWait === finish) {
          drainWait = null;
        }
        resolve();
      };
      drainWait = finish;
      duplex.once("drain", finish);
      duplex.once("close", finish);
      duplex.once("error", finish);
    });
  }

  async function pump() {
    if (pumping || stopped) {
      return;
    }
    pumping = true;
    try {
      while (!stopped && queue.length > 0) {
        const frame = queue[0];
        let accepted;
        try {
          accepted = duplex.write(frame);
        } catch (error) {
          onError(error);
          return;
        }
        if (!accepted) {
          if (stopped) {
            return;
          }
          await waitForDrain();
        }
        if (stopped) {
          return;
        }
        if (queue[0] === frame) {
          queue.shift();
          queuedBytes -= frame.length;
        }
      }
    } finally {
      pumping = false;
      if (!stopped && queue.length > 0) {
        void pump();
      }
    }
  }

  return Object.freeze({
    enqueue(frame) {
      if (stopped) {
        return false;
      }
      if (queuedBytes + frame.length > maxOutboundBytes) {
        onOverflow(
          new ControlChannelError(
            "outbound_overflow",
            "control channel outbound byte budget is exhausted",
          ),
        );
        return false;
      }
      queue.push(frame);
      queuedBytes += frame.length;
      void pump();
      return true;
    },
    clear,
    get queuedBytes() {
      return queuedBytes;
    },
  });
}
