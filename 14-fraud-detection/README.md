# Tripwire — Fraud & Anomaly Detection System

Fraud/anomaly detection for a fictional payments company (**Kite Payments**): a seeded synthetic
dataset of 5,000 transactions with 150 labeled frauds across 5 patterns, two complementary
detectors — a **transparent z-score rules engine** and an **isolation forest implemented from
scratch** — explainable flags, and honest precision/recall evaluation with a live threshold slider.

Next.js 14 (App Router) + TypeScript + PostgreSQL. No ML libraries — the isolation forest is ~60
lines of real algorithm, which is the point.

## Architecture

```
scripts/generate.mjs        scripts/score.mjs                    Next.js app
┌──────────────────┐   ┌──────────────────────────────┐   ┌──────────────────────────┐
│ 200 account      │   │ 1. velocity (sliding window) │   │ /api/transactions        │
│ profiles         │──▶│ 2. features vs baseline      │──▶│ /api/metrics  (P/R sweep)│
│ 4850 normal txns │   │ 3. z-score rules + reasons   │   │ /api/score    (what-if)  │
│ 150 fraud (5     │   │ 4. train isolation forest    │   │                          │
│ labeled patterns)│   │ 5. blend → risk_score 0-100  │   │ dashboard: flags, matrix,│
└──────────────────┘   │ 6. store model as JSON       │   │ PR curve, threshold slider│
        Postgres        └──────────────────────────────┘   └──────────────────────────┘
```

## Design decisions

1. **Two detectors, deliberately different.** The rules engine is fully explainable — every flag
   lists which rules fired, the points each contributed, and the underlying values in plain
   English ("Amount $2,340.00 is 14.2σ above this account's typical $38.50"). The isolation
   forest is unsupervised and catches combinations no rule anticipates. Rules are what you defend
   to a regulator; the forest is what covers your blind spots. The blend is 50/50 after
   normalizing both to [0,1].

2. **Isolation forest from scratch, per the paper.** Liu, Ting & Zhou (2008): anomalies are few
   and different, so random axis-aligned splits isolate them in fewer cuts. 100 trees, subsample
   256, height limit ⌈log₂256⌉ = 8, score = 2^(−E[h(x)]/c(n)) with the paper's c(n) normalizer
   extending paths at unsplit leaves. Training lives in `scripts/score.mjs`; the trained forest is
   stored as JSON in `model_store`, and `lib/isoforest.ts` only *walks* the stored trees — so the
   what-if API scores hypotheticals without retraining.

3. **Every feature is relative to the account's own baseline.** A $500 charge is unremarkable for
   a business traveler and wildly anomalous for a student. Six features: `amount_z`, `hour_off`
   (circular distance outside usual active hours), `new_country`, `new_device`, `cat_novelty`,
   `velocity_1h`. Global-threshold rules can't express any of this.

4. **Ground truth is stored but firewalled.** `is_fraud`/`fraud_pattern` are written by the
   generator and read ONLY by evaluation code. The detectors never touch labels — the forest is
   trained unsupervised on all 5,000 vectors, contamination included, exactly as it would be in
   production where you don't have labels.

5. **The dataset makes false positives possible on purpose.** 2% of normal transactions are
   legitimate travel (new country), 5% are legit category exploration. Without this noise the
   detectors would score a dishonest 100% precision and the threshold slider would teach nothing.

6. **The threshold is a product decision, not an ML decision.** The dashboard's slider recomputes
   the confusion matrix live so you can *feel* the trade-off: flag at 40 and drown analysts in
   false positives; flag at 80 and let account takeovers through. Per-pattern recall shows which
   patterns die first as you raise it (velocity and card testing survive; amount spikes fade).

7. **Determinism everywhere.** Data seed 42, model seed 7 (mulberry32). Same seeds → same world,
   same trees, same metrics. `EVAL.md` numbers are reproducible, not cherry-picked.

## Getting started

```bash
npm install
cp .env.example .env.local   # set DATABASE_URL (Neon/Supabase free tier works)
npm run setup                # schema + 2 analysts
npm run generate             # 5,000-transaction synthetic world (seed 42)
npm run score                # train forest + score everything + print eval
npm run dev                  # http://localhost:3000
```

Sign-in (what-if desk): `analyst@tripwire.test` / `admin@tripwire.test` with `SEED_PASSWORD`
(default `ChangeMe123!`).

## API

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/transactions?minRisk=&account=&fraud=&limit=` | — | List transactions (risk-sorted) |
| GET | `/api/transactions?id=` | — | Detail: features, rule reasons, account baseline |
| GET | `/api/metrics?threshold=` | — | Confusion matrix, P/R/F1, 5–95 sweep, per-pattern recall |
| POST | `/api/score` | session | Score a hypothetical transaction with stored model |
| GET/POST/DELETE | `/api/auth` | — | Session check / login / logout |

## The five injected fraud patterns

| Pattern | Shape | What catches it |
| --- | --- | --- |
| `card_testing` | Bursts of 5 tiny charges minutes apart | velocity rule + forest |
| `account_takeover` | New country + new device + odd hour + 3–8× amount | nearly every rule at once |
| `amount_spike` | 10–25× typical spend, everything else normal | amount_z rule |
| `velocity` | 5 normal-looking txns in ~40 min | velocity rule alone — rules earn their keep |
| `new_merchant_high` | Never-seen category at 4–8× amount | novel-category + amount_z |

## Edge cases handled

| # | Edge case | Behavior |
| --- | --- | --- |
| 1 | Account with tiny std (consistent spender) | std floored at 1¢ so amount_z can't divide by zero |
| 2 | Active hours near midnight | `hour_off` uses circular distance (2am vs 9–19h window = 5h, not 7h) |
| 3 | Legitimate travel | Honest false positives — visible in the Flagged tab with a `legit` chip |
| 4 | Feature with no spread in a tree partition | Excluded from split candidates; degenerate splits return leaf |
| 5 | Unscored dataset | Metrics/flags respond with a "run npm run score" hint, not empty UI |
| 6 | What-if for unknown account | 404 with the valid ref range |
| 7 | What-if before training | 409 "No trained model found" |
| 8 | Threshold extremes | Clamped 1–99; sweep skips undefined precision (no flags) points |
| 9 | Double generation | `generate` refuses if transactions exist; prints exact TRUNCATE to reset |
| 10 | Velocity at account boundaries | Sliding window resets per account; counts strictly-prior txns only |

## Honesty notes

- **Synthetic data is easier than real fraud.** Injected patterns are cleanly separated from
  normal behavior by construction; real fraud adapts adversarially. The metrics in `EVAL.md` are
  a property of this dataset, not a claim about production performance.
- **Baselines come from the generator.** In production, account profiles would be rolling
  aggregates over transaction history, updated carefully so fraud doesn't poison its own baseline
  (a classic feedback-loop failure this project sidesteps by construction).
- **The 50/50 blend and iso-score rescale band ([0.35, 0.75]) are tuned to this dataset.** In
  production you'd fit these on a labeled validation window.

## Deploying

- **App:** Vercel (Next.js defaults).
- **Postgres:** Neon or Supabase free tier.
- Run `setup`/`generate`/`score` once from your machine against the production `DATABASE_URL`.
  The model is stored in Postgres, so the what-if API needs no filesystem.
