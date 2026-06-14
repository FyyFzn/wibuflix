import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { syncOtakudesu } from './src/scraper/otakudesu_sync.js';

dotenv.config();

async function runSync() {
    await mongoose.connect(process.env.MONGODB_URI);
    await syncOtakudesu();
    console.log("Selesai upsert");
    process.exit(0);
}
runSync();
