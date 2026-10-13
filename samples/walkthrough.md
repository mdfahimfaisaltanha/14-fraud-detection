# Tripwire — 6-step demo walkthrough

A scripted tour that shows off every load-bearing part in ~5 minutes. Run `npm run setup`,
`npm run generate`, `npm run score`, `npm run dev` first.

## 1. Watch the eval print (terminal)

`npm run score` ends with the threshold sweep and per-pattern recall table. Point at the
`velocity` row — ~53% recall — and explain *why* (each txn in a burst looks individually normal;
only the sequence is anomalous). Knowing your detector's blind spot beats pretending it has none.

## 2. Flagged tab — read a flag like a human

Open 🚨 Flagged at the default threshold 60. Click the top transaction (usually an
`account_takeover` scoring 90+). The detail view shows:

- per-rule contributions: `+25 Transaction from RO; account's home country is US`,
  `+15 new device`, `+20 odd hour`, `+33 amount 8.1σ above typical`
- the transaction-vs-baseline table mapping every raw value to its feature

This is the explainability deliverable: an analyst can act on this without trusting a black box.

## 3. Find a false positive — honesty on display

Still in Flagged, look for a row with a green `legit` chip (the tab header counts them). It is
almost always legitimate travel — new country fires +25, forest agrees it's unusual. Say: "the
dataset injects legit travel noise *on purpose* so precision can't be a dishonest 100%."

## 4. Metrics tab — drag the slider

Open 📊 Metrics. Drag the threshold from 60 down to 40: recall jumps to ~92% but false positives
explode (~116). Drag up to 70: precision hits ~95% but a third of fraud walks through, and the
per-pattern table shows `velocity` recall collapsing first. One sentence: "the threshold is a
product decision — this UI makes the trade-off tangible."

## 5. What-if desk — score a hypothetical

Sign in (`analyst@tripwire.test` / `ChangeMe123!`), open 🧪 What-if. The default form is a 3am
foreign electronics splurge on ACC-0001 — score it: high risk, three or four reasons. Now change
country to the account's home, hour to 14, amount to ~2500 cents and rescore: risk collapses to
near zero. This runs the *stored* forest (JSON in Postgres) — inference without retraining.

## 6. Prove determinism (optional, terminal)

```bash
# same seeds → identical metrics
npm run score   # run it twice; the sweep table is identical both times
```

Then open `.env.example`: `DATA_SEED`/`MODEL_SEED` are the only knobs — change one and the whole
world (and its metrics) reproducibly changes.

## Curl quickies

```bash
# top flags
curl 'http://localhost:3000/api/transactions?minRisk=80&limit=5'

# metrics at a strict threshold
curl 'http://localhost:3000/api/metrics?threshold=75'
```
