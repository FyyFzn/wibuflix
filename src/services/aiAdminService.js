/**
 * aiAdminService.js
 * Sole responsibility: parse a natural-language admin message via the Gemini
 * REST API (with Google Search grounding) and return a structured intent object.
 * Never touches the database.
 *
 * Uses axios with x-goog-api-key header to support both standard (AIzaSy...)
 * and auth keys (AQ...).
 *
 * NOTE: Google Search grounding and responseMimeType:'application/json' are
 * mutually exclusive in the Gemini API. We use grounding + text output, then
 * extract JSON robustly from the response.
 */

import axios from 'axios';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const SYSTEM_PROMPT = `You are an internal admin assistant for Wibuflix, an anime streaming platform.
You have access to Google Search — use it whenever you are unsure of an anime's official title,
alternate names, season names, or canonical romanization. Always search before guessing.

Your ONLY output must be a single valid JSON object. No prose, no markdown fences, no explanation.

Available actions:
- "merge": combine two anime cards. One is the "primary" (the one that survives), the other is the "target" (the one to be deleted after merging).
- "search": look up an anime by title in the Wibuflix database.
- "unknown": the request is unclear or not a supported action.

Rules for "merge":
- Use Google Search to verify the correct canonical title of each anime before returning.
- The card that the user describes as having a proper/full title, or explicitly says to keep, is the PRIMARY.
- The card described as "Season 2 only", "vague", or "the one without a name" is the TARGET.
- Use the most common English title recognized on MyAnimeList or AniList as the canonical title.
- If the user does not specify direction, return both titles and set disambiguate: true.

Response schema (always return exactly this, as raw JSON — no backticks, no markdown):
{"action":"merge","primary":"<canonical title of the card that survives>","targets":["<canonical title of the card to be merged/deleted>"],"disambiguate":false,"reply":"<short 1-sentence confirmation of what you understood>"}

For "search":
{"action":"search","query":"<canonical search term>","reply":"<confirmation>"}

For "unknown":
{"action":"unknown","reply":"<polite explanation of what you can and cannot do>"}

Examples:
User: "Season 2 of Overlord is actually called Overlord II, please merge them"
Response: {"action":"merge","primary":"Overlord II","targets":["Overlord Season 2"],"disambiguate":false,"reply":"I'll merge 'Overlord Season 2' into 'Overlord II'."}

User: "what is season 2 of shingeki called? merge it"
Response (after searching): {"action":"merge","primary":"Attack on Titan Season 2","targets":["Shingeki no Kyojin Season 2"],"disambiguate":false,"reply":"Shingeki no Kyojin Season 2 is officially 'Attack on Titan Season 2' — I'll merge them."}`;

/**
 * Extracts the first valid JSON object from a raw text string.
 * Handles cases where Gemini wraps the output in markdown code fences.
 * @param {string} text
 * @returns {object|null}
 */
function extractJson(text) {
    // Strip markdown code fences if present
    const stripped = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();

    // Try direct parse first
    try {
        return JSON.parse(stripped);
    } catch (_) { /* fall through */ }

    // Find first {...} block in the text
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        try {
            return JSON.parse(stripped.slice(start, end + 1));
        } catch (_) { /* fall through */ }
    }

    return null;
}

/**
 * Interprets a natural-language admin message using Gemini with Google Search grounding.
 * @param {string} message - The admin's raw text input.
 * @returns {Promise<{action: string, primary?: string, targets?: string[], query?: string, disambiguate?: boolean, reply: string}>}
 */
export async function interpretAdminMessage(message) {
    if (!message || !message.trim()) {
        return { action: 'unknown', reply: 'Please type a message.' };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('[aiAdminService] GEMINI_API_KEY is not set.');
        return { action: 'unknown', reply: 'AI service is not configured (missing API key).' };
    }

    const requestBody = {
        system_instruction: {
            parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: [
            {
                role: 'user',
                parts: [{ text: message.trim() }],
            },
        ],
        // Google Search grounding — lets Gemini search the web to verify anime titles
        tools: [{ googleSearch: {} }],
        generationConfig: {
            // NOTE: responseMimeType cannot be used together with googleSearch tool.
            // JSON extraction is handled manually via extractJson().
            temperature: 0.1,
            maxOutputTokens: 1024,
        },
    };

    try {
        const response = await axios.post(GEMINI_API_BASE, requestBody, {
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
            },
            timeout: 20000,
        });

        const candidate = response.data?.candidates?.[0];
        const text = candidate?.content?.parts?.map(p => p.text || '').join('').trim();

        if (!text) {
            throw new Error('Empty response from Gemini API.');
        }

        const parsed = extractJson(text);

        if (!parsed || !parsed.action) {
            console.warn('[aiAdminService] Could not parse JSON from response:', text.slice(0, 200));
            return { action: 'unknown', reply: 'Received an unexpected response from AI.' };
        }

        return parsed;
    } catch (err) {
        const detail = err.response?.data?.error?.message || err.message;
        console.error('[aiAdminService] Error calling Gemini:', detail);
        return {
            action: 'unknown',
            reply: 'Failed to reach the AI service. Please try again.',
        };
    }
}
