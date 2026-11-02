import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface SettingsPresentationValue {
  /**
   * 手机远控设置呈现（Web Remote Control 且 `(max-width: 767px)`）。
   * 只影响设置业务组件的呈现形态，不是第二份业务状态；桌面和普通窄窗口始终为 false。
   */
  isMobile: boolean;
}

const DEFAULT_SETTINGS_PRESENTATION: SettingsPresentationValue = { isMobile: false };

const SettingsPresentationContext = createContext<SettingsPresentationValue>(
  DEFAULT_SETTINGS_PRESENTATION,
);

export function SettingsPresentationProvider({
  isMobile,
  children,
}: {
  isMobile: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ isMobile }), [isMobile]);
  return (
    <SettingsPresentationContext.Provider value={value}>
      {children}
    </SettingsPresentationContext.Provider>
  );
}

/** 设置业务组件读取手机呈现上下文；未包 Provider 时按桌面处理。 */
export function useSettingsPresentation(): SettingsPresentationValue {
  return useContext(SettingsPresentationContext);
}
