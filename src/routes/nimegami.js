import express from 'express';
import { getEpisodes, getServers } from '../services/scrapers/nimegamiScraper.js';

const router = express.Router();

// GET /api/nimegami/episodes?url=https://nimegami.id/rezero-.../
router.get('/api/nimegami/episodes', getEpisodes);

// GET /api/nimegami/servers?url=https://nimegami.id/rezero-.../?ep=1
router.get('/api/nimegami/servers', getServers);

export default router;
