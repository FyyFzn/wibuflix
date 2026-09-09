/**
 * aiAdminController.js
 * Sole responsibility: receive AI chat messages, orchestrate the AI service +
 * DB function execution loop, and return a final natural-language reply.
 */

import { chat, submitFunctionResult } from '../services/aiAdminService.js';
import { flushAll } from '../utils/cacheManager.js';
import { normalizeTitleForMatch } from '../utils/stringUtils.js';

// ── DB Helpers ────────────────────────────────────────────────────────────────

async function findCardsByTitle(Anime, title) {
    const query = title.trim();
    return Anime.find({
        $or: [
            { title: { $regex: query, $options: 'i' } },
            { aliases: { $regex: query, $options: 'i' } },
            { normalizedTitle: { $regex: normalizeTitleForMatch(query), $options: 'i' } },
        ],
    })
        .limit(6)
        .select('_id title aliases image malId tmdbId sourceUrls isLocked')
        .lean();
}

/**
 * Primary election: card WITH malId wins.
 * Tiebreak: more source URLs = more data = primary.
 */
function electPrimary(primaryCandidates, targetCandidates) {
    const all = [...primaryCandidates, ...targetCandidates];
    const withMal = all.filter(c => c.malId);

    let primary;
    if (withMal.length >= 1) {
        withMal.sort((a, b) => (b.sourceUrls?.length || 0) - (a.sourceUrls?.length || 0));
        primary = withMal[0];
    } else {
        primary = primaryCandidates[0];
    }

    const targets = all.filter(c => String(c._id) !== String(primary._id));
    return { primary, targets };
}

async function executeMerge(Anime, primary, targets) {
    const primaryDoc = await Anime.findById(primary._id);
    if (!primaryDoc) throw new Error(`Primary card not found: ${primary.title}`);

    for (const dup of targets) {
        const dupDoc = await Anime.findById(dup._id);
        if (!dupDoc) continue;

        const mergedUrls = new Set([...(primaryDoc.sourceUrls || []), ...(dupDoc.sourceUrls || [])].filter(Boolean));
        primaryDoc.sourceUrls = Array.from(mergedUrls);

        const aliasSet = new Set([
            ...(primaryDoc.aliases || []),
            ...(dupDoc.aliases || []),
            dupDoc.title,
        ].filter(a => a && a !== primaryDoc.title));
        primaryDoc.aliases = Array.from(aliasSet);

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

// ── Function Executors ────────────────────────────────────────────────────────

async function executeMergeCards(args) {
    const Anime = (await import('../models/Anime.js')).default;

    const primaryCandidates = await findCardsByTitle(Anime, args.primary_title);
    const targetCandidates = await findCardsByTitle(Anime, args.target_title);

    const allUnique = new Map();
    [...primaryCandidates, ...targetCandidates].forEach(c => allUnique.set(String(c._id), c));

    if (allUnique.size === 0) {
        return {
            success: false,
            message: `No cards found for "${args.primary_title}" or "${args.target_title}" in the database.`,
        };
    }

    if (allUnique.size < 2) {
        const only = Array.from(allUnique.values())[0];
        return {
            success: false,
            message: `Only found one card: "${only.title}". Need at least two cards to merge.`,
        };
    }

    if (allUnique.size > 5) {
        return {
            success: false,
            message: `Found ${allUnique.size} possible cards — too many to safely merge automatically. Please be more specific.`,
            candidates: Array.from(allUnique.values()).map(c => ({ title: c.title, malId: c.malId || null })),
        };
    }

    const { primary, targets } = electPrimary(primaryCandidates, targetCandidates);
    const merged = await executeMerge(Anime, primary, targets);

    return {
        success: true,
        primary: { title: merged.title, malId: merged.malId || null },
        merged: targets.map(t => t.title),
        message: `Successfully merged ${targets.length} card(s) into "${merged.title}" (MAL ID: ${merged.malId || 'none'}). Card is now locked.`,
    };
}

async function executeSearchCards(args) {
    const Anime = (await import('../models/Anime.js')).default;
    const results = await findCardsByTitle(Anime, args.query);
    return {
        count: results.length,
        cards: results.map(c => ({
            title: c.title,
            malId: c.malId || null,
            providers: (c.sourceUrls || []).length,
            isLocked: c.isLocked,
        })),
    };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleAiChat(req, res) {
    const { message, sessionId } = req.body;

    if (!message || !message.trim()) {
        return res.status(400).json({ status: 'error', reply: 'Message cannot be empty.' });
    }
    if (!sessionId) {
        return res.status(400).json({ status: 'error', reply: 'sessionId is required.' });
    }

    try {
        const result = await chat(sessionId, message);

        // ── Function Call Path ─────────────────────────────────────────────────
        if (result.functionCall) {
            const { name, args } = result.functionCall;

            let functionResult;
            if (name === 'merge_anime_cards') {
                functionResult = await executeMergeCards(args);
            } else if (name === 'search_anime_cards') {
                functionResult = await executeSearchCards(args);
            } else {
                functionResult = { error: `Unknown function: ${name}` };
            }

            // Feed result back to model for a natural wrap-up sentence
            const wrapUp = await submitFunctionResult(sessionId, name, functionResult);

            return res.json({
                status: 'ok',
                reply: wrapUp.reply,
                action: name,
                result: functionResult,
            });
        }

        // ── Plain Conversation Path ────────────────────────────────────────────
        return res.json({ status: 'ok', reply: result.reply });

    } catch (err) {
        console.error('[aiAdminController] Error:', err.message);
        res.status(500).json({
            status: 'error',
            reply: 'Failed to reach the AI service. Please try again.',
        });
    }
}
