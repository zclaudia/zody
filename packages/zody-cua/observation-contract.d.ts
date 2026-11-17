export interface CuaObservationRequest {
  readonly method:
    | "list_apps"
    | "list_windows"
    | "get_app_state"
    | "commit_state"
    | "left_click"
    | "perform_action"
    | "set_value"
    | "stop_computer_control";
  readonly arguments: Record<string, unknown>;
}
export interface CuaObservationResult {
  readonly content: Array<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
}
export interface CuaObservationExpectation {
  readonly sessionId: string;
  readonly workspaceKey: string;
  readonly turnId: string;
}
