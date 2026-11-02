// session 身份/资源 pin 头与 app plist 的纯文本生成。
import {
  APP_BINARY_NAME,
  APP_ICON_FILE,
  BUNDLE_ID,
  DesktopSessionBuildError,
  FIXED_DEPLOYMENT_TARGET,
} from "./cua-desktop-session-config.mjs";

function cString(value) {
  let escaped = "";
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    switch (character) {
      case "\\":
        escaped += "\\\\";
        break;
      case '"':
        escaped += '\\"';
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\t":
        escaped += "\\t";
        break;
      default:
        if (code < 0x20 || code > 0x7e) {
          throw new DesktopSessionBuildError(
            "pin-encoding",
            "pin values must stay printable ASCII",
            { value },
          );
        }
        escaped += character;
    }
  }
  return escaped;
}

const ENTRY_MACROS = {
  "host-entry.mjs": "HOST",
  "cli-entry.mjs": "CLI",
  "session-entry.mjs": "SESSION",
};

const RESOURCE_MACROS = {
  "node-repl-server.mjs": "NODE_REPL_SERVER",
  "tasks-storage-worker.mjs": "TASKS_STORAGE_WORKER",
};

export function pinsHeader({
  nodeSha256,
  entries,
  resources = [],
  identityPins,
}) {
  const lines = [
    "#pragma once",
    "// 由 cua-desktop-session builder 生成。身份 pin 复用已签名 R11 证书/DR/Node CDHash；",
    "// entry 资源 pin 来自本次实际 bundle bytes。builder 不签名。",
    `#define CUA_DESKTOP_SESSION_SELF_IDENTIFIER "${cString(BUNDLE_ID)}"`,
    `#define CUA_DESKTOP_SESSION_SELF_LEAF_SHA256 "${cString(identityPins.leafSha256)}"`,
    `#define CUA_DESKTOP_SESSION_SELF_DESIGNATED_REQUIREMENT "${cString(identityPins.designatedRequirement)}"`,
    `#define CUA_DESKTOP_SESSION_NODE_SHA256 "${cString(nodeSha256)}"`,
    `#define CUA_DESKTOP_SESSION_NODE_IDENTIFIER "${cString(identityPins.nodeIdentifier)}"`,
    `#define CUA_DESKTOP_SESSION_NODE_LEAF_SHA256 "${cString(identityPins.nodeLeafSha256)}"`,
    `#define CUA_DESKTOP_SESSION_NODE_DESIGNATED_REQUIREMENT "${cString(identityPins.nodeDesignatedRequirement)}"`,
    `#define CUA_DESKTOP_SESSION_NODE_CDHASH "${cString(identityPins.nodeCdhash)}"`,
  ];
  for (const entry of entries) {
    const suffix = ENTRY_MACROS[entry.name];
    if (!suffix) {
      throw new DesktopSessionBuildError(
        "entry-name",
        `unsupported entry ${entry.name}`,
      );
    }
    lines.push(
      `#define CUA_DESKTOP_SESSION_ENTRY_${suffix}_SHA256 "${cString(entry.sha256)}"`,
      `#define CUA_DESKTOP_SESSION_ENTRY_${suffix}_MAX_BYTES (${entry.maxBytes}u)`,
    );
  }
  for (const resource of resources) {
    const suffix = RESOURCE_MACROS[resource.name];
    if (!suffix) {
      throw new DesktopSessionBuildError(
        "resource-name",
        `unsupported resource ${resource.name}`,
      );
    }
    lines.push(
      `#define CUA_DESKTOP_SESSION_RESOURCE_${suffix}_SHA256 "${cString(resource.sha256)}"`,
      `#define CUA_DESKTOP_SESSION_RESOURCE_${suffix}_MAX_BYTES (${resource.maxBytes}u)`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function appInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${APP_BINARY_NAME}</string>
  <key>CFBundleIconFile</key><string>${APP_ICON_FILE}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Zody CUA Desktop Session</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>${FIXED_DEPLOYMENT_TARGET}</string>
</dict>
</plist>
`;
}
