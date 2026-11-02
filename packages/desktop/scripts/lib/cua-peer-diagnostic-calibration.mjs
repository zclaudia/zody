import { createHash } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PeerDiagnosticFailureError } from "./cua-peer-diagnostic-core.mjs";
import { runBoundedCommand, spawnCollected } from "./cua-peer-diagnostic-command.mjs";
import {
  makeWorkdir,
  parseJsonOutput,
  writeFixtureObject,
} from "./cua-peer-diagnostic-scenarios.mjs";

const CODESIGN = "/usr/bin/codesign";
const LIPO = "/usr/bin/lipo";
const OTOOL = "/usr/bin/otool";
const MECHANISM = "node-signature-lower-layer-control-not-local-self-signed-helper";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha1(buffer) {
  return createHash("sha1").update(buffer).digest("hex");
}

function parseMinos(output) {
  const values = [];
  for (const match of output.matchAll(/^\s*minos\s+([0-9]+(?:\.[0-9]+){0,2})\s*$/gm)) {
    values.push(match[1]);
  }
  return values;
}

function normalizeVersion(value) {
  const parts = value.split(".").map((part) => Number(part));
  while (parts.length > 2 && parts[parts.length - 1] === 0) {
    parts.pop();
  }
  return parts.join(".");
}

function commandDetails(result) {
  return {
    command: result.command,
    args: result.args,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    bufferOverflow: result.bufferOverflow,
    error: result.error,
    stdout: result.stdout.slice(0, 4_000),
    stderr: result.stderr.slice(0, 4_000),
  };
}

function blockedCalibration(reason, details) {
  return {
    status: "blocked",
    reason,
    details,
    mechanism: MECHANISM,
    attestsLoadedJs: false,
    scenarios: [],
  };
}

