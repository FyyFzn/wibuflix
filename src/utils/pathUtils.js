const path = require('path');
const fs = require('fs');

function getDataDir() {
    // 1. Prioritas Utama: Azure Linux App Service (sesuai tutorial)
    // Azure mem-mount WEBSITES_ENABLE_APP_SERVICE_STORAGE ke /home
    const azureLinuxPath = '/home/data';
    if (fs.existsSync('/home')) {
        if (!fs.existsSync(azureLinuxPath)) {
            fs.mkdirSync(azureLinuxPath, { recursive: true });
        }
        return azureLinuxPath;
    }
    
    // 2. Azure Windows App Service
    const azureWindowsPath = 'D:\\home\\data';
    if (fs.existsSync('D:\\home')) {
        if (!fs.existsSync(azureWindowsPath)) {
            fs.mkdirSync(azureWindowsPath, { recursive: true });
        }
        return azureWindowsPath;
    }

    // 3. Fallback lingkungan lokal (Komputer Anda)
    const localPath = path.join(__dirname, '../../data');
    if (!fs.existsSync(localPath)) {
        fs.mkdirSync(localPath, { recursive: true });
    }
    return localPath;
}

module.exports = { getDataDir };
