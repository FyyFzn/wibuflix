import { BlobServiceClient } from '@azure/storage-blob';
import axios from 'axios';
import { getCache } from './cacheManager.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'videos';

let containerClient = null;
let isContainerInitialized = false;

if (connectionString) {
    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        containerClient = blobServiceClient.getContainerClient(containerName);
    } catch (err) {
        console.error('[Azure Uploader] Failed to create ContainerClient:', err.message);
    }
} else {
    console.warn('[Azure Uploader] WARNING: AZURE_STORAGE_CONNECTION_STRING is not set. Azure upload will be disabled.');
}

const uploadCache = getCache('azure-uploads', 86400); // 24 hours TTL

export const uploadProgressCache = new Map();
export const activeUploadControllers = new Map();

/**
 * Returns the current upload progress string for a given blob.
 */
export function getUploadProgress(seriesSlug, episodeSlug) {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    return uploadProgressCache.get(blobPath) || 'Menyiapkan video...';
}

/**
 * Cancels all currently active uploads.
 */
export function cancelAllUploads() {
    let count = 0;
    for (const [blobPath, controller] of activeUploadControllers.entries()) {
        controller.abort();
        console.info(`[Azure Uploader] Cancelled upload for ${blobPath}`);
        count++;
    }
    activeUploadControllers.clear();
    return count;
}

/**
 * Normalizes and formats the blob path for Azure
 */
export function getBlobPath(seriesSlug, episodeSlug) {
    return `${seriesSlug}/${episodeSlug}.mp4`;
}

/**
 * Gets the direct URL of a blob
 */
export function getBlobUrl(blobPath) {
    if (!containerClient) return '';
    const rawUrl = containerClient.getBlockBlobClient(blobPath).url;
    
    // Gunakan Azure CDN jika dikonfigurasi di environment variables
    const cdnUrl = process.env.AZURE_CDN_URL;
    if (cdnUrl) {
        try {
            const parsedRaw = new URL(rawUrl);
            // Tambahkan protokol otomatis jika user lupa memasukkan https://
            const validCdnUrl = cdnUrl.startsWith('http') ? cdnUrl : `https://${cdnUrl}`;
            const parsedCdn = new URL(validCdnUrl);
            
            // Gabungkan host CDN dengan path asli dan ubah spasi menjadi %20 agar tidak error di player
            return `${parsedCdn.origin}${parsedRaw.pathname}${parsedRaw.search}`.replace(/ /g, '%20');
        } catch (e) {
            console.error('[Azure Uploader] URL CDN tidak valid, kembali ke URL Blob default.');
        }
    }
    
    // Fallback: Mengambil video langsung dari Azure Storage Blob
    
    // Pastikan URL di-encode dengan benar (mengubah spasi menjadi %20 dll) agar player Native tidak error
    try {
        return new URL(rawUrl).href;
    } catch (e) {
        return rawUrl;
    }
}

/**
 * Initializes the container, ensuring it exists with public access
 */
async function ensureContainerExists() {
    if (!containerClient || isContainerInitialized) return;
    try {
        await containerClient.createIfNotExists({
            access: 'blob'
        });
        isContainerInitialized = true;
        console.info(`[Azure Uploader] Container "${containerName}" is ready.`);
    } catch (err) {
        console.error(`[Azure Uploader] Failed to ensure container exists:`, err.message);
    }
}

/**
 * Checks the upload status of a video
 * Returns: 'READY' | 'UPLOADING' | 'FAILED' | null (not started)
 */
export async function checkUploadStatus(seriesSlug, episodeSlug) {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    
    // Check in-memory cache ONLY for UPLOADING or FAILED
    const cachedStatus = uploadCache.get(blobPath);
    if (cachedStatus === 'UPLOADING' || cachedStatus === 'FAILED') {
        return cachedStatus;
    }

    if (!containerClient) return null;

    try {
        await ensureContainerExists();
        const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
        const exists = await blockBlobClient.exists();
        if (exists) {
            return 'READY';
        }
    } catch (err) {
        console.error(`[Azure Uploader] Error checking blob existence for ${blobPath}:`, err.message);
    }

    return cachedStatus || null;
}

/**
 * Marks the upload as failed in the cache with a 10-minute TTL
 */
export function markUploadFailed(seriesSlug, episodeSlug) {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    uploadCache.set(blobPath, 'FAILED', 600); // 10 minutes failure cache TTL
}

