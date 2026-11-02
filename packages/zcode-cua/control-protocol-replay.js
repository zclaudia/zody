import { CONTROL_LIMITS, fail } from "./control-protocol-limits.js";
import {
  canonicalizeControlJson,
  immutableControlValue,
  readStrictArray,
  readStrictObject,
} from "./control-protocol-json.js";
import {
  DIRECTIONS,
  normalizeBinding,
  readEnum,
  readHex64,
  readIdentifier,
  readNonNegativeSafeInteger,
  readPositiveSafeInteger,
} from "./control-protocol-schema.js";

const REPLAY_STATE_KEYS = ["windowSize", "binding", "direction", "lastSequence", "records"];
const REPLAY_WINDOW_KEYS = ["windowSize", "binding", "direction"];
const REPLAY_ENTRY_KEYS = ["sequence", "messageId", "bodyDigest", "binding", "direction"];
const REPLAY_RECORD_KEYS = ["sequence", "messageId", "bodyDigest"];

function readWindowSize(value) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < CONTROL_LIMITS.minReplayWindow ||
    value > CONTROL_LIMITS.maxReplayWindow
  ) {
    fail("invalid_schema", "replay window size is out of range");
  }
  return value;
}

function normalizeReplayRecord(value, path) {
  const fields = readStrictObject(value, REPLAY_RECORD_KEYS, path);
  return {
    sequence: readPositiveSafeInteger(fields.sequence, `${path}.sequence`),
    messageId: readIdentifier(fields.messageId, `${path}.messageId`),
    bodyDigest: readHex64(fields.bodyDigest, `${path}.bodyDigest`),
  };
}

function normalizeReplayState(value, path) {
  const fields = readStrictObject(value, REPLAY_STATE_KEYS, path);
  const windowSize = readWindowSize(fields.windowSize);
  const binding = normalizeBinding(fields.binding, `${path}.binding`);
  const direction = readEnum(fields.direction, DIRECTIONS, `${path}.direction`);
  const lastSequence = readNonNegativeSafeInteger(fields.lastSequence, `${path}.lastSequence`);
  const rawRecords = readStrictArray(
    fields.records,
    `${path}.records`,
    CONTROL_LIMITS.maxReplayRecords,
  );
  const records = rawRecords.map((record, index) =>
    normalizeReplayRecord(record, `${path}.records[${index}]`),
  );
  const expectedCount = Math.min(windowSize, lastSequence);
  if (records.length !== expectedCount) {
    fail("invalid_schema", `${path}.records does not match the replay watermark`);
  }
  const firstSequence = lastSequence - expectedCount + 1;
  for (let index = 0; index < expectedCount; index += 1) {
    if (records[index].sequence !== firstSequence + index) {
      fail("invalid_schema", `${path}.records is not the exact retained window`);
    }
  }
  return { windowSize, binding, direction, lastSequence, records };
}

export function createControlReplayWindow(input) {
  const fields = readStrictObject(input, REPLAY_WINDOW_KEYS, "replay window input");
  return immutableControlValue({
    windowSize: readWindowSize(fields.windowSize),
    binding: normalizeBinding(fields.binding, "replay window input.binding"),
    direction: readEnum(fields.direction, DIRECTIONS, "replay window input.direction"),
    lastSequence: 0,
    records: [],
  });
}

export function admitControlSequence(state, entry) {
  const windowState = normalizeReplayState(state, "replay state");
  const fields = readStrictObject(entry, REPLAY_ENTRY_KEYS, "replay entry");
  const entryBinding = normalizeBinding(fields.binding, "replay entry.binding");
  const entryDirection = readEnum(fields.direction, DIRECTIONS, "replay entry.direction");
  if (canonicalizeControlJson(entryBinding) !== canonicalizeControlJson(windowState.binding)) {
    fail("channel_mismatch", "replay entry binding does not match the window");
  }
  if (entryDirection !== windowState.direction) {
    fail("channel_mismatch", "replay entry direction does not match the window");
  }
  const record = {
    sequence: readPositiveSafeInteger(fields.sequence, "replay entry.sequence"),
    messageId: readIdentifier(fields.messageId, "replay entry.messageId"),
    bodyDigest: readHex64(fields.bodyDigest, "replay entry.bodyDigest"),
  };
  const expectedSequence =
    windowState.lastSequence === Number.MAX_SAFE_INTEGER ? null : windowState.lastSequence + 1;
  if (expectedSequence !== null && record.sequence === expectedSequence) {
    const records = [...windowState.records, record].slice(-windowState.windowSize);
    return immutableControlValue({
      decision: "exact",
      state: {
        windowSize: windowState.windowSize,
        binding: windowState.binding,
        direction: windowState.direction,
        lastSequence: record.sequence,
        records,
      },
    });
  }
  if (record.sequence <= windowState.lastSequence) {
    const previous = windowState.records.find(
      (candidate) => candidate.sequence === record.sequence,
    );
    if (!previous) {
      return immutableControlValue({ decision: "stale", state: windowState });
    }
    const decision =
      previous.messageId === record.messageId && previous.bodyDigest === record.bodyDigest
        ? "duplicate"
        : "conflict";
    return immutableControlValue({ decision, state: windowState });
  }
  return immutableControlValue({ decision: "stale", state: windowState });
}
