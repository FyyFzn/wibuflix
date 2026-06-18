import express from 'express';
import { handleGetEpisodes, handleGetServers } from '../controllers/kuronimeController.js';

const router = express.Router();

// GET /api/kuronime/episodes?url=https://kuronime.sbs/anime/re-zero/
router.get('/api/kuronime/episodes', handleGetEpisodes);

// GET /api/kuronime/servers?url=https://kuronime.sbs/nonton-re-zero-episode-1/
router.get('/api/kuronime/servers', handleGetServers);

export default router;
