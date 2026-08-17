import fs from 'fs';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import pLimit from 'p-limit';
import { uploadProgressCache } from './streamStateStore.js';
import { uploadSegmentStaged, uploadRemainingFilesToAzure } from './azureSegmentUploader.js';

/**
 * Menjalankan FFmpeg dengan prioritas rendah (nice -n 15) dan memantau segmen HLS untuk diunggah secara estafet ke Azure.
 */
export async function transcodeAndMonitorHLS({
    videoUrl,
    requestHeaders,
    isM3u8Input,
    isPipeMode,
    ffmpegInputSource,
    streamSource,
    hlsOutputDir,
    baseAzurePath,
    globalAbort,
    blobPath
}) {
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

    return await new Promise((resolve, reject) => {
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
                reject(new Error(`Stream putus: ${err.message}`));
            });
        }

        const totalUploadedChunksRef = { count: 0 };
        let finalSweepTriggered = false;
        let isProcessingInterval = false;
        
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
                    
                    const totalTsCount = totalUploadedChunksRef.count + finalTsFiles.length;
                    if (totalTsCount <= 2 && !blobPath.includes('trailer')) {
                        reject(new Error('Koneksi terputus di tengah jalan: Hanya mendapatkan 1-2 segmen video. Silakan coba server lain.'));
                        return;
                    }

                    await uploadRemainingFilesToAzure(hlsOutputDir, baseAzurePath, globalAbort, uploadLimit);

                    resolve();
                    return;
                }
                
                const files = fs.readdirSync(hlsOutputDir);
                const validTsFiles = files.filter(f => f.endsWith('.ts')).sort();
                
                if (validTsFiles.length === 0) {
                    isProcessingInterval = false;
                    return;
                }

                await Promise.all(validTsFiles.map(file => uploadLimit(async () => {
                    if (isUploadError) return;
                    const localPath = path.join(hlsOutputDir, file);
                    const azureDest = `${baseAzurePath}/${file}`;
                    await uploadSegmentStaged(localPath, azureDest, globalAbort, blobPath, totalUploadedChunksRef);
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
}
