package com.example

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.example.offline.OfflineSyncRepository
import com.example.pwa.PwaAssetInterceptor
import com.example.pwa.PwaFileExporter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ExampleRobolectricTest {

  @Test
  fun `read app name from context`() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val appName = context.getString(R.string.app_name)
    assertEquals("Dept. Pendidikan", appName)
  }

  @Test
  fun `pwa asset interceptor resolves bundled index html`() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val response = PwaAssetInterceptor.intercept(context, android.net.Uri.parse(PwaAssetInterceptor.ENTRY_URL))
    assertNotNull(response)
    assertEquals("text/html", response?.mimeType)
  }

  @Test
  fun `pwa asset interceptor blocks path traversal`() {
    assertNull(PwaAssetInterceptor.resolveAssetPath("/assets/www/../../secret.txt"))
    assertEquals("www/manifest.json", PwaAssetInterceptor.resolveAssetPath("/assets/www/manifest.json"))
    assertEquals("application/json", PwaAssetInterceptor.guessMimeType("www/manifest.json"))
  }

  @Test
  fun `file exporter sanitizes unsafe filenames`() {
    assertEquals(
      "Rekap_Kamar_A1.pdf",
      PwaFileExporter.sanitizeFileName("Rekap Kamar/A1.pdf", "pdf"),
    )
    assertEquals(
      "Dokumen_DeptPendidikan.csv",
      PwaFileExporter.sanitizeFileName("   ", "csv"),
    )
  }

  @Test
  fun `offline sync repository builds readable Indonesian labels`() {
    assertEquals(
      "Absensi WB • Kamar A1",
      OfflineSyncRepository.buildSummaryLabel(
        "submitAbsensi",
        """[{"type":"wb","target":"Kamar A1"}]""",
      ),
    )
    assertEquals(
      "Pengumuman Baru",
      OfflineSyncRepository.buildSummaryLabel("savePengumuman", """["Rapat"]"""),
    )
  }
}
