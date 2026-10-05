/**
 * Migrasi URL Oploverz di MongoDB.
 *
 * Semua URL Oploverz lama diarahkan ke domain aktif saat ini (lihat PROVIDER_URLS.OPLOVERZ.BASE_URL).
 * Yang dipindahkan hanya host-nya; path, slug, dan urutan array tidak berubah.
 *
 * Dijalankan dalam mode DRY-RUN secara default. Tambahkan --apply untuk menulis,
 * lalu --yes untuk melewati konfirmasi interaktif.
 *
 * Contoh:
 *   node src/scripts/migrate_oploverz_url.js            # dry-run (aman, hanya baca)
 *   node src/scripts/migrate_oploverz_url.js --apply    # jalankan migrasi
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { PROVIDER_URLS } from '../config/providerUrls.js';
import Anime from '../models/Anime.js';

dotenv.config();

const TARGET_BASE = PROVIDER_URLS.OPLOVERZ.BASE_URL;
const NEW_HOST = (() => {
    try { return new URL(TARGET_BASE).host.toLowerCase(); } catch { return TARGET_BASE.toLowerCase(); }
})();

// Host Oploverz lama yang masih tersimpan di database.
const LEGACY_HOST_PATTERN = /^(?:[a-z0-9-]+\.)*oploverz\.[a-z]{2,}$/i;

/**
 * Mengubah satu URL Oploverz agar memakai host baru.
 * Mengembalikan null bila URL tidak perlu diubah.
 */
