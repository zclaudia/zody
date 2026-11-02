// stop-worker staticlib 的架构、部署目标与导出符号校验。
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { FIXED_ARCH } from "./cua-desktop-session-config.mjs";
import { run } from "./cua-desktop-session-toolchain.mjs";
import { stopBuildError } from "./cua-desktop-stop-visual-errors.mjs";

export async function verifyStaticlib(paths, profile, baseline) {
  const lipo = await run("/usr/bin/lipo", ["-archs", paths.staticlib]);
  if (lipo.code !== 0 || lipo.stdout.trim() !== FIXED_ARCH) {
    throw stopBuildError("architecture", "staticlib is not arm64", lipo);
  }
  const extractRoot = join(paths.buildRoot, "ar-extract");
  await rm(extractRoot, { recursive: true, force: true });
  await mkdir(extractRoot, { recursive: true, mode: 0o700 });
  const extract = await run("/usr/bin/ar", ["-x", paths.staticlib], {
    cwd: extractRoot,
  });
  if (extract.code !== 0) {
    throw stopBuildError(
      "ar-extract",
      "failed to extract staticlib members",
      extract,
    );
  }
  const objects = (await readdir(extractRoot)).filter((name) =>
    name.endsWith(".o"),
  );
  if (!objects.includes("CuaVisualCapture.o")) {
    throw stopBuildError(
      "swift-object",
      "staticlib is missing CuaVisualCapture.o",
      {
        objects,
      },
    );
  }
  let maxMinos = 0;
  const overTarget = [];
  for (const object of objects) {
    const otool = await run("/usr/bin/otool", [
      "-l",
      join(extractRoot, object),
    ]);
    for (const match of otool.stdout.matchAll(/^\s*minos\s+([0-9.]+)\s*$/gm)) {
      const value = Number(match[1]);
      if (value > maxMinos) maxMinos = value;
      if (value > 14.2) overTarget.push({ object, minos: match[1] });
    }
  }
  if (overTarget.length > 0) {
    throw stopBuildError("deployment-target", "staticlib member exceeds 14.2", {
      overTarget,
    });
  }
  const swiftOtool = await run("/usr/bin/otool", [
    "-l",
    join(extractRoot, "CuaVisualCapture.o"),
  ]);
  const swiftMinos = [
    ...swiftOtool.stdout.matchAll(/^\s*minos\s+([0-9.]+)\s*$/gm),
  ].map((match) => match[1]);
  if (swiftMinos.length === 0 || swiftMinos.some((value) => value !== "14.2")) {
    throw stopBuildError("swift-minos", "Swift bridge object is not 14.2", {
      swiftMinos,
    });
  }

  const crateObjects = objects.filter(
    (name) => name.startsWith("cua_macos_visual-") && name.endsWith(".o"),
  );
  let symbolOutput = "";
  for (const object of crateObjects) {
    const nm = await run("/usr/bin/nm", ["-gU", join(extractRoot, object)]);
    symbolOutput += nm.stdout;
  }
  const required = [
    "_cua_r11_visual_start",
    "_cua_r11_visual_wait",
    "_cua_r11_visual_take_png",
    "_cua_r11_visual_cancel",
    "_cua_r11_visual_callback_resources_released",
    "_cua_r11_visual_destroy",
    "_cua_r11_visual_free_png",
  ];
  for (const symbol of required) {
    if (!symbolOutput.includes(symbol)) {
      throw stopBuildError("symbol-missing", `staticlib is missing ${symbol}`, {
        symbol,
      });
    }
  }
  const gateSymbol = "_cua_r11_visual_wait_diagnostic_gate";
  const gatePresent = symbolOutput.includes(gateSymbol);
  if (profile.gateEnabled && !gatePresent) {
    throw stopBuildError(
      "gate-symbol-missing",
      "diagnostic staticlib lacks the gate symbol",
      {
        gateSymbol,
      },
    );
  }
  if (!profile.gateEnabled && gatePresent) {
    throw stopBuildError(
      "gate-symbol-leak",
      "production staticlib unexpectedly exports the gate",
      {
        gateSymbol,
      },
    );
  }
  return {
    objects: objects.length,
    maxMemberMinOS: maxMinos.toFixed(1),
    swiftMinos,
    requiredSymbols: required,
    gateSymbolPresent: gatePresent,
    sourceToolchain: baseline.toolchain,
  };
}
