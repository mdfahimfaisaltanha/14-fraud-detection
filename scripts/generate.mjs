// Synthetic dataset generator — 5,000 transactions, deterministic (DATA_SEED).
//
// 200 accounts each get a behavioral profile (typical amount, active hours,
// home country, usual device, known categories). 4,850 normal transactions
// are drawn FROM those profiles — including realistic noise like legitimate
// travel and occasional new categories, which is what makes false positives
// honest rather than impossible. 150 fraudulent transactions are injected
// across 5 labeled patterns (30 each) so recall can be measured per pattern.
//
// Ground truth (is_fraud, fraud_pattern) is stored on the row but detectors
// never read it — it exists purely so evaluation can be honest.

import { readFileSync } from "node:fs"
import pg from "pg"

try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.")
  process.exit(1)
}

// ---- deterministic RNG -----------------------------------------------------
const SEED = Number(process.env.DATA_SEED || 42)
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(SEED)
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)) // inclusive
const pick = (arr) => arr[Math.floor(rng() * arr.length)]
function gaussian(mean, std) {
  // Box-Muller with our seeded rng
  const u1 = Math.max(rng(), 1e-9)
  const u2 = rng()
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

// ---- world -----------------------------------------------------------------
const HOME_COUNTRIES = ["US", "US", "US", "GB", "GB", "DE", "CA", "AU", "BD", "JP", "BR"]
const TRAVEL_COUNTRIES = ["FR", "IT", "ES", "TR", "TH", "AE", "SG"] // legit trips — honest FP source
const FRAUD_COUNTRIES = ["RO", "NG", "RU", "VN", "UA", "ID"]
const DEVICES = ["ios-app", "android-app", "chrome-desktop", "safari-desktop", "android-web"]
const CATEGORIES = {
  groceries: ["FreshMart", "GreenGrocer", "DailyBasket"],
  dining: ["Cedar Grill", "Noodle Nook", "Cafe Aroma"],
  fuel: ["PetroGo", "FuelPoint"],
  electronics: ["VoltWorld", "GizmoHub"],
  fashion: ["Threadline", "UrbanStitch"],
  travel: ["SkyLoop Air", "Transit Rail"],
  streaming: ["StreamBox", "TuneWave"],
  pharmacy: ["CarePlus Pharmacy", "MediShelf"],
  home: ["NestSupply", "BrightHome"],
  gaming: ["PixelForge Store", "ArcadeVault"],
}
const ALL_CATEGORIES = Object.keys(CATEGORIES)

const NUM_ACCOUNTS = 200
const NORMAL_TXNS = 4850
const DAYS = 30
const NOW = Date.now()

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const already = await client.query(`SELECT count(*)::int AS txn_count FROM transactions`)
if (already.rows[0].txn_count > 0) {
  console.log(`transactions already has ${already.rows[0].txn_count} rows — refusing to double-generate.`)
  console.log(`To regenerate from scratch:`)
  console.log(`  TRUNCATE transactions RESTART IDENTITY; TRUNCATE accounts RESTART IDENTITY CASCADE;`)
  await client.end()
  process.exit(0)
}

// ---- accounts ----------------------------------------------------------------
console.log(`Seed ${SEED}: creating ${NUM_ACCOUNTS} accounts…`)
const accounts = []
for (let i = 1; i <= NUM_ACCOUNTS; i++) {
  const meanAmountCents = Math.round(800 + rng() * rng() * 12000) // $8–$128, skewed low
  const stdAmountCents = Math.round(meanAmountCents * (0.25 + rng() * 0.25))
  const start = randInt(6, 11)
  const end = Math.min(start + randInt(9, 13), 23)
  const shuffled = [...ALL_CATEGORIES].sort(() => rng() - 0.5)
  const categories = shuffled.slice(0, randInt(3, 5))
  accounts.push({
    ref: `ACC-${String(i).padStart(4, "0")}`,
    profile: {
      meanAmountCents,
      stdAmountCents,
      activeHours: [start, end],
      homeCountry: pick(HOME_COUNTRIES),
      usualDevice: pick(DEVICES),
      categories,
    },
  })
}
for (const a of accounts) {
  const res = await client.query(`INSERT INTO accounts (ref, profile) VALUES ($1, $2) RETURNING id`, [
    a.ref,
    JSON.stringify(a.profile),
  ])
  a.id = res.rows[0].id
}

// ---- helpers ----------------------------------------------------------------
function txnTime(daysBack) {
  return new Date(NOW - daysBack * 86400_000)
}
function randomTimeInWindow(profile) {
  const daysBack = rng() * DAYS
  const d = txnTime(daysBack)
  const [start, end] = profile.activeHours
  const hour = rng() < 0.9 ? randInt(start, end) : Math.max(0, Math.min(23, pick([start - 2, start - 1, end + 1, end + 2])))
  d.setHours(hour, randInt(0, 59), randInt(0, 59), 0)
  return d
}
function merchantFor(category) {
  return pick(CATEGORIES[category])
}

const rows = [] // [account_id, amount_cents, merchant, category, country, device, occurred_at, is_fraud, fraud_pattern]

// ---- normal traffic ----------------------------------------------------------
console.log(`Generating ${NORMAL_TXNS} normal transactions…`)
for (let i = 0; i < NORMAL_TXNS; i++) {
  const a = pick(accounts)
  const p = a.profile
  const amount = Math.max(100, Math.round(gaussian(p.meanAmountCents, p.stdAmountCents)))
  const category = rng() < 0.95 ? pick(p.categories) : pick(ALL_CATEGORIES) // 5% legit exploration
  const country = rng() < 0.98 ? p.homeCountry : pick(TRAVEL_COUNTRIES) // 2% legit travel
  const device = rng() < 0.95 ? p.usualDevice : pick(DEVICES)
  rows.push([a.id, amount, merchantFor(category), category, country, device, randomTimeInWindow(p), false, null])
}

// ---- fraud injection: 5 patterns x 30 txns = 150 ------------------------------
console.log("Injecting 150 fraudulent transactions (5 patterns × 30)…")
const usedAccounts = new Set()
function freshAccount() {
  // avoid reusing an account across fraud patterns so per-pattern recall is clean
  for (let tries = 0; tries < 1000; tries++) {
    const a = pick(accounts)
    if (!usedAccounts.has(a.id)) {
      usedAccounts.add(a.id)
      return a
    }
  }
  return pick(accounts)
}

// 1) card_testing — 6 accounts, bursts of 5 tiny charges minutes apart
for (let b = 0; b < 6; b++) {
  const a = freshAccount()
  const base = txnTime(rng() * DAYS)
  base.setHours(randInt(0, 23), randInt(0, 59), 0, 0)
  for (let k = 0; k < 5; k++) {
    const t = new Date(base.getTime() + k * randInt(2, 6) * 60_000)
    const category = pick(["gaming", "streaming", "electronics"])
    rows.push([
      a.id,
      randInt(100, 500),
      merchantFor(category),
      category,
      a.profile.homeCountry,
      rng() < 0.5 ? a.profile.usualDevice : pick(DEVICES),
      t,
      true,
      "card_testing",
    ])
  }
}

// 2) account_takeover — new country + new device + odd hour + elevated amount
for (let i = 0; i < 30; i++) {
  const a = freshAccount()
  const p = a.profile
  const d = txnTime(rng() * DAYS)
  d.setHours((p.activeHours[1] + randInt(4, 8)) % 24, randInt(0, 59), 0, 0)
  const device = pick(DEVICES.filter((x) => x !== p.usualDevice))
  const category = pick(ALL_CATEGORIES)
  rows.push([
    a.id,
    Math.round(p.meanAmountCents * (3 + rng() * 5)),
    merchantFor(category),
    category,
    pick(FRAUD_COUNTRIES),
    device,
    d,
    true,
    "account_takeover",
  ])
}

// 3) amount_spike — 10-25x typical spend, everything else looks normal
for (let i = 0; i < 30; i++) {
  const a = freshAccount()
  const p = a.profile
  const category = pick(p.categories)
  rows.push([
    a.id,
    Math.round(p.meanAmountCents * (10 + rng() * 15)),
    merchantFor(category),
    category,
    p.homeCountry,
    p.usualDevice,
    randomTimeInWindow(p),
    true,
    "amount_spike",
  ])
}

// 4) velocity — 6 accounts, bursts of 5 normal-looking txns within ~40 minutes
for (let b = 0; b < 6; b++) {
  const a = freshAccount()
  const p = a.profile
  const base = randomTimeInWindow(p)
  for (let k = 0; k < 5; k++) {
    const t = new Date(base.getTime() + k * randInt(4, 9) * 60_000)
    const category = pick(p.categories)
    rows.push([
      a.id,
      Math.max(100, Math.round(p.meanAmountCents * (0.8 + rng() * 0.7))),
      merchantFor(category),
      category,
      p.homeCountry,
      p.usualDevice,
      t,
      true,
      "velocity",
    ])
  }
}

// 5) new_merchant_high — never-seen category at 4-8x typical amount
for (let i = 0; i < 30; i++) {
  const a = freshAccount()
  const p = a.profile
  const category = pick(ALL_CATEGORIES.filter((c) => !p.categories.includes(c)))
  rows.push([
    a.id,
    Math.round(p.meanAmountCents * (4 + rng() * 4)),
    merchantFor(category),
    category,
    p.homeCountry,
    p.usualDevice,
    randomTimeInWindow(p),
    true,
    "new_merchant_high",
  ])
}

// ---- insert -------------------------------------------------------------------
console.log(`Inserting ${rows.length} transactions…`)
const BATCH = 250
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH)
  const params = []
  const values = batch
    .map((r, j) => {
      params.push(...r)
      const o = j * 9
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9})`
    })
    .join(", ")
  await client.query(
    `INSERT INTO transactions (account_id, amount_cents, merchant, category, country, device, occurred_at, is_fraud, fraud_pattern)
     VALUES ${values}`,
    params,
  )
}

const summary = await client.query(
  `SELECT coalesce(fraud_pattern, 'normal') AS kind, count(*)::int AS n FROM transactions GROUP BY 1 ORDER BY 1`,
)
console.log("\nDataset ready:")
for (const r of summary.rows) console.log(`  ${r.kind.padEnd(18)} ${r.n}`)
console.log(`\nTotal: ${rows.length} transactions across ${NUM_ACCOUNTS} accounts (seed ${SEED}).`)
console.log("Next: npm run score")

await client.end()
