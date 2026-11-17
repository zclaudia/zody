import type { ComputerUseRuntime, ComputerUseRuntimeContext } from "@zody/zody-cua";
import type {
  CuaObservationRequest,
  CuaObservationResult,
} from "@zody/zody-cua/observation-contract";
import { z } from "zod";
import {
  createCuaCaptureComputerUseRuntime,
  type CuaCaptureComputerUseRuntimeOptions,
  type CuaCaptureExpectation,
  type CuaCaptureImageResult,
} from "./cua-capture-runtime.js";

const appRef = z.union([
  z.string().trim().min(1),
  z
    .strictObject({
      name: z.string().trim().min(1).optional(),
      bundle_id: z.string().trim().min(1).optional(),
      pid: z.number().int().positive().safe().optional(),
      window_id: z.number().int().positive().safe().optional(),
    })
    .refine((v) => !!(v.name || v.bundle_id || v.pid)),
]);
const schemas = {
  list_apps: z.strictObject({}),
  list_windows: z.strictObject({ app_ref: appRef.optional() }),
  get_app_state: z.strictObject({
    app_ref: appRef,
    include_screenshot: z.boolean().optional(),
    disable_diffing: z.boolean().optional(),
    tree_shown_to_model: z.boolean().optional(),
  }),
};
const element = z.strictObject({
  type: z.literal("element"),
  index: z.number().int().nonnegative().safe(),
});
const returnState = z.enum(["none", "compact", "full"]).optional();
const writeSchemas = {
  left_click: z.strictObject({
    target: element,
    app_ref: appRef.optional(),
    mouse_button: z.literal("left").optional(),
    click_count: z.literal(1).optional(),
    modifiers: z.union([z.literal(""), z.array(z.never()).length(0)]).optional(),
    strategy: z.enum(["auto", "a11y"]).optional(),
    return_state: returnState,
  }),
  perform_action: z.strictObject({
    target: element,
    action: z.literal("AXPress"),
    app_ref: appRef.optional(),
    return_state: returnState,
  }),
  set_value: z.strictObject({
    target: element,
    value: z.string(),
    app_ref: appRef.optional(),
    strategy: z.enum(["auto", "a11y"]).optional(),
    return_state: returnState,
  }),
};
type ObservationMethod = keyof typeof schemas;
export interface CuaObservationRuntimeOptions extends CuaCaptureComputerUseRuntimeOptions {
  observationOnce(
    request: CuaObservationRequest,
    options: { expected: CuaCaptureExpectation; signal?: AbortSignal },
  ): Promise<CuaObservationResult>;
  verifyObservationScope?(expected: CuaCaptureExpectation): boolean | Promise<boolean>;
}

