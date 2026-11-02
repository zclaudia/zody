/**
 * Backend-neutral CDP trusted input。
 *
 * locator click/press 在 IAB 与 extension backend 上必须使用同一套 CDP Input 语义；
 * 坐标只来自 Playwright injected runtime，不来自截图像素。
 */
import type { BrowserKeyModifier, BrowserMouseButton } from "@zody/shared";
import type { PlaywrightPage, PlaywrightPointer } from "./types.js";

const MODIFIER_BITS: Record<BrowserKeyModifier, number> = {
  Alt: 1,
  Control: 2,
  ControlOrMeta: process.platform === "darwin" ? 4 : 2,
  Meta: 4,
  Shift: 8,
};

const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
};

const MODIFIER_KEY_MAP: Record<
  BrowserKeyModifier,
  { code: string; windowsVirtualKeyCode: number }
> = {
  Alt: { code: "AltLeft", windowsVirtualKeyCode: 18 },
  Control: { code: "ControlLeft", windowsVirtualKeyCode: 17 },
  ControlOrMeta:
    process.platform === "darwin"
      ? { code: "MetaLeft", windowsVirtualKeyCode: 91 }
      : { code: "ControlLeft", windowsVirtualKeyCode: 17 },
  Meta: { code: "MetaLeft", windowsVirtualKeyCode: 91 },
  Shift: { code: "ShiftLeft", windowsVirtualKeyCode: 16 },
};

function normalizeCuaKey(raw: string): string {
  const key = raw.trim();
  const alias: Record<string, string> = {
    alt: "Alt",
    option: "Alt",
    control: "Control",
    ctrl: "Control",
    controlormeta: process.platform === "darwin" ? "Meta" : "Control",
    cmd: "Meta",
    meta: "Meta",
    super: "Meta",
    win: "Meta",
    shift: "Shift",
    esc: "Escape",
    return: "Enter",
    space: "Space",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
  };
  return alias[key.toLowerCase()] ?? key;
}

function asModifier(key: string): BrowserKeyModifier | undefined {
  return ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(key)
    ? (key as BrowserKeyModifier)
    : undefined;
}

function keyDefinition(keyName: string): {
  key: string;
  code?: string;
  windowsVirtualKeyCode?: number;
} {
  const known = KEY_MAP[keyName];
  if (known) return known;
  const modifier = asModifier(keyName);
  if (modifier) return { key: modifier, ...MODIFIER_KEY_MAP[modifier] };
  if (/^[a-z]$/iu.test(keyName)) {
    const upper = keyName.toUpperCase();
    return { key: keyName, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/u.test(keyName)) {
    return {
      key: keyName,
      code: `Digit${keyName}`,
      windowsVirtualKeyCode: keyName.charCodeAt(0),
    };
  }
  return { key: keyName };
}

/** 组合键输入：逐键按下组合键，末键 down/up 后逆序释放其余按键。 */
export async function dispatchKeyPressOnPage(
  page: PlaywrightPage,
  keys: readonly string[],
): Promise<void> {
  const normalized = keys
    .flatMap((key) => key.split("+"))
    .filter(Boolean)
    .map(normalizeCuaKey);
  const last = normalized.at(-1);
  if (!last) throw new Error("keypress requires at least one key");
  const held = normalized.slice(0, -1);
  const pressedModifiers = new Set<BrowserKeyModifier>();

  const dispatch = async (type: "keyDown" | "keyUp", keyName: string): Promise<void> => {
    const modifier = asModifier(keyName);
    if (type === "keyDown" && modifier) pressedModifiers.add(modifier);
    if (type === "keyUp" && modifier) pressedModifiers.delete(modifier);
    const definition = keyDefinition(keyName);
    const modifiers = modifiersBitmask([...pressedModifiers]);
    await page.send("Input.dispatchKeyEvent", {
      type,
      ...definition,
      ...(modifiers > 0 ? { modifiers } : {}),
    });
  };

  for (const key of held) await dispatch("keyDown", key);
  await dispatch("keyDown", last);
  await dispatch("keyUp", last);
  for (const key of held.toReversed()) await dispatch("keyUp", key);
}

export function modifiersBitmask(
  mods?: readonly BrowserKeyModifier[],
  platform: NodeJS.Platform = process.platform,
): number {
  if (!mods || mods.length === 0) return 0;
  let bits = 0;
  for (const modifier of mods) {
    const bitsForModifier =
      modifier === "ControlOrMeta" ? (platform === "darwin" ? 4 : 2) : MODIFIER_BITS[modifier];
    bits |= bitsForModifier;
  }
  return bits;
}

/** 在给定坐标发一次 CDP 真实鼠标点击（mouseMoved→mousePressed→mouseReleased）。 */
export async function dispatchClickAtOnPage(
  page: PlaywrightPage,
  center: PlaywrightPointer,
  button: BrowserMouseButton,
  doubleClick: boolean,
  modifiers = 0,
): Promise<void> {
  const clickCount = doubleClick ? 2 : 1;
  const mod = modifiers > 0 ? { modifiers } : {};
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: center.x,
    y: center.y,
    ...mod,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: center.x,
    y: center.y,
    button,
    clickCount,
    ...mod,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: center.x,
    y: center.y,
    button,
    clickCount,
    ...mod,
  });
}

/** 发一次按键（keyDown + keyUp）；已知键带完整映射，未知键裸传 key。 */
export async function dispatchKeyOnPage(
  page: PlaywrightPage,
  keyName: string,
  modifiers = 0,
  sessionId?: string,
): Promise<void> {
  const definition = KEY_MAP[keyName];
  const base = definition
    ? {
        key: definition.key,
        code: definition.code,
        windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      }
    : { key: keyName };
  const mod = modifiers > 0 ? { modifiers } : {};
  // 保留 IAB 既有调用形状：主页面 sessionId 缺省时只传两个参数，避免给测试/适配器
  // 注入一个无意义的 undefined 第三参数。
  const sendKey = (type: "keyDown" | "keyUp") =>
    sessionId == null
      ? page.send("Input.dispatchKeyEvent", { type, ...base, ...mod })
      : page.send("Input.dispatchKeyEvent", { type, ...base, ...mod }, sessionId);
  await sendKey("keyDown");
  await sendKey("keyUp");
}
