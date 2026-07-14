// ── Circuit Breaker Module for Puppeteer/Scraper Providers ──
// Sesuai SRP, modul ini khusus mengurus pendeteksian kegagalan beruntun
// dan status Open Circuit per domain untuk mencegah terbuangnya slot browser.

const providerCircuits = new Map(); // domain -> { failureCount, lastFailureTime, openUntil }

const MAX_FAILURES_BEFORE_OPEN = 3;
const FAILURE_WINDOW_MS = 2 * 60 * 1000; // 2 menit
const OPEN_CIRCUIT_DURATION_MS = 10 * 60 * 1000; // 10 menit

export function isCircuitOpen(domain) {
    if (!domain) return false;
    const entry = providerCircuits.get(domain);
    if (!entry) return false;

    if (Date.now() < entry.openUntil) {
        return true;
    } else if (entry.openUntil > 0 && Date.now() >= entry.openUntil) {
        // Half-open / Reset setelah durasi open berakhir
        entry.failureCount = 0;
        entry.openUntil = 0;
    }
    return false;
}

export function recordProviderFailure(domain, error) {
    if (!domain) return;
    const now = Date.now();
    let entry = providerCircuits.get(domain) || { failureCount: 0, lastFailureTime: 0, openUntil: 0 };

    if (now - entry.lastFailureTime > FAILURE_WINDOW_MS) {
        entry.failureCount = 1;
    } else {
        entry.failureCount++;
    }
    entry.lastFailureTime = now;

    if (entry.failureCount >= MAX_FAILURES_BEFORE_OPEN) {
        entry.openUntil = now + OPEN_CIRCUIT_DURATION_MS;
        console.warn(`[CircuitBreaker] ⚠️ Sirkuit untuk domain ${domain} TERBUKA (Open Circuit) selama 10 menit akibat ${entry.failureCount} kegagalan berturut-turut!`);
    }

    providerCircuits.set(domain, entry);
}

export function recordProviderSuccess(domain) {
    if (!domain) return;
    const entry = providerCircuits.get(domain);
    if (entry && entry.failureCount > 0) {
        entry.failureCount = 0;
        entry.openUntil = 0;
        providerCircuits.set(domain, entry);
    }
}
