import assert from "node:assert/strict";
import test from "node:test";
import { findGatewayClientMarkers } from "../mobile-web-bundle-inspection.mjs";

test("source-map documentation is not an SDK import", () => {
  assert.deepEqual(
    findGatewayClientMarkers(
      JSON.stringify({
        sources: ["../shared/src/remoteAccess.ts"],
        sourcesContent: ["/** discoverBackends from @zclaudia/gateway-client */"],
      }),
      true,
    ),
    [],
  );
});
test("SDK sources remain forbidden including pnpm paths", () => {
  for (const path of [
    "../../node_modules/@zclaudia/gateway-client/dist/index.js",
    "../../node_modules/.pnpm/@zclaudia+gateway-client@0.3.0/node_modules/pkg/index.js",
  ]) {
    assert.deepEqual(findGatewayClientMarkers(JSON.stringify({ sources: [path] }), true), [
      "@zclaudia/gateway-client",
    ]);
  }
});
test("actual SDK identifiers in generated JavaScript are still detected", () => {
  assert.deepEqual(findGatewayClientMarkers("function discoverBackends() {}"), [
    "discoverBackends",
  ]);
});
