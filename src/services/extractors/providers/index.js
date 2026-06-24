import * as blogger from './blogger.js';
import * as krakenfiles from './krakenfiles.js';
import * as pixeldrain from './pixeldrain.js';
import * as acefile from './acefile.js';
import * as vidhide from './vidhide.js';
import * as wibufile from './wibufile.js';
import * as filedon from './filedon.js';
import * as filemoon from './filemoon.js';
import * as filelions from './filelions.js';
import * as gdrive from './gdrive.js';
import * as mega from './mega.js';
import * as mediafire from './mediafire.js';
import * as generic from './generic.js';

const extractors = [
    blogger,
    krakenfiles,
    pixeldrain,
    acefile,
    vidhide,
    wibufile,
    filedon,
    filemoon,
    filelions,
    gdrive,
    mega,
    mediafire, // Harus sebelum generic agar tidak jatuh ke Puppeteer
];

export function resolveExtractor(embedUrl) {
    for (const extractor of extractors) {
        if (extractor.match(embedUrl)) {
            return extractor;
        }
    }
    return generic;
}
