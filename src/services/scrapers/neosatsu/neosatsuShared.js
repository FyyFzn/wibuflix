import { getCache } from '../../../utils/cacheManager.js';
import { cleanSeriesTitle } from '../../../utils/stringUtils.js';
import axios from 'axios';

export const cache = getCache('neosatsu', 3600); // 1 jam TTL

export const IGNORED_CATS = [
    'episode', 'movie', 'batch', 'completed', 'ongoing', 'kamen rider', 
    'super sentai', 'ultraman', 'metal hero', 'tokusatsu', 'spesial', 
    'spin-off', 'hyper battle dvd', 'project red', 'dvd', 'tv series', 'series'
];

export function cleanTitle(title) {
    if (!title) return '';
    return cleanSeriesTitle(title);
}

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
];

export async function fetchWithBackoff(url, maxRetries = 4, initialDelay = 15000) {
    let delay = initialDelay;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
            return await axios.get(url, { 
                headers: { 
                    'User-Agent': ua,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }, 
                timeout: 60000 
            });
        } catch (e) {
            if (e.response && (e.response.status === 429 || e.response.status === 403)) {
                console.warn(`[Neosatsu] ${e.response.status} on ${url}. Retrying in ${delay/1000}s (Attempt ${i+1}/${maxRetries})...`);
                await new Promise(r => setTimeout(r, delay));
                delay *= 1.5; // Exponential backoff
            } else {
                throw e;
            }
        }
    }
    throw new Error(`Max retries reached for ${url}`);
}
