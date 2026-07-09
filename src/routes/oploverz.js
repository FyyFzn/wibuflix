import express from 'express';
import { handleGetEpisodes, handleGetServers } from '../controllers/oploverzController.js';

const router = express.Router();

router.get('/episodes', handleGetEpisodes);
router.get('/servers', handleGetServers);

export default router;
