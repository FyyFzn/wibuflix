// server-prod.js
// Script ini digunakan khusus untuk mode Production (Deployment di Azure, dll)
// Berfungsi untuk menonaktifkan log terminal standar agar menghemat CPU/IO dan mencegah buffer overflow pada named pipe Azure,
// namun tetap menyimpan log ke global.memLogs dengan format bersih untuk Live Terminal UI di Admin Dashboard.

import { initLogger } from './src/utils/logger.js';
initLogger({ productionSilent: true });

// Mulai aplikasi utama persis seperti biasa
import { startServer } from './src/server.js';
startServer();
