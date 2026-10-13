// Detector 1: transparent weighted rules over z-scores and novelty flags.
//
// Deliberately simple and FULLY EXPLAINABLE — every flagged transaction can
// list exactly which rules fired, how many points each contributed, and the
// underlying values in plain English. This is the detector you can defend to
// a regulator; the isolation forest is the one that catches what rules miss.
//
// MIRROR WARNING: scripts/score.mjs re-implements this inline in JS.

import type { AccountProfile, FeatureVector, RuleReason } from "./types"

export function ruleScore(
  f: FeatureVector,
  profile: AccountProfile,
  txn: { amountCents: number; country: string; device: string; category: string },
): { score: number; reasons: RuleReason[] } {
  const reasons: RuleReason[] = []

  if (f.amount_z > 3) {
    const points = Math.round((Math.min(f.amount_z, 12) / 12) * 40)
    reasons.push({
      rule: "amount_spike",
      points,
      detail: `Amount $${(txn.amountCents / 100).toFixed(2)} is ${f.amount_z.toFixed(1)}σ above this account's typical $${(profile.meanAmountCents / 100).toFixed(2)}`,
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
