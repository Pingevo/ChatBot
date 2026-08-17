#!/usr/bin/env node
// Seed script — creates the first superadmin.
// Usage:
//   node scripts/seed-superadmin.mjs --email admin@digital.in.th --username admin --password "yourpassword"
// Or interactively (no args): prompts via stdin.
//
// Reads MongoDB connection from ADMIN_MONGO_* env vars (same as Python admin/db.py).
// Load your .env first:  source ../.env  OR  export ADMIN_MONGO_URI=...
import { createHash, randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

function buildMongoUri() {
  const direct = process.env.ADMIN_MONGO_URI?.trim();
  if (direct) return direct;
  const host = process.env.ADMIN_MONGO_HOST?.trim() || "127.0.0.1:27017";
  const username = process.env.ADMIN_MONGO_USERNAME?.trim() || "";
  const password = process.env.ADMIN_MONGO_PASSWORD?.trim() || "";
  const authSource = process.env.ADMIN_MONGO_AUTH_SOURCE?.trim() || "admin";
  const tls = (process.env.ADMIN_MONGO_TLS?.trim().toLowerCase() || "false") === "true";
  const params = new URLSearchParams({ authSource, tls: String(tls) });
  const creds = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
  return `mongodb://${creds}${host}/?${params.toString()}`;
}

const MONGO_URI = buildMongoUri();
const MONGO_DB = process.env.ADMIN_MONGO_DB?.trim() || "chatbot_admin";
const ADMINS_COLL = process.env.ADMIN_MONGO_COLLECTION_ADMINS?.trim() || "admins";

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.replace(/^--/, "");
      if (key.includes("=")) {
        const [k, ...v] = key.split("=");
        args[k] = v.join("=");
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        args[key] = argv[i + 1];
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

async function prompt(rl, question, hidden = false) {
  if (!hidden) return (await rl.question(question)).trim();
  return new Promise((resolve) => {
    process.stdout.write(question);
    let value = "";
    const onData = (ch) => {
      const c = ch.toString();
      if (c === "\r" || c === "\n" || c === "\u0004") {
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value.trim());
      } else if (c === "\u0003") {
        process.exit(1);
      } else {
        value += c;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const args = parseArgs();
  let email = args.email;
  let username = args.username;
  let password = args.password;
  let name = args.name || "Super Admin";
  let role = args.role || "superadmin";

  if (!email || !username || !password) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    email = email || (await prompt(rl, "Email: "));
    username = username || (await prompt(rl, "Username: "));
    if (!password) password = await prompt(rl, "Password (min 8 chars): ", true);
    if (!name) name = (await prompt(rl, "Display name (optional): ")) || "Super Admin";
    rl.close();
  }

  if (!email || !username || !password) {
    console.error("Missing required fields: email, username, password");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters");
    process.exit(1);
  }

  console.log(`\nConnecting to MongoDB: ${MONGO_DB} (host from env)`);
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(MONGO_DB);
  const coll = db.collection(ADMINS_COLL);

  // Ensure indexes
  await coll.createIndex({ email: 1 }, { unique: true, sparse: true });
  await coll.createIndex({ username: 1 }, { unique: true, sparse: true });
  await coll.createIndex({ admin_id: 1 }, { unique: true, sparse: true });

  // Check existing
  const existingByEmail = await coll.findOne({ email: email.toLowerCase() });
  if (existingByEmail) {
    console.error(`Email ${email} already exists.`);
    await client.close();
    process.exit(1);
  }
  const existingByUsername = await coll.findOne({ username });
  if (existingByUsername) {
    console.error(`Username ${username} already exists.`);
    await client.close();
    process.exit(1);
  }

  // Hash password (sha256 pre-hash + bcrypt, same as auth.ts)
  const pre = createHash("sha256").update(password, "utf8").digest("hex");
  const salt = await bcrypt.genSalt(12);
  const passwordHash = await bcrypt.hash(pre, salt);

  const adminId = "adm_" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  const doc = {
    admin_id: adminId,
    email: email.toLowerCase(),
    username,
    name,
    role: role,
    password_hash: passwordHash,
    active: true,
    channels_access: [],
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    created_at: new Date(),
    created_by: "seed",
  };

  await coll.insertOne(doc);
  console.log(`\n✓ Superadmin created successfully:`);
  console.log(`  admin_id: ${adminId}`);
  console.log(`  email:    ${email}`);
  console.log(`  username: ${username}`);
  console.log(`  role:     ${role}`);
  console.log(`\nYou can now log in at /login`);
  await client.close();
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
