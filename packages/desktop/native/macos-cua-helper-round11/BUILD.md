# Round11 Helper final build

Unsigned build entry point:

```sh
node --input-type=module -e "import { buildRound11Helper } from './packages/desktop/scripts/lib/cua-helper-round11-final-build.mjs'; await buildRound11Helper({ outputRoot: 'output/cua-helper-round11/worker-final' });"
```

`buildRound11Helper({ outputRoot, visualRoot, nodePath, identityPins })` uses the fixed SDK `macosx27.0`, arm64, deployment target `14.2`, and a prebuilt `libcua_macos_visual_round11.a` from `visualRoot`. It refreshes `@zody/core` through the public `./cua-submission` export, copies Node 24.14.0 and its LICENSE, bundles the authority entry, builds the Helper and lease test, and writes `build/build-manifest.json`.

`identityPins` accepts `leafSha256`, `designatedRequirement`, `nodeIdentifier`, `nodeLeafSha256`, `nodeDesignatedRequirement`, and `nodeCdhash`. All identity pins default to empty strings, so an unapproved build remains fail-closed. Resource pins are always computed from the copied/packed bytes.

This entry point does not sign, install certificates, change Keychain/TCC state, capture a screen, or launch the app. Signing remains a separate approved step.
