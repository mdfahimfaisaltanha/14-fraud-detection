// Shared domain types for Tripwire.

export type User = {
  id: number
  name: string
  email: string
  role: "analyst" | "admin"
}

export const FRAUD_PATTERNS = [
  "card_testing",
  "account_takeover",
  "amount_spike",
  "velocity",
  "new_merchant_high",
] as const
export type FraudPattern = (typeof FRAUD_PATTERNS)[number]

// Per-account behavioral baseline. In this project the generator creates the
// profile and draws transactions from it; in production these are rolling
// aggregates over the account's history (see README — "honesty notes").
export type AccountProfile = {
  meanAmountCents: number
  stdAmountCents: number
  activeHours: [number, number] // [start, end], may wrap midnight
  homeCountry: string
  usualDevice: string
  categories: string[]
}

export type Account = {
  id: number
  ref: string
  profile: AccountProfile
}

export type Transaction = {
  id: number
  account_id: number
  account_ref?: string
  amount_cents: number
  merchant: string
  category: string
  country: string
  device: string
  occurred_at: string
  // ground truth — used ONLY for evaluation, never by the detectors
  is_fraud: boolean
  fraud_pattern: FraudPattern | null
  // written by scripts/score.mjs
  features: FeatureVector | null
  rule_score: number | null
  rule_reasons: RuleReason[] | null
  iso_score: number | null
  risk_score: number | null
  scored_at: string | null
}

// The six behavioral features both detectors consume.
export type FeatureVector = {
  amount_z: number // standard deviations above account's typical amount
  hour_off: number // hours outside the account's usual active window (0 = inside)
  new_country: number // 1 if country differs from home country
  new_device: number // 1 if device differs from usual device
  cat_novelty: number // 1 if category never seen for this account
  velocity_1h: number // account transactions in the preceding 60 minutes
}

export type RuleReason = {
  rule: string
  points: number
  detail: string
}

export type MetricsAtThreshold = {
  threshold: number
  tp: number
  fp: number
  fn: number
  tn: number
  precision: number
  recall: number
  f1: number
}

export type MetricsResponse = {
  total: number
  fraudTotal: number
  at: MetricsAtThreshold
  sweep: MetricsAtThreshold[] // thresholds 5..95 step 5, for the PR curve
  perPattern: Array<{ pattern: string; total: number; caught: number; recall: number }>
  scored: boolean
}
