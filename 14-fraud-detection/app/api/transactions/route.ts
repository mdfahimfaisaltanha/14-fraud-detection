// GET /api/transactions?minRisk=60&account=ACC-0042&fraud=1&limit=50 — list
// GET /api/transactions?id=123 — detail: txn + features + rule reasons + profile
//
// Ground truth (is_fraud / fraud_pattern) is returned deliberately: the whole
// point of the dashboard is comparing what the detectors flagged against what
// was actually injected — including seeing the false positives honestly.

import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)

  const id = searchParams.get("id")
  if (id) {
    const { rows } = await query(
      `SELECT t.*, a.ref AS account_ref, a.profile AS account_profile
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE t.id = $1`,
      [Number(id)],
    )
    if (rows.length === 0) return NextResponse.json({ error: "Transaction not found" }, { status: 404 })
    return NextResponse.json({ transaction: rows[0] })
  }

  const conditions: string[] = []
  const params: unknown[] = []

  const minRisk = searchParams.get("minRisk")
  if (minRisk !== null && minRisk !== "") {
    params.push(Number(minRisk))
    conditions.push(`t.risk_score >= $${params.length}`)
  }
  const account = searchParams.get("account")
  if (account) {
    params.push(account)
    conditions.push(`a.ref = $${params.length}`)
  }
  const fraud = searchParams.get("fraud")
  if (fraud === "1") conditions.push(`t.is_fraud = TRUE`)
  if (fraud === "0") conditions.push(`t.is_fraud = FALSE`)

  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 50, 1), 200)
  params.push(limit)

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
  const { rows } = await query(
    `SELECT t.id, a.ref AS account_ref, t.amount_cents, t.merchant, t.category, t.country, t.device,
            t.occurred_at, t.is_fraud, t.fraud_pattern, t.rule_score, t.iso_score, t.risk_score
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     ${where}
     ORDER BY t.risk_score DESC NULLS LAST, t.id ASC
     LIMIT $${params.length}`,
    params,
  )
  return NextResponse.json({ transactions: rows })
}
