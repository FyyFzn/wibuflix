import express from 'express';
import {
    extractVideoHandler,
    smartPlayHandler,
    cancelUploadsHandler,
    uploadStatusHandler,
    cancelStreamHandler,
    reportBrokenHandler,
    queueAddHandler,
    queuePrioritizeHandler,
    queueCancelHandler,
    queueStatusHandler,
    queueStreamHandler
} from '../controllers/extractController.js';
const router = express.Router();

// Video Extraction & Smart Play
router.get('/api/extract-video', extractVideoHandler);
router.get('/api/smart-play', smartPlayHandler);

// Upload & Stream Management
router.post('/api/cancel-uploads', cancelUploadsHandler);
router.get('/api/upload-status', uploadStatusHandler);
router.all(['/api/cancel-stream', '/cancel-stream'], express.json(), cancelStreamHandler);
router.all(['/api/report-broken', '/report-broken'], express.json(), reportBrokenHandler);

// Background Queue Download Manager
router.post('/api/queue/add', express.json(), queueAddHandler);
router.post('/api/queue/prioritize', express.json(), queuePrioritizeHandler);
router.post('/api/queue/cancel', express.json(), queueCancelHandler);
router.get('/api/queue/status', queueStatusHandler);
router.get('/api/queue/stream', queueStreamHandler);

export default router;
