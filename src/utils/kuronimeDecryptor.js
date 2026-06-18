import crypto from 'crypto';
import axios from 'axios';

const KURONIME_PASSPHRASE = '3&!Z0M,VIZ;dZW==';

/**
 * Menurunkan key dan IV dari passphrase + salt menggunakan algoritma EVP_BytesToKey (MD5, OpenSSL compat).
 */
function deriveKeyAndIv(passphrase, saltHex) {
    const salt = Buffer.from(saltHex, 'hex');
    const password = Buffer.from(passphrase, 'utf-8');
    let derivedBytes = Buffer.alloc(0);
    let block = Buffer.alloc(0);
    while (derivedBytes.length < 48) {
        const hasher = crypto.createHash('md5');
        hasher.update(block);
        hasher.update(password);
        hasher.update(salt);
        block = hasher.digest();
        derivedBytes = Buffer.concat([derivedBytes, block]);
    }
    return { key: derivedBytes.subarray(0, 32), iv: derivedBytes.subarray(32, 48) };
}

/**
 * Mendekripsi satu field terenkripsi dari API Kuronime/Animeku.
 * @param {string} encryptedBase64 - String base64 yang berisi JSON { ct, iv, s }
 * @returns {object} - Objek hasil dekripsi
 */
export function decryptKuronimeField(encryptedBase64) {
    const raw = Buffer.from(encryptedBase64, 'base64').toString('utf-8');
    const parsed = JSON.parse(raw);
    const { key, iv } = deriveKeyAndIv(KURONIME_PASSPHRASE, parsed.s);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(parsed.ct, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
}

/**
 * Mengambil token dari halaman episode Kuronime dan menembak API animeku.org
 * untuk mendapatkan link stream/download yang sudah didekripsi.
 * @param {string} html - HTML mentah dari halaman episode Kuronime
 * @returns {object|null} - { stream: { src, src_sd }, mirror: { embed, download } }
 */
export async function fetchKuronimeSourcesFromHtml(html) {
    const tokenMatch = html.match(/var\s+_0xa100d42aa\s*=\s*["']([^"']+)["']/i);
    if (!tokenMatch) {
        console.log('[KuronimeDecryptor] Token _0xa100d42aa tidak ditemukan di halaman.');
        return null;
    }
    const token = tokenMatch[1];
    console.log(`[KuronimeDecryptor] Token ditemukan: ${token.substring(0, 20)}...`);

    try {
        const { data: apiResp } = await axios.post(
            'https://animeku.org/api/v9/sources',
            `id=${encodeURIComponent(token)}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': 'https://kuronime.sbs/',
                    'Origin': 'https://kuronime.sbs',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 10000
            }
        );

        const result = {};

        if (apiResp.src) result.stream = decryptKuronimeField(apiResp.src);
        if (apiResp.src_sd) result.stream_sd = decryptKuronimeField(apiResp.src_sd);
        if (apiResp.mirror) result.mirror = decryptKuronimeField(apiResp.mirror);

        return result;
    } catch (err) {
        console.error('[KuronimeDecryptor] Gagal fetch API atau dekripsi:', err.message);
        return null;
    }
}

/**
 * Mengonversi objek mirror hasil dekripsi ke format server standar Wibuflix.
 * Prioritas: pixeldrain > krakenfiles > filelions > mp4upload > doodstream
 * @param {object} mirror - Objek mirror hasil decryptKuronimeField
 * @param {string} resolution - e.g. 'v1080p', 'v720p', 'v480p', 'v360p'
 * @returns {Array} - Array server dalam format standar { nama, namaHost, iframeUrl, type, aktif }
 */
export function mirrorToServers(mirror, resolution = null) {
    if (!mirror || !mirror.embed) return [];

    // Urutan resolusi prioritas
    const resolutions = resolution
        ? [resolution]
        : ['v1080p', 'v720p', 'v480p', 'v360p'];

    // Urutan host prioritas (sesuai providers yang sudah ada + tambahan baru)
    const hostPriority = [
        { key: 'pixeldrain',  label: 'Pixeldrain' },
        { key: 'krakenfiles', label: 'KrakenFiles' },
        { key: 'filelions',   label: 'FileLions' },
        { key: 'mp4upload',   label: 'Mp4Upload' },
        { key: 'doodstream',  label: 'Doodstream' },
    ];

    const servers = [];

    for (const res of resolutions) {
        const embedData = mirror.embed[res];
        if (!embedData) continue;

        const resLabel = res.replace('v', '').toUpperCase(); // e.g. '1080P'

        for (const host of hostPriority) {
            const url = embedData[host.key];
            if (!url) continue;

            // Konversi /f/ ke /e/ untuk embed-host yang membutuhkannya
            let iframeUrl = url;
            if (['filelions'].includes(host.key) && iframeUrl.match(/\/f\/[^/]+\/?$/)) {
                iframeUrl = iframeUrl.replace('/f/', '/e/');
            }

            servers.push({
                nama: `${resLabel} MP4`,
                namaHost: host.label,
                iframeUrl,
                type: 'direct',
                aktif: servers.length === 0
            });
        }
    }

    return servers;
}
