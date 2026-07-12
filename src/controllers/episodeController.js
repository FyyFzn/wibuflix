import { getEpisodeServiceData } from '../services/episodeService.js';
import { assertAndRespondContract } from '../utils/contractValidator.js';

export async function getEpisodesMerged(req, res) {
    const targetUrl = req.query.url;
    const urlSamehadaku = req.query.urlSamehadaku;
    const urlOtakudesu = req.query.urlOtakudesu;
    const urlKuronime = req.query.urlKuronime;
    const urlNanime = req.query.urlNanime;
    const urlNimegami = req.query.urlNimegami;
    const urlOploverz = req.query.urlOploverz;
    
    if (!targetUrl && !urlSamehadaku && !urlOtakudesu && !urlKuronime && !urlNanime && !urlNimegami && !urlOploverz) {
        return res.status(400).json({ error: "Parameter 'url' wajib diisi!" });
    }

    try {
        const result = await getEpisodeServiceData({
            targetUrl,
            urlSamehadaku,
            urlOtakudesu,
            urlKuronime,
            urlNanime,
            urlNimegami,
            urlOploverz
        });

        if (!res.headersSent) {
            if (!assertAndRespondContract(res, result.data, 'episodes', result.source || 'multi-provider')) return;
            return res.json({
                status: result.status,
                data: result.data,
                source: result.source
            });
        }
    } catch (err) {
        console.error('[Episodes Controller Error]', err.message);
        if (!res.headersSent) {
            const statusCode = err.message && err.message.includes("tidak ditemukan") ? 404 : 500;
            return res.status(statusCode).json({ status: 'error', message: err.message });
        }
    }
}
