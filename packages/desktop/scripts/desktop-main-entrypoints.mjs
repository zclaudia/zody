// main 进程入口与 worker 入口必须由普通 tsup 构建和独立 UI 候选构建共用，
// 避免候选产物只包含 main/index.js 而遗漏运行时懒加载的 worker 文件。
export const DESKTOP_MAIN_ENTRYPOINTS = Object.freeze({
  "main/index": "src/main/index.ts",
  "main/browserWebmRecorder": "src/main/browserView/electronBrowserWebmRecorder.ts",
  "main/zcodeDataSizeWorker": "src/main/zcodeDataSizeWorker.ts",
  "main/storageScanWorker": "src/main/storageScanWorker.ts",
});
