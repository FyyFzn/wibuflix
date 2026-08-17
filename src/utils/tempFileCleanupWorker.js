import fs from 'fs';
import path from 'path';
import os from 'os';

const APP_TMP_DIR = path.join(os.tmpdir(), 'wibuflix_temp');

/**
 * Memastikan direktori sementara wibuflix_temp ada.
 */
export function ensureAppTmpDir() {
    if (!fs.existsSync(APP_TMP_DIR)) {
        fs.mkdirSync(APP_TMP_DIR, { recursive: true });
    }
    return APP_TMP_DIR;
}

/**
 * Menyapu dan membersihkan file sampah serta direktori hls_* atau .part dari sesi sebelumnya
 * tanpa memblokir event loop.
 */
export function sweepOrphanedTempFiles() {
    ensureAppTmpDir();
    console.log('[System] Menyapu file sampah dari sesi sebelumnya...');
    fs.readdir(APP_TMP_DIR, (err, files) => {
        if (err) return console.warn('[System] Gagal memindai direktori temp:', err.message);
        files.forEach(file => {
            const fullPath = path.join(APP_TMP_DIR, file);
            fs.rm(fullPath, { recursive: true, force: true }, err => {
                if (err && err.code !== 'ENOENT') console.warn(`Gagal menghapus: ${file}`);
            });
        });
    });
}

/**
 * Membersihkan file sementara secara asinkron tanpa memblokir Event Loop Node.js.
 * Menghapus file .mp4 temp, bagian-bagian .partN, serta direktori HLS output jika ada.
 */
export async function cleanTempFilesAsync(tempFilePath, hlsOutputDir = null) {
    if (tempFilePath) {
        fs.promises.unlink(tempFilePath).catch(() => {});
        for (let i = 0; i < 32; i++) {
            const chunkPath = `${tempFilePath}.part${i}`;
            fs.promises.unlink(chunkPath).catch(() => {});
        }
    }
    if (hlsOutputDir) {
        fs.promises.rm(hlsOutputDir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Menjalankan pembersihan stale temp files sekali di awal lalu setiap 12 jam.
 * Dipanggil oleh scheduler — bukan oleh server startup sweep.
 */
export function scheduledCleanup() {
    const runClean = () => {
        ensureAppTmpDir();
        fs.readdir(APP_TMP_DIR, (err, files) => {
            if (err) return;
            const now = Date.now();
            files.forEach(file => {
                if (file.startsWith('hls_') || file.includes('.part')) {
                    const filePath = path.join(APP_TMP_DIR, file);
                    fs.stat(filePath, (statErr, stats) => {
                        if (stats && (now - stats.mtimeMs > 4 * 60 * 60 * 1000)) {
                            fs.rm(filePath, { recursive: true, force: true }, () => {
                                console.log(`[CleanUp] 🧹 Hapus file/folder sampah lawas: ${file}`);
                            });
                        }
                    });
                }
            });
        });
    };

    runClean();
    setInterval(runClean, 12 * 60 * 60 * 1000);
}
