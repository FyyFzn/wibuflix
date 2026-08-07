import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        const db = mongoose.connection.db;
        const animes = await db.collection('animes').find({ "episodesList.urls.kuronime": { $regex: "/anime/" } }).toArray();
        for (const anime of animes) {
            console.log(`Anime: ${anime.title}`);
            const eps = anime.episodesList.filter(ep => ep.urls.kuronime && ep.urls.kuronime.includes('/anime/'));
            for (const ep of eps.slice(0, 3)) {
                console.log(`  Ep ${ep.num}: ${ep.urls.kuronime}`);
            }
        }
        console.log(`Found ${animes.length} animes with /anime/ in Kuronime episode URL.`);
        mongoose.disconnect();
    });
