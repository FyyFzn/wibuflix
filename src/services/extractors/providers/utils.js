import { PROVIDER_URLS, PROVIDER_LIST } from '../../../config/providerUrls.js';

const iframeRefererMap = new Map();

export function recordIframeReferer(iframeUrl, targetUrl) {
    if (!iframeUrl || !targetUrl) return;
    try {
        iframeRefererMap.set(iframeUrl, targetUrl);
        if (iframeRefererMap.size > 2000) {
            const firstKey = iframeRefererMap.keys().next().value;
            iframeRefererMap.delete(firstKey);
        }
    } catch (e) {}
}

export function getExtractorReferer(embedUrl, req) {
    try {
        if (req && req.query) {
            const explicitRef = req.query.referer || req.query.episodeUrl || req.query.seriesUrl;
            if (explicitRef && typeof explicitRef === 'string' && explicitRef.startsWith('http')) {
                return new URL(explicitRef).origin + '/';
            }
            if (req.query.url && typeof req.query.url === 'string' && req.query.url.startsWith('http')) {
                for (const prov of PROVIDER_LIST) {
                    if (prov.DOMAIN_KEYWORDS.some(kw => req.query.url.toLowerCase().includes(kw.toLowerCase()))) {
                        return new URL(req.query.url).origin + '/';
                    }
                }
            }
        }
        if (req && req.headers && req.headers['referer']) {
            const hdrRef = req.headers['referer'];
            for (const prov of PROVIDER_LIST) {
                if (prov.DOMAIN_KEYWORDS.some(kw => hdrRef.toLowerCase().includes(kw.toLowerCase()))) {
                    return new URL(hdrRef).origin + '/';
                }
            }
        }

        if (embedUrl && iframeRefererMap.has(embedUrl)) {
            const originalTarget = iframeRefererMap.get(embedUrl);
            if (originalTarget && originalTarget.startsWith('http')) {
                return new URL(originalTarget).origin + '/';
            }
        }

        return `${PROVIDER_URLS.SAMEHADAKU.BASE_URL}/`;
    } catch (e) {
        return `${PROVIDER_URLS.SAMEHADAKU.BASE_URL}/`;
    }
}

export function getExtractorOrigin(embedUrl, req) {
    const ref = getExtractorReferer(embedUrl, req);
    try {
        return new URL(ref).origin;
    } catch {
        return PROVIDER_URLS.SAMEHADAKU.BASE_URL;
    }
}

export function extractIframeSrc(html) {
    const match = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    return match ? match[1] : null;
}

export function namaServer(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        if (host.includes('wibufile')) return 'wibufile';
        if (host.includes('kraken')) return 'krakenfiles';
        if (host.includes('mega.nz')) return 'mega';
        if (host.includes('bili')) return 'bilibili';
        if (host.includes('blog')) return 'blogger';
        if (host.includes('mp4upload')) return 'mp4upload';
        if (host.includes('gdrive') || host.includes('google')) return 'gdrive';
        if (host.includes('vidhide')) return 'vidhide';
        if (host.includes('filemoon')) return 'filemoon';
        if (host.includes('filelions')) return 'filelions';
        if (host.includes('moonplayer')) return 'moonplayer';
        if (host.includes('filedon') || host.includes('pucuk')) return 'pucuk';
        
        return host.replace('www.', '').split('.')[0];
    } catch {
        return '';
    }
}
