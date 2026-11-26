package com.example.offline

import androidx.room.Entity
import androidx.room.PrimaryKey

object SyncStatus {
  const val PENDING = "PENDING"
  const val SYNCING = "SYNCING"
  const val FAILED = "FAILED"
}

/**
 * Local offline outbox entry for write operations (attendance, finance, announcements,
 * letters, gallery, suggestions, database edits) waiting to sync to Google Sheets.
 */
@Entity(tableName = "pending_sync_ops")
data class PendingSyncEntity(
  @PrimaryKey val clientOpId: String,
  val fnName: String,
  val argsJson: String,
  val summaryLabel: String,
  val status: String = SyncStatus.PENDING,
  val retryCount: Int = 0,
  val lastError: String? = null,
  val createdAt: Long = System.currentTimeMillis(),
  val updatedAt: Long = System.currentTimeMillis(),
)

/**
 * Local Room cache storing read responses from Google Apps Script so the app remains
 * usable even while offline.
 */
@Entity(tableName = "cached_gas_responses")
data class CachedResponseEntity(
  @PrimaryKey val cacheKey: String,
  val fnName: String,
  val responseJson: String,
  val updatedAt: Long = System.currentTimeMillis(),
)
