/**
 * Azure Uploader Facade
 * File ini telah di-refactor ke dalam arsitektur berlapis (Clean Layered Architecture).
 * Semua ekspor dipertahankan di sini untuk kompatibilitas mundur (backward compatibility).
 */

export { uploadCache, globalBlacklistCache, uploadProgressCache, activeUploadControllers, failureCountCache } from '../services/stream/streamStateStore.js';
export { containerClient, getBlobPath, getBlobUrl, ensureContainerExists, checkUploadStatus, checkUploadStatusWithFallback, deleteBlobFromAzure } from '../services/stream/blobStorageService.js';
export { isMegaBlacklisted, getUploadProgress, cancelAllUploads, markUploadFailed, hasActiveUploadForSeries, getActiveUploadCount, cancelUpload, invalidateAndDeleteBlob } from '../services/stream/uploadProgressService.js';
export { checkRangeSupport, uploadStream } from '../services/stream/ffmpegStreamService.js';