export function rewriteOploverzUrl(inputUrl) {
    if (typeof inputUrl !== 'string' || !inputUrl) return null;

    let parsed;
    try {
        parsed = new URL(inputUrl);
    } catch {
        return null; // URL rusak: biarkan apa adanya
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    const currentHost = parsed.host.toLowerCase();
    if (currentHost === NEW_HOST) return null; // sudah benar
    if (!LEGACY_HOST_PATTERN.test(currentHost)) return null; // bukan domain Oploverz

    // Pertahankan protocol asli; hanya host yang diganti.
    return `${parsed.protocol}//${NEW_HOST}${parsed.pathname}${parsed.search}`;
}

function dedupePreservingOrder(urls) {
    const seen = new Set();
    const out = [];
    for (const u of urls) {
        if (typeof u !== 'string' || !u) continue;
        if (seen.has(u)) continue;
        seen.add(u);
        out.push(u);
    }
    return out;
}

async function run() {
    const args = process.argv.slice(2);
    const shouldApply = args.includes('--apply');
    const skipConfirm = args.includes('--yes') || args.includes('-y');

    console.log('[Migrate Oploverz URL] 🚀 Mulai migrasi URL Oploverz');
    console.log(`[Migrate Oploverz URL] Target host: ${TARGET_BASE}`);
    if (!shouldApply) {
        console.log('[Migrate Oploverz URL] MODE DRY-RUN — tidak ada data yang diubah. Tambahkan --apply untuk menulis.');
    }

    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });

    try {
        const docs = await Anime.find(
            { sourceUrls: { $regex: 'oploverz', $options: 'i' } },
            { sourceUrls: 1, title: 1 }
        ).lean();

        let urlChanges = 0;
        let duplicateRemovals = 0;
        let docsToUpdate = 0;
        const samples = [];

        const bulkOps = [];

        for (const doc of docs) {
            const original = Array.isArray(doc.sourceUrls) ? doc.sourceUrls : [];
            let changed = false;

            let next = original.map((u) => {
                const rewritten = rewriteOploverzUrl(u);
                if (rewritten) {
                    changed = true;
                    urlChanges++;
                    return rewritten;
                }
                return u;
            });

            const deduped = dedupePreservingOrder(next);
            if (deduped.length !== next.length) {
                duplicateRemovals += next.length - deduped.length;
                changed = true;
            }

            if (!changed) continue;
            docsToUpdate++;

            if (samples.length < 10) {
                const before = original.find((u) => rewriteOploverzUrl(u));
                if (before) samples.push({ title: doc.title, before, after: rewriteOploverzUrl(before) });
            }

            bulkOps.push({
                updateOne: {
                    filter: { _id: doc._id },
                    update: { $set: { sourceUrls: deduped } }
                }
            });
        }

        console.log('');
        console.log(`[Migrate Oploverz URL] Dokumen dengan URL Oploverz : ${docs.length}`);
        console.log(`[Migrate Oploverz URL] URL yang akan di-rewrite     : ${urlChanges}`);
        console.log(`[Migrate Oploverz URL] Duplikat yang akan dibuang   : ${duplicateRemovals}`);
        console.log(`[Migrate Oploverz URL] Dokumen yang akan berubah     : ${docsToUpdate}`);

        if (samples.length) {
            console.log('');
            console.log('[Migrate Oploverz URL] Contoh perubahan:');
            for (const s of samples) {
                console.log(`  ${s.title}`);
                console.log(`    -  ${s.before}`);
                console.log(`    +  ${s.after}`);
            }
        }

        if (!shouldApply) {
            console.log('');
            console.log('[Migrate Oploverz URL] ✅ Dry-run selesai. Tidak ada perubahan tersimpan.');
            return;
        }

        if (docsToUpdate === 0) {
            console.log('');
            console.log('[Migrate Oploverz URL] ✅ Tidak ada yang perlu dimigrasi. Selesai.');
            return;
        }

        if (!skipConfirm && process.stdin.isTTY) {
            const readline = await import('node:readline');
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const answer = await new Promise((resolve) => rl.question(`Lanjut menulis ke ${docsToUpdate} dokumen? (yes/no): `, resolve));
            rl.close();
            if (!/^y(es)?$/i.test(answer.trim())) {
                console.log('[Migrate Oploverz URL] ❌ Dibatalkan oleh pengguna.');
                return;
            }
        }

        // Backup sebelum menulis, supaya dapat dikembalikan.
        const backupName = `animes_url_backup_${new Date().toISOString().replace(/[:.]/g, '-')}`;
        const ids = bulkOps.map((op) => op.updateOne.filter._id);
        const backupDocs = await Anime.find({ _id: { $in: ids } }, { title: 1, sourceUrls: 1 }).lean();
        await mongoose.connection.collection(backupName).insertMany(backupDocs);
        console.log('');
        console.log(`[Migrate Oploverz URL] 💾 Backup ${backupDocs.length} dokumen → koleksi "${backupName}"`);

        const result = await Anime.bulkWrite(bulkOps, { ordered: false });
        console.log(`[Migrate Oploverz URL] ✅ Selesai. Modified: ${result.modifiedCount}`);

        // Verifikasi: tidak boleh ada URL Oploverz di luar host baru.
        const remaining = await Anime.countDocuments({
            sourceUrls: { $elemMatch: { $regex: 'oploverz', $options: 'i', $not: new RegExp(`^https?://${NEW_HOST.replace(/\./g, '\\.')}/`, 'i') } }
        });
        if (remaining > 0) {
            console.log(`[Migrate Oploverz URL] ⚠️  Masih ada ${remaining} dokumen dengan URL Oploverz lama. Periksa manual.`);
        } else {
            console.log('[Migrate Oploverz URL] ✅ Verifikasi: semua URL Oploverz kini memakai host baru.');
        }
    } finally {
        await mongoose.disconnect();
    }
}

// Jalankan sebagai CLI. Import tanpa eksekusi agar tetap bisa diuji.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('migrate_oploverz_url.js');
if (invokedDirectly) {
    run().catch((err) => {
        console.error('[Migrate Oploverz URL] ❌ Error:', err.message);
        process.exit(1);
    });
}

export { run, dedupePreservingOrder, LEGACY_HOST_PATTERN, NEW_HOST };
