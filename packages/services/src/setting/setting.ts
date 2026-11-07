import type { AppSettings } from "@zody/shared";
import { ServiceChannels } from "@zody/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISettingService {
  get(): Promise<AppSettings>;
  update(
    patch: Partial<AppSettings>,
    expectedAccountSettings?: Pick<
      AppSettings,
      "providerFamilyDomain" | "providerFamilyConnectionSelections"
    >,
  ): Promise<void>;
  /** Change the data base directory: copy data from old → new location, then persist the setting. */
  updateDataBaseDir(newDir: string | undefined): Promise<void>;
  ensureDefaultProject(homedir: string): Promise<{ path: string; created: boolean }>;
  /**
   * 读取用户自定义指令（个性化）文件 `{home}/.zody/AGENTS.md`（home 解析与 CLI adapter 一致）。
   * 来源：上游 v3.17.1（commit a60ba6a7）；文件缺失时返回空 content，filePath 用于排查
   * 与 Agent 实际读取路径是否一致。
   */
  getUserInstructions(): Promise<{ content: string; filePath: string }>;
  /** 原子写入用户自定义指令（个性化）文件，按需创建 `{home}/.zody` 目录；超 100KB 抛 user_instructions_too_large。 */
  saveUserInstructions(content: string): Promise<{ filePath: string }>;
}

export const ISettingService = createServiceDescriptor<ISettingService>(ServiceChannels.Setting);
