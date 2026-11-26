package com.example.pwa

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream

data class ExportResult(
  val fileName: String,
  val mimeType: String,
  val uri: Uri?,
  val errorMessage: String? = null,
) {
  val isSuccess: Boolean get() = uri != null && errorMessage == null
}

/**
 * Exports Base64 payloads (PDFs from html2pdf.js and CSV reports) to device storage
 * without requiring legacy broad storage permissions.
 */
object PwaFileExporter {

  fun sanitizeFileName(rawName: String, fallbackExt: String): String {
    val cleaned =
      rawName
        .trim()
        .replace(Regex("[^a-zA-Z0-9._-]"), "_")
        .replace(Regex("_+"), "_")
        .trim('_')
    val base = if (cleaned.isBlank()) "Dokumen_DeptPendidikan.$fallbackExt" else cleaned
    return if (base.contains('.')) base else "$base.$fallbackExt"
  }

  fun saveBase64File(
    context: Context,
    base64Data: String,
    rawFileName: String,
    rawMimeType: String,
  ): ExportResult {
    val mimeType =
      rawMimeType.ifBlank {
        when {
          rawFileName.endsWith(".pdf", ignoreCase = true) -> "application/pdf"
          rawFileName.endsWith(".csv", ignoreCase = true) -> "text/csv"
          else -> "application/octet-stream"
        }
      }
    val fallbackExt =
      when {
        mimeType.contains("pdf") -> "pdf"
        mimeType.contains("csv") -> "csv"
        else -> "bin"
      }
    val fileName = sanitizeFileName(rawFileName, fallbackExt)

    return try {
      val pureBase64 = base64Data.substringAfter("base64,", base64Data)
      val bytes = Base64.decode(pureBase64, Base64.DEFAULT)

      val savedUri =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          saveViaMediaStore(context, fileName, mimeType, bytes)
        } else {
          saveViaAppDownloads(context, fileName, bytes)
        }

      ExportResult(fileName = fileName, mimeType = mimeType, uri = savedUri)
    } catch (e: Exception) {
      ExportResult(
        fileName = fileName,
        mimeType = mimeType,
        uri = null,
        errorMessage = e.localizedMessage ?: "Unknown error",
      )
    }
  }

  private fun saveViaMediaStore(
    context: Context,
    fileName: String,
    mimeType: String,
    bytes: ByteArray,
  ): Uri {
    val resolver = context.contentResolver
    val values =
      ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
        put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
        put(
          MediaStore.MediaColumns.RELATIVE_PATH,
          "${Environment.DIRECTORY_DOWNLOADS}/DeptPendidikan",
        )
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
    val uri =
      resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IllegalStateException("Tidak dapat membuat berkas di folder Download.")

    resolver.openOutputStream(uri)?.use { out ->
      out.write(bytes)
      out.flush()
    } ?: throw IllegalStateException("Tidak dapat menulis berkas.")

    val completedValues = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
    resolver.update(uri, completedValues, null, null)
    return uri
  }

  private fun saveViaAppDownloads(
    context: Context,
    fileName: String,
    bytes: ByteArray,
  ): Uri {
    val dir =
      context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
        ?: File(context.cacheDir, "exports").apply { mkdirs() }
    if (!dir.exists()) dir.mkdirs()
    val targetFile = File(dir, fileName)
    FileOutputStream(targetFile).use { out ->
      out.write(bytes)
      out.flush()
    }
    return FileProvider.getUriForFile(
      context,
      "${context.packageName}.fileprovider",
      targetFile,
    )
  }

  fun openOrShareDocument(context: Context, uri: Uri, mimeType: String): Boolean {
    val viewIntent =
      Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, mimeType)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
    return try {
      context.startActivity(viewIntent)
      true
    } catch (_: ActivityNotFoundException) {
      val shareIntent =
        Intent(Intent.ACTION_SEND).apply {
          type = mimeType
          putExtra(Intent.EXTRA_STREAM, uri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
      try {
        context.startActivity(Intent.createChooser(shareIntent, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
      } catch (_: Exception) {
        false
      }
    }
  }
}
