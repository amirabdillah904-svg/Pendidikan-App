package com.example.offline

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
  entities = [PendingSyncEntity::class, CachedResponseEntity::class],
  version = 1,
  exportSchema = false,
)
abstract class OfflineDatabase : RoomDatabase() {
  abstract fun offlineSyncDao(): OfflineSyncDao

  companion object {
    @Volatile private var instance: OfflineDatabase? = null

    fun getInstance(context: Context): OfflineDatabase {
      return instance
        ?: synchronized(this) {
          instance
            ?: Room.databaseBuilder(
              context.applicationContext,
              OfflineDatabase::class.java,
              "dept_pendidikan_offline.db",
            )
              .fallbackToDestructiveMigration(dropAllTables = true)
              .build()
              .also { instance = it }
        }
    }
  }
}
