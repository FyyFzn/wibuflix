import connectDB from '../config/db.js';
import { syncNimegami } from '../sync/nimegami_sync.js';

async function main() {
    console.log('🚀 [Init Nimegami] Memulai sinkronisasi awal katalog A-Z dari Nimegami...');
    await connectDB();
    await syncNimegami();
    console.log('✅ [Init Nimegami] Sinkronisasi awal A-Z selesai!');
    process.exit(0);
}

main().catch(err => {
    console.error('❌ [Init Nimegami] Error fatal:', err);
    process.exit(1);
});
