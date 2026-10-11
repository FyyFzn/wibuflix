/**
 * Centralized AI Log Monitor Service
 * Membaca buffer global.memLogs, mendiagnosis kegagalan dengan Gemini Flash,
 * dan mengirim notifikasi ringkas ke Telegram jika terjadi error spike.
 */

import axios from 'axios';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

let lastAlertTime = 0;
let lastAnalyzedIndex = 0;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // Cooldown 30 menit antar-notifikasi agar tidak spam

/**
 * Mengirim pesan teks Markdown ke Telegram Bot.
 */
export async function sendTelegramAlert(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        console.warn('[AIMonitor] TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID belum diatur di .env. Notifikasi dilewati.');
        return { success: false, reason: 'credentials_missing' };
    }

    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await axios.post(url, {
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        }, { timeout: 10000 });

        return { success: true };
    } catch (err) {
        const detail = err.response?.data?.description || err.message;
        console.error(`[AIMonitor] Gagal mengirim pesan ke Telegram: ${detail}`);
        return { success: false, reason: detail };
    }
}

/**
 * Mengumpulkan log terbaru dari memory buffer.
 */
function extractRecentLogs(maxLines = 80) {
    const logs = global.memLogs || [];
    if (logs.length === 0) return [];

    // Prioritaskan baris ERROR dan WARN terlebih dahulu
    const errorLogs = logs.filter(l => l.includes('[ERROR]'));
    const warnLogs = logs.filter(l => l.includes('[WARN]'));
    const recentLogs = logs.slice(-maxLines);

    // Gabungkan: error unik terbaru + konteks log berjalan
    const combined = [...new Set([...errorLogs.slice(-40), ...warnLogs.slice(-20), ...recentLogs])];
    return combined.slice(-maxLines);
}

/**
 * Menganalisis log menggunakan Gemini Flash.
 */
export async function analyzeLogsWithGemini(customLogLines = null) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY belum diatur di environment variable.');
    }

    const logLines = customLogLines || extractRecentLogs(70);
    if (!logLines || logLines.length === 0) {
        return {
            status: 'HEALTHY',
            summary: 'Log masih kosong atau server baru dinyalakan. Belum ada aktivitas tercatat.',
            hasErrors: false
        };
    }

    const errorCount = logLines.filter(l => l.includes('[ERROR]')).length;
    const prompt = `Anda adalah SRE/DevOps AI untuk backend streaming anime Wibuflix (Node.js/Express, Puppeteer scraper, Mongoose, FFmpeg stream proxy).

Berikut adalah potongan log server terbaru:
\`\`\`
${logLines.join('\n')}
\`\`\`

Tugas Anda:
1. Jika TIDAK ada masalah kritis, balas dengan status "🟢 NORMAL" dan penjelasan 1 kalimat.
2. Jika ADA kegagalan (cth: scraper domain mati, Cloudflare challenge gagal, origin 522 timeout, DB disconnect, memory leak, unhandled error):
   - Status: 🔴 KRITIS atau 🟡 PERINGATAN
   - Masalah Pokok: (sebutkan provider / service yang gagal dan penyebab teknisnya)
   - Dampak Pengguna: (cth: episode provider X tidak bisa di-play)
   - Rekomendasi Solusi: 1-2 langkah konkret perbaikan.

Format pesan ringkas dalam Bahasa Indonesia menggunakan Markdown Telegram (maksimal 150 kata).`;

    const requestBody = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 1500,
            thinkingConfig: {
                thinkingBudget: 0
            }
        }
    };

    const response = await axios.post(GEMINI_API_BASE, requestBody, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        timeout: 25000
    });

    const reply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Gagal menghasilkan analisis dari Gemini.';
    const isCritical = reply.includes('🔴') || reply.includes('KRITIS');
    const isWarning = reply.includes('🟡') || reply.includes('PERINGATAN') || errorCount > 0;

    return {
        status: isCritical ? 'CRITICAL' : (isWarning ? 'WARNING' : 'HEALTHY'),
        summary: reply,
        hasErrors: errorCount > 0,
        errorCount,
        analyzedLinesCount: logLines.length
    };
}

/**
 * Memeriksa status error dan mengirim alert Telegram jika mendeteksi lonjakan error.
 */
export async function checkAndAlert({ force = false, minErrors = 3 } = {}) {
    const logs = global.memLogs || [];
    const currentIndex = logs.length;
    const newLogs = logs.slice(lastAnalyzedIndex);
    lastAnalyzedIndex = currentIndex;

    const newErrorCount = newLogs.filter(l => l.includes('[ERROR]')).length;

    // Lewati jika tidak ada error dan tidak dipaksa
    if (!force && newErrorCount < minErrors) {
        return { triggered: false, reason: 'error_threshold_not_reached', newErrorCount };
    }

    // Cooldown check (kecuali bila dipicu manual)
    const now = Date.now();
    if (!force && (now - lastAlertTime) < ALERT_COOLDOWN_MS) {
        return { triggered: false, reason: 'cooldown_active', newErrorCount };
    }

    console.log(`[AIMonitor] 🔍 Menganalisis ${newErrorCount} error baru dengan Gemini...`);
    const analysis = await analyzeLogsWithGemini();

    if (analysis.status === 'HEALTHY' && !force) {
        return { triggered: false, reason: 'healthy', analysis };
    }

    lastAlertTime = now;
    const telegramMessage = `🤖 *Wibuflix AI Log Alert*\n\n${analysis.summary}\n\n_Waktu: ${new Date().toLocaleString('id-ID')}_`;
    const sendResult = await sendTelegramAlert(telegramMessage);

    return {
        triggered: true,
        analysis,
        telegramSent: sendResult.success
    };
}

/**
 * Menjalankan watcher berkala (misal setiap 15 menit).
 */
export function startBackgroundLogMonitor(intervalMs = 15 * 60 * 1000) {
    console.log(`[AIMonitor] ⏱️ Background Log Watcher aktif (interval: ${intervalMs / 60000} menit).`);
    const timer = setInterval(async () => {
        try {
            await checkAndAlert({ minErrors: 3 });
        } catch (err) {
            console.error('[AIMonitor] Background check gagal:', err.message);
        }
    }, intervalMs);

    if (timer.unref) timer.unref();
    return timer;
}
