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
      const count = await col.countDocuments({
        $or: [
          { message_id: '2430080132981358961' },
          { message_id: 2430080132981358961n },
          { text: /mrwfijrynd3c55/ },
          { url: /mrwfijrynd3c55/ },
          { content: /mrwfijrynd3c55/ }
        ]
      });
      if (count > 0) {
        console.log(`>>> MATCH FOUND IN dbWallet Collection: ${c.name} (count: ${count}) <<<`);
        const docs = await col.find({
          $or: [
            { message_id: '2430080132981358961' },
            { message_id: 2430080132981358961n },
            { text: /mrwfijrynd3c55/ },
            { url: /mrwfijrynd3c55/ },
            { content: /mrwfijrynd3c55/ }
          ]
        }).limit(5).toArray();
        console.log(JSON.stringify(docs, null, 2));
      }
    } catch (e) {}
  }

  await conn.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
