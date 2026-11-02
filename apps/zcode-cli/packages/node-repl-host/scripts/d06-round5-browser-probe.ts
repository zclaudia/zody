import { pathToFileURL } from "node:url";
import type { D06Round5Observation } from "./d06-round5-policy.js";
import {
  CELL_CLASSIFY,
  asBoolean,
  asRecord,
  deltaStats,
  extractData,
  stageOf,
  type D06Round5ProbeContext,
} from "./d06-round5-probe-common.js";
import { sha256File } from "./d06-round5-resources.js";
import { runProbeCell } from "./d06-probe-runtime.js";

export async function runBrowserProbe(
  context: D06Round5ProbeContext,
  asset: {
    clientPath: string;
    docsDir: string;
    apiPath: string;
    readmePath: string;
    clientSha256: string;
    docsSha256: string;
    readmeSha256: string;
  },
): Promise<D06Round5Observation> {
  const before = { ...context.stats };
  const clientBefore = await sha256File(asset.clientPath);
  const docsBefore = await sha256File(asset.apiPath);
  const readmeBefore = await sha256File(asset.readmePath);
  const observed = await runProbeCell(
    context.seatbeltExecutor,
    browserCellCode(asset.clientPath, asset.docsDir, asset.apiPath, asset.readmePath),
    30_000,
  );
  const data = extractData(observed.raw);
  const clientAfter = await sha256File(asset.clientPath);
  const docsAfter = await sha256File(asset.apiPath);
  const readmeAfter = await sha256File(asset.readmePath);
  const write = asRecord(data.write);
  return {
    outcome: observed.outcome === "blocked" ? "blocked" : observed.outcome,
    stage: stageOf(observed),
    checks: {
      "browser client built through public export": asset.clientSha256 === clientBefore.sha256,
      "real docs copied with source hashes":
        asset.docsSha256 === docsBefore.sha256 &&
        asset.readmeSha256 === readmeBefore.sha256 &&
        data.documentationRoot === asset.docsDir &&
        typeof data.documentation === "string" &&
        data.documentation.includes("Built-in Browser Automation API"),
      "client loaded in built cell": data.loaded === true,
      "setupBrowserRuntime executed": data.setup === true,
      "list returned zero synthetic browsers":
        Array.isArray(data.browsers) && data.browsers.length === 0,
      "broker token matched": context.stats.browserTokenMatches - before.browserTokenMatches === 1,
      "broker request schema valid":
        context.stats.browserSchemaValid - before.browserSchemaValid === 1,
      "broker list count delta one":
        context.stats.browserValidRequests - before.browserValidRequests === 1,
      "client write denied": asBoolean(write.client),
      "docs write denied": asBoolean(write.docs),
      "readme write denied": asBoolean(write.readme),
      "client hash unchanged": clientBefore.sha256 === clientAfter.sha256,
      "docs hash unchanged": docsBefore.sha256 === docsAfter.sha256,
      "readme hash unchanged": readmeBefore.sha256 === readmeAfter.sha256,
    },
    raw: {
      data,
      stats: deltaStats(before, context.stats),
      hashes: {
        client: { before: clientBefore.sha256, after: clientAfter.sha256 },
        docs: { before: docsBefore.sha256, after: docsAfter.sha256 },
        readme: { before: readmeBefore.sha256, after: readmeAfter.sha256 },
      },
    },
  };
}

function browserCellCode(
  clientPath: string,
  docsDir: string,
  apiPath: string,
  readmePath: string,
): string {
  return [
    CELL_CLASSIFY,
    "const fs = require('node:fs');",
    `const client = await import(${JSON.stringify(pathToFileURL(clientPath).href)});`,
    "await client.setupBrowserRuntime({ globals: globalThis });",
    "const bridge = globalThis[Symbol.for('zcode.node-repl.browser-control-bridge')];",
    "const browsers = await globalThis.agent.browsers.list();",
    "const documentation = await globalThis.agent.documentation.get('overview');",
    `const write = {}; for (const [name, path] of Object.entries({ client: ${JSON.stringify(clientPath)}, docs: ${JSON.stringify(apiPath)}, readme: ${JSON.stringify(readmePath)} })) { try { fs.writeFileSync(path, 'tampered'); write[name] = false; } catch (error) { write[name] = error.code === 'EPERM' || error.code === 'EACCES' || error.cause?.code === 'EPERM' || error.cause?.code === 'EACCES'; } }`,
    'return { outcome: "allowed", stage: "listed", data: { loaded: true, setup: true, browsers, documentationRoot: bridge?.documentationRoot, documentation, write } };',
  ].join("\n");
}
