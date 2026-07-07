import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const connectDB = async () => {
    try {
        const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
        if (!uri) {
            console.warn("⚠️ [MongoDB] MONGODB_URI/MONGO_URI belum diatur di .env. Menggunakan memori sementara atau database lokal jika tersedia.");
            return;
        }

        const conn = await mongoose.connect(uri, {
            maxPoolSize: 10,           // Batasi pool untuk RAM kecil
            minPoolSize: 2,
            serverSelectionTimeoutMS: 5000, 
            socketTimeoutMS: 45000,
        });

        mongoose.connection.on('disconnected', () => console.warn('⚠️ [MongoDB] Terputus. Menunggu reconnect...'));
        mongoose.connection.on('error', (err) => console.error(`❌ [MongoDB] Error Runtime: ${err.message}`));

        console.log(`✅ [MongoDB] Berhasil terhubung ke: ${conn.connection.host}`);
    } catch (error) {
        console.error(`❌ [MongoDB] Error Koneksi: ${error.message}`);
        process.exit(1);
    }
};

export default connectDB;
