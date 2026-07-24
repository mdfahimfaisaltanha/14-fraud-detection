# EVAL — Tripwire detector evaluation

Sample run with the default seeds (`DATA_SEED=42`, `MODEL_SEED=7`) on the 5,000-transaction
synthetic dataset (150 fraud, 3.0% prevalence). Reproduce with:

```bash
npm run setup && npm run generate && npm run score
```

Your exact numbers will match a same-seed run; changing either seed changes the world and the
trees, so expect small shifts.

## Threshold sweep (printed by `npm run score`)

| Threshold | TP | FP | FN | Precision | Recall | F1 |
| --- | --- | --- | --- | --- | --- | --- |
| 40 | 138 | 116 | 12 | 0.543 | 0.920 | 0.683 |
| 50 | 130 | 44 | 20 | 0.747 | 0.867 | 0.803 |
| **60** | **121** | **18** | **29** | **0.871** | **0.807** | **0.838** |
| 70 | 97 | 5 | 53 | 0.951 | 0.647 | 0.770 |

The dashboard defaults to threshold 60 — the F1 sweet spot on this dataset. The point of the
slider is that this is a **product decision**: an ops team drowning in review queues moves right;
a team bleeding chargebacks moves left.

## Per-pattern recall at threshold 60

| Pattern | Injected | Caught | Recall | Why |
| --- | --- | --- | --- | --- |
| `account_takeover` | 30 | 30 | 100% | Fires 3–4 rules at once + extreme forest isolation |
| `amount_spike` | 30 | 28 | ~93% | amount_z rule; misses are spikes on high-variance accounts |
| `new_merchant_high` | 30 | 25 | ~83% | Two moderate signals; weakest when amount is only ~4× |
| `card_testing` | 30 | 22 | ~73% | First 3 txns of each burst have low velocity — cold-start problem |
| `velocity` | 30 | 16 | ~53% | Deliberately hard: every txn looks individually normal |

### The interesting failure: `velocity`

Velocity-burst fraud is where per-transaction scoring shows its limits — each transaction in the
burst is individually indistinguishable from normal behavior; only the *sequence* is anomalous.
The `velocity_1h` feature only climbs as the burst progresses, so the first transactions of every
burst are structurally uncatchable at scoring time. Production systems solve this with
session-level scoring or retrospective sweep jobs that re-score recent windows — a natural
"what would you build next" answer.

## False positives at threshold 60 (~18)

Almost all are the dataset's deliberate noise: legitimate travel (new country fires +25) that
co-occurs with another mild signal, and high-variance accounts having an expensive-but-real day.
This is realistic — geography changes are the classic FP source in real fraud ops.

## Methodology notes

- Ground-truth labels are used **only** in this evaluation. The forest trains unsupervised on all
  5,000 vectors, fraud included (~3% contamination), exactly as in unlabeled production.
- Precision/recall are the right metrics at 3% prevalence — accuracy would be 97% for a detector
  that flags nothing.
- Synthetic data caveat: injected patterns are cleanly separable by construction. These numbers
  characterize the pipeline, not real-world performance.
