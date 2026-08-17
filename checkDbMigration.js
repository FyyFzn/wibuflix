import mongoose from 'mongoose';
import connectDB from './src/config/db.js';
import Anime from './src/models/Anime.js';

async function check() {
    try {
        await connectDB();
        const total = await Anime.countDocuments({});
        const migrated = await Anime.countDocuments({ sourceUrls: { $exists: true, $ne: [] } });
        console.log(`Total: ${total} | With sourceUrls: ${migrated} | Missing: ${total - migrated}`);
        process.exit(0);
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}

check();