/** 仅由 sealed composition 注入；正文授权和状态归可信 authority/native 所有。 */
export function createCuaObservationRuntime(
  options: CuaObservationRuntimeOptions,
): ComputerUseRuntime {
  const capture = createCuaCaptureComputerUseRuntime(options);
  let disposed = false;
  let active = false;
  let frozen:
    | { stateId: string; scope: string; appRef: string; target: { pid: number; window_id: number } }
    | undefined;
  return {
    async execute(input) {
      if (disposed) throw new Error("cua_observation_runtime_disposed");
      if (input.toolName === "stop_computer_control") {
        const args = z
          .strictObject({ reason: z.string().optional() })
          .safeParse(input.arguments ?? {});
        if (!args.success) return unavailable();
        const expected = trustedExpectation(input.context);
        frozen = undefined;
        return options.observationOnce(
          { method: "stop_computer_control", arguments: args.data } as CuaObservationRequest,
          { expected },
        );
      }
      const isWrite = Object.hasOwn(writeSchemas, input.toolName);
      if (input.toolName !== "screenshot" && !Object.hasOwn(schemas, input.toolName) && !isWrite)
        return unavailable();
      // 原因：并行 consumer 会拿到同一个 live scope，其中一次 close 会误伤另一次；
      // 本轮直接拒绝重入，不创建第二条队列或 authority。
      if (active) return busy();
      active = true;
      const ensureLive = () => {
        if (disposed) throw new Error("cua_observation_runtime_disposed");
        input.signal?.throwIfAborted();
      };
      try {
        if (input.toolName === "screenshot") {
          const result = await capture.execute(input);
          ensureLive();
          return result;
        }
        if (isWrite) {
          const parsed = writeSchemas[input.toolName as keyof typeof writeSchemas].safeParse(
            input.arguments,
          );
          if (!parsed.success) return unavailable();
          const expected = trustedExpectation(input.context);
          const args = parsed.data;
          if (
            !frozen ||
            frozen.scope !== JSON.stringify(expected) ||
            (args.app_ref !== undefined && frozen.appRef !== JSON.stringify(args.app_ref))
          )
            return unavailable();
          try {
            const result = await options.observationOnce(
              {
                method: input.toolName,
                // 只使用已交付状态的真实窗口身份，模型省略 app_ref 时也不能回退到前台窗口。
                arguments: {
                  ...args,
                  app_ref: frozen.target,
                  ...(input.toolName === "left_click" &&
                  "modifiers" in args &&
                  args.modifiers === ""
                    ? { modifiers: [] }
                    : {}),
                  state_id: frozen.stateId,
                },
              } as CuaObservationRequest,
              { expected, ...(input.signal ? { signal: input.signal } : {}) },
            );
            ensureLive();
            const returnedState = result.structuredContent;
            if (
              !result.isError &&
              args.return_state &&
              args.return_state !== "none" &&
              returnedState &&
              typeof returnedState.state_id === "string" &&
              returnedState.state_id &&
              Array.isArray(returnedState.elements) &&
              isRecord(returnedState.app) &&
              isRecord(returnedState.window)
            ) {
              frozen = {
                stateId: returnedState.state_id,
                scope: JSON.stringify(expected),
                appRef: frozen.appRef,
                target: frozen.target,
              };
            }
            return result;
          } catch {
            // 断链或撤销可能发生在原生 admission 之后，不能将未知派发伪装为未发送或重放。
            frozen = undefined;
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    code: "action_unavailable",
                    message: "Computer Use action outcome unavailable",
                    action_sent: true,
                    dispatch_status: "possibly_sent",
                    state_sync_status: "failed",
                  }),
                },
              ],
            };
          }
        }
        const method = input.toolName as ObservationMethod;
        const args = schemas[method].parse(
          input.arguments === undefined ? {} : input.arguments,
        ) as Record<string, unknown>;
        const expected = trustedExpectation(input.context);
        input.signal?.throwIfAborted();
        const screenshot = method === "get_app_state" && args.include_screenshot === true;
        if (screenshot) frozen = undefined;
        if (screenshot && !options.verifyObservationScope)
          throw new Error("cua_observation_scope_verifier_required");
        // 截图可能失败，尚未展示的树不能成为模型可见 diff 基线。
        const requestArgs = screenshot
          ? {
              ...args,
              include_screenshot: false,
              tree_shown_to_model: false,
              disable_diffing: true,
            }
          : args;
        const callOptions = { expected, ...(input.signal ? { signal: input.signal } : {}) };
        const result = await options.observationOnce(
          { method, arguments: requestArgs },
          callOptions,
        );
        ensureLive();
        if (!result || !Array.isArray(result.content))
          throw new Error("cua_observation_result_invalid");
        if (result.isError) return result;
        if (result.content.some((item) => item.type === "image"))
          throw new Error("cua_observation_unexpected_image");
        if (method !== "get_app_state") return result;
        const state = result.structuredContent;
        if (
          !state ||
          typeof state.state_id !== "string" ||
          !Array.isArray(state.elements) ||
          !isRecord(state.app) ||
          !isRecord(state.window)
        ) {
          return structuredStateUnavailable();
        }
        const pid = state.app.pid;
        const windowId = state.window.window_id;
        if (!positiveInteger(pid) || !positiveInteger(windowId))
          return structuredStateUnavailable();
        if (!screenshot) {
          // 只绑定已交付的冻结状态；静默观察不能改变模型可操作索引。
          if (args.tree_shown_to_model !== false)
            frozen = {
              stateId: state.state_id,
              scope: JSON.stringify(expected),
              appRef: JSON.stringify(args.app_ref),
              target: { pid: Number(pid), window_id: Number(windowId) },
            };
          return result;
        }
        // 两次独立授权后仍须复核原 scope，防止截图等待期间旧正文跨轮交付。
        const image = await options.captureOnce({ pid, windowId }, callOptions);
        ensureLive();
        if (image.isError) return image;
        if (!options.verifyObservationScope || !(await options.verifyObservationScope(expected)))
          throw new Error("cua_observation_scope_invalid");
        ensureLive();
        if (
          !Array.isArray(image.content) ||
          image.content.filter((item) => item.type === "image").length !== 1 ||
          !image.content.some(
            (item) =>
              item.type === "image" &&
              typeof item.data === "string" &&
              item.data.length > 0 &&
              typeof item.mimeType === "string" &&
              /^image\/[a-z0-9.+-]+$/iu.test(item.mimeType),
          )
        )
          throw new Error("cua_observation_image_invalid");
        if (args.tree_shown_to_model !== false) {
          const committed = await options.observationOnce(
            {
              method: "commit_state",
              arguments: { state_id: state.state_id, app_ref: { pid, window_id: windowId } },
            } as CuaObservationRequest,
            callOptions,
          );
          ensureLive();
          if (!isCommittedState(committed, state.state_id)) return structuredStateUnavailable();
          if (!(await options.verifyObservationScope(expected)))
            throw new Error("cua_observation_scope_invalid");
          ensureLive();
          frozen = {
            stateId: state.state_id,
            scope: JSON.stringify(expected),
            appRef: JSON.stringify(args.app_ref),
            target: { pid: Number(pid), window_id: Number(windowId) },
          };
        }
        return {
          ...result,
          content: [...result.content, ...image.content],
          ...(image._meta ? { _meta: { ...result._meta, ...image._meta } } : {}),
        };
      } finally {
        active = false;
      }
    },
    async closeSession(context) {
      await capture.closeSession(context);
    },
    async dispose() {
      disposed = true;
      frozen = undefined;
      await capture.dispose();
    },
  };
}
function trustedExpectation(context: ComputerUseRuntimeContext): CuaCaptureExpectation {
  if (
    context.runtimeScope !== "main" ||
    !context.sessionId?.trim() ||
    !context.workspaceKey?.trim() ||
    !context.turnId?.trim() ||
    !["desktop-continuous", "web-remote-replayable"].includes(context.clientMode ?? "") ||
    context.clientMode !== context.deliveryKind
  )
    throw new Error("cua_observation_untrusted_context");
  return Object.freeze({
    sessionId: context.sessionId.trim(),
    workspaceKey: context.workspaceKey.trim(),
    turnId: context.turnId.trim(),
    ...(context.workspaceIdentity?.trim()
      ? { workspaceIdentity: context.workspaceIdentity.trim() }
      : {}),
    ...(context.remoteSessionId?.trim() ? { remoteSessionId: context.remoteSessionId.trim() } : {}),
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function unavailable(): CuaCaptureImageResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: { code: "action_unavailable", message: "Computer Use action unavailable" },
          action_sent: false,
          dispatch_status: "not_sent",
          state_sync_status: "not_requested",
        }),
      },
    ],
  };
}

function busy(): CuaCaptureImageResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: "controller_busy",
          message: "Computer Use already has an active observation or screenshot",
          // 重入在 native 调用前被拒绝，写动作也必须带完整的零派发事实。
          action_sent: false,
          dispatch_status: "not_sent",
          state_sync_status: "not_requested",
        }),
      },
    ],
  };
}

function structuredStateUnavailable(): CuaCaptureImageResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: "structured_state_unavailable",
          message: "Computer Use returned no usable accessibility state",
        }),
      },
    ],
  };
}

function isCommittedState(result: CuaObservationResult, stateId: string): boolean {
  if (
    !result ||
    result.isError ||
    result.structuredContent ||
    result._meta ||
    !Array.isArray(result.content) ||
    result.content.length !== 1
  )
    return false;
  const block = result.content[0];
  if (
    !isRecord(block) ||
    block.type !== "text" ||
    typeof block.text !== "string" ||
    Object.keys(block).some((key) => key !== "type" && key !== "text")
  )
    return false;
  try {
    const receipt: unknown = JSON.parse(block.text);
    return (
      isRecord(receipt) &&
      receipt.committed === true &&
      receipt.state_id === stateId &&
      Object.keys(receipt).length === 2
    );
  } catch {
    return false;
  }
}
