import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Anime from './src/models/Anime.js';

dotenv.config();

async function checkOtakudesu() {
    await mongoose.connect(process.env.MONGODB_URI);
    const total = await Anime.countDocuments({});
    const otakudesu = await Anime.countDocuments({'sources.otakudesu.url': { $ne: null }});
    const otakudesuOnly = await Anime.countDocuments({'sources.otakudesu.url': { $ne: null }, 'sources.samehadaku.url': null});
    console.log(`Total Anime: ${total}`);
    console.log(`Anime with Otakudesu Source: ${otakudesu}`);
    console.log(`Anime ONLY from Otakudesu: ${otakudesuOnly}`);
    process.exit(0);
}
checkOtakudesu();
