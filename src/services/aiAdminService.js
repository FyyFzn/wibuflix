/**
 * aiAdminService.js
 * Sole responsibility: communicate with the Gemini API, manage per-session
 * conversation history, and define the available function tools.
 * Never touches the database directly.
 */

import axios from 'axios';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// ── Session Store ─────────────────────────────────────────────────────────────
// Keyed by sessionId. Each session stores the full Gemini-format message history.
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
        if (now - session.lastActivity > SESSION_TTL_MS) sessions.delete(id);
    }
}, 10 * 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

function getOrCreateSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { history: [], lastActivity: Date.now() });
    }
    const session = sessions.get(sessionId);
    session.lastActivity = Date.now();
    return session;
}

// ── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Wibu-chan, a friendly and knowledgeable admin assistant for Wibuflix — an anime streaming platform.
You can have natural conversations about anime, answer questions, and also perform admin database actions when asked.

You have access to:
- Google Search: use it to verify anime titles, look up season names, find canonical names, etc.
- merge_anime_cards: merge two anime cards in the database (e.g. "Season 2" card into the properly-named one).
- search_anime_cards: search the Wibuflix database for anime cards by title.

Personality:
- Friendly, concise, and helpful. You can use casual language.
- When discussing anime, feel free to share knowledge about it (genres, studios, air dates, etc.)
- When the user asks you to do a database action, use the appropriate function — don't just describe it.
- Always use Google Search to verify the canonical/official anime title before merging.
- After executing a function, summarize what happened in a natural sentence.

Important rules for merging:
- The card that already has a MAL ID in the database becomes the primary (it survives).
- If neither has a MAL ID, the card with the fuller/more specific title wins.
- Always confirm what you merged after the operation completes.`;

// ── Function Declarations ─────────────────────────────────────────────────────
const FUNCTION_DECLARATIONS = [
    {
        name: 'merge_anime_cards',
        description: 'Merge two anime cards in the Wibuflix database. The card with a MAL ID becomes the primary (surviving) card. The other is merged into it and deleted. Use Google Search first to confirm the canonical title.',
        parameters: {
            type: 'OBJECT',
            properties: {
                primary_title: {
                    type: 'STRING',
                    description: 'The canonical/official title of the anime card that should survive (the primary).',
                },
                target_title: {
                    type: 'STRING',
                    description: 'The title of the anime card to be merged into the primary and deleted.',
                },
            },
            required: ['primary_title', 'target_title'],
        },
    },
    {
        name: 'search_anime_cards',
        description: 'Search the Wibuflix database for anime cards by title. Returns matching cards with their IDs, MAL IDs, and source providers.',
        parameters: {
            type: 'OBJECT',
            properties: {
                query: {
                    type: 'STRING',
                    description: 'The anime title or keyword to search for in the database.',
                },
            },
            required: ['query'],
        },
    },
];

// ── Gemini HTTP Call ──────────────────────────────────────────────────────────
async function callGemini(history) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set.');

    const requestBody = {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: history,
        tools: [
            { googleSearch: {} },
            { functionDeclarations: FUNCTION_DECLARATIONS },
        ],
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1024,
        },
    };

    const response = await axios.post(GEMINI_API_BASE, requestBody, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        timeout: 25000,
    });

    return response.data;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a user message in a session. Returns either a text reply or a function call.
 * @param {string} sessionId
 * @param {string} userMessage
 * @returns {Promise<{ reply: string|null, functionCall: {name: string, args: object}|null }>}
 */
export async function chat(sessionId, userMessage) {
    const session = getOrCreateSession(sessionId);

    session.history.push({ role: 'user', parts: [{ text: userMessage }] });

    try {
        const data = await callGemini(session.history);
        const candidate = data?.candidates?.[0];
        if (!candidate) throw new Error('No candidate in Gemini response.');

        const parts = candidate.content?.parts || [];

        // Check for a function call in the response parts
        const functionCallPart = parts.find(p => p.functionCall);
        if (functionCallPart) {
            // Store the model's function-call turn in history so the next turn has context
            session.history.push({ role: 'model', parts });
            return { reply: null, functionCall: functionCallPart.functionCall };
        }

        // Plain text response
        const text = parts.map(p => p.text || '').join('').trim();
        session.history.push({ role: 'model', parts: [{ text }] });
        return { reply: text, functionCall: null };
    } catch (err) {
        // Remove the failed user turn so history stays clean
        session.history.pop();
        const detail = err.response?.data?.error?.message || err.message;
        console.error('[aiAdminService] Error calling Gemini:', detail);
        throw err;
    }
}

/**
 * Submit a function execution result back to the model to get a natural-language wrap-up.
 * @param {string} sessionId
 * @param {string} functionName
 * @param {object} result - The result of the function execution.
 * @returns {Promise<{ reply: string }>}
 */
export async function submitFunctionResult(sessionId, functionName, result) {
    const session = sessions.get(sessionId);
    if (!session) return { reply: 'Session expired. Please start a new conversation.' };

    // Append the function result as a user turn (Gemini v1beta format)
    session.history.push({
        role: 'user',
        parts: [{
            functionResponse: {
                name: functionName,
                response: { result },
            },
        }],
    });

    try {
        const data = await callGemini(session.history);
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = parts.map(p => p.text || '').join('').trim();
        session.history.push({ role: 'model', parts: [{ text }] });
        return { reply: text };
    } catch (err) {
        const detail = err.response?.data?.error?.message || err.message;
        console.error('[aiAdminService] Error getting function wrap-up from Gemini:', detail);
        return { reply: 'Action completed, but I had trouble composing a response.' };
    }
}
