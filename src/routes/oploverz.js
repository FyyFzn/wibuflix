import express from 'express';
import { handleGetEpisodes, handleGetServers } from '../services/scrapers/oploverzScraper.js';

const router = express.Router();

router.get('/episodes', handleGetEpisodes);
router.get('/servers', handleGetServers);

export default router;
