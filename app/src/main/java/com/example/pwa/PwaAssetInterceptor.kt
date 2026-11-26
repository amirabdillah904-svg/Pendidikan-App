package com.example.pwa

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import java.io.IOException

/**
 * Intercepts HTTPS requests to the local appassets origin and serves bundled PWA files
 * from `app/src/main/assets/www/` with proper MIME types and security checks.
 */
object PwaAssetInterceptor {
  const val APP_HOST = "appassets.androidplatform.net"
  const val ASSET_PREFIX = "/assets/"
  const val ENTRY_URL = "https://$APP_HOST/assets/www/index.html"

  fun isLocalAppUri(uri: Uri?): Boolean {
    return uri != null &&
      uri.scheme.equals("https", ignoreCase = true) &&
      uri.host.equals(APP_HOST, ignoreCase = true)
  }

  fun resolveAssetPath(rawPath: String?): String? {
    if (rawPath.isNullOrBlank()) return null
    val normalized =
      when {
        rawPath.startsWith(ASSET_PREFIX) -> rawPath.removePrefix(ASSET_PREFIX)
        rawPath.startsWith("/") -> rawPath.removePrefix("/")
        else -> rawPath
      }
    if (normalized.isBlank() || normalized.contains("..")) return null
    return normalized
  }

  fun guessMimeType(assetPath: String): String {
    return when (assetPath.substringAfterLast('.', "").lowercase()) {
      "html", "htm" -> "text/html"
      "js", "mjs" -> "application/javascript"
      "css" -> "text/css"
      "json", "webmanifest" -> "application/json"
      "png" -> "image/png"
      "jpg", "jpeg" -> "image/jpeg"
      "webp" -> "image/webp"
      "svg" -> "image/svg+xml"
      "ico" -> "image/x-icon"
      "woff2" -> "font/woff2"
      "ttf" -> "font/ttf"
      else -> "application/octet-stream"
    }
  }

  fun intercept(context: Context, uri: Uri?): WebResourceResponse? {
    if (!isLocalAppUri(uri)) return null
    val assetPath = resolveAssetPath(uri?.path) ?: return null
    return try {
      val stream = context.assets.open(assetPath)
      val mimeType = guessMimeType(assetPath)
      val encoding = if (mimeType.startsWith("text/") || mimeType.contains("json") || mimeType.contains("javascript") || mimeType.contains("svg")) {
        "UTF-8"
      } else {
        null
      }
      WebResourceResponse(
        mimeType,
        encoding,
        200,
        "OK",
        mapOf(
          "Cache-Control" to "no-cache",
          "Access-Control-Allow-Origin" to "*",
        ),
        stream,
      )
    } catch (_: IOException) {
      null
    }
  }
}
