// Feature engineering — the shared vocabulary of both detectors.
//
// Every feature is RELATIVE TO THE ACCOUNT'S OWN BASELINE, not global. A $500
// charge is unremarkable for a business traveler and wildly anomalous for a
// student account; absolute-amount rules can't express that.
//
// MIRROR WARNING: scripts/score.mjs re-implements these functions inline in
// JS (scripts cannot import TS). If you change the math here, change it there.

import type { AccountProfile, FeatureVector } from "./types"

export type TxnForFeatures = {
  amountCents: number
  hour: number // 0-23, local
  country: string
  device: string
  category: string
  velocity1h: number // account txns in the preceding 60 minutes
}

// Hours outside the usual active window, as circular distance (a 2am txn for
// a 9-19h account is 5h off via the near side, not 7h). 0 = inside window.
export function hourOff(hour: number, activeHours: [number, number]): number {
  const [start, end] = activeHours
  const inWindow = start <= end ? hour >= start && hour <= end : hour >= start || hour <= end
  if (inWindow) return 0
  const circDist = (a: number, b: number) => {
    const d = Math.abs(a - b)
    return Math.min(d, 24 - d)
  }
  return Math.min(circDist(hour, start), circDist(hour, end))
}

export function computeFeatures(txn: TxnForFeatures, profile: AccountProfile): FeatureVector {
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

// Fixed feature order for the isolation forest — must match training
// (scripts/score.mjs) exactly, or the model scores garbage.
export function featureArray(f: FeatureVector): number[] {
  return [
    f.amount_z,
    f.hour_off,
    f.new_country,
    f.new_device,
    f.cat_novelty,
    Math.min(f.velocity_1h, 20), // cap so one pathological burst can't dominate splits
  ]
}

export const FEATURE_NAMES = ["amount_z", "hour_off", "new_country", "new_device", "cat_novelty", "velocity_1h"] as const
