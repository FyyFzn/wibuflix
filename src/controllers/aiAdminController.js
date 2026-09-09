/**
 * aiAdminController.js
 * Sole responsibility: receive AI chat messages, resolve DB card IDs from
 * the AI-parsed intent, and execute the appropriate admin action.
 * Primary selection rule: the card WITH a malId wins. If neither or both
 * have malId, the more complete title (longer) wins.
 */

import { interpretAdminMessage } from '../services/aiAdminService.js';
import { flushAll } from '../utils/cacheManager.js';
import { normalizeTitleForMatch } from '../utils/stringUtils.js';

// ── Title → DB Lookup ─────────────────────────────────────────────────────────

async function findCardsByTitle(Anime, title) {
    const query = title.trim();
    const results = await Anime.find({
        $or: [
            { title: { $regex: query, $options: 'i' } },
            { aliases: { $regex: query, $options: 'i' } },
            { normalizedTitle: { $regex: normalizeTitleForMatch(query), $options: 'i' } },
        ],
    })
        .limit(5)
        .select('_id title aliases image malId tmdbId sourceUrls')
        .lean();

    return results;
}

// ── Primary Election ──────────────────────────────────────────────────────────

/**
 * Given two card arrays (primary candidates and target candidates), pick the
 * best primary: prefer the card that already has a malId. If tie, prefer the
 * one with the longer title (more specific).
 */
function electPrimary(primaryCandidates, targetCandidates) {
    const allCandidates = [...primaryCandidates, ...targetCandidates];

    // 1. Cards with malId rank highest
    const withMal = allCandidates.filter(c => c.malId);
    const withoutMal = allCandidates.filter(c => !c.malId);

    if (withMal.length === 1) {
        const primary = withMal[0];
        const targets = allCandidates.filter(c => String(c._id) !== String(primary._id));
        return { primary, targets };
    }

    // 2. Multiple have malId → pick the one with the most source URLs (most data)
    if (withMal.length > 1) {
        withMal.sort((a, b) => (b.sourceUrls?.length || 0) - (a.sourceUrls?.length || 0));
        const primary = withMal[0];
        const targets = allCandidates.filter(c => String(c._id) !== String(primary._id));
        return { primary, targets };
    }

    // 3. Nobody has malId → use the AI-declared primary as-is (first primaryCandidates result)
    const primary = primaryCandidates[0];
    const targets = allCandidates.filter(c => String(c._id) !== String(primary._id));
    return { primary, targets };
}

// ── Merge Execution ───────────────────────────────────────────────────────────

async function executeMerge(Anime, primary, targets) {
    const primaryDoc = await Anime.findById(primary._id);
    if (!primaryDoc) throw new Error(`Primary card not found in DB: ${primary.title}`);

    for (const dup of targets) {
        const dupDoc = await Anime.findById(dup._id);
        if (!dupDoc) continue;

        // Merge sourceUrls
        const mergedUrls = new Set([
            ...(primaryDoc.sourceUrls || []),
            ...(dupDoc.sourceUrls || []),
        ].filter(Boolean));
        primaryDoc.sourceUrls = Array.from(mergedUrls);

        // Merge aliases (add the duplicate's title as an alias)
        const aliasSet = new Set([
            ...(primaryDoc.aliases || []),
            ...(dupDoc.aliases || []),
            dupDoc.title,
        ].filter(a => a && a !== primaryDoc.title));
        primaryDoc.aliases = Array.from(aliasSet);

        // Fill in missing metadata from duplicate
        if (!primaryDoc.malId && dupDoc.malId) primaryDoc.malId = dupDoc.malId;
        if (!primaryDoc.tmdbId && dupDoc.tmdbId) primaryDoc.tmdbId = dupDoc.tmdbId;
        if ((!primaryDoc.image || primaryDoc.image.includes('placehold')) && dupDoc.image) {
            primaryDoc.image = dupDoc.image;
        }
    }

    primaryDoc.isLocked = true;
    await primaryDoc.save();

    await Anime.deleteMany({ _id: { $in: targets.map(t => t._id) } });

    flushAll();
    if (global.anime_db_cache) global.anime_db_cache = null;
    if (global.otaku_db_cache) global.otaku_db_cache = null;

    return primaryDoc;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleAiChat(req, res) {
    const { message } = req.body;

    if (!message || !message.trim()) {
        return res.status(400).json({ status: 'error', reply: 'Message cannot be empty.' });
    }

    try {
        const intent = await interpretAdminMessage(message);

        // ── MERGE ──────────────────────────────────────────────────────────────
        if (intent.action === 'merge') {
            const Anime = (await import('../models/Anime.js')).default;

            const primaryCandidates = await findCardsByTitle(Anime, intent.primary);
            const targetCandidatesAll = await Promise.all(
                (intent.targets || []).map(t => findCardsByTitle(Anime, t))
            );
            const targetCandidates = targetCandidatesAll.flat();

            // Guard: nothing found at all
            if (primaryCandidates.length === 0 && targetCandidates.length === 0) {
                return res.json({
                    status: 'not_found',
                    reply: `I couldn't find any cards matching "${intent.primary}" or "${intent.targets?.join(', ')}" in the database. Try checking the titles.`,
                    intent,
                });
            }

            // Guard: ambiguous — too many candidates, need user to pick
            const totalUnique = new Map();
            [...primaryCandidates, ...targetCandidates].forEach(c => totalUnique.set(String(c._id), c));
            if (totalUnique.size > 4) {
                return res.json({
                    status: 'ambiguous',
                    reply: `Found ${totalUnique.size} possible cards. Please be more specific or use the manual merge tool.`,
                    candidates: Array.from(totalUnique.values()),
                    intent,
                });
            }

            // Guard: only one card found total — nothing to merge
            if (totalUnique.size < 2) {
                const only = Array.from(totalUnique.values())[0];
                return res.json({
                    status: 'not_found',
                    reply: `Only found one card: "${only?.title}". Need at least two cards to merge.`,
                    intent,
                });
            }

            const { primary, targets } = electPrimary(primaryCandidates, targetCandidates);

            const mergedCard = await executeMerge(Anime, primary, targets);

            return res.json({
                status: 'ok',
                reply: `✅ Done! Merged ${targets.length} card(s) into **"${mergedCard.title}"** (MAL ID: ${mergedCard.malId || 'none'}). The card is now locked.`,
                data: {
                    primary: { _id: mergedCard._id, title: mergedCard.title, malId: mergedCard.malId },
                    merged: targets.map(t => t.title),
                },
                intent,
            });
        }

        // ── SEARCH ─────────────────────────────────────────────────────────────
        if (intent.action === 'search') {
            const Anime = (await import('../models/Anime.js')).default;
            const results = await findCardsByTitle(Anime, intent.query);
            return res.json({
                status: 'ok',
                reply: results.length > 0
                    ? `Found ${results.length} card(s) matching "${intent.query}".`
                    : `No cards found for "${intent.query}".`,
                data: results,
                intent,
            });
        }

        // ── UNKNOWN ────────────────────────────────────────────────────────────
        return res.json({
            status: 'unknown',
            reply: intent.reply || "I didn't understand that. Try: \"Merge [title A] with [title B]\".",
            intent,
        });
    } catch (err) {
        console.error('[aiAdminController] Error:', err.message);
        res.status(500).json({ status: 'error', reply: 'Internal server error.', error: err.message });
    }
}
