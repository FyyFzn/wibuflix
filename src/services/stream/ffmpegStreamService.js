import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import pLimit from 'p-limit';
import { setMaxListeners } from 'events';
import { uploadCache, globalBlacklistCache, uploadProgressCache, activeUploadControllers, failureCountCache } from './streamStateStore.js';
import { getBlobPath, containerClient, ensureContainerExists, deleteBlobFromAzure } from './blobStorageService.js';
import { markUploadFailed } from './uploadProgressService.js';

// --- FUNGSI JDOWNLOADER & STREAM VALIDATOR ---
export async function checkRangeSupport(url, headers) {
    try {
        if (url.includes('/api/proxy/mega')) {
            return { supported: false, totalSize: 0 };
        }
        if (url.includes('.m3u8') || url.includes('/hls/')) {
            console.log(`[Ping] Memeriksa ketersediaan playlist M3U8: ${url.substring(0, 150)}`);
            const axiosConfig = {
                method: 'get',
                url: url,
                headers: headers,
                timeout: 8000
            };
            if (url.includes('127.0.0.1') || url.includes('localhost')) {
                axiosConfig.proxy = false;
            }
            const res = await axios(axiosConfig);
            if (res.status !== 200 && res.status !== 206) {
                throw new Error(`HTTP_${res.status}_M3U8_ERROR`);
            }
            if (!res.data || (typeof res.data === 'string' && !res.data.includes('#EXTM3U'))) {
                throw new Error('INVALID_M3U8_PLAYLIST');
            }
            return { supported: false, totalSize: 0 };
        }
        
        console.log(`[Ping] Memeriksa Range Support untuk URL: ${url.substring(0, 150)}`);
        const axiosConfig = {
            method: 'get',
            url: url,
            headers: { ...headers, 'Range': 'bytes=0-0' },
            timeout: 10000
        };
        // Bypass global proxy (seperti SOCKS/WARP) untuk koneksi internal
        if (url.includes('127.0.0.1') || url.includes('localhost')) {
            axiosConfig.proxy = false;
        }
        
        const res = await axios(axiosConfig);
        if (res.status === 206) {
            const contentRange = res.headers['content-range'];
            if (contentRange) {
                const match = contentRange.match(/\/(\d+)$/);
                if (match) return { supported: true, totalSize: parseInt(match[1], 10) };
            }
        }
        // Jika status 200 OK, berarti file ada tapi tidak support resume
        return { supported: false, totalSize: 0 };
    } catch (e) {
        if (e.response) {
            if (e.response.status === 429) throw new Error('HTTP_429_LIMIT');
            if (e.response.status === 404) throw new Error('HTTP_404_NOT_FOUND');
            if (e.response.status === 403) throw new Error('HTTP_403_FORBIDDEN');
            if (e.response.status >= 500) throw new Error(`HTTP_${e.response.status}_SERVER_ERROR`);
        }
        throw new Error('NETWORK_ERROR: ' + e.message);
    }
}

