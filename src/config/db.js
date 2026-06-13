import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const connectDB = async () => {
    try {
        if (!process.env.MONGODB_URI) {
            console.warn("⚠️ [MongoDB] MONGODB_URI belum diatur di .env. Menggunakan memori sementara atau database lokal jika tersedia.");
            return;
        }

        const conn = await mongoose.connect(process.env.MONGODB_URI);
        console.log(`✅ [MongoDB] Berhasil terhubung ke: ${conn.connection.host}`);
    } catch (error) {
        console.error(`❌ [MongoDB] Error Koneksi: ${error.message}`);
        process.exit(1);
    }
};

export default connectDB;
