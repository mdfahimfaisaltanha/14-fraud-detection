// Train + score: feature extraction, z-score rules, isolation forest (built
// FROM SCRATCH here — training lives in this script; lib/isoforest.ts only
// walks the stored trees for what-if inference).
//
// Deterministic given MODEL_SEED (default 7). Re-runnable: rescores all rows
// and overwrites the stored model.
//
// MIRROR WARNING: computeFeatures/featureArray/ruleScore/riskScore below must
// stay in lockstep with lib/features.ts, lib/zscore.ts, lib/isoforest.ts.

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

const MODEL_SEED = Number(process.env.MODEL_SEED || 7)
const NUM_TREES = 100
const SAMPLE = 256
const MAX_DEPTH = Math.ceil(Math.log2(SAMPLE)) // 8

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(MODEL_SEED)

// ---- feature engineering (mirror of lib/features.ts) -----------------------
function hourOff(hour, activeHours) {
  const [start, end] = activeHours
  const inWindow = start <= end ? hour >= start && hour <= end : hour >= start || hour <= end
  if (inWindow) return 0
  const circDist = (a, b) => {
    const d = Math.abs(a - b)
    return Math.min(d, 24 - d)
  }
  return Math.min(circDist(hour, start), circDist(hour, end))
}

function computeFeatures(txn, profile) {
  const std = Math.max(profile.stdAmountCents, 1)
  return {
    amount_z: (txn.amountCents - profile.meanAmountCents) / std,
    hour_off: hourOff(txn.hour, profile.activeHours),
    new_country: txn.country === profile.homeCountry ? 0 : 1,
    new_device: txn.device === profile.usualDevice ? 0 : 1,
    cat_novelty: profile.categories.includes(txn.category) ? 0 : 1,
    velocity_1h: txn.velocity1h,
  }
}

function featureArray(f) {
  return [f.amount_z, f.hour_off, f.new_country, f.new_device, f.cat_novelty, Math.min(f.velocity_1h, 20)]
}

// ---- rules (mirror of lib/zscore.ts) ---------------------------------------
function ruleScore(f, profile, txn) {
  const reasons = []
  if (f.amount_z > 3) {
    const points = Math.round((Math.min(f.amount_z, 12) / 12) * 40)
    reasons.push({
      rule: "amount_spike",
      points,
      detail: `Amount $${(txn.amountCents / 100).toFixed(2)} is ${f.amount_z.toFixed(1)}\u03c3 above this account's typical $${(profile.meanAmountCents / 100).toFixed(2)}`,
    })
  }
  if (f.hour_off >= 3) {
    const points = Math.min(Math.round(8 + 2 * f.hour_off), 20)
    reasons.push({
      rule: "odd_hour",
      points,
      detail: `Transaction ${f.hour_off}h outside the account's usual ${profile.activeHours[0]}:00-${profile.activeHours[1]}:00 window`,
    })
  }
  if (f.new_country === 1) {
    reasons.push({
      rule: "new_country",
      points: 25,
      detail: `Transaction from ${txn.country}; account's home country is ${profile.homeCountry}`,
    })
  }
  if (f.new_device === 1) {
    reasons.push({
      rule: "new_device",
      points: 15,
      detail: `Device "${txn.device}" differs from the account's usual "${profile.usualDevice}"`,
    })
  }
  if (f.cat_novelty === 1 && f.amount_z > 2) {
    reasons.push({
      rule: "novel_category_high",
      points: 10,
      detail: `First-ever "${txn.category}" purchase for this account, at an unusually high amount`,
    })
  }
  if (f.velocity_1h >= 4) {
    const points = Math.min(Math.round(f.velocity_1h * 3), 25)
    reasons.push({
      rule: "velocity",
      points,
      detail: `${f.velocity_1h} transactions on this account in the preceding hour`,
    })
  }
  const score = Math.min(
    reasons.reduce((s, r) => s + r.points, 0),
    100,
  )
  return { score, reasons }
}

