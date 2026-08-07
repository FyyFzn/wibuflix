import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        const db = mongoose.connection.db;
        const animes = await db.collection('animes').find({ "episodesList.urls.kuronime": { $exists: true } }).sort({ lastUpdated: -1 }).limit(3).toArray();
        for (const anime of animes) {
            console.log(`Anime: ${anime.title}`);
            const eps = anime.episodesList.slice(0, 3);
            for (const ep of eps) {
                console.log(`  Ep ${ep.num}: ${ep.urls.kuronime}`);
            }
        }
        mongoose.disconnect();
    });
