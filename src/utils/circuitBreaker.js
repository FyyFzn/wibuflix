/**
 * Circuit Breaker untuk Melindungi Server VPS Azure B1
 * Mencegah pemanggilan Puppeteer buta-butaan saat target web sedang down/maintenance/memblokir IP.
 *
 * Exponential backoff: setiap kali sirkuit kembali OPEN setelah HALF_OPEN gagal,
 * cooldown berlipat ganda (5m → 10m → 20m → 30m max) sehingga domain yang
 * sudah terbukti tidak bisa diakses tidak terus-menerus membuang slot Puppeteer.
 */

const MIN_RESET_TIMEOUT_MS = 5 * 60 * 1000;   // 5 menit
const MAX_RESET_TIMEOUT_MS = 30 * 60 * 1000;  // 30 menit

class CircuitBreaker {
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold || 5; // Jumlah kegagalan beruntun sebelum sirkuit dibuka
        // states: domain -> { state: 'CLOSED'|'OPEN'|'HALF_OPEN', failures, nextAttempt, openCount }
        this.states = new Map();
    }

    _getState(domain) {
        if (!this.states.has(domain)) {
            this.states.set(domain, { state: 'CLOSED', failures: 0, nextAttempt: 0, openCount: 0 });
        }
        return this.states.get(domain);
    }

    /**
     * Menghitung cooldown berikutnya menggunakan exponential backoff.
     * Cooldown awal 5m, berlipat tiap kali sirkuit kembali OPEN, maks 30m.
     */
    _nextResetTimeout(openCount) {
        const ms = MIN_RESET_TIMEOUT_MS * Math.pow(2, openCount);
        return Math.min(ms, MAX_RESET_TIMEOUT_MS);
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
     * Mengembalikan status sirkuit saat ini untuk domain tertentu.
     * @param {string} domain - Hostname
     * @returns {'CLOSED'|'OPEN'|'HALF_OPEN'}
     */
    getState(domain) {
        const info = this._getState(domain.toLowerCase());
        if (info.state === 'OPEN' && Date.now() >= info.nextAttempt) {
            return 'HALF_OPEN';
        }
        return info.state;
    }

    /**
     * Mencatat keberhasilan request. Mengembalikan sirkuit ke status CLOSED dan reset openCount.
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
        info.openCount = 0; // reset backoff saat pulih
    }

    /**
     * Mencatat kegagalan request. Jika mencapai batas, buka sirkuit (OPEN) dengan exponential backoff.
     * Error internal (detached frame, dll) dapat dikecualikan via options.skipCircuit = true.
     */
    recordFailure(urlOrDomain, error) {
        let domain = urlOrDomain;
        try { domain = new URL(urlOrDomain).hostname.toLowerCase(); } catch (e) {}

        // Abaikan error 404 (karena server target merespons normal)
        if (error && (error.message?.includes('404') || error.status === 404)) {
            return;
        }

        // Abaikan race condition internal Puppeteer — bukan kegagalan provider
        if (error?.skipCircuit === true) {
            return;
        }

        const info = this._getState(domain);
        info.failures++;

        console.warn(`[CircuitBreaker] Kegagalan tercatat untuk ${domain} (${info.failures}/${this.failureThreshold}):`, error?.message || 'Unknown error');

        if (info.failures >= this.failureThreshold || info.state === 'HALF_OPEN') {
            info.openCount = (info.openCount || 0) + 1;
            const cooldownMs = this._nextResetTimeout(info.openCount - 1);
            info.state = 'OPEN';
            info.nextAttempt = Date.now() + cooldownMs;
            console.error(`🚨 [CircuitBreaker] SIRKUIT TERBUKA (OPEN) untuk ${domain}! Semua request ke domain ini akan ditolak otomatis selama ${cooldownMs / 1000}s demi menyelamatkan CPU server.`);
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
