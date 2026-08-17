import { getCache } from '../../utils/cacheManager.js';

class BoundedLRUMap extends Map {
    constructor(maxSize = 200, defaultTTLMs = 7200000, onEvict = null) {
        super();
        this.maxSize = maxSize;
        this.defaultTTLMs = defaultTTLMs;
        this.onEvict = onEvict;
        this.expiryMap = new Map();
        this.interval = setInterval(() => this.evictExpired(), 600000);
        if (this.interval.unref) this.interval.unref();
    }

    set(key, value, customTTLSeconds = null) {
        this.evictExpired();
        if (this.size >= this.maxSize && !this.has(key)) {
            const oldestKey = this.keys().next().value;
            if (oldestKey !== undefined) {
                if (this.onEvict) {
                    const val = super.get(oldestKey);
                    try { this.onEvict(oldestKey, val); } catch (e) {}
                }
                super.delete(oldestKey);
                this.expiryMap.delete(oldestKey);
            }
        }
        const ttl = customTTLSeconds ? customTTLSeconds * 1000 : this.defaultTTLMs;
        this.expiryMap.set(key, Date.now() + ttl);
        return super.set(key, value);
    }

    get(key) {
        if (this.isExpired(key)) {
            if (this.onEvict) {
                const val = super.get(key);
                try { this.onEvict(key, val); } catch (e) {}
            }
            super.delete(key);
            this.expiryMap.delete(key);
            return undefined;
        }
        return super.get(key);
    }

    has(key) {
        if (this.isExpired(key)) {
            if (this.onEvict) {
                const val = super.get(key);
                try { this.onEvict(key, val); } catch (e) {}
            }
            super.delete(key);
            this.expiryMap.delete(key);
            return false;
        }
        return super.has(key);
    }

    delete(key) {
        this.expiryMap.delete(key);
        return super.delete(key);
    }

    clear() {
        this.expiryMap.clear();
        return super.clear();
    }

    isExpired(key) {
        const expiry = this.expiryMap.get(key);
        return expiry !== undefined && Date.now() > expiry;
    }

    evictExpired() {
        const now = Date.now();
        for (const [key, expiry] of this.expiryMap.entries()) {
            if (now > expiry) {
                if (this.onEvict) {
                    const val = super.get(key);
                    try { this.onEvict(key, val); } catch (e) {}
                }
                super.delete(key);
                this.expiryMap.delete(key);
            }
        }
    }
}

export const uploadCache = getCache('azure-uploads', 86400); // 24 hours TTL
export const globalBlacklistCache = getCache('global-blacklist', 3600); // 1 hour TTL
export const uploadProgressCache = getCache('upload-progress', 7200); // 2 hours TTL
export const activeUploadControllers = new BoundedLRUMap(100, 7200000, (key, val) => {
    if (val && typeof val === 'object') {
        const ctrl = val.abortController || val;
        if (ctrl && typeof ctrl.abort === 'function' && !ctrl.signal?.aborted) {
            console.warn(`[StreamStateStore] Evicting active controller for ${key} due to TTL/Limit`);
            try { ctrl.abort(); } catch(e) {}
        }
        if (val.tempFilePath || val.hlsOutputDir) {
            import('./uploadProgressService.js').then(m => m.cleanTempFilesAsync(val.tempFilePath, val.hlsOutputDir)).catch(() => {});
        }
    }
}); // max 100 items, 2 jam TTL, auto abort & cleanup saat evict
export const failureCountCache = getCache('failure-count', 86400); // 24 hours TTL
