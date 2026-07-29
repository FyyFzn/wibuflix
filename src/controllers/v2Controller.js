import { getUnifiedAnimeEpisodes } from '../services/animeOrchestrator.js';
import { assertAndRespondContract } from '../utils/contractValidator.js';

/**
 * Controller V2: Mengambil detail dan urutan episode anime
 * Rute: GET /api/v2/episodes atau GET /api/v2/anime/:slug/episodes
 */
export async function getV2Episodes(req, res) {
    const slug = req.params.slug || req.query.slug;
    const targetUrl = req.query.url;
    const id = req.query.id;
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';

    let providerUrls = {};
    if (req.query.urls) {
        try {
            providerUrls = typeof req.query.urls === 'string' ? JSON.parse(req.query.urls) : req.query.urls;
        } catch (e) {
            console.warn('[v2Controller] Failed to parse urls parameter', e.message);
        }
    }

    if (!slug && !targetUrl && !id) {
        return res.status(400).json({
            status: 'error',
            message: "Parameter 'slug', 'id', atau 'url' wajib diisi untuk mengambil episode!"
        });
    }

    try {
        const result = await getUnifiedAnimeEpisodes({
            targetUrl,
            slug,
            id,
            forceRefresh,
            providerUrls
        });

        if (!res.headersSent) {
            if (!assertAndRespondContract(res, result, 'episodes', result.source_type || 'orchestrator-v2')) return;
            return res.json({
                status: 'success',
                data: result
            });
        }
    } catch (err) {
        console.error('[API v2 Episodes Error]', err.message);
        if (!res.headersSent) {
            const statusCode = err.message && err.message.includes("tidak ditemukan") ? 404 : 500;
            return res.status(statusCode).json({
                status: 'error',
                message: err.message
            });
        }
    }
}
