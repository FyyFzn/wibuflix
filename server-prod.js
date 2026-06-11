// server-prod.js
// Script ini digunakan khusus untuk mode Production (Deployment di Azure, dll)
// Berfungsi untuk menonaktifkan console.log agar menghemat penggunaan CPU dan I/O.

const originalLog = console.log;

// Membuka akses untuk log penting saat startup
global.forceLog = originalLog;

// Mematikan log standar untuk mengurangi I/O
console.log = function () { };
console.debug = function () { };
// console.info tetap menyala untuk log informatif aplikasi kita

// Catatan: console.error dan console.warn sengaja TIDAK dimatikan 
// agar jika terjadi error kritis di server, Anda tetap bisa melihat log-nya.

// Mulai aplikasi utama persis seperti biasa
import { startServer } from './src/server.js';
startServer();
