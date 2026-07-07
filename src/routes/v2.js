import express from 'express';
import { getV2Episodes } from '../controllers/v2Controller.js';
import { getV2Stream, reportBrokenV2 } from '../controllers/v2StreamController.js';

const router = express.Router();

// ============================================================
// RUTE API V2: SERVER-DRIVEN (THIN CLIENT)
// ============================================================

// 1. Ambil urutan episode bersatu berdasarkan slug atau URL
router.get('/api/v2/anime/:slug/episodes', getV2Episodes);
router.get('/api/v2/episodes', getV2Episodes);

// 2. Eksklusif Azure Blob Streaming (Zero Direct Link / Iframe Fallback)
router.get('/api/v2/stream', getV2Stream);

// 3. Smart Server-Side Failover (Report Broken & Auto-Switch Provider)
router.post('/api/v2/stream/report-broken', reportBrokenV2);

export default router;
