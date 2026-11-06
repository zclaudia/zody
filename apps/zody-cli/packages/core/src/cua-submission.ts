// 显式开发入口只公开既有 authority 本身；admit/bind 仍由 authority 唯一持有。
export { CuaSubmissionAuthority } from "./runtime/cua/cua-submission-authority.js";
export type { CuaSubmissionAuthorityOptions } from "./runtime/cua/cua-submission-types.js";
