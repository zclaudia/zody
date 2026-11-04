package io.github.zclaudia.zody.mobile.bridge

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.CookieManager
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory

/**
 * WebView 自身发起的下载（T6.3 / M4-T1）。
 *
 * 方案要求 DownloadListener 与页面 saveFile 走同一条保存路径，因此这里不把下载交给
 * DownloadManager，而是拉取字节后写入 [MobileFileSaver]（MediaStore/应用专属下载目录），
 * 完成后用 [MobileFileOpener] 打开。blob: URL 只存在于渲染进程，原生无法读取；遇到时记录警告。
 *
 * M4-T1：下载开始与落盘都在后台线程，必须在写入前、提交前和打开前重新确认发起下载的
 * session 仍是当前 Remote 会话。backend 切换后旧页面的迟到下载不能继续保存或打开文件。
 */
class MobileDownloadHandler(
    private val context: Context,
    private val saver: MobileFileSaver,
    private val opener: MobileFileOpener,
    private val currentSessionId: () -> String?,
) {
    private val mainHandler = Handler(Looper.getMainLooper())

    // 单线程队列：连续下载按触发顺序落盘，避免同时打开多个 MediaStore 写入。
    private val executor = Executors.newSingleThreadExecutor(
        ThreadFactory { runnable ->
            Thread(runnable, "zody-mobile-download").apply { isDaemon = true }
        },
    )

    fun enqueue(
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
    ) {
        val sessionId = currentSessionId()?.takeIf { it.isNotBlank() }
        if (sessionId == null) {
            // Shell 或已失效页面不应产生下载；没有当前 Remote session 直接丢弃。
            Log.w(TAG, "Discarded a WebView download without a current Remote session.")
            return
        }
        executor.execute {
            runCatching { download(url, userAgent, contentDisposition, mimeType, sessionId) }
                .onSuccess { downloaded ->
                    Log.i(TAG, "Saved WebView download to ${downloaded.savedFile.displayPath}")
                    mainHandler.post {
                        if (isCurrentSession(sessionId)) {
                            opener.open(downloaded.savedFile.uri, downloaded.mimeType)
                        } else {
                            Log.w(TAG, "Discarded opening a download from a stale session.")
                        }
                    }
                }
                .onFailure { error ->
                    if (error is StaleDownloadSessionException) {
                        Log.w(TAG, "Discarded a WebView download from a stale session.")
                    } else {
                        Log.w(TAG, "Failed to save a WebView download.", error)
                    }
                }
        }
    }

    fun shutdown() {
        executor.shutdownNow()
    }

    private fun download(
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
        sessionId: String,
    ): DownloadedFile {
        requireCurrentSession(sessionId)
        return when (MobileDownloadPolicy.classify(url)) {
            MobileDownloadPolicy.SourceKind.DATA_URL ->
                saveDataUrl(url, contentDisposition, mimeType, sessionId)
            MobileDownloadPolicy.SourceKind.CONTENT_URI ->
                saveContentUri(url, contentDisposition, mimeType, sessionId)
            MobileDownloadPolicy.SourceKind.HTTP ->
                saveHttp(url, userAgent, contentDisposition, mimeType, sessionId)
            MobileDownloadPolicy.SourceKind.BLOB_UNSUPPORTED ->
                throw IOException("blob: downloads are not readable from the native layer.")
            MobileDownloadPolicy.SourceKind.UNSUPPORTED ->
                throw IOException("Unsupported download scheme: ${url.substringBefore(':')}")
        }
    }

    private fun saveHttp(
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
        sessionId: String,
    ): DownloadedFile {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            instanceFollowRedirects = true
            userAgent?.takeIf { it.isNotBlank() }?.let { setRequestProperty("User-Agent", it) }
            CookieManager.getInstance().getCookie(url)?.let { setRequestProperty("Cookie", it) }
        }
        try {
            val status = connection.responseCode
            if (status !in 200..299) {
                throw IOException("Download failed with HTTP $status.")
            }
            val resolvedMime = MobileDownloadPolicy.resolveMimeType(
                mimeType,
                connection.contentType,
                contentDisposition,
            )
            val fileName = MobileDownloadPolicy.resolveFileName(url, contentDisposition, resolvedMime)
            return connection.inputStream.use { input ->
                save(input, fileName, resolvedMime, sessionId)
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun saveContentUri(
        url: String,
        contentDisposition: String?,
        mimeType: String?,
        sessionId: String,
    ): DownloadedFile {
        val resolver = context.contentResolver
        val uri = Uri.parse(url)
        val resolvedMime = MobileDownloadPolicy.resolveMimeType(
            mimeType,
            resolver.getType(uri),
            contentDisposition,
        )
        val fileName = MobileDownloadPolicy.resolveFileName(url, contentDisposition, resolvedMime)
        val input = resolver.openInputStream(uri)
            ?: throw IOException("Unable to read the downloaded content URI.")
        return input.use { save(it, fileName, resolvedMime, sessionId) }
    }

    private fun saveDataUrl(
        url: String,
        contentDisposition: String?,
        mimeType: String?,
        sessionId: String,
    ): DownloadedFile {
        val comma = url.indexOf(',')
        if (comma <= 5) {
            throw IOException("Malformed data: URL.")
        }
        val header = url.substring(5, comma)
        val payload = url.substring(comma + 1)
        val headerMime = header.substringBefore(';').takeIf { it.isNotBlank() }
        val resolvedMime = MobileDownloadPolicy.resolveMimeType(
            mimeType,
            headerMime,
            contentDisposition,
        )
        val fileName = MobileDownloadPolicy.resolveFileName("data:", contentDisposition, resolvedMime)
        val bytes = if (header.contains(";base64", ignoreCase = true)) {
            Base64.decode(payload, Base64.DEFAULT)
        } else {
            Uri.decode(payload).toByteArray(Charsets.UTF_8)
        }
        requireCurrentSession(sessionId)
        val session = saver.begin(fileName, resolvedMime)
        return try {
            session.append(bytes)
            // 数据已写入但尚未提交：backend 可能在这期间切换，提交前必须再次确认 session。
            requireCurrentSession(sessionId)
            DownloadedFile(session.finish(), resolvedMime)
        } catch (error: Throwable) {
            session.abort()
            throw error
        }
    }

    private fun save(
        input: InputStream,
        fileName: String,
        mimeType: String,
        sessionId: String,
    ): DownloadedFile {
        requireCurrentSession(sessionId)
        val session = saver.begin(fileName, mimeType)
        return try {
            val buffer = ByteArray(BUFFER_BYTES)
            while (true) {
                // 长下载期间也要响应 backend 切换，避免继续读完整份旧 backend 的文件。
                requireCurrentSession(sessionId)
                val read = input.read(buffer)
                if (read < 0) {
                    break
                }
                if (read > 0) {
                    session.append(buffer.copyOf(read))
                }
            }
            // 提交前最后一次确认：旧 session 的半成品由 abort 删除，不会出现在 Downloads。
            requireCurrentSession(sessionId)
            DownloadedFile(session.finish(), mimeType)
        } catch (error: Throwable) {
            session.abort()
            throw error
        }
    }

    private fun isCurrentSession(sessionId: String): Boolean =
        MobileDownloadPolicy.isCurrentSession(sessionId, currentSessionId())

    private fun requireCurrentSession(sessionId: String) {
        if (!isCurrentSession(sessionId)) {
            throw StaleDownloadSessionException()
        }
    }

    private data class DownloadedFile(
        val savedFile: SavedMobileFile,
        val mimeType: String,
    )

    private class StaleDownloadSessionException :
        IOException("The download session is no longer current.")

    private companion object {
        const val TAG = "ZodyMobileDownload"
        const val TIMEOUT_MS = 30_000
        const val BUFFER_BYTES = 16 * 1024
    }
}
