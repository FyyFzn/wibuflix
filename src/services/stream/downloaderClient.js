import axios from 'axios';
import fs from 'fs';
import pLimit from 'p-limit';
import { uploadProgressCache, globalBlacklistCache } from './streamStateStore.js';

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

export async function downloadChunked(url, headers, tempFilePath, totalSize, numThreads, globalAbort, blobPath) {
    const chunkSize = Math.ceil(totalSize / numThreads);
    const chunkFiles = [];
    let downloadedBytes = 0;
    let nextLogThreshold = 5 * 1024 * 1024;
    const limit = pLimit(Math.min(numThreads, 8)); 
    const promises = [];
    
    const abortCallbacks = new Set();
    const handleGlobalAbort = () => {
        for (const cb of abortCallbacks) {
            try { cb(); } catch (e) {}
        }
    };
    globalAbort.signal.addEventListener('abort', handleGlobalAbort);
    
    try {
        const fd = fs.openSync(tempFilePath, 'w');
        fs.ftruncateSync(fd, totalSize);
        fs.closeSync(fd);
    } catch (err) {
        console.error(`[FFmpegStream] Gagal mengalokasikan file ${tempFilePath}:`, err.message);
        throw err;
    }

    for (let i = 0; i < numThreads; i++) {
        const start = i * chunkSize;
        const end = Math.min((i + 1) * chunkSize - 1, totalSize - 1);
        if (start > end) break;
        
        promises.push(limit(async () => {
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
                    
                    const writer = fs.createWriteStream(tempFilePath, { flags: 'r+', start: start });
                    let idleTimeout;
                    
                    const resetIdleTimeout = () => {
                        clearTimeout(idleTimeout);
                        idleTimeout = setTimeout(() => {
                            if (res.data && typeof res.data.destroy === 'function') {
                                res.data.destroy(new Error('STREAM_IDLE_TIMEOUT'));
                            }
                        }, 20000);
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
                    
                    break;
                } catch (err) {
                    downloadedBytes -= chunkDownloadedBytes;
                    if (err.message === 'UPLOAD_CANCELLED' || globalAbort.signal.aborted) {
                        throw err;
                    }
                    if (attempt >= maxAttempts) {
                        console.error(`[FFmpegStream] Chunk gagal setelah ${maxAttempts} percobaan: ${err.message}`);
                        throw err;
                    }
                    console.warn(`[FFmpegStream] Chunk gagal/stuck, mengulang (${attempt}/${maxAttempts})... Error: ${err.message}`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }));
    }
    
    await Promise.all(promises);
    globalAbort.signal.removeEventListener('abort', handleGlobalAbort);
    
    console.info(`[FFmpegStream] Pengunduhan multi-jalur selesai. Langsung memulai proses...`);
}

export async function downloadFromMega(megaUrl, tempFilePath, globalAbort, blobPath) {
    uploadProgressCache.set(blobPath, 'Menyiapkan unduhan Mega...');
    
    // Unwrap the proxy URL if it exists
    let finalUrl = megaUrl;
    if (finalUrl.includes('/api/proxy/mega')) {
        try {
            const urlObj = new URL(finalUrl);
            const rawUrl = urlObj.searchParams.get('url');
            if (rawUrl) finalUrl = decodeURIComponent(rawUrl);
        } catch(e) {
            console.warn(`[FFmpegStream] Gagal mengekstrak raw URL dari Mega proxy: ${e.message}`);
        }
    }

    const { File } = await import('megajs');
    const file = File.fromURL(finalUrl);
    await file.loadAttributes();
    
    const totalMegaSize = file.size || 0;
    const totalMegaMB = Math.round(totalMegaSize / 1024 / 1024);
    let downloadedMegaBytes = 0;
    let nextMegaLogThreshold = 5 * 1024 * 1024;

    return await new Promise((resolve, reject) => {
        const megaStream = file.download({ maxConnections: 4 });
        const writer = fs.createWriteStream(tempFilePath);
        
        const onAbort = () => {
            try { megaStream.destroy(); } catch (e) {}
            writer.destroy(new Error('UPLOAD_CANCELLED'));
            reject(new Error('UPLOAD_CANCELLED'));
        };
        globalAbort.signal.addEventListener('abort', onAbort, { once: true });

        megaStream.on('data', (chunk) => {
            downloadedMegaBytes += chunk.length;
            if (totalMegaSize > 0 && downloadedMegaBytes >= nextMegaLogThreshold) {
                const downloadedMB = Math.round(downloadedMegaBytes / 1024 / 1024);
                const msg = `Mengunduh dari Mega: ${Math.round((downloadedMegaBytes / totalMegaSize) * 100)}% (${downloadedMB}MB / ${totalMegaMB}MB)`;
                console.info(`[FFmpegStream] ${blobPath} - ${msg}`);
                uploadProgressCache.set(blobPath, msg);
                nextMegaLogThreshold += 25 * 1024 * 1024;
            } else if (totalMegaSize === 0 && downloadedMegaBytes >= nextMegaLogThreshold) {
                const downloadedMB = Math.round(downloadedMegaBytes / 1024 / 1024);
                const msg = `Mengunduh dari Mega: ${downloadedMB}MB...`;
                console.info(`[FFmpegStream] ${blobPath} - ${msg}`);
                uploadProgressCache.set(blobPath, msg);
                nextMegaLogThreshold += 25 * 1024 * 1024;
            }
        });

        megaStream.pipe(writer);

        writer.on('finish', () => {
            globalAbort.signal.removeEventListener('abort', onAbort);
            console.info(`[FFmpegStream] ✓ Unduhan Mega selesai (${Math.round(downloadedMegaBytes / 1024 / 1024)}MB). Memulai pemotongan HLS lokal...`);
            resolve();
        });

        writer.on('error', (err) => {
            globalAbort.signal.removeEventListener('abort', onAbort);
            reject(err);
        });

        megaStream.on('error', (err) => {
            globalAbort.signal.removeEventListener('abort', onAbort);
            if (globalAbort.signal.aborted) {
                try { writer.destroy(err); } catch (e) {}
                return reject(new Error('UPLOAD_CANCELLED'));
            }
            console.error('[FFmpegStream] Mega Download Error:', err.message);
            console.warn('[FFmpegStream] Mega limit/blocked/disconnected hit. Blacklisting Mega for 10 minutes.');
            globalBlacklistCache.set('mega_blacklist', true, 600);
            try { writer.destroy(err); } catch (e) {}
            reject(err);
        });
    });
}