// ---- isolation forest: TRAINING ---------------------------------------------
function buildTree(data, depth) {
  if (depth >= MAX_DEPTH || data.length <= 1) return { n: data.length }
  // candidate features are those with actual spread in this partition
  const dims = data[0].length
  const candidates = []
  for (let d = 0; d < dims; d++) {
    let lo = Infinity
    let hi = -Infinity
    for (const x of data) {
      if (x[d] < lo) lo = x[d]
      if (x[d] > hi) hi = x[d]
    }
    if (hi > lo) candidates.push({ d, lo, hi })
  }
  if (candidates.length === 0) return { n: data.length }
  const c = candidates[Math.floor(rng() * candidates.length)]
  const v = c.lo + rng() * (c.hi - c.lo)
  const left = []
  const right = []
  for (const x of data) (x[c.d] < v ? left : right).push(x)
  if (left.length === 0 || right.length === 0) return { n: data.length }
  return { f: c.d, v, l: buildTree(left, depth + 1), r: buildTree(right, depth + 1) }
}

function trainForest(vectors) {
  const trees = []
  for (let t = 0; t < NUM_TREES; t++) {
    const sample = []
    for (let i = 0; i < Math.min(SAMPLE, vectors.length); i++) {
      sample.push(vectors[Math.floor(rng() * vectors.length)])
    }
    trees.push(buildTree(sample, 0))
  }
  return { trees, sample: SAMPLE }
}

// ---- isolation forest: INFERENCE (mirror of lib/isoforest.ts) ---------------
function avgPathLen(n) {
  if (n <= 1) return 0
  return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n
}
function pathLength(node, x, depth = 0) {
  if (node.l === undefined) return depth + avgPathLen(node.n ?? 1)
  return pathLength(x[node.f] < node.v ? node.l : node.r, x, depth + 1)
}
function isoScore(forest, x) {
  const mean = forest.trees.reduce((s, t) => s + pathLength(t, x), 0) / forest.trees.length
  return Math.pow(2, -mean / avgPathLen(forest.sample))
}
function riskScore(rule0to100, iso0to1) {
  const ruleN = rule0to100 / 100
  const isoN = Math.max(0, Math.min(1, (iso0to1 - 0.35) / 0.4))
  return Math.round(100 * (0.5 * ruleN + 0.5 * isoN))
}

// ---- main --------------------------------------------------------------------
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const accountsRes = await client.query(`SELECT id, profile FROM accounts`)
const profiles = new Map(accountsRes.rows.map((r) => [r.id, r.profile]))

const txnsRes = await client.query(
  `SELECT id, account_id, amount_cents, merchant, category, country, device, occurred_at, is_fraud, fraud_pattern
   FROM transactions ORDER BY account_id, occurred_at, id`,
)
const txns = txnsRes.rows
if (txns.length === 0) {
  console.error("No transactions found — run: npm run generate")
  await client.end()
  process.exit(1)
}
console.log(`Scoring ${txns.length} transactions…`)

// velocity_1h: sliding window per account (rows are sorted by account, time)
const window = []
let windowAccount = null
for (const t of txns) {
  const ts = new Date(t.occurred_at).getTime()
  if (t.account_id !== windowAccount) {
    window.length = 0
    windowAccount = t.account_id
  }
  while (window.length > 0 && ts - window[0] > 3600_000) window.shift()
  t.velocity1h = window.length
  window.push(ts)
}

// features + rules
const t0 = Date.now()
for (const t of txns) {
  const profile = profiles.get(t.account_id)
  const hour = new Date(t.occurred_at).getHours()
  t.featuresObj = computeFeatures(
    {
      amountCents: t.amount_cents,
      hour,
      country: t.country,
      device: t.device,
      category: t.category,
      velocity1h: t.velocity1h,
    },
    profile,
  )
  const rules = ruleScore(t.featuresObj, profile, {
    amountCents: t.amount_cents,
    country: t.country,
    device: t.device,
    category: t.category,
  })
  t.ruleScoreVal = rules.score
  t.ruleReasonsVal = rules.reasons
  t.vector = featureArray(t.featuresObj)
}

