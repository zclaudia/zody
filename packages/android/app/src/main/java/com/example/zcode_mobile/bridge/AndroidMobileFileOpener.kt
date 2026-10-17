package com.example.zcode_mobile.bridge

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.util.Log

/**
 * 用系统默认应用打开刚保存的文件（T6.3）。
 *
 * 只允许本应用 FileProvider 与 MediaStore 产出的 content URI：页面是内置页面，但桥方法仍按
 * 「最小权限」处理，避免把任意 content scheme 交给外部应用。
 */
class AndroidMobileFileOpener(private val context: Context) : MobileFileOpener {
    override fun open(uri: String, mimeType: String): Boolean {
        val parsed = runCatching { Uri.parse(uri) }.getOrNull() ?: return false
        if (parsed.scheme != "content") {
            return false
        }
        val authority = parsed.authority
        val allowed = authority == MediaStore.AUTHORITY ||
            authority == "${context.packageName}.fileprovider"
        if (!allowed) {
            return false
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(parsed, mimeType.ifBlank { "application/octet-stream" })
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if (context !is Activity) {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }
        return try {
            context.startActivity(intent)
            true
        } catch (error: ActivityNotFoundException) {
            Log.w(TAG, "No app can open the saved file.", error)
            false
        } catch (error: SecurityException) {
            Log.w(TAG, "The saved file URI was rejected by the viewer.", error)
            false
        }
    }

    private companion object {
        const val TAG = "ZcodeMobileFileOpener"
    }
}
