// Inspect executable bundle text and source identities separately. Source-map comments are not imports.
const MARKERS = ["@zclaudia/gateway-client", "@zclaudia/", "discoverBackends"];
export function findGatewayClientMarkers(text, sourceMap = false) {
  if (!sourceMap) return MARKERS.filter((marker) => text.includes(marker));
  const map = JSON.parse(text);
  const sources = [
    ...(map.sources ?? []),
    ...(map.sections ?? []).flatMap((section) => section.map?.sources ?? []),
  ];
  // pnpm encodes scoped package separators as '+'. Both regular and pnpm paths identify the SDK.
  return sources.some((source) => /(?:^|[/\\])@zclaudia[/+]gateway-client(?:[/\\@]|$)/.test(source))
    ? ["@zclaudia/gateway-client"]
    : [];
}
