import type { ReactNode } from "react";
import { zodyLogoUrl } from "@/brand.js";
import { cn } from "@/components/lib/utils.js";
import "./rootStartupLogo.css";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <ZodyStartupLogoBadge />
      {children}
    </div>
  );
}

/** 初始化与引导共用应用图标。图标文件自带圆角底板，不再套旧的深色 Z 标壳。 */
export function ZodyStartupLogoBadge({ animated = true }: { animated?: boolean }) {
  return <ZodyStartupLogo className="size-24" animated={animated} />;
}

export function ZodyStartupLogo({
  className,
  animated = true,
}: {
  className?: string;
  animated?: boolean;
}) {
  return (
    <img
      src={zodyLogoUrl}
      alt=""
      width={96}
      height={96}
      className={cn("shrink-0", className, animated && "zcode-startup-logo-breathe")}
    />
  );
}