// train forest on ALL vectors — unsupervised, labels never touched
console.log(`Training isolation forest (${NUM_TREES} trees, subsample ${SAMPLE}, seed ${MODEL_SEED})…`)
const forest = trainForest(txns.map((t) => t.vector))

for (const t of txns) {
  t.isoScoreVal = isoScore(forest, t.vector)
  t.riskScoreVal = riskScore(t.ruleScoreVal, t.isoScoreVal)
}
console.log(`Scored in ${((Date.now() - t0) / 1000).toFixed(1)}s.`)

// persist scores in batches
const BATCH = 250
for (let i = 0; i < txns.length; i += BATCH) {
  const batch = txns.slice(i, i + BATCH)
  const params = []
  const values = batch
    .map((t, j) => {
      params.push(
        t.id,
        JSON.stringify(t.featuresObj),
        t.ruleScoreVal,
        JSON.stringify(t.ruleReasonsVal),
        Number(t.isoScoreVal.toFixed(6)),
        t.riskScoreVal,
      )
      const o = j * 6
      return `($${o + 1}::int, $${o + 2}::jsonb, $${o + 3}::real, $${o + 4}::jsonb, $${o + 5}::real, $${o + 6}::real)`
    })
    .join(", ")
  await client.query(
    `UPDATE transactions t
     SET features = v.features, rule_score = v.rule_score, rule_reasons = v.rule_reasons,
         iso_score = v.iso_score, risk_score = v.risk_score, scored_at = now()
     FROM (VALUES ${values}) AS v(id, features, rule_score, rule_reasons, iso_score, risk_score)
     WHERE t.id = v.id`,
    params,
  )
}

// persist the model for the what-if API
await client.query(
  `INSERT INTO model_store (name, model, meta, trained_at)
   VALUES ('isoforest_v1', $1, $2, now())
   ON CONFLICT (name) DO UPDATE SET model = EXCLUDED.model, meta = EXCLUDED.meta, trained_at = now()`,
  [
    JSON.stringify(forest),
    JSON.stringify({ trees: NUM_TREES, sample: SAMPLE, seed: MODEL_SEED, trainedOn: txns.length }),
  ],
)

// ---- honest evaluation against ground truth ----------------------------------
function evaluate(threshold) {
  let tp = 0
  let fp = 0
  let fn = 0
  for (const t of txns) {
    const flagged = t.riskScoreVal >= threshold
    if (flagged && t.is_fraud) tp++
    else if (flagged && !t.is_fraud) fp++
    else if (!flagged && t.is_fraud) fn++
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { threshold, tp, fp, fn, precision, recall, f1 }
}

console.log("\nEvaluation vs ground truth (fraud = 150 of 5000):")
console.log("  thr   TP    FP    FN   precision  recall   F1")
for (const thr of [40, 50, 60, 70]) {
  const e = evaluate(thr)
  console.log(
    `  ${String(e.threshold).padEnd(4)} ${String(e.tp).padStart(3)}  ${String(e.fp).padStart(4)}  ${String(e.fn).padStart(4)}     ${e.precision.toFixed(3)}    ${e.recall.toFixed(3)}  ${e.f1.toFixed(3)}`,
  )
}

console.log("\nPer-pattern recall at threshold 60:")
const patterns = new Map()
for (const t of txns) {
  if (!t.is_fraud) continue
  const p = patterns.get(t.fraud_pattern) ?? { total: 0, caught: 0 }
  p.total++
  if (t.riskScoreVal >= 60) p.caught++
  patterns.set(t.fraud_pattern, p)
}
for (const [name, p] of [...patterns.entries()].sort()) {
  console.log(`  ${name.padEnd(18)} ${p.caught}/${p.total}`)
}

console.log("\nDone. Open the dashboard: npm run dev → http://localhost:3000")
await client.end()
