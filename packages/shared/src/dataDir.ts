/**
 * fork 数据隔离：家目录级数据根改为 .zcoder，避免与正式版 ZCode 共用。
 *
 * 家目录/数据根（dataBaseDir/homedir）为基准拼出的数据目录一律使用该段名；
 * 项目内工具目录（<项目>/.zcode/...）保持 `.zcode` 不变，与正式版在同一项目共用。
 */
export const ZCODE_DATA_ROOT_DIR_NAME = ".zcoder";
