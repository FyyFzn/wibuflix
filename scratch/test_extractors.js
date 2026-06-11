import { extractVideoUrl } from '../src/scraper/extractor.js';

async function test() {
    console.log("=== Testing Extractors ===");
    
    // Test Pixeldrain URL
    const pixeldrainUrl = "https://pixeldrain.com/u/abc123xyz";
    console.log(`\nTesting Pixeldrain: ${pixeldrainUrl}`);
    try {
        const res = await extractVideoUrl(pixeldrainUrl);
        console.log("Result:", res);
    } catch (e) {
        console.error("Error:", e.message);
    }

    // Test Filemoon URL
    const filemoonUrl = "https://filemoon.sx/e/dummyfile123";
    console.log(`\nTesting Filemoon: ${filemoonUrl}`);
    try {
        const res = await extractVideoUrl(filemoonUrl);
        console.log("Result:", res);
    } catch (e) {
        console.error("Error:", e.message);
    }

    // Test Filelions URL
    const filelionsUrl = "https://filelions.com/e/dummyfile456";
    console.log(`\nTesting Filelions: ${filelionsUrl}`);
    try {
        const res = await extractVideoUrl(filelionsUrl);
        console.log("Result:", res);
    } catch (e) {
        console.error("Error:", e.message);
    }
}

test();
