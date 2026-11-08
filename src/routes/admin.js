// ============================================================
// ROUTER: ADMIN ROUTES (THIN ROUTER / NO GOD CODE)
// ============================================================

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import * as adminCtrl from '../controllers/adminController.js';
import { handleAiChat } from '../controllers/aiAdminController.js';
import { adminAuthMiddleware } from '../middlewares/adminAuthMiddleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Helper untuk menyajikan halaman login.html dengan pesan error (jika ada)
function renderLoginPage(error = '') {
    const filePath = path.join(__dirname, '../views/admin/login.html');
    let html = fs.readFileSync(filePath, 'utf-8');
    const errorHtml = error ? `<div class="error-banner">⚠️ ${error}</div>` : '';
    return html.replace('<!--ERROR_BANNER-->', errorHtml);
}

// Rate limiter untuk proteksi brute-force login admin (maksimal 10 percobaan per 15 menit per IP)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Terlalu banyak percobaan login yang gagal. Silakan coba lagi setelah 15 menit.',
    handler: (req, res, next, options) => {
        res.status(429).send(renderLoginPage(options.message));
    }
});

// ============================================================
// 0. AUTHENTICATION ROUTES (PUBLIC)
// ============================================================

// Form Login Admin (GET /admin/login)
router.get('/admin/login', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.redirect('/admin');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderLoginPage());
});

// Proses Autentikasi Login (POST /admin/login)
router.post('/admin/login', loginLimiter, (req, res) => {
    const { password } = req.body || {};
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
        console.error('❌ [AdminAuth] ADMIN_PASSWORD belum dikonfigurasi di environment!');
        res.status(500);
        return res.send(renderLoginPage('Konfigurasi server bermasalah (ADMIN_PASSWORD belum diset).'));
    }

    if (password === adminPassword) {
        req.session.isAdmin = true;
        return req.session.save((err) => {
            if (err) {
                console.error('❌ [AdminAuth] Gagal menyimpan session:', err);
                return res.status(500).send(renderLoginPage('Gagal membuat sesi login.'));
            }
            res.redirect('/admin');
        });
    }

    res.status(401);
    res.send(renderLoginPage('Kata sandi salah. Silakan coba lagi.'));
});

// Logout Admin (GET /admin/logout)
router.get('/admin/logout', (req, res) => {
    if (req.session) {
        req.session.destroy((err) => {
            if (err) {
                console.error('❌ [AdminAuth] Gagal menghapus session:', err);
            }
            res.clearCookie('connect.sid');
            res.redirect('/admin/login');
        });
    } else {
        res.redirect('/admin/login');
    }
});

// ============================================================
// 1. UI Portals & Live Stream (PROTECTED)
// ============================================================
router.get(['/admin', '/api/admin'], adminAuthMiddleware, adminCtrl.renderAdminPortal);
router.get('/api/admin/logs', adminAuthMiddleware, adminCtrl.renderLiveLogUI);
router.get('/api/admin/logs/raw', adminAuthMiddleware, adminCtrl.getRawLogs);
router.get('/api/admin/logs/ai-analyze', adminAuthMiddleware, adminCtrl.analyzeLogsAi);
router.post('/api/admin/logs/test-telegram', adminAuthMiddleware, adminCtrl.testTelegramAlert);

// ============================================================
// 2. System Maintenance & Cache (PROTECTED)
// ============================================================
router.get('/api/cache-clear', adminAuthMiddleware, adminCtrl.clearMemoryCache);
router.get('/api/force-sync', adminAuthMiddleware, adminCtrl.triggerForceSync);
router.get('/api/retry-enrich', adminAuthMiddleware, adminCtrl.triggerRetryEnrich);
router.get('/api/factory-reset', adminAuthMiddleware, adminCtrl.triggerFactoryReset);

// ============================================================
// 3. Card Management & Merge Engine (PROTECTED)
// ============================================================
router.get('/api/admin/catalog-search', adminAuthMiddleware, adminCtrl.searchCatalogCards);
router.post('/api/admin/merge-anime', adminAuthMiddleware, adminCtrl.mergeAnimeCards);
router.post('/api/admin/force-mal-id', adminAuthMiddleware, adminCtrl.forceMalIdOnCard);
router.post('/api/admin/rename-anime', adminAuthMiddleware, adminCtrl.renameAnimeCard);
router.post('/api/admin/force-enrich-card', adminAuthMiddleware, adminCtrl.forceEnrichCards);
router.get('/api/admin/anime-details/:id', adminAuthMiddleware, adminCtrl.getAnimeDetails);
router.post('/api/admin/split-url', adminAuthMiddleware, adminCtrl.splitAnimeUrl);

// ============================================================
// 4. AI Assistant (PROTECTED)
// ============================================================
router.post('/api/admin/ai-chat', adminAuthMiddleware, handleAiChat);

export default router;