async function downloadChunked(url, headers, tempFilePath, totalSize, numThreads, globalAbort, blobPath) {
    const chunkSize = Math.ceil(totalSize / numThreads);
    const chunkFiles = [];
    let downloadedBytes = 0;
    let nextLogThreshold = 5 * 1024 * 1024;
    // Batasi concurrency maksimal 8 agar aman dari error 429 (Too Many Requests), tapi tetap cepat (~1 MB/s)
    const limit = pLimit(Math.min(numThreads, 8)); 
    const promises = [];
    
    // Gunakan satu event listener terpusat untuk menghindari MaxListenersExceededWarning
    const abortCallbacks = new Set();
    const handleGlobalAbort = () => {
        for (const cb of abortCallbacks) {
            try { cb(); } catch (e) {}
        }
    };
    globalAbort.signal.addEventListener('abort', handleGlobalAbort);
    
    for (let i = 0; i < numThreads; i++) {
        const start = i * chunkSize;
        const end = Math.min((i + 1) * chunkSize - 1, totalSize - 1);
        if (start > end) break;
        
        const chunkPath = `${tempFilePath}.part${i}`;
        chunkFiles.push(chunkPath);
        
        promises.push(limit(async () => {
            // Trik Anti-DDoS: Beri jeda acak 0.5 - 2.5 detik sebelum memulai tiap thread baru
            // Mencegah tembakan request serentak di milidetik yang sama agar tidak dianggap serangan bot
            const staggerDelay = 500 + Math.random() * 2000;
            await new Promise(r => setTimeout(r, staggerDelay));

            let attempt = 0;
            const maxAttempts = 3;
            
            while (attempt < maxAttempts) {
                attempt++;
                let chunkDownloadedBytes = 0;
                
                try {
                    const localAbort = new AbortController();
                    
                    const axiosConfig = {
                        method: 'get',
                        url: url,
                        responseType: 'stream',
                        headers: { ...headers, 'Range': `bytes=${start}-${end}` },
                        signal: localAbort.signal,
                        timeout: 30000
                    };
                    if (url.includes('127.0.0.1') || url.includes('localhost')) {
                        axiosConfig.proxy = false;
                    }
                    const res = await axios(axiosConfig);
                    const contentType = (res.headers['content-type'] || '').toLowerCase();
                    if (contentType.includes('text/html') || contentType.includes('application/json') || contentType.includes('manifest')) {
                        if (res.data && typeof res.data.destroy === 'function') res.data.destroy();
                        throw new Error(`[Stream Validator] Gagal. URL ini bukan video! Content-Type yang didapat: ${contentType}`);
                    }
                    
                    const writer = fs.createWriteStream(chunkPath);
                    let idleTimeout;
                    
                    const resetIdleTimeout = () => {
                        clearTimeout(idleTimeout);
                        idleTimeout = setTimeout(() => {
                            if (res.data && typeof res.data.destroy === 'function') {
                                res.data.destroy(new Error('STREAM_IDLE_TIMEOUT'));
                            }
                        }, 20000); // 20 detik tanpa data = timeout
                    };
                    
                    resetIdleTimeout();

                    res.data.on('data', (chunk) => {
                        resetIdleTimeout();
                        chunkDownloadedBytes += chunk.length;
                        downloadedBytes += chunk.length;
                        if (downloadedBytes >= nextLogThreshold) {
                            const downloadedMB = Math.round(downloadedBytes / 1024 / 1024);
                            const msg = `Mengunduh (${numThreads} Jalur): ${Math.round((downloadedBytes / totalSize) * 100)}% (${downloadedMB}MB / ${Math.round(totalSize / 1024 / 1024)}MB)`;
                            console.info(`[FFmpegStream] ${blobPath} - ${msg}`);
                            uploadProgressCache.set(blobPath, msg);
                            nextLogThreshold += 25 * 1024 * 1024;
                        }
                    });
                    
                    res.data.pipe(writer);
                    
                    await new Promise((resolve, reject) => {
                        const onAbort = () => {
                            clearTimeout(idleTimeout);
                            localAbort.abort();
                            writer.destroy(new Error('UPLOAD_CANCELLED'));
                            reject(new Error('UPLOAD_CANCELLED'));
                        };
                        
                        abortCallbacks.add(onAbort);
                        
                        writer.on('finish', () => {
                            clearTimeout(idleTimeout);
                            abortCallbacks.delete(onAbort);
                            const expectedSize = end - start + 1;
                            if (chunkDownloadedBytes < expectedSize && attempt < maxAttempts) {
                                reject(new Error(`INCOMPLETE_CHUNK: Expected ${expectedSize}, got ${chunkDownloadedBytes}`));
                            } else {
                                resolve();
                            }
                        });
                        writer.on('error', (err) => {
                            clearTimeout(idleTimeout);
                            abortCallbacks.delete(onAbort);
                            reject(err);
                        });
                        res.data.on('error', (err) => {
                            clearTimeout(idleTimeout);
                            abortCallbacks.delete(onAbort);
                            reject(err);
                        });
                    });
                    
                    // Jika sukses, keluar dari loop retry
                    break;
                } catch (err) {
                    // Kurangi bytes yang sudah terhitung agar progress bar tidak rusak
                    downloadedBytes -= chunkDownloadedBytes;
                    
                    if (err.message === 'UPLOAD_CANCELLED' || globalAbort.signal.aborted) {
                        throw err;
                    }
                    
                    if (attempt >= maxAttempts) {
                        console.error(`[FFmpegStream] Chunk ${i} gagal setelah ${maxAttempts} percobaan: ${err.message}`);
                        throw err;
                    }
                    
                    console.warn(`[FFmpegStream] Chunk ${i} gagal/stuck, mengulang (${attempt}/${maxAttempts})... Error: ${err.message}`);
                    await new Promise(r => setTimeout(r, 2000)); // jeda sebelum retry
                }
            }
        }));
    }
    
    await Promise.all(promises);
    globalAbort.signal.removeEventListener('abort', handleGlobalAbort);
    
    console.info(`[FFmpegStream] Pengunduhan multi-jalur selesai. Menggabungkan ${chunkFiles.length} file...`);
    uploadProgressCache.set(blobPath, 'Menggabungkan potongan file...');
    
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    for (const chunkPath of chunkFiles) {
        if (!fs.existsSync(chunkPath)) throw new Error(`Chunk hilang: ${chunkPath}`);
        await new Promise((resolve, reject) => {
            const reader = fs.createReadStream(chunkPath);
            const writer = fs.createWriteStream(tempFilePath, { flags: 'a' });
            reader.pipe(writer);
            reader.on('end', () => {
                fs.unlinkSync(chunkPath);
                resolve();
            });
            reader.on('error', reject);
            writer.on('error', reject);
        });
    }
}

