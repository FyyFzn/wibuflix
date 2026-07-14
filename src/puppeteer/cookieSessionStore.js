import { PROVIDER_URLS } from '../config/providerUrls.js';

const DEFAULT_CF_DOMAIN = new URL(PROVIDER_URLS.SAMEHADAKU.BASE_URL).hostname;

// ── Thread-safe Cookie Store untuk Cloudflare per domain ──
export let globalCfCookie = ''; // Dipertahankan untuk backward-compat
export const globalUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const cfCookieStore = new Map(); // domain -> { cookieString, cookiesArray, timestamp }

export function getCfCookie(domain = DEFAULT_CF_DOMAIN) {
    const entry = cfCookieStore.get(domain);
    if (entry && entry.cookieString) return entry.cookieString;
    if (domain.includes('samehadaku')) {
        const fallbackEntry = cfCookieStore.get(DEFAULT_CF_DOMAIN);
        return fallbackEntry ? fallbackEntry.cookieString : globalCfCookie;
    }
    return '';
}

export function getCfCookiesArray(domain = DEFAULT_CF_DOMAIN) {
    const entry = cfCookieStore.get(domain);
    if (entry && entry.cookiesArray) return entry.cookiesArray;
    if (domain.includes('samehadaku')) {
        const fallbackEntry = cfCookieStore.get(DEFAULT_CF_DOMAIN);
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
