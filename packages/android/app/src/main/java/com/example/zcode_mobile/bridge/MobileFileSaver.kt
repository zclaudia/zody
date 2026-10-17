package com.example.zcode_mobile.bridge

/**
 * 手机文件保存/打开能力（T6.3）。
 *
 * 抽成接口的原因与 [SecureKeyValueStore] 相同：`@JavascriptInterface` 的契约可以在 JVM 单测里
 * 用内存实现覆盖，MediaStore/FileProvider 等 Android 运行时细节留在实现类，由仪器测试验证。
 */
interface MobileFileSaver {
    /**
     * 开始一次保存。
     *
     * @param fileName 页面建议的文件名；实现必须再次清洗，不能直接当路径使用。
     * @param mimeType 页面推断的 MIME；为空时按扩展名兜底。
     */
    fun begin(fileName: String, mimeType: String): MobileFileSaveSession
}

interface MobileFileSaveSession {
    /** 实际写入的文件名（已清洗，可能因重名被系统调整）。 */
    val displayName: String

    /** 追加一段已解码的字节。页面按块发送 base64，桥负责解码后调用这里。 */
    fun append(bytes: ByteArray)

    /** 关闭并提交文件；返回可被 [MobileFileOpener] 打开的 URI。 */
    fun finish(): SavedMobileFile

    /** 放弃本次保存并清理半成品。可重复调用。 */
    fun abort()
}

data class SavedMobileFile(
    /** 可交给 ACTION_VIEW 的内容 URI。 */
    val uri: String,
    /** 给用户看的位置，例如 `Download/report.pdf`。 */
    val displayPath: String,
)

interface MobileFileOpener {
    /**
     * 用系统默认应用打开文件。
     *
     * @return false 表示 URI 不在允许范围或系统没有可处理的应用；保存本身仍然成功。
     */
    fun open(uri: String, mimeType: String): Boolean
}