async function probeNodeStaticFacts(nodePath) {
  const architecture = await runBoundedCommand(LIPO, ["-archs", nodePath], { timeoutMs: 30_000 });
  if (architecture.exitCode !== 0 || architecture.timedOut || architecture.bufferOverflow) {
    throw new PeerDiagnosticFailureError("node lipo -archs failed", commandDetails(architecture));
  }
  const otool = await runBoundedCommand(OTOOL, ["-l", nodePath], {
    timeoutMs: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (otool.exitCode !== 0 || otool.timedOut || otool.bufferOverflow) {
    throw new PeerDiagnosticFailureError("node otool -l failed", commandDetails(otool));
  }
  const architectures = architecture.stdout.trim().split(/\s+/).filter(Boolean);
  const minos = parseMinos(otool.stdout);
  const executable = await readFile(nodePath);
  return {
    architectures,
    minimumMacOSVersion: normalizeVersion(minos[0] ?? ""),
    executableSha256: sha256(executable),
  };
}

function calibrationProfile({ leafSha256, leafSha1, staticFacts, wrongLeaf = false }) {
  return {
    schemaVersion: 1,
    kind: "zody-cua-node-signature-calibration-profile",
    calibrationOnly: true,
    identifier: "node",
    leafCertificateSha256: wrongLeaf ? "0".repeat(64) : leafSha256,
    certificateSha1: leafSha1,
    designatedRequirement: `identifier "node" and certificate leaf = H"${leafSha1}"`,
    executableSha256: staticFacts.executableSha256,
    architectures: staticFacts.architectures,
    minimumMacOSVersion: staticFacts.minimumMacOSVersion,
    entitlements: {},
  };
}

function nodeClientScript() {
  return `import net from "node:net";
const [socketPath] = process.argv.slice(2);
const request = Buffer.from(JSON.stringify({kind:"zody-cua-peer-identity-request",schemaVersion:1}));
const frame = Buffer.alloc(4 + request.length);
frame.writeUInt32BE(request.length, 0);
request.copy(frame, 4);
const deadline = Date.now() + 10000;
function attempt() {
  const socket = net.connect(socketPath);
  let data = Buffer.alloc(0);
  socket.on("connect", () => socket.write(frame));
  socket.on("data", (chunk) => {
    data = Buffer.concat([data, chunk]);
    if (data.length >= 4) {
      const length = data.readUInt32BE(0);
      if (data.length >= 4 + length) {
        console.log(JSON.stringify({role:"node-client",status:"connected",responseBytes:length}));
        socket.end();
        process.exit(0);
      }
    }
  });
  socket.on("error", () => {
    if (Date.now() < deadline) setTimeout(attempt, 20);
    else process.exit(1);
  });
}
attempt();
`;
}

async function runCalibrationServe({ binary, workdir, profilePath, nodePid, nodeUid }) {
  const result = await runBoundedCommand(
    binary,
    [
      "serve",
      "--workdir",
      workdir,
      "--calibration-profile",
      profilePath,
      "--expect-pid",
      String(nodePid),
      "--expect-uid",
      String(nodeUid),
      "--timeout-ms",
      "10000",
    ],
    { timeoutMs: 15_000, maxBuffer: 64 * 1024 },
  );
  return { result, response: parseJsonOutput(result, "calibration serve") };
}

async function runCalibrationPair({ binary, workdir, profilePath, clientScript, nodePath }) {
  const socketPath = join(workdir, "peer.sock");
  const client = spawnCollected(nodePath, [clientScript, socketPath], {
    timeoutMs: 20_000,
    maxBuffer: 64 * 1024,
  });
  const server = await runCalibrationServe({
    binary,
    workdir,
    profilePath,
    nodePid: client.pid,
    nodeUid: process.geteuid(),
  });
  const clientResult = await client.result;
  if (clientResult.exitCode !== 0 || server.result.exitCode !== 0) {
    throw new PeerDiagnosticFailureError("calibration pair failed", {
      client: commandDetails(clientResult),
      server: commandDetails(server.result),
      serverResponse: server.response,
    });
  }
  return { response: server.response, nodePid: client.pid, nodeUid: process.geteuid() };
}

export async function runCalibrationControl({ binary }) {
  const nodePath = process.execPath;
  const verify = await runBoundedCommand(CODESIGN, ["--verify", "--strict", nodePath], {
    timeoutMs: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const codesignVerify = {
    status: verify.exitCode === 0 && !verify.timedOut && !verify.bufferOverflow ? "pass" : "failed",
    ...commandDetails(verify),
  };
  if (verify.error) {
    return blockedCalibration("node-codesign-verify-spawn-failed", codesignVerify);
  }

  const workdir = await makeWorkdir("zody-cua-peer-r10-node-");
  try {
    const certPrefix = join(workdir, "cert");
    // 本机 codesign 要求带值长选项使用 = 形式；用空格会被当成额外路径操作数。
    // -d 只显示签名并导出公开证书，不执行任何签名动作。
    const extract = await runBoundedCommand(
      CODESIGN,
      ["-d", `--extract-certificates=${certPrefix}`, nodePath],
      { timeoutMs: 120_000, maxBuffer: 2 * 1024 * 1024 },
    );
    if (extract.exitCode !== 0 || extract.timedOut || extract.bufferOverflow) {
      return blockedCalibration("node-certificate-extraction-failed", {
        codesignVerify,
        extraction: commandDetails(extract),
      });
    }
    let leafDer;
    try {
      leafDer = await readFile(`${certPrefix}0`);
    } catch (error) {
      return blockedCalibration("node-leaf-certificate-missing", {
        codesignVerify,
        extraction: commandDetails(extract),
        error: error.message,
        certPrefix,
      });
    }
    const leafSha256 = sha256(leafDer);
    const leafSha1 = sha1(leafDer);
    const staticFacts = await probeNodeStaticFacts(nodePath);

    const positiveProfile = await writeFixtureObject(
      workdir,
      "calibration.synthetic.json",
      calibrationProfile({ leafSha256, leafSha1, staticFacts }),
    );
    const negativeProfile = await writeFixtureObject(
      workdir,
      "calibration.wrong-leaf.json",
      calibrationProfile({ leafSha256, leafSha1, staticFacts, wrongLeaf: true }),
    );
    const clientScript = join(workdir, "node-client.mjs");
    await writeFile(clientScript, nodeClientScript(), { encoding: "utf8", mode: 0o600 });
    await chmod(clientScript, 0o600);

    const positive = await runCalibrationPair({
      binary,
      workdir,
      profilePath: positiveProfile,
      clientScript,
      nodePath,
    });
    const negative = await runCalibrationPair({
      binary,
      workdir,
      profilePath: negativeProfile,
      clientScript,
      nodePath,
    });

    const lowerLayerPositive =
      positive.response.calibrationOnly === true &&
      positive.response.lowerLayerSecurityControl?.guestCreated === true &&
      positive.response.lowerLayerSecurityControl?.codeValid === true &&
      positive.response.lowerLayerSecurityControl?.leafRequirementMatched === true &&
      positive.response.lowerLayerSecurityControl?.leafSha256Matched === true;
    const positiveRejected = positive.response.decision?.accepted === false;
    const negativeRejected =
      negative.response.decision?.accepted === false &&
      negative.response.decision?.reason === "leaf-sha256-mismatch";
    const helperPolicyRejected =
      positive.response.strictLocalSelfSignedDr?.storedStrictlyMatched === false ||
      positive.response.decision?.reason === "calibration-control-only";

    const scenarios = [
      {
        id: "node-signature-lower-layer-positive",
        kind: "calibration-only-real-security",
        status: lowerLayerPositive && positiveRejected && helperPolicyRejected ? "pass" : "blocked",
        diagnostics: {
          lowerLayerPositive,
          positiveRejected,
          helperPolicyRejected,
          decision: positive.response.decision ?? null,
          strictLocalSelfSignedDr: positive.response.strictLocalSelfSignedDr ?? null,
        },
        expected: { pid: positive.nodePid, uid: positive.nodeUid },
        response: positive.response,
        leafSha256,
        leafSha1,
      },
      {
        id: "node-signature-wrong-pin-negative",
        kind: "calibration-only-real-security",
        status: negativeRejected ? "pass" : "blocked",
        diagnostics: {
          negativeRejected,
          decision: negative.response.decision ?? null,
        },
        expected: { pid: negative.nodePid, uid: negative.nodeUid },
        response: negative.response,
        wrongLeafSha256: "0".repeat(64),
      },
    ];
    const status = scenarios.every((scenario) => scenario.status === "pass") ? "pass" : "blocked";
    return {
      status,
      reason: status === "pass" ? null : "calibration-scenario-not-passed",
      nodePath,
      nodeExecutableSha256: staticFacts.executableSha256,
      leafCertificateSha256: leafSha256,
      leafCertificateSha1: leafSha1,
      codesignVerify,
      mechanism: MECHANISM,
      attestsLoadedJs: false,
      scenarios,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
