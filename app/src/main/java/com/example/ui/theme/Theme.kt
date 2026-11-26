package com.example.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
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
    primary = BrandBlue600,
    onPrimary = Color.White,
    primaryContainer = BrandNavy900,
    onPrimaryContainer = BrandBlue100,
    secondary = BrandEmerald,
    onSecondary = Color.White,
    tertiary = BrandGold,
    onTertiary = BrandNavy950,
    background = DarkPageBg,
    onBackground = DarkTextMain,
    surface = DarkSurface,
    onSurface = DarkTextMain,
    onSurfaceVariant = DarkTextMuted,
    outline = DarkOutline,
    error = BrandError,
  )

private val LightColorScheme =
  lightColorScheme(
    primary = BrandBlue700,
    onPrimary = Color.White,
    primaryContainer = BrandBlue50,
    onPrimaryContainer = BrandNavy900,
    secondary = BrandEmerald,
    onSecondary = Color.White,
    tertiary = BrandGold,
    onTertiary = BrandNavy950,
    background = LightPageBg,
    onBackground = LightTextMain,
    surface = LightSurface,
    onSurface = LightTextMain,
    onSurfaceVariant = LightTextMuted,
    outline = LightOutline,
    error = BrandError,
  )

@Composable
fun DeptPendidikanTheme(
  darkTheme: Boolean = isSystemInDarkTheme(),
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
