import { resolve } from "node:path";
import { nodeTargetForDistribution } from "./targets.mjs";

export function seaBuildSteps({ cliRoot, target, nodeExecutable }) {
  return [
    {
      command: "pnpm",
      args: ["--filter", "@zcode/browser-use-plugin...", "build"],
    },
    {
      command: nodeExecutable,
      args: [
        resolve(cliRoot, "scripts/build-sea.mjs"),
        "--target",
        nodeTargetForDistribution(target),
      ],
    },
  ];
}
