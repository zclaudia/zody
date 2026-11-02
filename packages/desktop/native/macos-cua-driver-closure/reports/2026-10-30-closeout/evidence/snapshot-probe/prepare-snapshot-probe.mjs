import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { build } from 'esbuild';
import { bundleEntry, loadUnsupportedNativeModules } from '../../packages/desktop/scripts/lib/cua-desktop-session-bundle.mjs';
import { UNSUPPORTED_NATIVE_PINS } from '../../packages/desktop/scripts/lib/cua-desktop-session-config.mjs';
const root = new URL('./snapshot-probe/', import.meta.url).pathname;
await mkdir(root, {recursive:true});
const unsupportedModules = await loadUnsupportedNativeModules(UNSUPPORTED_NATIVE_PINS);
await bundleEntry({entry:'apps/zcode-cli/packages/node-repl-host/src/server.ts',output:root+'server.mjs',metafilePath:root+'server.metafile.json',unsupportedModules});
const oldRoot=root+'opening-src/';
await cp('apps/zcode-cli/packages/node-repl-host/src',oldRoot,{recursive:true});
for(const name of ['subprocess-executor.ts','subprocess-launch.ts','cell-child-transport.ts']){
 await writeFile(oldRoot+name,await readFile('output/cua-phase1-closeout/preimages/apps/zcode-cli/packages/node-repl-host/src/'+name));
}
await build({entryPoints:['output/cua-phase1-closeout/snapshot-probe-entry.ts'],outfile:root+'probe.mjs',nodePaths:[new URL('../../apps/zcode-cli/packages/node-repl-host/node_modules/',import.meta.url).pathname],bundle:true,format:'esm',platform:'node',target:'node24',banner:{js:'import {createRequire as __probeRequire} from "node:module"; const require=__probeRequire(import.meta.url);'}});
console.log(JSON.stringify({root,server:root+'server.mjs',probe:root+'probe.mjs'}));
