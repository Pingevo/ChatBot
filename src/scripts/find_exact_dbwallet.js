const dotenv = require('dotenv');
dotenv.config();
const mongoose = require('mongoose');

async function main() {
  const conn = await mongoose.createConnection(process.env.SELLCENTER_MONGO_URI).asPromise();
  console.log('Connected to dbWallet!');

  const collections = await conn.db.listCollections().toArray();
  for (const c of collections) {
    try {
      const col = conn.collection(c.name);
      const doc = await col.findOne({
        $or: [
          { message_id: '2430080132981358961' },
          { message_id: 2430080132981358961n },
          { message_id: 2430080132981358961 }
        ]
      });
      if (doc) {
        console.log(`>>> EXACT MATCH IN COLLECTION: ${c.name} <<<`);
        console.log(JSON.stringify(doc, null, 2));
      }
    } catch (e) {}
  }

  await conn.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
