import NodeCache from 'node-cache';

const caches = {};

/**
 * Mendapatkan atau membuat instance cache untuk namespace tertentu.
 * @param {string} namespace - Nama namespace cache (e.g. 'katalog', 'episodes', dll)
 * @param {number} ttl - TTL dalam detik (default 3600)
 * @returns {NodeCache} Instance NodeCache untuk namespace tersebut
 */
export function getCache(namespace, ttl = 3600) {
    if (!caches[namespace]) {
        caches[namespace] = new NodeCache({ stdTTL: ttl });
    }
    return caches[namespace];
}

/**
 * Membersihkan semua cache di seluruh namespace.
 */
export function flushAll() {
    Object.values(caches).forEach(c => c.flushAll());
}
