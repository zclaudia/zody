/**
 * F15 图片标注编辑器组件夹具（manual-review/pending，未转正不计为正式 Desktop 通过；
 * 注册于 docs/conversation-session-case-catalog.md PA161，产品规格 docs/ui/image-preview-editor.md）。
 * 以假 receiver（registerImageComposerTarget）替代真实 Composer，断言 append 合同、
 * 自然尺寸导出与失效路径；changeScope 模拟 scope 换代释放接收方，rejectSave 模拟 admission 拒绝。
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZodyIntlProvider } from "@/i18n/IntlProvider.js";
import {
  ImageAnnotationDialog,
  registerImageComposerTarget,
} from "@/image-preview-editor/index.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") === "en-US" ? "en-US" : "zh-CN";
localStorage.setItem("zody-locale-preference", locale);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";

// 已知像素源：白底 + 居中天蓝圆。默认 320×240（导出自然尺寸断言）；
// size=huge 为 6000×5500=33M 像素，触发 32M 导出上限拒绝路径。
const svg = (width: number, height: number) =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" fill="white"/>` +
      `<circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 5}" fill="skyblue"/></svg>`,
  );
const src = params.get("size") === "huge" ? svg(6000, 5500) : svg(320, 240);

const fixture = window as unknown as {
  savedFiles: File[];
  changeScope: () => void;
  rejectSave: boolean;
};
fixture.savedFiles = [];
fixture.rejectSave = false;

function Fixture() {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState(0);
  fixture.changeScope = () => setScope((value) => value + 1);
  const withReceiver = params.get("receiver") !== "0";
  // scope 换代时先释放旧接收方再注册新的（与 useComposerAttachments 的依赖重注册同构）。
  useEffect(() => {
    if (!withReceiver) return;
    return registerImageComposerTarget({
      append: (file) => {
        if (fixture.rejectSave) return false;
        fixture.savedFiles.push(file);
        return true;
      },
    });
  }, [scope, withReceiver]);
  return (
    <ZodyIntlProvider initialLocale={locale}>
      <button onClick={() => setOpen(true)}>Open</button>
      <ImageAnnotationDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setOpen(false);
        }}
        src={src}
        filename="drawing.png"
      />
    </ZodyIntlProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
