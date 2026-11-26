package com.example

import com.example.pwa.PwaAssetInterceptor
import com.example.pwa.PwaFileExporter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ExampleUnitTest {

  @Test
  fun resolveAssetPath_handlesValidAndTraversalPaths() {
    assertEquals("www/index.html", PwaAssetInterceptor.resolveAssetPath("/assets/www/index.html"))
    assertEquals("www/manifest.json", PwaAssetInterceptor.resolveAssetPath("/assets/www/manifest.json"))
    assertNull(PwaAssetInterceptor.resolveAssetPath("/assets/www/../../secret.txt"))
    assertNull(PwaAssetInterceptor.resolveAssetPath(""))
  }

  @Test
  fun guessMimeType_returnsExpectedTypes() {
    assertEquals("text/html", PwaAssetInterceptor.guessMimeType("www/index.html"))
    assertEquals("application/json", PwaAssetInterceptor.guessMimeType("www/manifest.json"))
    assertEquals("application/javascript", PwaAssetInterceptor.guessMimeType("www/sw.js"))
    assertEquals("image/png", PwaAssetInterceptor.guessMimeType("www/icon-512.png"))
  }

  @Test
  fun sanitizeFileName_cleansUnsafeCharacters() {
    assertEquals(
      "Rekap_Kamar_A1.pdf",
      PwaFileExporter.sanitizeFileName("Rekap Kamar/A1.pdf", "pdf"),
    )
    assertEquals(
      "Laporan_simpanan.csv",
      PwaFileExporter.sanitizeFileName("Laporan_simpanan", "csv"),
    )
    assertEquals(
      "Dokumen_DeptPendidikan.pdf",
      PwaFileExporter.sanitizeFileName("   ", "pdf"),
    )
  }
}
