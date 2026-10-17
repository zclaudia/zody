package com.example.zcode_mobile.bridge

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
 * WebView 自身发起的下载（T6.3）。
 *
 * 方案要求 DownloadListener 与页面 saveFile 走同一条保存路径，因此这里不把下载交给
 * DownloadManager，而是拉取字节后写入 [MobileFileSaver]（MediaStore/应用专属下载目录），
 * 完成后用 [MobileFileOpener] 打开。blob: URL 只存在于渲染进程，原生无法读取；遇到时记录警告。
 */
class MobileDownloadHandler(
    private val context: Context,
    private val saver: MobileFileSaver,
    private val opener: MobileFileOpener,
) {
    private val mainHandler = Handler(Looper.getMainLooper())

    // 单线程队列：连续下载按触发顺序落盘，避免同时打开多个 MediaStore 写入。
    private val executor = Executors.newSingleThreadExecutor(
        ThreadFactory { runnable ->
            Thread(runnable, "zcode-mobile-download").apply { isDaemon = true }
        },
    )

    fun enqueue(
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
    ) {
        executor.execute {
            runCatching { download(url, userAgent, contentDisposition, mimeType) }
                .onSuccess { downloaded ->
                    Log.i(TAG, "Saved WebView download to ${downloaded.savedFile.displayPath}")
                    mainHandler.post { opener.open(downloaded.savedFile.uri, downloaded.mimeType) }
                }
                .onFailure { error ->
                    Log.w(TAG, "Failed to save a WebView download.", error)
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
    ): DownloadedFile {
        return when {
            url.startsWith("data:", ignoreCase = true) ->
                saveDataUrl(url, contentDisposition, mimeType)
            url.startsWith("content:", ignoreCase = true) ->
                saveContentUri(url, contentDisposition, mimeType)
            url.startsWith("http:", ignoreCase = true) ||
                url.startsWith("https:", ignoreCase = true) ->
                saveHttp(url, userAgent, contentDisposition, mimeType)
            url.startsWith("blob:", ignoreCase = true) ->
                throw IOException("blob: downloads are not readable from the native layer.")
            else -> throw IOException("Unsupported download scheme: ${url.substringBefore(':')}")
        }
    }

    private fun saveHttp(
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
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
            val resolvedMime = resolveMimeType(mimeType, connection.contentType, contentDisposition)
            val fileName = resolveFileName(url, contentDisposition, resolvedMime)
            return connection.inputStream.use { input ->
                save(input, fileName, resolvedMime)
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun saveContentUri(
        url: String,
        contentDisposition: String?,
        mimeType: String?,
    ): DownloadedFile {
        val resolver = context.contentResolver
        val uri = Uri.parse(url)
        val resolvedMime = resolveMimeType(mimeType, resolver.getType(uri), contentDisposition)
        val fileName = resolveFileName(url, contentDisposition, resolvedMime)
        val input = resolver.openInputStream(uri)
            ?: throw IOException("Unable to read the downloaded content URI.")
        return input.use { save(it, fileName, resolvedMime) }
    }

    private fun saveDataUrl(
        url: String,
        contentDisposition: String?,
        mimeType: String?,
    ): DownloadedFile {
        val comma = url.indexOf(',')
        if (comma <= 5) {
            throw IOException("Malformed data: URL.")
        }
        val header = url.substring(5, comma)
        val payload = url.substring(comma + 1)
        val headerMime = header.substringBefore(';').takeIf { it.isNotBlank() }
        val resolvedMime = resolveMimeType(mimeType, headerMime, contentDisposition)
        val fileName = resolveFileName("data:", contentDisposition, resolvedMime)
        val bytes = if (header.contains(";base64", ignoreCase = true)) {
            Base64.decode(payload, Base64.DEFAULT)
        } else {
            Uri.decode(payload).toByteArray(Charsets.UTF_8)
        }
        val session = saver.begin(fileName, resolvedMime)
        return try {
            session.append(bytes)
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
    ): DownloadedFile {
        val session = saver.begin(fileName, mimeType)
        return try {
            val buffer = ByteArray(BUFFER_BYTES)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) {
                    break
                }
                if (read > 0) {
                    session.append(buffer.copyOf(read))
                }
            }
            DownloadedFile(session.finish(), mimeType)
        } catch (error: Throwable) {
            session.abort()
            throw error
        }
    }

    private fun resolveMimeType(
        requested: String?,
        response: String?,
        contentDisposition: String?,
    ): String {
        requested?.substringBefore(';')?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        response?.substringBefore(';')?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        return MobileFileNames.inferMimeType(
            MobileFileNames.parseContentDispositionFileName(contentDisposition).orEmpty(),
        )
    }

    private fun resolveFileName(
        url: String,
        contentDisposition: String?,
        mimeType: String,
    ): String {
        val candidate = MobileFileNames.parseContentDispositionFileName(contentDisposition)
            ?: MobileFileNames.fileNameFromUrl(url)
            ?: MobileFileNames.defaultNameForMimeType(mimeType)
        return MobileFileNames.sanitize(candidate)
    }

    private data class DownloadedFile(
        val savedFile: SavedMobileFile,
        val mimeType: String,
    )

    private companion object {
        const val TAG = "ZcodeMobileDownload"
        const val TIMEOUT_MS = 30_000
        const val BUFFER_BYTES = 16 * 1024
    }
}
