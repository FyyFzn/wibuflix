// ============================================================
// ROUTER: ADMIN ROUTES (THIN ROUTER / NO GOD CODE)
// ============================================================

import express from 'express';
import * as adminCtrl from '../controllers/adminController.js';

const router = express.Router();

// 1. UI Portals & Live Stream
router.get(['/admin', '/api/admin'], adminCtrl.renderAdminPortal);
router.get('/api/admin/logs', adminCtrl.renderLiveLogUI);
router.get('/api/admin/logs/raw', adminCtrl.getRawLogs);

// 2. System Maintenance & Cache
router.get('/api/cache-clear', adminCtrl.clearMemoryCache);
router.get('/api/force-sync', adminCtrl.triggerForceSync);
router.get('/api/retry-enrich', adminCtrl.triggerRetryEnrich);
router.get('/api/factory-reset', adminCtrl.triggerFactoryReset);

// 3. Card Management & Merge Engine
router.get('/api/admin/catalog-search', adminCtrl.searchCatalogCards);
router.post('/api/admin/merge-anime', adminCtrl.mergeAnimeCards);
router.post('/api/admin/force-mal-id', adminCtrl.forceMalIdOnCard);

export default router;
