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
