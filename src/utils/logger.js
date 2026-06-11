/**
 * Centralized logger helper to support custom production logging (e.g. Azure/global.forceLog override)
 */
export function log(...args) {
    if (global.forceLog) {
        global.forceLog(...args);
    } else {
        console.log(...args);
    }
}
