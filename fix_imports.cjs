const fs = require('fs');
const path = require('path');

// Fix providers
const dir = 'src/services/extractors/providers';
fs.readdirSync(dir).forEach(file => {
    if (!file.endsWith('.js')) return;
    const p = path.join(dir, file);
    let content = fs.readFileSync(p, 'utf-8');
    content = content.replace(/from\s+['"].*puppeteer\/pool\.js['"];?['"];?/g, "from '../../../puppeteer/pool.js';");
    // Just force it unconditionally if it matches any puppeteer/pool.js
    content = content.replace(/from\s+.*?puppeteer\/pool\.js.*?(\r?\n)/g, "from '../../../puppeteer/pool.js';$1");
    fs.writeFileSync(p, content);
});

// Fix videoExtractor
let ext = 'src/services/extractors/videoExtractor.js';
let content = fs.readFileSync(ext, 'utf-8');
content = content.replace(/from\s+.*?puppeteer\/pool\.js.*?(\r?\n)/g, "from '../../puppeteer/pool.js';$1");
fs.writeFileSync(ext, content);

console.log("Imports fixed again!");
