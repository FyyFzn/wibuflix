import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Anime from '../src/models/Anime.js';

dotenv.config();

async function fixAllYlnimeMalformedUrls() {
    try {
        const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
        if (!uri) throw new Error('MONGODB_URI not found in .env');
        
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
        console.log('✓ Connected to MongoDB\n');
        
        // Find all anime with malformed ylnime URLs (&episode= instead of &ep=)
        const animes = await Anime.find({
            'episodesList.urls.1': { $regex: /[&?]episode=/ }
        });
        
        if (animes.length === 0) {
            console.log('No anime with malformed ylnime URLs found');
            process.exit(0);
        }
        
        console.log(`Found ${animes.length} anime with malformed ylnime URLs\n`);
        
        let totalEpisodesFixed = 0;
        
        for (const anime of animes) {
            let epCount = 0;
            
            for (const ep of anime.episodesList) {
                const urls = ep.urls instanceof Map ? Object.fromEntries(ep.urls) : { ...ep.urls };
                const hadMalformed = urls['1'] && /[&?]episode=/.test(urls['1']);
                
                if (hadMalformed) {
                    delete urls['1'];
                    delete urls.ylnime;
                    ep.urls = urls;
                    epCount++;
                }
            }
            
            if (epCount > 0) {
                await anime.save();
                console.log(`✓ ${anime.title} (MAL: ${anime.malId}) - cleaned ${epCount} episodes`);
                totalEpisodesFixed += epCount;
            }
        }
        
        console.log(`\n✓ Fixed ${totalEpisodesFixed} episodes across ${animes.length} anime`);
        console.log('✓ Database cleanup completed');
        
        process.exit(0);
    } catch (err) {
        console.error('✗ Error:', err.message);
        process.exit(1);
    }
}

fixAllYlnimeMalformedUrls();
