import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Anime from '../models/Anime.js';
import util from 'util';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fyy_stream';

async function viewCard() {
    const keyword = process.argv.slice(2).join(' ');
    
    if (!keyword) {
        console.log('❌ Harap masukkan judul anime atau ID!');
        console.log('Gunakan: node src/scripts/view_card.js <Judul_Atau_ID>');
        process.exit(1);
    }

    try {
        await mongoose.connect(MONGO_URI);
        console.log(`🔍 Mencari Anime Card dengan kata kunci: "${keyword}"...\n`);

        let query = {};
        if (keyword.match(/^[0-9a-fA-F]{24}$/)) {
            query = { _id: keyword };
        } else {
            query = { title: { $regex: keyword, $options: 'i' } };
        }

        const anime = await Anime.findOne(query).lean();

        if (!anime) {
            console.log(`❌ Tidak ditemukan Anime Card untuk: "${keyword}"`);
            process.exit(0);
        }

        console.log('✅ Ditemukan Anime Card:');
        console.log('==================================================');
        console.log(util.inspect(anime, { showHidden: false, depth: null, colors: true }));
        console.log('==================================================');

    } catch (err) {
        console.error('❌ Terjadi kesalahan:', err);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

viewCard();
