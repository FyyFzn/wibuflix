const fs = require('fs'); const cheerio = require('cheerio'); const $ = cheerio.load(fs.readFileSync('otaku_dump.html')); console.log($('.download').html());
