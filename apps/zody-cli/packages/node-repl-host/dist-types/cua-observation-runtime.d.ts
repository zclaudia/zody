import type { ComputerUseRuntime } from "@zody/zody-cua";
import type { CuaObservationRequest, CuaObservationResult } from "@zody/zody-cua/observation-contract";
import { type CuaCaptureComputerUseRuntimeOptions, type CuaCaptureExpectation } from "./cua-capture-runtime.js";
export interface CuaObservationRuntimeOptions extends CuaCaptureComputerUseRuntimeOptions {
    observationOnce(request: CuaObservationRequest, options: {
        expected: CuaCaptureExpectation;
        signal?: AbortSignal;
    }): Promise<CuaObservationResult>;
    verifyObservationScope?(expected: CuaCaptureExpectation): boolean | Promise<boolean>;
}
/** 仅由 sealed composition 注入；正文授权和状态归可信 authority/native 所有。 */
export declare function createCuaObservationRuntime(options: CuaObservationRuntimeOptions): ComputerUseRuntime;
//# sourceMappingURL=cua-observation-runtime.d.ts.map