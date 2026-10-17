package com.example.zcode_mobile.bridge

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream

/**
 * 把页面保存的文件写入系统「下载」目录（T6.3）。
 *
 * - Android 10（API 29）及以上：用 MediaStore.Downloads 写入公共下载目录，不需要存储权限；
 *   写入期间标记 IS_PENDING，完成后清除，其它应用不会看到半成品。
 * - Android 9 及以下：MediaStore.Downloads 不可用，公共下载目录又需要 WRITE_EXTERNAL_STORAGE，
 *   而方案明确不申请存储权限。降级到应用专属的 `files/Download` 目录，并用 FileProvider 生成
 *   可交给 ACTION_VIEW 的内容 URI；文件仍随应用卸载清理，符合「不新增存储权限」的边界。
 */
class DownloadsFileWriter(private val context: Context) : MobileFileSaver {

    override fun begin(fileName: String, mimeType: String): MobileFileSaveSession {
        val displayName = MobileFileNames.sanitize(fileName)
        val resolvedMime = mimeType.trim().takeIf { it.isNotEmpty() }
            ?: MobileFileNames.inferMimeType(displayName)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            beginMediaStore(displayName, resolvedMime)
        } else {
            beginLegacy(displayName)
        }
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun beginMediaStore(displayName: String, mimeType: String): MobileFileSaveSession {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, displayName)
            put(MediaStore.Downloads.MIME_TYPE, mimeType)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IOException("Unable to create a file in Downloads.")
        // MediaStore 遇到重名会自动改名；查询实际 DISPLAY_NAME，保证提示里的文件名与落盘一致。
        val actualName = runCatching {
            resolver.query(
                uri,
                arrayOf(MediaStore.Downloads.DISPLAY_NAME),
                null,
                null,
                null,
            )?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        }.getOrNull() ?: displayName
        val stream = resolver.openOutputStream(uri)
            ?: run {
                resolver.delete(uri, null, null)
                throw IOException("Unable to open the Downloads file for writing.")
            }
        return MediaStoreSession(
            resolver = resolver,
            uri = uri,
            displayName = actualName,
            stream = stream,
        )
    }

    private fun beginLegacy(displayName: String): MobileFileSaveSession {
        val directory = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: File(context.filesDir, "downloads")
        directory.mkdirs()
        val file = uniqueFile(directory, displayName)
        return LegacySession(
            context = context,
            file = file,
            displayName = file.name,
            stream = FileOutputStream(file),
        )
    }

    private fun uniqueFile(directory: File, displayName: String): File {
        val candidate = File(directory, displayName)
        if (!candidate.exists()) {
            return candidate
        }
        val dot = displayName.lastIndexOf('.')
        val base = if (dot > 0) displayName.substring(0, dot) else displayName
        val extension = if (dot > 0) displayName.substring(dot) else ""
        var index = 1
        while (true) {
            val next = File(directory, "$base ($index)$extension")
            if (!next.exists()) {
                return next
            }
            index += 1
        }
    }

    private class MediaStoreSession(
        private val resolver: android.content.ContentResolver,
        private val uri: Uri,
        override val displayName: String,
        private val stream: OutputStream,
    ) : MobileFileSaveSession {
        private var closed = false

        override fun append(bytes: ByteArray) {
            check(!closed) { "The save session is already closed." }
            stream.write(bytes)
        }

        override fun finish(): SavedMobileFile {
            closeStream()
            val values = ContentValues().apply {
                put(MediaStore.Downloads.IS_PENDING, 0)
            }
            resolver.update(uri, values, null, null)
            return SavedMobileFile(
                uri = uri.toString(),
                displayPath = "${Environment.DIRECTORY_DOWNLOADS}/$displayName",
            )
        }

        override fun abort() {
            closeStream()
            runCatching { resolver.delete(uri, null, null) }
        }

        private fun closeStream() {
            if (closed) {
                return
            }
            closed = true
            runCatching {
                stream.flush()
                stream.close()
            }
        }
    }

    private class LegacySession(
        private val context: Context,
        private val file: File,
        override val displayName: String,
        private val stream: OutputStream,
    ) : MobileFileSaveSession {
        private var closed = false

        override fun append(bytes: ByteArray) {
            check(!closed) { "The save session is already closed." }
            stream.write(bytes)
        }

        override fun finish(): SavedMobileFile {
            closeStream()
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file,
            )
            return SavedMobileFile(
                uri = uri.toString(),
                displayPath = "${Environment.DIRECTORY_DOWNLOADS}/$displayName",
            )
        }

        override fun abort() {
            closeStream()
            runCatching { file.delete() }
        }

        private fun closeStream() {
            if (closed) {
                return
            }
            closed = true
            runCatching {
                stream.flush()
                stream.close()
            }
        }
    }
}