/**
 * Melakukan download multi-thread (jika didukung) atau single-stream, lalu upload ke Azure Blob Storage
 */
export async function uploadStream(videoUrl, headers = {}, seriesSlug, episodeSlug, source = 'player') {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    
    if (!containerClient) {
        console.error('[FFmpegStream] Cannot upload: Container client is not configured.');
        uploadCache.set(blobPath, 'FAILED');
        return Promise.reject(new Error('Container client is not configured.'));
    }

    await ensureContainerExists();
    uploadCache.set(blobPath, 'UPLOADING', 1800);
    console.info(`[FFmpegStream] Starting upload for ${blobPath} from ${videoUrl}`);

    return (async () => {
        const globalAbort = new AbortController();
        try { setMaxListeners(50, globalAbort.signal); } catch (e) {}
        
        const appTmpDir = path.join(os.tmpdir(), 'wibuflix_temp');
        if (!fs.existsSync(appTmpDir)) fs.mkdirSync(appTmpDir, { recursive: true });
        const tempFileName = crypto.randomUUID() + '.mp4';
        const tempFilePath = path.join(appTmpDir, tempFileName);
        const hlsOutputDir = path.join(appTmpDir, `hls_${crypto.randomUUID()}`);
        
        activeUploadControllers.set(blobPath, { abortController: globalAbort, tempFilePath, source });
        
        try {
            if (fs.existsSync(hlsOutputDir)) fs.rmSync(hlsOutputDir, { recursive: true, force: true });
            fs.mkdirSync(hlsOutputDir, { recursive: true });
            const requestHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/124.0.0.0',
                ...headers
            };

            let isM3u8Input = videoUrl.includes('.m3u8');
            let isPipeMode = false;
            let ffmpegInputSource = videoUrl;
            let streamSource = null;

            if (isM3u8Input) {
                console.info(`[FFmpegStream] Mode M3U8: FFmpeg membaca dari URL.`);
                uploadProgressCache.set(blobPath, 'Menghubungkan ke stream M3U8...');
            } else {
                uploadProgressCache.set(blobPath, 'Menghubungkan ke server...');
                const rangeCheck = await checkRangeSupport(videoUrl, requestHeaders);
                
                let numThreads = 1;
                const hostLow = videoUrl.toLowerCase();
                if (hostLow.includes('kraken')) numThreads = 16;
                if (
                    hostLow.includes('googleapis') ||
                    hostLow.includes('drive.google') ||
                    hostLow.includes('mediafire') ||
                    hostLow.includes('pixeldrain') ||
                    hostLow.includes('wibufile')
                ) {
                    numThreads = 2; // Turunkan dari 4 ke 2 agar bandwidth VPS tidak habis oleh download, sisakan untuk Puppeteer/scraper
                }
                
                if (rangeCheck.supported && numThreads > 1) {
                    console.info(`[FFmpegStream] Mode JDownloader/Kraken. Mengunduh ke VPS lokal...`);
                    ffmpegInputSource = tempFilePath;
                    await downloadChunked(videoUrl, requestHeaders, tempFilePath, rangeCheck.totalSize, numThreads, globalAbort, blobPath);
                } else if (videoUrl.includes('/api/proxy/mega')) {
                    console.info(`[FFmpegStream] Mode Mega: Mengalirkan data (Pipe) ke FFmpeg...`);
                    isPipeMode = true;
                    uploadProgressCache.set(blobPath, 'Menyiapkan aliran Mega...');
                    
                    const megaUrl = new URL(videoUrl).searchParams.get('url');
                    const { File } = await import('megajs');
                    const file = File.fromURL(megaUrl);
                    await file.loadAttributes();
                    streamSource = file.download({ maxConnections: 2 });
                    streamSource.on('error', (err) => {
                        console.error('[FFmpegStream] Mega Stream Error:', err.message);
                        console.warn('[FFmpegStream] Mega limit/blocked/disconnected hit. Blacklisting Mega for 10 minutes.');
                        globalBlacklistCache.set('mega_blacklist', true, 600); // 10 minutes TTL
                    });
                } else {
                    console.info(`[FFmpegStream] Mode Single Stream: Mengalirkan data (Pipe)...`);
                    isPipeMode = true;
                    uploadProgressCache.set(blobPath, 'Mengalirkan video ke mesin...');
                    
                    const axiosConfig = {
                        method: 'get',
                        url: videoUrl,
                        responseType: 'stream',
                        headers: requestHeaders,
                        timeout: 30000,
                        validateStatus: () => true,
                        signal: globalAbort.signal
                    };
                    if (videoUrl.includes('127.0.0.1') || videoUrl.includes('localhost')) {
                        axiosConfig.proxy = false;
                    }
                    const response = await axios(axiosConfig);
                    const contentType = (response.headers['content-type'] || '').toLowerCase();
                    if (response.status !== 200 && response.status !== 206) {
                        if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
                        throw new Error(`[Stream Error] HTTP Status ${response.status} tidak valid untuk stream video`);
                    }
                    if (contentType.includes('text/html') || contentType.includes('application/json') || contentType.includes('manifest')) {
                        if (response.data && typeof response.data.destroy === 'function') response.data.destroy(); // Bunuh stream-nya segera
                        throw new Error(`[Stream Validator] Gagal. URL ini bukan video! Content-Type yang didapat: ${contentType}`);
                    }
                    streamSource = response.data;
                }
            }

            if (globalAbort.signal.aborted) throw new Error('UPLOAD_CANCELLED');

            console.info(`[FFmpegStream] Memulai pemotongan HLS paralel untuk ${blobPath}`);
            uploadProgressCache.set(blobPath, 'Memproses video & Mengunggah cicilan HLS...');
            
            const baseAzurePath = `${seriesSlug}/${episodeSlug}`;
            const m3u8Path = path.join(hlsOutputDir, 'playlist.m3u8');
            
            let ffmpegArgs = ['-y'];
            if (isM3u8Input) {
                ffmpegArgs.push(
                    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
                    '-reconnect', '1', 
                    '-reconnect_streamed', '1', 
                    '-reconnect_delay_max', '10'
                );
                if (requestHeaders['User-Agent']) ffmpegArgs.push('-user_agent', requestHeaders['User-Agent']);
                if (requestHeaders['Referer']) ffmpegArgs.push('-referer', requestHeaders['Referer']);
                const headersArray = [];
                if (requestHeaders['Origin']) headersArray.push(`Origin: ${requestHeaders['Origin']}`);
                if (headersArray.length > 0) ffmpegArgs.push('-headers', headersArray.join('\r\n') + '\r\n');
            }

            ffmpegArgs.push(
                '-fflags', '+genpts',
                '-i', isPipeMode ? 'pipe:0' : ffmpegInputSource,
                '-map', '0:v?',
                '-map', '0:a?',
                '-c', 'copy',
                '-max_muxing_queue_size', '1024',
                '-f', 'hls',
                '-hls_time', '10',
                '-hls_playlist_type', 'vod',
                '-hls_flags', 'independent_segments+temp_file',
                '-hls_segment_filename', path.join(hlsOutputDir, 'seg_%03d.ts'),
                m3u8Path
            );

            await new Promise((resolve, reject) => {
                let isFfmpegDone = false;
                let isUploadError = false;
                const uploadLimit = pLimit(3);
                let ffmpegProcess;
                
                const onAbort = () => {
                    isUploadError = true;
                    if (ffmpegProcess) {
                        try { ffmpegProcess.kill(); } catch(e){}
                    }
                    reject(new Error('UPLOAD_CANCELLED'));
                };
                globalAbort.signal.addEventListener('abort', onAbort);

                // Jalankan FFmpeg dengan prioritas rendah (nice -n 15) agar CPU VPS
                // selalu memprioritaskan Puppeteer/scraper (interaksi user) di atas pemotongan HLS latar belakang
                ffmpegProcess = spawn('nice', ['-n', '15', ffmpegPath, ...ffmpegArgs], {
                    stdio: isPipeMode ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
                });

                let ffmpegStderr = '';
                ffmpegProcess.stderr.on('data', (chunk) => { ffmpegStderr += chunk.toString(); });

                ffmpegProcess.on('error', (error) => {
                    globalAbort.signal.removeEventListener('abort', onAbort);
                    if (!isUploadError) {
                        reject(new Error(`FFmpeg Gagal: ${error.message}`));
                    }
                });

                ffmpegProcess.on('close', (code) => {
                    globalAbort.signal.removeEventListener('abort', onAbort);
                    if (code !== 0 && !isUploadError) {
                        if (videoUrl && videoUrl.includes('/api/proxy/mega')) {
                            console.warn('[FFmpegStream] Mega FFmpeg error. Blacklisting Mega for 10 minutes.');
                            globalBlacklistCache.set('mega_blacklist', true, 600);
                        }
                        reject(new Error(`FFmpeg Gagal (exit code ${code}):\n${ffmpegStderr}`));
                        return;
                    }
                    isFfmpegDone = true;
                });

                if (isPipeMode && streamSource) {
                    streamSource.pipe(ffmpegProcess.stdin);
                    streamSource.on('error', (err) => {
                        isUploadError = true;
                        try { ffmpegProcess.kill(); } catch(e){}
                        if (videoUrl && videoUrl.includes('/api/proxy/mega')) {
                            console.warn('[FFmpegStream] Mega stream putus. Blacklisting Mega for 10 minutes.');
                            globalBlacklistCache.set('mega_blacklist', true, 600);
                        }
                        reject(new Error(`Stream putus: ${err.message}`));
                    });
                }

                let totalUploadedChunks = 0;
                let finalSweepTriggered = false; // Mencegah double resolve
                let isProcessingInterval = false; // Mencegah overlap interval
                
                const intervalId = setInterval(async () => {
                    if (isProcessingInterval) return;
                    isProcessingInterval = true;
                    try {
                        if (isUploadError) {
                            clearInterval(intervalId);
                            return;
                        }
                        
                        if (isFfmpegDone && !finalSweepTriggered) {
                            finalSweepTriggered = true;
                            clearInterval(intervalId);
                            uploadProgressCache.set(blobPath, 'Menyelesaikan playlist akhir...');
                            
                            const remainingFiles = fs.readdirSync(hlsOutputDir);
                            const finalTsFiles = remainingFiles.filter(f => f.endsWith('.ts'));
                            
                            const totalTsCount = totalUploadedChunks + finalTsFiles.length;
                            if (totalTsCount <= 2 && !blobPath.includes('trailer')) {
                                if (videoUrl && videoUrl.includes('/api/proxy/mega')) {
                                    console.warn('[FFmpegStream] Mega failed to provide segments. Blacklisting Mega for 10 minutes.');
                                    globalBlacklistCache.set('mega_blacklist', true, 600);
                                }
                                reject(new Error('Koneksi terputus di tengah jalan: Hanya mendapatkan 1-2 segmen video. Silakan coba server lain.'));
                                return;
                            }

                            await Promise.all(remainingFiles.map(file => uploadLimit(async () => {
                                const localPath = path.join(hlsOutputDir, file);
                                if (file.endsWith('.tmp') || file.endsWith('.uploading')) return;
                                
                                const azureDest = `${baseAzurePath}/${file}`;
                                const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
                                
                                if (!fs.existsSync(localPath)) return;
                                const stats = fs.statSync(localPath);
                                if (stats.size === 0) return;

                                const blockBlobClient = containerClient.getBlockBlobClient(azureDest);
                                await blockBlobClient.uploadFile(localPath, {
                                    blobHTTPHeaders: { 
                                        blobContentType: type, 
                                        blobCacheControl: 'public, max-age=31536000' 
                                    },
                                    abortSignal: globalAbort.signal
                                });
                                try { fs.unlinkSync(localPath); } catch (e) {}
                            })));

                            resolve();
                            return;
                        }
                        
                        const files = fs.readdirSync(hlsOutputDir);
                        // HANYA ambil file .ts, ABAIKAN file .tmp (karena temp_file flag)
                        const validTsFiles = files.filter(f => f.endsWith('.ts')).sort();
                        
                        // Tidak perlu lagi membuang file terakhir (pop) karena dijamin sudah selesai ditulis oleh FFmpeg temp_file flag
                        if (validTsFiles.length === 0) {
                            isProcessingInterval = false;
                            return;
                        }

                        await Promise.all(validTsFiles.map(file => uploadLimit(async () => {
                            if (isUploadError) return;
                            const localPath = path.join(hlsOutputDir, file);
                            const azureDest = `${baseAzurePath}/${file}`;
                            
                            if (!fs.existsSync(localPath)) return;
                            
                            const stats = fs.statSync(localPath);
                            if (stats.size === 0) return;

                            // Pindahkan file ke direktori staging sebelum upload untuk mencegah lock conflict & race condition
                            const stagingPath = localPath + '.uploading';
                            try {
                                fs.renameSync(localPath, stagingPath);
                            } catch (renameErr) {
                                return;
                            }

                            const blockBlobClient = containerClient.getBlockBlobClient(azureDest);
                            await blockBlobClient.uploadFile(stagingPath, {
                                blobHTTPHeaders: { 
                                    blobContentType: 'video/mp2t', 
                                    blobCacheControl: 'public, max-age=31536000' 
                                },
                                abortSignal: globalAbort.signal
                            });
                            
                            try { fs.unlinkSync(stagingPath); } catch (e) {}
                            totalUploadedChunks++;
                            uploadProgressCache.set(blobPath, `Mencicil unggahan pecahan video... (${totalUploadedChunks} pecahan terkirim)`);
                        })));

                    } catch (err) {
                        isUploadError = true;
                        clearInterval(intervalId);
                        try { ffmpegProcess.kill(); } catch(e){}
                        reject(new Error('Gagal mencicil ke Azure: ' + err.message));
                    } finally {
                        isProcessingInterval = false;
                    }
                }, 4000);
            });

            console.info(`[FFmpegStream] Berhasil mengunggah versi HLS ke Azure secara Estafet: ${blobPath}`);
            uploadCache.set(blobPath, 'READY');
            uploadProgressCache.delete(blobPath);
            activeUploadControllers.delete(blobPath);
            failureCountCache.delete(blobPath);

        } catch (err) {
            if (globalAbort.signal.aborted || err.message === 'UPLOAD_CANCELLED' || err.code === 'ERR_CANCELED') {
                console.info(`[FFmpegStream] Upload dibatalkan: ${blobPath}`);
                uploadCache.del(blobPath);
                uploadProgressCache.delete(blobPath);
            } else {
                console.error(`[FFmpegStream] Gagal memproses ${blobPath} dari URL ${videoUrl}:`, err.message);
                if (videoUrl && (videoUrl.includes('/api/proxy/mega') || videoUrl.toLowerCase().includes('mega.nz'))) {
                    console.warn('[FFmpegStream] Mega upload gagal total/diblokir. Memasukkan Mega ke Blacklist Global selama 10 menit...');
                    globalBlacklistCache.set('mega_blacklist', true, 600);
                }
                markUploadFailed(seriesSlug, episodeSlug);
                uploadProgressCache.delete(blobPath);
            }
            // Hapus playlist.m3u8 parsial dari Azure jika upload gagal atau dibatalkan agar tidak dianggap READY oleh checkUploadStatus
            if (containerClient) {
                try {
                    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
                    blockBlobClient.deleteIfExists().catch(() => {});
                } catch (delErr) {}
            }
            activeUploadControllers.delete(blobPath);
            throw err;
        } finally {
            try {
                if (!globalAbort.signal.aborted) {
                    globalAbort.abort();
                }
                
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                
                for (let i = 0; i < 32; i++) {
                    const chunkPath = `${tempFilePath}.part${i}`;
                    if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath);
                }
                
                if (hlsOutputDir && fs.existsSync(hlsOutputDir)) fs.rmSync(hlsOutputDir, { recursive: true, force: true });
            } catch (fsErr) {
                // Abaikan
            }
        }
    })();
}
