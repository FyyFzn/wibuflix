import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function migrateOldData(oldDir, newDir) {
    if (!fs.existsSync(oldDir)) return;
    const files = ['anime_db.json', 'otakudesu_db.json', 'tmdb_cache.json'];
    files.forEach(file => {
        const oldPath = path.join(oldDir, file);
        const newPath = path.join(newDir, file);
        if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
            try {
                fs.copyFileSync(oldPath, newPath);
                console.log(`[Auto-Migrate] Berhasil menyalin ${file} ke ${newDir}`);
            } catch (e) {
                console.error(`[Auto-Migrate] Gagal menyalin ${file}:`, e.message);
            }
        }
    });
}

export function getDataDir() {
    const localPath = path.join(__dirname, '../../data');

    // 1. Prioritas Utama: Azure Linux App Service (sesuai tutorial)
    // Azure mem-mount WEBSITES_ENABLE_APP_SERVICE_STORAGE ke /home
    const azureLinuxPath = '/home/data';
    if (fs.existsSync('/home')) {
        if (!fs.existsSync(azureLinuxPath)) {
            fs.mkdirSync(azureLinuxPath, { recursive: true });
        }
        migrateOldData(localPath, azureLinuxPath);
        return azureLinuxPath;
    }
    
    // 2. Azure Windows App Service
    const azureWindowsPath = 'D:\\home\\data';
    if (fs.existsSync('D:\\home')) {
        if (!fs.existsSync(azureWindowsPath)) {
            fs.mkdirSync(azureWindowsPath, { recursive: true });
        }
        migrateOldData(localPath, azureWindowsPath);
        return azureWindowsPath;
    }

    // 3. Fallback lingkungan lokal (Komputer Anda)
    if (!fs.existsSync(localPath)) {
        fs.mkdirSync(localPath, { recursive: true });
    }
    return localPath;
}
