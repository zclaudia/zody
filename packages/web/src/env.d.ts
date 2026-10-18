declare module "*.css";
declare module "@zcode/ui/styles.css";

interface ImportMetaEnv {
  // 本文件手写声明了 Vite env 形状，内置 BASE_URL 也需要显式补上，
  // 手机入口构建使用 `/assets/remote/` 作为 base，需要读取它。
  readonly BASE_URL: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly VITE_ZCODE_BASE_URL?: string;
  readonly VITE_ZCODE_ENDPOINT_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
