import { extract } from '../src/scraper/extractors/mega.js';

const mockReq = {
    protocol: 'http',
    get: (key) => 'localhost:3000'
};

const url = 'https://mega.nz/file/hIt0kRZY#J410B-3t9xUqS4gTqP_c00m0Ua7j8xS-y0R8_A10aE';

extract(url, mockReq).then(console.log).catch(console.error);
