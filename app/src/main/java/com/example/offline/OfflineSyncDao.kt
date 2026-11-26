package com.example.offline

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface OfflineSyncDao {

  @Query("SELECT * FROM pending_sync_ops ORDER BY createdAt ASC")
  fun observePendingOperations(): Flow<List<PendingSyncEntity>>

  @Query("SELECT COUNT(*) FROM pending_sync_ops")
  fun observePendingCount(): Flow<Int>

  @Query("SELECT * FROM pending_sync_ops ORDER BY createdAt ASC")
  suspend fun getAllPendingOperations(): List<PendingSyncEntity>

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertPendingOperation(operation: PendingSyncEntity)

  @Query("UPDATE pending_sync_ops SET status = :status, updatedAt = :updatedAt WHERE clientOpId = :clientOpId")
  suspend fun updateOperationStatus(
    clientOpId: String,
    status: String,
    updatedAt: Long = System.currentTimeMillis(),
  )

  @Query(
    "UPDATE pending_sync_ops SET status = :status, retryCount = retryCount + 1, lastError = :error, updatedAt = :updatedAt WHERE clientOpId = :clientOpId"
  )
  suspend fun markOperationFailed(
    clientOpId: String,
    status: String = SyncStatus.FAILED,
    error: String?,
    updatedAt: Long = System.currentTimeMillis(),
  )

  @Query("DELETE FROM pending_sync_ops WHERE clientOpId = :clientOpId")
  suspend fun deleteOperation(clientOpId: String)

  @Query("SELECT COUNT(*) FROM pending_sync_ops")
  suspend fun getPendingCountOnce(): Int

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertCachedResponse(entry: CachedResponseEntity)

  @Query("SELECT * FROM cached_gas_responses WHERE cacheKey = :cacheKey LIMIT 1")
  suspend fun getCachedResponse(cacheKey: String): CachedResponseEntity?
}
