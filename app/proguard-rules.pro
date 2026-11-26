# Add project specific ProGuard rules here.
# Keep JavascriptInterface methods exposed to the PWA WebView.
-keepclassmembers class com.example.pwa.PwaJsBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
