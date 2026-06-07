const path = require('path');
const fs = require('fs');

function getDataDir() {
    // Lingkungan Azure Web App (baik Linux maupun Windows) menggunakan variabel HOME.
    // Di Windows Azure, HOME biasanya menunjuk ke D:\home
    // Di Linux Azure, HOME menunjuk ke /home
    // Direktori ini bersifat persisten dan tidak terpengaruh oleh Local Cache atau Git Deployments.
    if (process.env.HOME && fs.existsSync(process.env.HOME)) {
        return path.join(process.env.HOME, 'data');
    }
    
    // Fallback eksplisit untuk Azure Windows jika process.env.HOME tidak terbaca
    if (fs.existsSync('D:\\home')) {
        return path.join('D:\\home', 'data');
    }

    // Fallback lingkungan lokal (Komputer Anda)
    // Akan menyimpan di samehadaku-scraper/data
    return path.join(__dirname, '../../data');
}

module.exports = { getDataDir };
