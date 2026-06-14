// server-prod.js
// Script ini digunakan khusus untuk mode Production (Deployment di Azure, dll)
// Berfungsi untuk menonaktifkan console.log agar menghemat penggunaan CPU dan I/O.

const originalLog = console.log;
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;

global.forceLog = originalLog;
global.memLogs = []; // Array untuk menyimpan 500 log terakhir

function pushLog(type, ...args) {
    const msg = `[${new Date().toISOString()}] [${type}] ` + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    global.memLogs.push(msg);
    if (global.memLogs.length > 500) global.memLogs.shift();
}

console.log = function (...args) { pushLog('LOG', ...args); };
console.debug = function () { }; // Biarkan debug mati
console.info = function (...args) { pushLog('INFO', ...args); originalInfo(...args); };
console.warn = function (...args) { pushLog('WARN', ...args); originalWarn(...args); };
console.error = function (...args) { pushLog('ERROR', ...args); originalError(...args); };

// Mulai aplikasi utama persis seperti biasa
import { startServer } from './src/server.js';
startServer();