/**
 * Checks if there is any active upload for a specific series.
 */
export function hasActiveUploadForSeries(seriesSlug) {
    const prefix = `${seriesSlug}/`;
    const keys = uploadCache.keys();
    for (const key of keys) {
        if (key.startsWith(prefix) && uploadCache.get(key) === 'UPLOADING') {
            return true;
        }
    }
    return false;
}

/**
 * Gets the total number of active uploads globally.
 */
export function getActiveUploadCount() {
    let count = 0;
    const keys = uploadCache.keys();
    for (const key of keys) {
        if (uploadCache.get(key) === 'UPLOADING') {
            count++;
        }
    }
    return count;
}

/**
 * Melakukan download multi-thread (jika didukung) atau single-stream, lalu upload ke Azure Blob Storage
 */
export async function uploadStream(videoUrl, headers = {}, seriesSlug, episodeSlug) {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    
    if (!containerClient) {
        console.error('[Azure Uploader] Cannot upload: Container client is not configured.');
        uploadCache.set(blobPath, 'FAILED');
        return Promise.reject(new Error('Container client is not configured.'));
    }

    await ensureContainerExists();
    // Set UPLOADING state with a 30-minute TTL to prevent it from getting stuck forever if the upload crashes
    uploadCache.set(blobPath, 'UPLOADING', 1800);
    console.info(`[Azure Uploader] Starting upload for ${blobPath} from ${videoUrl}`);

    // Return the upload promise so callers can wait for it if they want
    return (async () => {
        const globalAbort = new AbortController();
        activeUploadControllers.set(blobPath, globalAbort);
        
        const tempFileName = crypto.randomUUID() + '.mp4';
        const tempFilePath = path.join(os.tmpdir(), tempFileName);
        const optimizedFilePath = path.join(os.tmpdir(), 'fast_' + tempFileName);
        
        try {
            const requestHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                ...headers
            };

            const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

            // ========================================================
            // TAHAP 1: UNDUH UTUH KE SERVER LOKAL (VPS)
            // ========================================================
            console.info(`[Azure Uploader] Tahap 1: Mengunduh ${blobPath} ke server lokal...`);
            uploadProgressCache.set(blobPath, 'Mengunduh ke Server VPS... 0%');
            
            const response = await axios({
                method: 'get',
                url: videoUrl,
                responseType: 'stream',
                headers: requestHeaders,
                timeout: 30000,
                signal: globalAbort.signal
            });

            const contentLengthStr = response.headers['content-length'];
            const contentLength = contentLengthStr ? parseInt(contentLengthStr) : 0;
            const MIN_VIDEO_SIZE = 100 * 1024; // 100 KB
            let totalDownloadedBytes = 0;

            const writer = fs.createWriteStream(tempFilePath);
            
            let nextLogThreshold = 5 * 1024 * 1024;
            response.data.on('data', (chunk) => {
                totalDownloadedBytes += chunk.length;
                if (totalDownloadedBytes >= nextLogThreshold) {
                    const downloadedMB = Math.round(totalDownloadedBytes / 1024 / 1024);
                    const msg = contentLength > MIN_VIDEO_SIZE 
                        ? `Mengunduh ke Server VPS: ${Math.round((totalDownloadedBytes / contentLength) * 100)}% (${downloadedMB}MB / ${Math.round(contentLength / 1024 / 1024)}MB)`
                        : `Mengunduh ke Server VPS: ${downloadedMB}MB...`;
                        
                    console.info(`[Azure Uploader] ${blobPath} - ${msg}`);
                    uploadProgressCache.set(blobPath, msg);
                    nextLogThreshold += 5 * 1024 * 1024;
                }
            });

            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                // Menangani pembatalan jika user exit player
                globalAbort.signal.addEventListener('abort', () => {
                    writer.destroy(new Error('UPLOAD_CANCELLED'));
                    reject(new Error('UPLOAD_CANCELLED'));
                });
            });

            // Validasi akhir ukuran file
            if (totalDownloadedBytes < MIN_VIDEO_SIZE) {
                throw new Error(`[Azure Uploader] File terlalu kecil (${totalDownloadedBytes} bytes) — URL mungkin bukan direct link video.`);
            }

            // ========================================================
            // TAHAP 2: OPTIMASI FASTSTART MENGGUNAKAN FFMPEG
            // ========================================================
            if (globalAbort.signal.aborted) throw new Error('UPLOAD_CANCELLED');
            
            console.info(`[Azure Uploader] Tahap 2: Optimasi FastStart (FFmpeg) untuk ${blobPath}...`);
            uploadProgressCache.set(blobPath, 'Mengoptimasi File MP4 (FastStart)...');
            
            try {
                // Eksekusi FFmpeg: -y (overwrite), -i (input), -c copy (tanpa konversi), -movflags faststart (pindah atom)
                await execFileAsync(ffmpegPath, [
                    '-y',
                    '-i', tempFilePath,
                    '-c', 'copy',
                    '-movflags', 'faststart',
                    optimizedFilePath
                ]);
                console.info(`[Azure Uploader] FastStart sukses diterapkan menggunakan FFmpeg untuk ${blobPath}.`);
            } catch (fastErr) {
                 console.warn('[Azure Uploader] FFmpeg FastStart gagal (Mungkin file rusak parah). Menyimpan file asli.', fastErr.message);
                 fs.copyFileSync(tempFilePath, optimizedFilePath);
            }

            // ========================================================
            // TAHAP 3: UNGGAH KE AZURE STORAGE
            // ========================================================
            if (globalAbort.signal.aborted) throw new Error('UPLOAD_CANCELLED');

            console.info(`[Azure Uploader] Tahap 3: Mengunggah file teroptimasi ke Azure Blob...`);
            uploadProgressCache.set(blobPath, 'Mengunggah ke Azure Cloud... 0%');

            const uploadAbort = new AbortController();
            const onGlobalAbort = () => uploadAbort.abort();
            globalAbort.signal.addEventListener('abort', onGlobalAbort);

            await blockBlobClient.uploadFile(optimizedFilePath, {
                concurrency: 5,
                blobHTTPHeaders: { 
                    blobContentType: 'video/mp4',
                    blobCacheControl: 'public, max-age=31536000' // Cache 1 tahun
                },
                onProgress: (ev) => {
                    const percent = totalDownloadedBytes > 0 ? Math.round((ev.loadedBytes / totalDownloadedBytes) * 100) : 0;
                    const uploadedMB = Math.round(ev.loadedBytes / 1024 / 1024);
                    const msg = `Mengunggah ke Azure Cloud: ${percent}% (${uploadedMB}MB)`;
                    // Hanya update log tiap kelipatan tertentu agar tidak spam
                    if (percent % 10 === 0) uploadProgressCache.set(blobPath, msg);
                },
                abortSignal: uploadAbort.signal
            });
            
            globalAbort.signal.removeEventListener('abort', onGlobalAbort);

            console.info(`[Azure Uploader] Berhasil mengunggah versi FastStart ke Azure: ${blobPath}`);
            uploadCache.set(blobPath, 'READY');
            uploadProgressCache.delete(blobPath);
            activeUploadControllers.delete(blobPath);

        } catch (err) {
            if (globalAbort.signal.aborted || err.message === 'UPLOAD_CANCELLED' || err.code === 'ERR_CANCELED') {
                console.info(`[Azure Uploader] Upload dibatalkan oleh pengguna: ${blobPath}`);
                uploadCache.delete(blobPath);
                uploadProgressCache.delete(blobPath);
            } else {
                console.error(`[Azure Uploader] Gagal memproses ${blobPath} dari URL ${videoUrl}:`, err.message);
                uploadCache.set(blobPath, 'FAILED', 600); // Fail for 10 minutes
                uploadProgressCache.delete(blobPath);
            }
            
            activeUploadControllers.delete(blobPath);
            
            // Cleanup partial blob jika gagal saat tahap 3
            try {
                const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
                await blockBlobClient.deleteIfExists();
            } catch (cleanupErr) {}
            
        } finally {
            // ========================================================
            // TAHAP 4: BERSIH-BERSIH DISK VPS
            // ========================================================
            try {
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                if (fs.existsSync(optimizedFilePath)) fs.unlinkSync(optimizedFilePath);
                console.info(`[Azure Uploader] Disk VPS dibersihkan untuk ${blobPath}.`);
            } catch (fsErr) {
                console.warn(`[Azure Uploader] Gagal menghapus file temporary: ${fsErr.message}`);
            }
        }
    })();
}
