/**
 * SSRF (Server-Side Request Forgery) Validator & Middleware
 * Mencegah eksploitasi parameter URL untuk mengakses jaringan internal VPS, cloud metadata (169.254.169.254),
 * dan alamat loopback/privat.
 */

// Rentang IP privat dan khusus yang dilarang diakses oleh server
const BLOCKED_IP_PATTERNS = [
    /^127\./,                 // Loopback (127.0.0.0/8)
    /^0\./,                   // 0.0.0.0/8
    /^10\./,                  // RFC 1918 Class A (10.0.0.0/8)
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // RFC 1918 Class B (172.16.0.0/12)
    /^192\.168\./,            // RFC 1918 Class C (192.168.0.0/16)
    /^169\.254\./,            // Link-local & AWS/Azure Cloud Metadata (169.254.0.0/16)
    /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./, // Carrier-grade NAT (100.64.0.0/10)
    /^(::1$|fe80:|fc00:|fd00:|::ffff:127\.|::ffff:169\.254\.|::ffff:10\.|::ffff:192\.168\.)/i, // IPv6 Loopback, Private & Mapped IPv4
    /^[0-9]+$/,               // Pure decimal IP representation (e.g. 2130706433 -> 127.0.0.1)
    /^0x[0-9a-f]+/i,          // Hex IP representation (e.g. 0x7f000001 -> 127.0.0.1)
    /^localhost$/i
];

/**
 * Memvalidasi apakah URL aman dari serangan SSRF.
 * @param {string} inputUrl - URL string yang akan diuji
 * @returns {{ valid: boolean, reason?: string, url?: URL }}
 */
export function validateSafeUrl(inputUrl) {
    if (!inputUrl || typeof inputUrl !== 'string') {
        return { valid: true }; // Abaikan parameter yang bukan string URL
    }

    // Abaikan string pendek yang bukan URL
    if (!inputUrl.startsWith('http://') && !inputUrl.startsWith('https://')) {
        // Cek jika mencoba skema berbahaya
        if (/^(file|ftp|gopher|dict|tftp|ldap|ssh):\/\//i.test(inputUrl)) {
            return { valid: false, reason: 'Protokol URL tidak diizinkan (hanya HTTP/HTTPS)' };
        }
        return { valid: true };
    }

    try {
        const parsed = new URL(inputUrl);
        const hostname = parsed.hostname.toLowerCase();

        // 1. Validasi skema
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, reason: 'Protokol URL harus HTTP atau HTTPS' };
        }

        // 2. Validasi hostname/IP terlarang (SSRF protection)
        for (const pattern of BLOCKED_IP_PATTERNS) {
            if (pattern.test(hostname)) {
                return { valid: false, reason: `Akses ke host/IP internal atau metadata (${hostname}) diblokir demi keamanan server.` };
            }
        }

        // 3. Blokir port internal non-standar yang mencurigakan (seperti MongoDB 27017, Redis 6379, SSH 22)
        if (parsed.port) {
            const portNum = parseInt(parsed.port, 10);
            const dangerousPorts = [22, 23, 25, 53, 135, 139, 445, 3306, 5432, 6379, 8080, 27017];
            if (dangerousPorts.includes(portNum)) {
                return { valid: false, reason: `Akses ke port sensitif (${portNum}) diblokir.` };
            }
        }

        return { valid: true, url: parsed };
    } catch (e) {
        return { valid: false, reason: 'Format URL tidak valid' };
    }
}

/**
 * Express Middleware untuk memeriksa semua parameter query dan body yang berpotensi mengandung URL.
 */
export function ssrfMiddleware(req, res, next) {
    const urlKeys = [
        'url', 'episodeUrl', 'seriesUrl', 'nextEpisodeUrl', 
        'urlSamehadaku', 'urlOtakudesu', 'urlKuronime', 'embedUrl', 'target'
    ];

    // Periksa query params
    if (req.query) {
        for (const key of urlKeys) {
            if (req.query[key]) {
                const check = validateSafeUrl(req.query[key]);
                if (!check.valid) {
                    console.warn(`[SSRF Protection] Blocked query param '${key}' = ${req.query[key]}: ${check.reason}`);
                    return res.status(403).json({
                        status: 'error',
                        message: `Keamanan Ditolak (SSRF Protection): ${check.reason}`
                    });
                }
            }
        }
    }

    // Periksa body params
    if (req.body && typeof req.body === 'object') {
        for (const key of urlKeys) {
            if (req.body[key]) {
                const check = validateSafeUrl(req.body[key]);
                if (!check.valid) {
                    console.warn(`[SSRF Protection] Blocked body param '${key}' = ${req.body[key]}: ${check.reason}`);
                    return res.status(403).json({
                        status: 'error',
                        message: `Keamanan Ditolak (SSRF Protection): ${check.reason}`
                    });
                }
            }
        }
    }

    next();
}
