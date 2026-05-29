// server-prod.js
// Script ini digunakan khusus untuk mode Production (Deployment di Azure, dll)
// Berfungsi untuk menonaktifkan console.log agar menghemat penggunaan CPU dan I/O.

const originalLog = console.log;

// Mematikan log standar
console.log = function() {};
console.debug = function() {};
console.info = function() {};

// Catatan: console.error dan console.warn sengaja TIDAK dimatikan 
// agar jika terjadi error kritis di server, Anda tetap bisa melihat log-nya.

originalLog('🚀 Memulai server dalam mode PRODUCTION (Log standar dinonaktifkan untuk kecepatan maksimal)...');

// Mulai aplikasi utama persis seperti biasa
const { startServer } = require('./src/server');
startServer();
