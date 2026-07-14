// ── Thread-safe Cookie Store untuk Cloudflare per domain ──
export let globalCfCookie = ''; // Dipertahankan untuk backward-compat
export const globalUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const cfCookieStore = new Map(); // domain -> { cookieString, cookiesArray, timestamp }

export function getCfCookie(domain = 'v2.samehadaku.how') {
    const entry = cfCookieStore.get(domain);
    if (entry && entry.cookieString) return entry.cookieString;
    if (domain.includes('samehadaku')) {
        const fallbackEntry = cfCookieStore.get('v2.samehadaku.how');
        return fallbackEntry ? fallbackEntry.cookieString : globalCfCookie;
    }
    return '';
}

export function getCfCookiesArray(domain = 'v2.samehadaku.how') {
    const entry = cfCookieStore.get(domain);
    if (entry && entry.cookiesArray) return entry.cookiesArray;
    if (domain.includes('samehadaku')) {
        const fallbackEntry = cfCookieStore.get('v2.samehadaku.how');
        return fallbackEntry ? fallbackEntry.cookiesArray : [];
    }
    return [];
}

export function setCfCookie(domain, cookieString, cookiesArray) {
    cfCookieStore.set(domain, { cookieString, cookiesArray, timestamp: Date.now() });
    if (domain && domain.includes('samehadaku')) {
        globalCfCookie = cookieString;
    }
}
