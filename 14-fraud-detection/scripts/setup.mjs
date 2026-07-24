// Idempotent schema + user seed for Tripwire.
// Usage: npm run setup   (then: npm run generate, npm run score)

import { readFileSync } from "node:fs"
import { randomBytes, scryptSync } from "node:crypto"
import pg from "pg"

// ---- .env.local loader (no dotenv dependency) -----------------------------
try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {
  // fine — rely on real environment variables
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.")
  process.exit(1)
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 16384 })
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`
}

console.log("Creating schema (idempotent)…")

await client.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('analyst', 'admin')),
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS users_sessions (
    token TEXT PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    ref TEXT NOT NULL UNIQUE,
    -- Behavioral baseline. Here the generator writes it; in production this
    -- would be a rolling aggregate over the account's history.
    profile JSONB NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    account_id INT NOT NULL REFERENCES accounts(id),
    amount_cents INT NOT NULL CHECK (amount_cents > 0),
    merchant TEXT NOT NULL,
    category TEXT NOT NULL,
    country TEXT NOT NULL,
    device TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    -- ground truth: used ONLY by evaluation, never by the detectors
    is_fraud BOOLEAN NOT NULL DEFAULT FALSE,
    fraud_pattern TEXT,
    -- written by scripts/score.mjs
    features JSONB,
    rule_score REAL,
    rule_reasons JSONB,
    iso_score REAL,
    risk_score REAL,
    scored_at TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_txn_account_time ON transactions (account_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_txn_risk ON transactions (risk_score DESC NULLS LAST);

  CREATE TABLE IF NOT EXISTS model_store (
    name TEXT PRIMARY KEY,
    model JSONB NOT NULL,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    trained_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`)

const existing = await client.query(`SELECT count(*)::int AS user_count FROM users`)
if (existing.rows[0].user_count > 0) {
  console.log("Users already seeded — skipping user seed.")
} else {
  const password = process.env.SEED_PASSWORD || "ChangeMe123!"
  const seedUsers = [
    { name: "Farah Hossain", email: "analyst@tripwire.test", role: "analyst" },
    { name: "Marcus Reid", email: "admin@tripwire.test", role: "admin" },
  ]
  for (const u of seedUsers) {
    await client.query(`INSERT INTO users (name, email, role, password_hash) VALUES ($1, $2, $3, $4)`, [
      u.name,
      u.email,
      u.role,
      hashPassword(password),
    ])
  }
  console.log("Seeded users (password = SEED_PASSWORD, default ChangeMe123!):")
  for (const u of seedUsers) console.log(`  ${u.email}  (${u.role})`)
}

console.log("\nDone. Next steps:")
console.log("  npm run generate   # create the synthetic 5000-transaction dataset")
console.log("  npm run score      # train the isolation forest + score everything")
console.log("  npm run dev        # open the dashboard")

await client.end()
