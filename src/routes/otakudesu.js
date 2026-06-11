import express from 'express';
import * as otakudesu from '../scraper/otakudesu_controller.js';

const router = express.Router();

// =====================================
// OTAKUDESU ROUTES
// =====================================
router.get('/api/otakudesu/episodes/:slug', otakudesu.getEpisodes);
router.get('/api/otakudesu/servers', otakudesu.getServers);

export default router;
