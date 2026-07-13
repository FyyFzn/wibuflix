import { initLogger } from './src/utils/logger.js';
initLogger();
import { startServer } from './src/server.js';

process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err);
    // Biarkan aplikasi tetap berjalan (jangan crash)
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
    // Biarkan aplikasi tetap berjalan
});

startServer();