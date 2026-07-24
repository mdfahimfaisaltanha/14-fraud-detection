// GET /api/metrics?threshold=60
//
// Evaluates the detectors against ground truth: confusion matrix + precision/
// recall/F1 at the requested threshold, a 5..95 sweep for the PR curve, and
// per-pattern recall (which fraud patterns the detectors are blind to).
//
// 5000 (risk_score, is_fraud, fraud_pattern) tuples are loaded once and
// evaluated in JS — simpler than 19 SQL passes and fast at this size.

import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import type { MetricsAtThreshold, MetricsResponse } from "@/lib/types"

export const dynamic = "force-dynamic"

function evaluate(
  rows: Array<{ risk_score: number | null; is_fraud: boolean }>,
  threshold: number,
): MetricsAtThreshold {
  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0
  for (const r of rows) {
    const flagged = (r.risk_score ?? 0) >= threshold
    if (flagged && r.is_fraud) tp++
    else if (flagged && !r.is_fraud) fp++
    else if (!flagged && r.is_fraud) fn++
    else tn++
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return {
    threshold,
    tp,
    fp,
    fn,
    tn,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(f1.toFixed(4)),
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const threshold = Math.min(Math.max(Number(searchParams.get("threshold")) || 60, 1), 99)

  const { rows } = await query<{ risk_score: number | null; is_fraud: boolean; fraud_pattern: string | null }>(
    `SELECT risk_score, is_fraud, fraud_pattern FROM transactions`,
  )

  const scored = rows.some((r) => r.risk_score !== null)
  const fraudTotal = rows.filter((r) => r.is_fraud).length

  const sweep: MetricsAtThreshold[] = []
  for (let t = 5; t <= 95; t += 5) sweep.push(evaluate(rows, t))

  const patterns = new Map<string, { total: number; caught: number }>()
  for (const r of rows) {
    if (!r.is_fraud || !r.fraud_pattern) continue
    const p = patterns.get(r.fraud_pattern) ?? { total: 0, caught: 0 }
    p.total++
    if ((r.risk_score ?? 0) >= threshold) p.caught++
    patterns.set(r.fraud_pattern, p)
  }

  const body: MetricsResponse = {
    total: rows.length,
    fraudTotal,
    at: evaluate(rows, threshold),
    sweep,
    perPattern: [...patterns.entries()]
      .map(([pattern, p]) => ({
        pattern,
        total: p.total,
        caught: p.caught,
        recall: Number((p.caught / p.total).toFixed(4)),
      }))
      .sort((a, b) => a.pattern.localeCompare(b.pattern)),
    scored,
  }
  return NextResponse.json(body)
}
