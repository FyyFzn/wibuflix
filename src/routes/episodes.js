import express from 'express';
import { getEpisodesMerged } from '../controllers/episodeController.js';

const router = express.Router();

// ============================================================
// RUTE 2: GET /api/episodes?url=URL_ANIME
// ============================================================
router.get('/api/episodes', getEpisodesMerged);

export default router;
