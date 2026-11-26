package com.example.ui.theme

import android.os.Build
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val DarkColorScheme =
  darkColorScheme(
    primary = LuminousMint,
    onPrimary = ObsidianBg,
    primaryContainer = ElectricIndigoContainer,
    onPrimaryContainer = Color.White,
    secondary = ElectricIndigo,
    onSecondary = Color.White,
    secondaryContainer = SlateSurface,
    onSecondaryContainer = DarkTextMain,
    tertiary = BrandGold,
    onTertiary = ObsidianBg,
    background = DarkPageBg,
    onBackground = DarkTextMain,
    surface = DarkSurface,
    onSurface = DarkTextMain,
    onSurfaceVariant = DarkTextMuted,
    outline = DarkOutline,
    error = BrandError,
    errorContainer = BrandErrorContainerDark,
    onErrorContainer = BrandOnErrorContainerDark,
  )

private val LightColorScheme =
  lightColorScheme(
    primary = ElectricIndigoDark,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE0E7FF),
    onPrimaryContainer = ElectricIndigoContainer,
    secondary = EmeraldDeep,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFD1FAE5),
    onSecondaryContainer = Color(0xFF064E3B),
    tertiary = BrandGold,
    onTertiary = ObsidianBg,
    background = LightPageBg,
    onBackground = LightTextMain,
    surface = LightSurface,
    onSurface = LightTextMain,
    onSurfaceVariant = LightTextMuted,
    outline = LightOutline,
    error = Color(0xFFDC2626),
    errorContainer = Color(0xFFFEE2E2),
    onErrorContainer = Color(0xFF7F1D1D),
  )

@Composable
fun DeptPendidikanTheme(
  darkTheme: Boolean = false,
  dynamicColor: Boolean = false,
  content: @Composable () -> Unit,
) {
  val colorScheme =
    when {
      dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
        val context = LocalContext.current
        if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
      }
      darkTheme -> DarkColorScheme
      else -> LightColorScheme
    }

  MaterialTheme(colorScheme = colorScheme, typography = Typography, content = content)
}
