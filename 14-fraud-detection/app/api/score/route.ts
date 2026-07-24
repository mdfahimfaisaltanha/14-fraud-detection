// POST /api/score — the what-if desk (sign-in required).
//
// Score a HYPOTHETICAL transaction against a real account's baseline using
// the stored isolation forest — no retraining, just walking the trees — plus
// the transparent rules. Body:
//   { accountRef, amountCents, hour, country, device, category, velocity1h }

import { NextRequest, NextResponse } from "next/server"
import { currentUser } from "@/lib/auth"
import { query } from "@/lib/db"
import { computeFeatures, featureArray } from "@/lib/features"
import { isoScore, riskScore, type IsoForest } from "@/lib/isoforest"
import { ruleScore } from "@/lib/zscore"
import type { AccountProfile } from "@/lib/types"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: "Sign in to use the what-if desk" }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const accountRef = String(body.accountRef ?? "").trim()
  const amountCents = Number(body.amountCents)
  const hour = Number(body.hour)
  const country = String(body.country ?? "").trim().toUpperCase()
  const device = String(body.device ?? "").trim()
  const category = String(body.category ?? "").trim()
  const velocity1h = Number(body.velocity1h ?? 0)

  if (!accountRef) return NextResponse.json({ error: "accountRef is required (e.g. ACC-0042)" }, { status: 422 })
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000) {
    return NextResponse.json({ error: "amountCents must be a positive integer" }, { status: 422 })
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return NextResponse.json({ error: "hour must be an integer 0-23" }, { status: 422 })
  }
  if (!/^[A-Z]{2}$/.test(country)) return NextResponse.json({ error: "country must be a 2-letter code" }, { status: 422 })
  if (!device) return NextResponse.json({ error: "device is required" }, { status: 422 })
  if (!category) return NextResponse.json({ error: "category is required" }, { status: 422 })
  if (!Number.isInteger(velocity1h) || velocity1h < 0 || velocity1h > 100) {
    return NextResponse.json({ error: "velocity1h must be an integer 0-100" }, { status: 422 })
  }

  const accounts = await query<{ id: number; ref: string; profile: AccountProfile }>(
    `SELECT id, ref, profile FROM accounts WHERE ref = $1`,
    [accountRef],
  )
  if (accounts.rows.length === 0) {
    return NextResponse.json({ error: `Account ${accountRef} not found (try ACC-0001 … ACC-0200)` }, { status: 404 })
  }
  const profile = accounts.rows[0].profile

  const models = await query<{ model: IsoForest }>(`SELECT model FROM model_store WHERE name = 'isoforest_v1'`)
  if (models.rows.length === 0) {
    return NextResponse.json({ error: "No trained model found — run: npm run score" }, { status: 409 })
  }
  const forest = models.rows[0].model

  const features = computeFeatures({ amountCents, hour, country, device, category, velocity1h }, profile)
  const rules = ruleScore(features, profile, { amountCents, country, device, category })
  const iso = isoScore(forest, featureArray(features))
  const risk = riskScore(rules.score, iso)

  return NextResponse.json({
    accountRef,
    profile,
    features,
    ruleScore: rules.score,
    ruleReasons: rules.reasons,
    isoScore: Number(iso.toFixed(4)),
    riskScore: risk,
  })
}
