import { type KeyObject } from "node:crypto";
import { Duplex } from "node:stream";
import type { ControlChannelAckResult, ControlChannelRequest } from "@zody/zody-cua/control-channel";
import type { ControlBinding } from "@zody/zody-cua/control-protocol";
import type { ProducerControlOwner } from "@zody/zody-cua/producer-control";
export declare const ZODY_NODE_REPL_CONTROL_FLAG = "--zody-node-repl-control";
export declare const CONTROL_ONLY_BOOTSTRAP_MAX_BYTES: number;
export type ControlOnlyErrorCode = "invalid_arguments" | "bootstrap_fd_unavailable" | "bootstrap_invalid" | "control_fd_unavailable" | "ready_write_failed" | "channel_failed";
export declare class ControlOnlyEntryError extends Error {
    readonly code: ControlOnlyErrorCode;
    constructor(code: ControlOnlyErrorCode, message: string, options?: {
        cause?: unknown;
    });
}
export interface ControlOnlyChildOptions {
    readonly argv?: readonly string[];
    readonly bootstrapFd?: number;
    readonly readyFd?: number;
    readonly controlReadFd?: number;
    readonly controlWriteFd?: number;
    readonly createOwner?: () => ProducerControlOwner;
    readonly onRequest?: (request: ControlChannelRequest) => ControlChannelAckResult | Promise<ControlChannelAckResult>;
    readonly onClosed?: (event: import("@zody/zody-cua/control-channel").ControlChannelClosedEvent) => void | Promise<void>;
    readonly writeStderr?: (text: string) => void;
}
export interface ValidatedBootstrap {
    readonly binding: ControlBinding;
    readonly challenge: string;
    readonly controllerKeyId: string;
    readonly controllerPublicKey: KeyObject;
    readonly producerKeyId: string;
    readonly producerPrivateKey: KeyObject;
}
export declare function isControlOnlyInvocation(argv: readonly string[]): boolean;
export declare function hasExactControlArguments(argv: readonly string[]): boolean;
export declare function parseBootstrap(raw: string): ValidatedBootstrap;
export declare function readBootstrapLine(fd: number): Promise<string>;
export declare function startupProof(challenge: string, binding: ControlBinding, producerPid: number): string;
export declare function writeReady(fd: number, material: ValidatedBootstrap): Promise<void>;
export declare function createControlDuplex(readFdNumber: number, writeFdNumber: number): Promise<Duplex>;
export declare function writeFailure(writeStderr: (text: string) => void, code: string): void;
//# sourceMappingURL=control-only-protocol.d.ts.map