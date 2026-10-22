import express from 'express';
import { getHistory, upsertHistory, deleteHistoryItem, clearHistory } from '../controllers/historyController.js';
import { syncAuthMiddleware } from '../middlewares/authMiddleware.js';

const router = express.Router();
router.use(syncAuthMiddleware);
router.get('/api/history', getHistory);
router.post('/api/history', upsertHistory);
router.delete('/api/history', clearHistory);
router.delete('/api/history/:identifier', deleteHistoryItem);

export default router;
