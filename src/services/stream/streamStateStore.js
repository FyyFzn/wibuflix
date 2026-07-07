import { getCache } from '../../utils/cacheManager.js';

export const uploadCache = getCache('azure-uploads', 86400); // 24 hours TTL
export const globalBlacklistCache = getCache('global-blacklist', 3600); // 1 hour TTL
export const uploadProgressCache = new Map();
export const activeUploadControllers = new Map();
export const failureCountCache = new Map();
