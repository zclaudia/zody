package io.github.zclaudia.zody.mobile.bridge

import java.io.IOException
import java.io.OutputStream

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

/**
 * Shared stream finalizer for Android save sessions. A close failure must reach the caller so the
 * MediaStore row is not published as a successful, possibly truncated download.
 */
internal class MobileFileSaveOutputStream(private val output: OutputStream) {
    private var closed = false

    fun write(bytes: ByteArray) {
        check(!closed) { "The save session is already closed." }
        output.write(bytes)
    }

    fun finish() {
        if (closed) return
        closed = true
        var failure: IOException? = null
        try {
            output.flush()
        } catch (error: IOException) {
            failure = error
        }
        try {
            output.close()
        } catch (error: IOException) {
            if (failure == null) failure = error else failure.addSuppressed(error)
        }
        failure?.let { throw it }
    }

    fun abort() {
        try {
            finish()
        } catch (_: Exception) {
            // Cleanup still deletes the uncommitted file when flushing or closing fails.
        }
    }
}
