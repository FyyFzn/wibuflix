/**
 * Circuit Breaker untuk Melindungi Server VPS Azure B1
 * Mencegah pemanggilan Puppeteer buta-butaan saat target web sedang down/maintenance/memblokir IP.
 */

class CircuitBreaker {
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold || 5; // Jumlah kegagalan beruntun sebelum sirkuit dibuka
        this.resetTimeout = options.resetTimeout || 5 * 60 * 1000; // Waktu tunggu sebelum tes ulang (5 menit)
        this.states = new Map(); // domain -> { state: 'CLOSED' | 'OPEN' | 'HALF_OPEN', failures: number, nextAttempt: number }
    }

    _getState(domain) {
        if (!this.states.has(domain)) {
            this.states.set(domain, { state: 'CLOSED', failures: 0, nextAttempt: 0 });
        }
        return this.states.get(domain);
    }

    /**
     * Memeriksa apakah request ke domain diizinkan oleh Circuit Breaker.
     * @param {string} urlOrDomain - URL lengkap atau hostname
     * @returns {{ allowed: boolean, reason?: string, domain: string }}
     */
    canExecute(urlOrDomain) {
        let domain = urlOrDomain;
        try {
            domain = new URL(urlOrDomain).hostname.toLowerCase();
        } catch (e) {}

        const info = this._getState(domain);
        const now = Date.now();

        if (info.state === 'OPEN') {
            if (now >= info.nextAttempt) {
                console.log(`[CircuitBreaker] Waktu tunggu berakhir untuk ${domain}. Mengubah status menjadi HALF_OPEN (tes 1 request)...`);
                info.state = 'HALF_OPEN';
                return { allowed: true, domain };
            }
            const sisaDetik = Math.ceil((info.nextAttempt - now) / 1000);
            return {
                allowed: false,
                reason: `Target ${domain} sedang mengalami gangguan/down. Sirkuit terbuka untuk mencegah overload CPU. Coba lagi dalam ${sisaDetik} detik.`,
                domain
            };
        }

        return { allowed: true, domain };
    }

    /**
     * Mencatat keberhasilan request. Mengembalikan sirkuit ke status CLOSED.
     */
    recordSuccess(urlOrDomain) {
        let domain = urlOrDomain;
        try { domain = new URL(urlOrDomain).hostname.toLowerCase(); } catch (e) {}

        const info = this._getState(domain);
        if (info.failures > 0 || info.state !== 'CLOSED') {
            console.log(`[CircuitBreaker] Target ${domain} pulih ✓ (Status: CLOSED)`);
        }
        info.failures = 0;
        info.state = 'CLOSED';
    }

    /**
     * Mencatat kegagalan request. Jika mencapai batas, buka sirkuit (OPEN).
     */
    recordFailure(urlOrDomain, error) {
        let domain = urlOrDomain;
        try { domain = new URL(urlOrDomain).hostname.toLowerCase(); } catch (e) {}

        // Abaikan error 404 (karena server target merespons normal)
        if (error && (error.message?.includes('404') || error.status === 404)) {
            return;
        }

        const info = this._getState(domain);
        info.failures++;

        console.warn(`[CircuitBreaker] Kegagalan tercatat untuk ${domain} (${info.failures}/${this.failureThreshold}):`, error?.message || 'Unknown error');

        if (info.failures >= this.failureThreshold || info.state === 'HALF_OPEN') {
            info.state = 'OPEN';
            info.nextAttempt = Date.now() + this.resetTimeout;
            console.error(`🚨 [CircuitBreaker] SIRKUIT TERBUKA (OPEN) untuk ${domain}! Semua request ke domain ini akan ditolak otomatis selama ${this.resetTimeout / 1000}s demi menyelamatkan CPU server.`);
        }
    }

    /**
     * Helper wrapper untuk menjalankan fungsi asinkron dengan proteksi Circuit Breaker.
     */
    async execute(urlOrDomain, asyncFn) {
        const check = this.canExecute(urlOrDomain);
        if (!check.allowed) {
            const err = new Error(check.reason);
            err.circuitOpen = true;
            err.status = 503;
            throw err;
        }

        try {
            const result = await asyncFn();
            this.recordSuccess(check.domain);
            return result;
        } catch (error) {
            this.recordFailure(check.domain, error);
            throw error;
        }
    }
}

export const circuitBreaker = new CircuitBreaker();
export default circuitBreaker;
