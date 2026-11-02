import { DOCTOR_KIND, DOCTOR_SCHEMA_VERSION } from "./cua-helper-local-doctor.mjs";
import { formatHumanResult, runDoctor } from "./cua-helper-local-result.mjs";

export const USAGE = `Usage:
  node scripts/doctor-macos-cua-helper-local.mjs --app /absolute/path/to/Helper.app \\
    --profile /absolute/path/to/profile.json [--json]

Read-only local-self-signed macOS CUA Helper artifact doctor.
It does not launch the Helper, use the Keychain/TCC/spctl/stapler, or create certificates.

Exit codes:
  0  pass
  1  fail
  2  blocked or invalid arguments
`;

function takeValue(argv, index, flag) {
  const argument = argv[index];
  if (argument.startsWith(`${flag}=`)) {
    const value = argument.slice(flag.length + 1);
    return value.length > 0
      ? { ok: true, value, next: index }
      : { ok: false, error: `${flag} requires a value` };
  }
  if (index + 1 >= argv.length) {
    return { ok: false, error: `${flag} requires a value` };
  }
  const value = argv[index + 1];
  if (value.startsWith("--")) {
    return { ok: false, error: `${flag} requires a value` };
  }
  return { ok: true, value, next: index + 1 };
}

export function parseCliArgs(argv) {
  let app = null;
  let profile = null;
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--json") {
      if (json) {
        return { ok: false, error: "--json specified more than once", json: true };
      }
      json = true;
      continue;
    }
    if (argument === "--app" || argument.startsWith("--app=")) {
      if (app !== null) {
        return { ok: false, error: "--app specified more than once", json };
      }
      const parsed = takeValue(argv, index, "--app");
      if (!parsed.ok) {
        return { ...parsed, json };
      }
      app = parsed.value;
      index = parsed.next;
      continue;
    }
    if (argument === "--profile" || argument.startsWith("--profile=")) {
      if (profile !== null) {
        return { ok: false, error: "--profile specified more than once", json };
      }
      const parsed = takeValue(argv, index, "--profile");
      if (!parsed.ok) {
        return { ...parsed, json };
      }
      profile = parsed.value;
      index = parsed.next;
      continue;
    }
    if (argument.startsWith("-")) {
      return { ok: false, error: `unknown option ${argument}`, json };
    }
    return { ok: false, error: `unexpected positional argument ${argument}`, json };
  }

  if (help) {
    return { ok: true, help: true, json, app, profile };
  }
  if (!app) {
    return { ok: false, error: "--app is required", json };
  }
  if (!profile) {
    return { ok: false, error: "--profile is required", json };
  }
  return { ok: true, app, profile, json };
}

function writeResult(stream, result, json) {
  stream.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${formatHumanResult(result)}\n`);
}

function argumentFailure(error) {
  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    kind: DOCTOR_KIND,
    status: "fail",
    appPath: null,
    profilePath: null,
    profile: "local-self-signed",
    checks: [{ id: "input.arguments", status: "fail", message: error }],
    summary: { pass: 0, fail: 1, blocked: 0 },
  };
}

export async function runCli(argv, { stdout = process.stdout, adapter, platform } = {}) {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    writeResult(stdout, argumentFailure(parsed.error), parsed.json === true);
    return 1;
  }
  if (parsed.help) {
    stdout.write(USAGE);
    return 0;
  }
  const result = await runDoctor({
    appPath: parsed.app,
    profilePath: parsed.profile,
    adapter,
    platform,
  });
  writeResult(stdout, result, parsed.json);
  if (result.status === "pass") {
    return 0;
  }
  return result.status === "fail" ? 1 : 2;
}
