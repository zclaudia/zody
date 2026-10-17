/**
 * LoginApiKeyForm —— 首启 BYOK（自带 API Key）provider 配置表单。
 *
 * fork（F4.1b）：官方账号入口摘除后，WelcomeScreen 只承载 BYOK 引导。provider 选择
 * 不再限于两个 OAuth 家族，而是列出 Host 下发的全部 API Key 模板
 * （各内置/自定义 provider 模板），也不再写 providerFamilyDomain。
 */
import { useMemo, useState } from "react";
import { resolveProviderTemplateName } from "@zcode/provider";
import {
  TID_LOGIN_API_KEY_CONTINUE_BUTTON,
  TID_LOGIN_API_KEY_ERROR,
  TID_LOGIN_API_KEY_INPUT,
  TID_LOGIN_API_KEY_PROVIDER_ITEM,
  TID_LOGIN_API_KEY_PROVIDER_TRIGGER,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
  testId,
} from "@zcode/shared";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildLoginApiKeyDefaultModelPreferenceFromSelection,
  shouldShowLoginApiKeyLink,
} from "@/login/LoginApiKeyForm.helpers.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

interface LoginApiKeyFormProps {
  onSaved: () => void | Promise<void>;
  onSkipped: () => void | Promise<void>;
}

export function LoginApiKeyForm({ onSaved, onSkipped }: LoginApiKeyFormProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const { modelSelectionService, providerSettingsService } = useServices();
  const markApiKeyLoginSuccess = useZCodeStore((state) => state.markApiKeyLoginSuccess);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;

  // fork（F4.1b）：通用模板列表——只列纯 API Key（type === "api-key"）模板，
  // 不含 zhipu-coding-plan-api-key（官方套餐 Key，随账号体系下线），不硬编码 zai/bigmodel。
  const apiKeyTemplates = useMemo(
    () =>
      (providerSettingsView?.providerTemplates ?? []).filter(
        (template) => template.config.access?.type === "api-key",
      ),
    [providerSettingsView],
  );
  const selectedTemplate =
    apiKeyTemplates.find((template) => template.templateId === selectedTemplateId) ?? null;
  const selectedAccess =
    selectedTemplate && selectedTemplate.config.access?.type === "api-key"
      ? selectedTemplate.config.access
      : null;
  const apiKeyUrl = selectedAccess?.apiKeyManagementUrl;
  // 用户已经输入或回填 API Key 后，右侧获取入口会挤占密码输入区域。
  const showApiKeyLink = shouldShowLoginApiKeyLink(apiKeyValue, apiKeyUrl);

  const saveApiKeyProvider = async () => {
    const apiKey = apiKeyValue.trim();
    if (!selectedTemplate || !selectedAccess) {
      // 「继续」按钮在未选模板时已禁用；此分支兜底异常时序，复用既有缺失提示文案。
      setError(intl.formatMessage({ id: "login.apiKey.providerMissingError" }, { provider: "" }));
      return;
    }
    if (!apiKey) {
      setError(intl.formatMessage({ id: "login.apiKey.emptyError" }));
      return;
    }

    setSaving(true);
    setError(null);
    const templateId = selectedTemplate.templateId;
    try {
      // fork（F4.1b）：保存前按模板 id 直读 Host 事实源，避免视图快照滞后导致
      // 用旧 access 类型创建 provider。
      const template = (await providerSettingsService.getView()).providerTemplates.find(
        (item) => item.templateId === templateId,
      );
      if (!template || template.config.access?.type !== "api-key") {
        setError(
          intl.formatMessage(
            { id: "login.apiKey.providerMissingError" },
            { provider: templateId },
          ),
        );
        return;
      }

      const created = await providerSettingsService.createPersonalProvider({
        templateId,
        initialConfig: { access: { type: template.config.access.type, apiKey } },
      });
      const defaultModelPreference = buildLoginApiKeyDefaultModelPreferenceFromSelection(
        await modelSelectionService.getView(),
        created.providerId,
      );
      markApiKeyLoginSuccess(defaultModelPreference);
      await onSaved();
    } catch (saveError) {
      logger.error("[LoginEntry] 保存 API Key provider 失败", {
        templateId,
        error: saveError,
      });
      setError(
        intl.formatMessage(
          { id: "login.apiKey.saveError" },
          {
            error: saveError instanceof Error ? saveError.message : String(saveError),
          },
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  // fork（F4.1b）：跳过只表示「暂不配置 provider」，直接进入工作区；
  // 不再写 providerFamilyDomain（官方账号运行域概念已下线，F4.1a 起不再读取）。
  const skipApiKeyProvider = async () => {
    setSkipping(true);
    setError(null);
    try {
      await onSkipped();
    } finally {
      setSkipping(false);
    }
  };

  const busy = saving || skipping;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "login.apiKey.title" })}
        </h2>
        <div className="space-y-2">
          <div>
            <Select
              value={selectedTemplateId ?? ""}
              onValueChange={(value) => {
                setSelectedTemplateId(value || null);
                setError(null);
              }}
              disabled={busy}
            >
              <SelectTrigger
                id="login-api-key-provider"
                size="lg"
                className="h-10 w-full text-ui-base"
                data-testid={TID_LOGIN_API_KEY_PROVIDER_TRIGGER}
                aria-label={intl.formatMessage({
                  id: "login.apiKey.providerLabel",
                })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" className="rounded-lg">
                {apiKeyTemplates.map((template) => (
                  <SelectItem
                    key={template.templateId}
                    value={template.templateId}
                    className="rounded-md"
                    data-testid={testId(TID_LOGIN_API_KEY_PROVIDER_ITEM, template.templateId)}
                  >
                    {resolveProviderTemplateName(template.templateId, template, locale)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="relative">
            <Input
              id="login-api-key"
              type="password"
              size="lg"
              className={`h-10 w-full text-ui-base ${showApiKeyLink ? "pr-28" : ""}`}
              data-testid={TID_LOGIN_API_KEY_INPUT}
              aria-label={intl.formatMessage({
                id: "login.apiKey.placeholder",
              })}
              value={apiKeyValue}
              placeholder={intl.formatMessage({
                id: "login.apiKey.placeholder",
              })}
              autoComplete="off"
              onChange={(event) => {
                setApiKeyValue(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && apiKeyValue.trim() && !busy) {
                  void saveApiKeyProvider();
                }
              }}
            />
            {showApiKeyLink ? (
              <button
                type="button"
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ui-base font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  if (apiKeyUrl) {
                    platform.openExternal(apiKeyUrl);
                  }
                }}
              >
                {intl.formatMessage({ id: "login.apiKey.getApiKey" })}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive" data-testid={TID_LOGIN_API_KEY_ERROR}>
          <TriangleAlertIcon className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Button
          type="button"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_API_KEY_CONTINUE_BUTTON}
          disabled={!apiKeyValue.trim() || !selectedTemplate || busy}
          onClick={() => void saveApiKeyProvider()}
        >
          {saving ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "login.apiKey.continue" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_API_KEY_SKIP_BUTTON}
          disabled={busy}
          onClick={() => void skipApiKeyProvider()}
        >
          {skipping ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "login.apiKey.skip" })}
        </Button>
      </div>
    </div>
  );
}
