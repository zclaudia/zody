import assert from "node:assert/strict";
import test from "node:test";
import {
  CTRL_C_EXIT_CONFIRMATION_WINDOW_MS,
  createCtrlCExitGuard,
  resetCtrlCExitGuard,
  resolveCtrlCExitIntent,
} from "../src/app-keyboard.js";

test("requires two consecutive Ctrl-C presses inside the confirmation window", () => {
  const guard = createCtrlCExitGuard();
  const firstPressAtMs = 1_000;

  assert.equal(resolveCtrlCExitIntent(guard, firstPressAtMs), "show_prompt");
  assert.equal(
    resolveCtrlCExitIntent(guard, firstPressAtMs + CTRL_C_EXIT_CONFIRMATION_WINDOW_MS),
    "confirm_exit",
  );
  assert.equal(guard.lastPressAtMs, undefined);
});

test("restarts Ctrl-C confirmation after the timeout", () => {
  const guard = createCtrlCExitGuard();
  const firstPressAtMs = 1_000;
  const afterTimeoutMs = firstPressAtMs + CTRL_C_EXIT_CONFIRMATION_WINDOW_MS + 1;

  assert.equal(resolveCtrlCExitIntent(guard, firstPressAtMs), "show_prompt");
  assert.equal(resolveCtrlCExitIntent(guard, afterTimeoutMs), "show_prompt");
  assert.equal(guard.lastPressAtMs, afterTimeoutMs);
});

test("resets Ctrl-C confirmation when another key is handled", () => {
  const guard = createCtrlCExitGuard();
  const firstPressAtMs = 1_000;

  assert.equal(resolveCtrlCExitIntent(guard, firstPressAtMs), "show_prompt");
  resetCtrlCExitGuard(guard);

  assert.equal(resolveCtrlCExitIntent(guard, firstPressAtMs + 1), "show_prompt");
});

test("requires a fresh confirmation after an exit was already confirmed", () => {
  const guard = createCtrlCExitGuard();
  const firstPressAtMs = 1_000;

  assert.equal(resolveCtrlCExitIntent(guard, firstPressAtMs), "show_prompt");
  assert.equal(resolveCtrlCExitIntent(guard, firstPressAtMs + 100), "confirm_exit");
  // 上一次确认已被消费；下一次 Ctrl+C 不能直接复用，必须重新走二次确认。
  assert.equal(resolveCtrlCExitIntent(guard, firstPressAtMs + 200), "show_prompt");
});
