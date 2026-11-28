import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZodyStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import type { Theme } from "@/useTheme.js";

interface ThemeHeroPalette {
  panel: string;
  meshBase: string;
  meshLight: string;
  glowPrimary: string;
  glowSecondary: string;
  heading: string;
  description: string;
}

function getThemeHeroPalette(theme: Theme): ThemeHeroPalette {
  switch (theme) {
    case "light":
    case "zai-light":
      return {
        meshBase: "#f6f5fa",
        meshLight: "#c8bfe3",
        panel:
          "bg-[linear-gradient(155deg,#f1eff8_0%,#f7f6fb_52%,#f7f3f1_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_18%,rgba(255,255,255,0.9),transparent_28%),radial-gradient(circle_at_80%_16%,rgba(168,156,212,0.2),transparent_32%),radial-gradient(circle_at_72%_86%,rgba(235,206,192,0.18),transparent_34%)]",
        glowPrimary: "bg-[#c8bfe3]/35 mix-blend-multiply",
        glowSecondary: "bg-[#ead8cf]/45 mix-blend-multiply",
        heading: "text-[#1d1b26]",
        description: "text-[#5c586d]",
      };
    case "zai-dark":
    case "dark":
    case "system":
    default:
      return {
        meshBase: "#141418",
        meshLight: "#a59dc9",
        panel:
          "bg-[linear-gradient(160deg,#16161c_0%,#131317_58%,#18171e_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_14%,rgba(255,255,255,0.06),transparent_34%),radial-gradient(circle_at_82%_84%,rgba(165,157,201,0.08),transparent_38%)]",
        glowPrimary: "bg-white/[0.04] mix-blend-screen",
        glowSecondary: "bg-[#a59dc9]/10 mix-blend-screen",
        heading: "text-[#ecebf2]",
        description: "text-[#9d9bab]",
      };
  }
}

export function useResolvedThemeHeroPalette(): ThemeHeroPalette {
  const theme = useZodyStore((state) => state.theme);
  const resolvedTheme =
    theme === "system" ? (resolveTheme(theme) === "dark" ? "dark" : "light") : theme;

  return getThemeHeroPalette(resolvedTheme);
}

export function ThemeHeroVisual(props: {
  className?: string;
  contentClassName?: string;
  children?: ReactNode;
}) {
  const palette = useResolvedThemeHeroPalette();

  return (
    <div className={cn("relative overflow-hidden", palette.panel, props.className)}>
      <div
        className={cn(
          "pointer-events-none absolute left-[-12%] top-[18%] h-[42rem] w-[42rem] rounded-full blur-3xl",
          palette.glowPrimary,
        )}
      />
      <div
        className={cn(
          "pointer-events-none absolute right-[-18%] bottom-[-14%] h-[36rem] w-[36rem] rounded-full blur-3xl",
          palette.glowSecondary,
        )}
      />
      {props.children ? (
        <div className={cn("relative z-10", props.contentClassName)}>{props.children}</div>
      ) : null}
    </div>
  );
}
