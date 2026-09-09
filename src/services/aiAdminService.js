/**
 * aiAdminService.js
 * Sole responsibility: parse a natural-language admin message via Gemini
 * and return a structured intent object. Never touches the database.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

const SYSTEM_PROMPT = `You are an internal admin assistant for Wibuflix, an anime streaming platform.
Your ONLY job is to interpret admin maintenance requests and return a single JSON object.
You must NEVER return prose, explanations, or markdown — only raw JSON.

Available actions:
- "merge": combine two anime cards. One is the "primary" (the one that survives), the other is the "target" (the one to be deleted after merging).
- "search": look up an anime by title.
- "unknown": the request is unclear or not a supported action.

Rules for "merge":
- The card that the user describes as having a proper/full title, or explicitly says to keep, is the PRIMARY.
- The card described as "Season 2 only", "vague", or "the one without a name" is the TARGET.
- If the user does not specify direction, return both titles and set disambiguate: true.

Response schema (always return exactly this):
{
  "action": "merge" | "search" | "unknown",
  "primary": "<exact title of the card that survives>",
  "targets": ["<exact title of the card to be merged/deleted>"],
  "disambiguate": false,
  "reply": "<short 1-sentence confirmation of what you understood, in English>"
}

For "search":
{
  "action": "search",
  "query": "<search term>",
  "reply": "<confirmation>"
}

For "unknown":
{
  "action": "unknown",
  "reply": "<polite explanation of what you can and cannot do>"
}

Examples:
User: "Season 2 of Overlord is actually called Overlord II, please merge them"
Response: {"action":"merge","primary":"Overlord II","targets":["Overlord Season 2"],"disambiguate":false,"reply":"I'll merge the card titled 'Overlord Season 2' into 'Overlord II'."}

User: "combine shingeki no kyojin season 2 with attack on titan season 2"
Response: {"action":"merge","primary":"Attack on Titan Season 2","targets":["Shingeki no Kyojin Season 2"],"disambiguate":false,"reply":"I'll merge 'Shingeki no Kyojin Season 2' into 'Attack on Titan Season 2'."}`;

let genAI = null;
let model = null;

function getModel() {
    if (!model) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error('GEMINI_API_KEY is not set in environment variables.');
        genAI = new GoogleGenerativeAI(apiKey);
        model = genAI.getGenerativeModel({
            model: 'gemini-3.6-flash',
            systemInstruction: SYSTEM_PROMPT,
            generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.1,
                maxOutputTokens: 512,
            },
        });
    }
    return model;
}

/**
 * Interprets a natural-language admin message and returns a structured intent.
 * @param {string} message - The admin's raw text input.
 * @returns {Promise<{action: string, primary?: string, targets?: string[], query?: string, disambiguate?: boolean, reply: string}>}
 */
export async function interpretAdminMessage(message) {
    if (!message || !message.trim()) {
        return { action: 'unknown', reply: 'Please type a message.' };
    }

    try {
        const aiModel = getModel();
        const result = await aiModel.generateContent(message.trim());
        const text = result.response.text().trim();

        const parsed = JSON.parse(text);

        if (!parsed.action) {
            return { action: 'unknown', reply: 'Received an unexpected response from AI.' };
        }

        return parsed;
    } catch (err) {
        console.error('[aiAdminService] Error calling Gemini:', err.message);
        return {
            action: 'unknown',
            reply: 'Failed to reach the AI service. Please try again.',
        };
    }
}
