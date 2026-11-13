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
  return {
    async execute(input) {
      if (disposed) throw new Error("cua_observation_runtime_disposed");
      if (input.toolName !== "screenshot" && !Object.hasOwn(schemas, input.toolName))
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
        const method = input.toolName as ObservationMethod;
        const args = schemas[method].parse(
          input.arguments === undefined ? {} : input.arguments,
        ) as Record<string, unknown>;
        const expected = trustedExpectation(input.context);
        input.signal?.throwIfAborted();
        const screenshot = method === "get_app_state" && args.include_screenshot === true;
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
        if (!screenshot) return result;
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
