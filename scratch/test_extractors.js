import { extract as extractPixeldrain } from '../src/services/extractors/providers/pixeldrain.js';
import { extract as extractMediafire } from '../src/services/extractors/providers/mediafire.js';

async function run() {
    // Mediafire from Neosatsu Gavv: https://www.mediafire.com/file/lllw7culvou9wjy/Gavv37-360-Sawidago.mp4/file
    const mfUrl = "https://www.mediafire.com/file/lllw7culvou9wjy/Gavv37-360-Sawidago.mp4/file";
    console.log("Testing Mediafire...");
    const mfResult = await extractMediafire(mfUrl, {});
    console.log("Mediafire Result:", mfResult);

    // Pixeldrain from Neosatsu Gavv: https://pixeldrain.com/u/wtXR7cfB
    const pdUrl = "https://pixeldrain.com/u/wtXR7cfB";
    console.log("\nTesting Pixeldrain...");
    const pdResult = await extractPixeldrain(pdUrl, {});
    console.log("Pixeldrain Result:", pdResult);
}
run();
