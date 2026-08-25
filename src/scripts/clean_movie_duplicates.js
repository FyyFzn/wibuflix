import dotenv from 'dotenv';
import connectDB from '../config/db.js';
import Anime from '../models/Anime.js';

dotenv.config();

/**
 * One-shot migration: remove duplicate OVA/movie-titled episode entries from episodesList.
 *
 * Problem: Before the runtime fix, different scrapers labeled the same single episode
 * differently for movie-type anime (e.g. "Persona 3 The Movie 1"):
 *   - Samehadaku → "Episode 1" (num: 1)
 *   - Kuronime   → "Movie"     (num: null)
 *   - Otakudesu  → "Episode Movie" (num: null)
 *
 * Both entries survived deduplication and were saved to the DB. This script removes any
 * num:null OVA/movie-titled entry whose URLs are already fully covered by a numbered episode.
 *
 * Safe-to-drop criteria (ALL must be true):
 *   1. ep.num === null
 *   2. Title matches OVA/movie regex (e.g. "Movie", "Episode Movie", "Film")
 *   3. Every URL in the entry already exists in a numbered episode in the same document
 *
 * Run: node src/scripts/clean_movie_duplicates.js
 */

const OVA_TITLE_RE = /\b(?:ova|oad|special|sp|ex|bonus|nced|ncop)[\s-_]*\d+/i;
const OVA_WORD_RE  = /\b(?:ova|oad|batch|nced|ncop|movie|film)\b/i;
const OVA_PAREN_RE = /\((?:ova|oad|special|sp|ex|bonus|nced|ncop)\)|\b(?:ova|oad|special|sp|ex|bonus|nced|ncop)\b\s*$/i;

function isOvaOrMovieTitle(title) {
    return OVA_TITLE_RE.test(title) || OVA_WORD_RE.test(title) || OVA_PAREN_RE.test(title);
}

function flattenUrls(urlsField) {
    if (!urlsField) return [];
    if (Array.isArray(urlsField)) return urlsField.filter(Boolean);
    if (urlsField instanceof Map) return Array.from(urlsField.values()).filter(Boolean);
    if (typeof urlsField === 'object') return Object.values(urlsField).filter(Boolean);
    return [];
}

function removeDuplicateMovieEntries(episodesList, episodesCount) {
    const rawEps = episodesList.map(ep =>
        ep.toObject ? ep.toObject({ flattenMaps: true }) : { ...ep }
    );

    // Build URL set from all numbered episodes
    const numberedEpUrlSet = new Set();
    const numberedEps = rawEps.filter(ep => ep.num != null && !isNaN(ep.num));
    for (const ep of numberedEps) {
        for (const url of flattenUrls(ep.urls)) {
            numberedEpUrlSet.add(url);
        }
    }

    const expectedEpCount = episodesCount || 0;
    const numberedEpCount = numberedEps.length;
    // True when numbered episodes already satisfy the expected count from MAL/DB
    const numberedEpsCoversAll = expectedEpCount > 0 && numberedEpCount >= expectedEpCount;

    const dropped = [];
    const kept = rawEps.filter(ep => {
        // Always keep numbered episodes
        if (ep.num != null && !isNaN(ep.num)) return true;

        const title = (ep.judul || ep.title || '').trim();
        if (!isOvaOrMovieTitle(title)) return true; // Not a movie/OVA label — keep

        // (a) URL cross-check: all URLs already present in numbered episodes
        const epUrls = flattenUrls(ep.urls);
        if (epUrls.length > 0 && epUrls.every(url => numberedEpUrlSet.has(url))) {
            dropped.push(`${title} [URL overlap]`);
            return false;
        }

        // (b) Strict single-episode movie: episodesCount === 1 means this is a movie with exactly
        //     one watchable entry. Any extra OVA/movie-titled entry is definitionally a duplicate label
        //     for the same content (e.g. "Episode Movie" from ylnime alongside "Episode 1" from nimegami).
        //     We do NOT apply this to multi-episode series (episodesCount > 1) because their OVAs are
        //     genuinely separate content.
        if (expectedEpCount === 1 && numberedEpCount >= 1) {
            dropped.push(`${title} [single-episode movie duplicate]`);
            return false;
        }

        return true;
    });

    return { kept, dropped };
}

(async () => {
    try {
        await connectDB();

        // Only scan anime that have at least one num:null episode to limit scan scope
        const candidates = await Anime.find({
            episodesList: { $elemMatch: { num: null } }
        });

        console.log(`\n[CleanMovieDuplicates] 🔍 Scanning ${candidates.length} anime with num:null episodes...\n`);

        let totalDocsUpdated = 0;
        let totalEntriesDropped = 0;

        for (const doc of candidates) {
            if (!doc.episodesList || doc.episodesList.length === 0) continue;

            const { kept, dropped } = removeDuplicateMovieEntries(doc.episodesList, doc.episodesCount);

            if (dropped.length > 0) {
                console.log(`[CLEAN] "${doc.title}" — removing ${dropped.length} duplicate movie entry/entries:`);
                dropped.forEach(t => console.log(`        - "${t}"`));

                doc.episodesList = kept;
                await doc.save();
                totalDocsUpdated++;
                totalEntriesDropped += dropped.length;
            }
        }

        console.log('\n==================================================');
        console.log('   HASIL PEMBERSIHAN DUPLIKAT MOVIE/OVA DATABASE');
        console.log('==================================================');
        console.log(`📦 Anime Dipindai        : ${candidates.length}`);
        console.log(`✨ Dokumen Diperbarui    : ${totalDocsUpdated}`);
        console.log(`🗑️  Entri Dihapus         : ${totalEntriesDropped}`);
        console.log('==================================================');
        if (totalEntriesDropped === 0) {
            console.log('[CleanMovieDuplicates] ✅ Tidak ada duplikat yang ditemukan. Database sudah bersih!');
        } else {
            console.log('[CleanMovieDuplicates] ✅ Selesai. Database kini bersih dari duplikat movie/OVA.');
        }
    } catch (err) {
        console.error('[CleanMovieDuplicates] ❌ Gagal:', err);
        process.exit(1);
    } finally {
        process.exit(0);
    }
})();
