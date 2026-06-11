import express from 'express';
import { extractVideoUrl } from '../scraper/extractor.js';

const router = express.Router();

// ============================================================
// RUTE 5: GET /api/extract-video?url=EMBED_URL
// ============================================================
router.get('/api/extract-video', async (req, res) => {
    const embedUrl = req.query.url;
    if (!embedUrl) return res.status(400).json({ success: false, error: "Parameter 'url' wajib diisi!" });

    try {
        const data = await extractVideoUrl(embedUrl, req);

        // Guard: jika semua strategy gagal (misal wibufile/mega/gofile), extractVideoUrl return null
        // Kembalikan webviewOnly: true agar frontend bisa langsung fallback ke WebView
        // JANGAN kirim HTTP 500 karena akan menyebabkan frontend throw exception (res.ok === false)
        if (!data || !data.url) {
            console.log(`[Extract-Video] Ekstraksi gagal/WebView-only: ${embedUrl}`);
            return res.json({ success: false, webviewOnly: true, message: 'Server ini hanya bisa diputar lewat WebView' });
        }

        let finalUrl = data.url;

        // Gunakan proxy untuk Krakenfiles karena CDN mengunci IP (IP lock)
        if (data?.headers?.token && data?.url) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            finalUrl = `${baseUrl}/api/proxy/kraken?url=${encodeURIComponent(data.url)}&token=${encodeURIComponent(data.headers.token)}&referer=${encodeURIComponent(data.headers.Referer || '')}`;
        } else if ((embedUrl.includes('filedon') || embedUrl.includes('pucuk') || embedUrl.includes('pixeldrain.com')) && data?.url) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            finalUrl = `${baseUrl}/api/proxy/filedon?url=${encodeURIComponent(data.url)}`;
        }

        res.json({
            success: true,
            url: finalUrl,
            headers: data?.headers || undefined,
            webviewOnly: data?.webviewOnly || false
        });
    } catch (err) {
        console.error(`[Extractor Error] URL: ${embedUrl} | STACK:`, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

export default router;
