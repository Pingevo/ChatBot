const dotenv = require('dotenv');
dotenv.config();
const mongoose = require('mongoose');

async function main() {
  const conn = await mongoose.createConnection(process.env.SELLCENTER_MONGO_URI).asPromise();
  console.log('Connected to dbWallet!');

  const Shp2022Token = conn.collection('Shp2022Token');
  const tokens = await Shp2022Token.find({ shop_id: 1002936956 }).toArray();
  console.log('--- Shp2022Token for Yaber ---');
  console.log(JSON.stringify(tokens, null, 2));

  await conn.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
