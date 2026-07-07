import { getCache } from '../../../utils/cacheManager.js';
import { cleanSeriesTitle } from '../../../utils/stringUtils.js';

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
