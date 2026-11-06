# gen-ui-protocol

Pure wire contracts for generated conversation UI. A reference identifies an executor-side file;
it does not grant file access. The target Host authorizes and normalizes paths. Workspace identity
and session isolate state. A state update replaces a JSON snapshot of at most 16 KiB. Only
modelContent can enter bounded, untrusted model context. No MCP plugin identity or tool permission
is implied by a generated UI reference.

Tweak messages follow the upstream registration/update/disposal and ACK lifecycle. Each registration identifies one DOM target and at most 12 typed controls; preview changes carry registrationId, targetId, callback and previousValue. The page owner accepts at most 64 live registrations. This private Gen UI method grants no generic tool access.

## Dual namespace (R50)

Rules: [plugin wire compat spec](../../../../specs/zody-rename-plugin-wire.md). Legacy `zcode/*` literals are retained byte-for-byte until the 1.0 runtime alias retirement gate; `zody/*` is canonical. Public helpers:

- `genUiMethodNames(canonical)` registers canonical and legacy method names on the same handler, which keeps the single existing owner/state path.
- `pickGenUiMethodName(capabilities, canonical)` selects exactly one name from the peer's declared `experimental` capability: canonical when `zody/gen-ui` is declared, legacy when only `zcode/gen-ui` is declared, canonical when both, `undefined` when neither. `undefined` means do not send; never retry under the other name.
- `projectGenUiContextEntries(state, tweaks)` emits `zody/genUiState` + `zcode/genUiState` and `zody/genUiTweaks` + `zcode/genUiTweaks` from one frozen snapshot; both keys reference the same object, so legacy and canonical projections cannot diverge.
- `buildGenUiExperimentalCapability()` declares both capability keys during the transition.
