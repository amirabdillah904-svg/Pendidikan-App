package com.example

import android.app.Application
import androidx.work.Configuration
import com.example.offline.BackgroundSyncAndNotifyWorker
import com.example.offline.SyncNotificationHelper

class DeptPendidikanApp : Application(), Configuration.Provider {
  override val workManagerConfiguration: Configuration
    get() = Configuration.Builder().build()

  override fun onCreate() {
    super.onCreate()
    // Ensure high-priority Android notification channels exist immediately
    SyncNotificationHelper(this)
    // Keep periodic background notification & offline auto-sync active even when the app is closed
    BackgroundSyncAndNotifyWorker.schedulePeriodicWork(this)
  }
}
