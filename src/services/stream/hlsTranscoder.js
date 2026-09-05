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
        const uploadLimit = pLimit(12); // Increased concurrency from 3 to 12
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

        ffmpegProcess.on('close', async (code) => {
            globalAbort.signal.removeEventListener('abort', onAbort);
            if (code !== 0 && !isUploadError) {
                reject(new Error(`FFmpeg Gagal (exit code ${code}):\n${ffmpegStderr}`));
                return;
            }
            
            try {
                if (isUploadError) return;
                
                uploadProgressCache.set(blobPath, 'Mengunggah file HLS utuh ke server...');
                
                const remainingFiles = fs.readdirSync(hlsOutputDir);
                const tsFiles = remainingFiles.filter(f => f.endsWith('.ts'));
                
                if (tsFiles.length <= 2 && !blobPath.includes('trailer')) {
                    reject(new Error('Koneksi terputus di tengah jalan: Hanya mendapatkan 1-2 segmen video. Silakan coba server lain.'));
                    return;
                }

                await uploadRemainingFilesToAzure(hlsOutputDir, baseAzurePath, globalAbort, uploadLimit);
                resolve();
            } catch (err) {
                if (!isUploadError) {
                    reject(new Error('Gagal mengunggah file utuh ke Azure: ' + err.message));
                }
            }
        });

        if (isPipeMode && streamSource) {
            streamSource.pipe(ffmpegProcess.stdin);
            streamSource.on('error', (err) => {
                isUploadError = true;
                try { ffmpegProcess.kill(); } catch(e){}
                reject(new Error(`Stream putus: ${err.message}`));
            });
        }
    });
}
