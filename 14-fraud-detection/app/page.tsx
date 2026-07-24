"use client"

import { useCallback, useEffect, useState } from "react"

type Txn = {
  id: number
  account_ref: string
  amount_cents: number
  merchant: string
  category: string
  country: string
  device: string
  occurred_at: string
  is_fraud: boolean
  fraud_pattern: string | null
  rule_score: number | null
  iso_score: number | string | null
  risk_score: number | null
}

type TxnDetail = Txn & {
  features: Record<string, number> | null
  rule_reasons: Array<{ rule: string; points: number; detail: string }> | null
  account_profile: {
    meanAmountCents: number
    stdAmountCents: number
    activeHours: [number, number]
    homeCountry: string
    usualDevice: string
    categories: string[]
  }
}

type MetricsAt = {
  threshold: number
  tp: number
  fp: number
  fn: number
  tn: number
  precision: number
  recall: number
  f1: number
}

type Metrics = {
  total: number
  fraudTotal: number
  at: MetricsAt
  sweep: MetricsAt[]
  perPattern: Array<{ pattern: string; total: number; caught: number; recall: number }>
  scored: boolean
}

type User = { id: number; name: string; email: string; role: string }

type WhatIfResult = {
  accountRef: string
  profile: TxnDetail["account_profile"]
  features: Record<string, number>
  ruleScore: number
  ruleReasons: Array<{ rule: string; points: number; detail: string }>
  isoScore: number
  riskScore: number
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function riskClass(score: number | null): string {
  if (score === null) return "low"
  if (score >= 60) return "high"
  if (score >= 35) return "med"
  return "low"
}

function RiskPill({ score }: { score: number | null }) {
  return <span className={`risk ${riskClass(score)}`}>{score ?? "—"}</span>
}

function TruthChip({ txn }: { txn: { is_fraud: boolean; fraud_pattern: string | null } }) {
  return txn.is_fraud ? (
    <span className="badge bad">fraud · {txn.fraud_pattern}</span>
  ) : (
    <span className="badge good">legit</span>
  )
}

export default function Home() {
  const [tab, setTab] = useState<"flagged" | "metrics" | "txns" | "whatif">("flagged")
  const [threshold, setThreshold] = useState(60)
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((d) => setUser(d.user))
      .catch(() => {})
  }, [])

  return (
    <main>
      <h1>🪤 Tripwire</h1>
      <p className="subtitle">
        Fraud &amp; anomaly detection for Kite Payments — z-score rules + from-scratch isolation forest over a
        seeded synthetic dataset, with explainable flags and honest precision/recall.
      </p>

      <div className="tabs">
        <button className={tab === "flagged" ? "active" : ""} onClick={() => setTab("flagged")}>
          🚨 Flagged
        </button>
        <button className={tab === "metrics" ? "active" : ""} onClick={() => setTab("metrics")}>
          📊 Metrics
        </button>
        <button className={tab === "txns" ? "active" : ""} onClick={() => setTab("txns")}>
          🔎 Transactions
        </button>
        <button className={tab === "whatif" ? "active" : ""} onClick={() => setTab("whatif")}>
          🧪 What-if desk
        </button>
      </div>

      {(tab === "flagged" || tab === "metrics") && (
        <div className="card">
          <div className="slider-row">
            <div>
              <label htmlFor="threshold">
                Risk threshold — transactions scoring at or above this are flagged. Slide it and watch
                precision/recall trade off.
              </label>
              <input
                id="threshold"
                type="range"
                min={5}
                max={95}
                step={5}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </div>
            <div className="val">{threshold}</div>
          </div>
        </div>
      )}

      {tab === "flagged" && <FlaggedTab threshold={threshold} />}
      {tab === "metrics" && <MetricsTab threshold={threshold} />}
      {tab === "txns" && <TxnsTab />}
      {tab === "whatif" && <WhatIfTab user={user} setUser={setUser} />}
    </main>
  )
}

/* ------------------------------------------------------------------ */
/* Flagged                                                             */
/* ------------------------------------------------------------------ */

function FlaggedTab({ threshold }: { threshold: number }) {
  const [txns, setTxns] = useState<Txn[]>([])
  const [detail, setDetail] = useState<TxnDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/transactions?minRisk=${threshold}&limit=200`)
      .then((r) => r.json())
      .then((d) => setTxns(d.transactions ?? []))
      .finally(() => setLoading(false))
  }, [threshold])

  const open = useCallback((id: number) => {
    fetch(`/api/transactions?id=${id}`)
      .then((r) => r.json())
      .then((d) => setDetail(d.transaction ?? null))
  }, [])

  const falsePositives = txns.filter((t) => !t.is_fraud).length

  if (detail) return <TxnDetailCard detail={detail} onBack={() => setDetail(null)} />

  return (
    <div className="card">
      <h2>
        Flagged at threshold {threshold}{" "}
        <span className="badge">{txns.length} flagged</span>
        <span className="badge warn">{falsePositives} false positives</span>
      </h2>
      <p className="muted">
        Ground-truth chips are shown on purpose — seeing the false positives is the point. Click a row for the
        full explanation.
      </p>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : txns.length === 0 ? (
        <p className="muted">
          Nothing flagged. If the whole dataset is unscored, run <code>npm run score</code>.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Risk</th>
              <th>Account</th>
              <th>Amount</th>
              <th>Merchant</th>
              <th>Where / how</th>
              <th>Truth</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <tr key={t.id} className="clickable" onClick={() => open(t.id)}>
                <td>
                  <RiskPill score={t.risk_score} />
                </td>
                <td className="mono">{t.account_ref}</td>
                <td>{money(t.amount_cents)}</td>
                <td>
                  {t.merchant} <span className="muted">· {t.category}</span>
                </td>
                <td className="muted">
                  {t.country} · {t.device} · {new Date(t.occurred_at).toLocaleString()}
                </td>
                <td>
                  <TruthChip txn={t} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function TxnDetailCard({ detail, onBack }: { detail: TxnDetail; onBack: () => void }) {
  const p = detail.account_profile
  const f = detail.features
  const iso = detail.iso_score === null ? null : Number(detail.iso_score)
  return (
    <div className="card">
      <button className="ghost" onClick={onBack}>
        ← Back to list
      </button>
      <h2>
        Transaction #{detail.id} <RiskPill score={detail.risk_score} /> <TruthChip txn={detail} />
      </h2>
      <p className="muted">
        {money(detail.amount_cents)} at {detail.merchant} ({detail.category}) · {detail.country} · {detail.device}
        {" · "}
        {new Date(detail.occurred_at).toLocaleString()} · account <span className="mono">{detail.account_ref}</span>
      </p>

      <div className="stat-grid">
        <div className="stat accent">
          <div className="v">{detail.risk_score ?? "—"}</div>
          <div className="k">blended risk (0-100)</div>
        </div>
        <div className="stat">
          <div className="v">{detail.rule_score ?? "—"}</div>
          <div className="k">rules score (0-100)</div>
        </div>
        <div className="stat">
          <div className="v">{iso === null ? "—" : iso.toFixed(3)}</div>
          <div className="k">isolation forest (0-1)</div>
        </div>
      </div>

      <h3>Why the rules fired</h3>
      {detail.rule_reasons && detail.rule_reasons.length > 0 ? (
        detail.rule_reasons.map((r, i) => (
          <div className="reason" key={i}>
            <span className="pts">+{r.points}</span>
            {r.detail} <span className="muted">({r.rule})</span>
          </div>
        ))
      ) : (
        <p className="muted">
          No rules fired — if this transaction still scored high, the isolation forest alone found it unusual
          (that is exactly the gap the forest exists to cover).
        </p>
      )}

      <h3>Transaction vs. account baseline</h3>
      {f ? (
        <table>
          <thead>
            <tr>
              <th>Signal</th>
              <th>This transaction</th>
              <th>Account baseline</th>
              <th>Feature value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Amount</td>
              <td>{money(detail.amount_cents)}</td>
              <td>
                {money(p.meanAmountCents)} ± {money(p.stdAmountCents)}
              </td>
              <td className="mono">amount_z = {f.amount_z.toFixed(2)}</td>
            </tr>
            <tr>
              <td>Hour</td>
              <td>{new Date(detail.occurred_at).getHours()}:00</td>
              <td>
                usual {p.activeHours[0]}:00-{p.activeHours[1]}:00
              </td>
              <td className="mono">hour_off = {f.hour_off}</td>
            </tr>
            <tr>
              <td>Country</td>
              <td>{detail.country}</td>
              <td>{p.homeCountry}</td>
              <td className="mono">new_country = {f.new_country}</td>
            </tr>
            <tr>
              <td>Device</td>
              <td>{detail.device}</td>
              <td>{p.usualDevice}</td>
              <td className="mono">new_device = {f.new_device}</td>
            </tr>
            <tr>
              <td>Category</td>
              <td>{detail.category}</td>
              <td>{p.categories.join(", ")}</td>
              <td className="mono">cat_novelty = {f.cat_novelty}</td>
            </tr>
            <tr>
              <td>Velocity</td>
              <td>{f.velocity_1h} txns in prior hour</td>
              <td className="muted">—</td>
              <td className="mono">velocity_1h = {f.velocity_1h}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p className="muted">
          Not scored yet — run <code>npm run score</code>.
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

function MetricsTab({ threshold }: { threshold: number }) {
  const [m, setM] = useState<Metrics | null>(null)

  useEffect(() => {
    fetch(`/api/metrics?threshold=${threshold}`)
      .then((r) => r.json())
      .then(setM)
      .catch(() => {})
  }, [threshold])

  if (!m) return <div className="card muted">Loading metrics…</div>
  if (!m.scored)
    return (
      <div className="card">
        <p className="muted">
          Dataset is not scored yet. Run <code>npm run score</code>, then refresh.
        </p>
      </div>
    )

  const a = m.at
  // PR curve as an inline SVG polyline: x = recall, y = precision.
  const W = 320
  const H = 220
  const PAD = 30
  const pts = m.sweep
    .filter((s) => s.tp + s.fp > 0)
    .map((s) => ({
      x: PAD + s.recall * (W - PAD - 10),
      y: H - PAD - s.precision * (H - PAD - 10),
      t: s.threshold,
    }))
  const cur = m.sweep.find((s) => s.threshold === a.threshold)

  return (
    <>
      <div className="card">
        <h2>Detector quality at threshold {a.threshold}</h2>
        <div className="stat-grid">
          <div className="stat accent">
            <div className="v">{(a.precision * 100).toFixed(1)}%</div>
            <div className="k">precision — of flags, how many were real fraud</div>
          </div>
          <div className="stat good">
            <div className="v">{(a.recall * 100).toFixed(1)}%</div>
            <div className="k">recall — of real fraud, how much we caught</div>
          </div>
          <div className="stat">
            <div className="v">{(a.f1 * 100).toFixed(1)}%</div>
            <div className="k">F1</div>
          </div>
          <div className="stat">
            <div className="v">
              {m.fraudTotal}/{m.total}
            </div>
            <div className="k">injected fraud / total txns</div>
          </div>
        </div>

        <h3>Confusion matrix</h3>
        <div className="matrix">
          <div className="hdr"></div>
          <div className="hdr">actually fraud</div>
          <div className="hdr">actually legit</div>
          <div className="hdr">flagged</div>
          <div className="cell tp">
            <div className="n">{a.tp}</div>
            <div className="muted">true positives</div>
          </div>
          <div className="cell fp">
            <div className="n">{a.fp}</div>
            <div className="muted">false positives</div>
          </div>
          <div className="hdr">not flagged</div>
          <div className="cell fn">
            <div className="n">{a.fn}</div>
            <div className="muted">missed fraud</div>
          </div>
          <div className="cell">
            <div className="n">{a.tn}</div>
            <div className="muted">true negatives</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Precision-recall curve</h2>
        <p className="muted">
          Each point is a threshold from 5 to 95. Lower thresholds slide right (catch more, flag more noise);
          higher thresholds slide up-left.
        </p>
        <svg className="prcurve" width={W} height={H} role="img" aria-label="Precision-recall curve">
          <line x1={PAD} y1={H - PAD} x2={W - 5} y2={H - PAD} stroke="#2a3040" />
          <line x1={PAD} y1={H - PAD} x2={PAD} y2={5} stroke="#2a3040" />
          <text x={W / 2} y={H - 8} fill="#99a1b3" fontSize="11" textAnchor="middle">
            recall →
          </text>
          <text x={12} y={H / 2} fill="#99a1b3" fontSize="11" textAnchor="middle" transform={`rotate(-90 12 ${H / 2})`}>
            precision →
          </text>
          {pts.length > 1 && (
            <polyline
              points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke="#f43f5e"
              strokeWidth="2"
            />
          )}
          {pts.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={p.t === a.threshold ? 5 : 2.5} fill="#f43f5e" />
          ))}
        </svg>
        {cur && (
          <p className="muted">
            Highlighted point = current threshold {a.threshold}: precision {(cur.precision * 100).toFixed(1)}%,
            recall {(cur.recall * 100).toFixed(1)}%.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Recall by fraud pattern</h2>
        <p className="muted">Where the detectors are blind — the most useful table in the project.</p>
        <table>
          <thead>
            <tr>
              <th>Pattern</th>
              <th>Injected</th>
              <th>Caught</th>
              <th>Recall</th>
            </tr>
          </thead>
          <tbody>
            {m.perPattern.map((p) => (
              <tr key={p.pattern}>
                <td className="mono">{p.pattern}</td>
                <td>{p.total}</td>
                <td>{p.caught}</td>
                <td>
                  <span className={`badge ${p.recall >= 0.8 ? "good" : p.recall >= 0.5 ? "warn" : "bad"}`}>
                    {(p.recall * 100).toFixed(0)}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

function TxnsTab() {
  const [account, setAccount] = useState("")
  const [fraud, setFraud] = useState("")
  const [txns, setTxns] = useState<Txn[]>([])
  const [detail, setDetail] = useState<TxnDetail | null>(null)

  const load = useCallback(() => {
    const params = new URLSearchParams({ limit: "100" })
    if (account.trim()) params.set("account", account.trim().toUpperCase())
    if (fraud) params.set("fraud", fraud)
    fetch(`/api/transactions?${params}`)
      .then((r) => r.json())
      .then((d) => setTxns(d.transactions ?? []))
  }, [account, fraud])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const open = (id: number) => {
    fetch(`/api/transactions?id=${id}`)
      .then((r) => r.json())
      .then((d) => setDetail(d.transaction ?? null))
  }

  if (detail) return <TxnDetailCard detail={detail} onBack={() => setDetail(null)} />

  return (
    <div className="card">
      <h2>Browse transactions</h2>
      <div className="form-grid">
        <div>
          <label>Account ref (e.g. ACC-0042)</label>
          <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="all accounts" />
        </div>
        <div>
          <label>Ground truth</label>
          <select value={fraud} onChange={(e) => setFraud(e.target.value)}>
            <option value="">all</option>
            <option value="1">fraud only</option>
            <option value="0">legit only</option>
          </select>
        </div>
        <div>
          <label>&nbsp;</label>
          <button className="primary" onClick={load}>
            Apply filters
          </button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Risk</th>
            <th>Account</th>
            <th>Amount</th>
            <th>Merchant</th>
            <th>Where / how</th>
            <th>Truth</th>
          </tr>
        </thead>
        <tbody>
          {txns.map((t) => (
            <tr key={t.id} className="clickable" onClick={() => open(t.id)}>
              <td>
                <RiskPill score={t.risk_score} />
              </td>
              <td className="mono">{t.account_ref}</td>
              <td>{money(t.amount_cents)}</td>
              <td>
                {t.merchant} <span className="muted">· {t.category}</span>
              </td>
              <td className="muted">
                {t.country} · {t.device} · {new Date(t.occurred_at).toLocaleString()}
              </td>
              <td>
                <TruthChip txn={t} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* What-if desk                                                        */
/* ------------------------------------------------------------------ */

function WhatIfTab({ user, setUser }: { user: User | null; setUser: (u: User | null) => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loginError, setLoginError] = useState("")

  const [form, setForm] = useState({
    accountRef: "ACC-0001",
    amountCents: "250000",
    hour: "3",
    country: "RO",
    device: "android-web",
    category: "electronics",
    velocity1h: "0",
  })
  const [result, setResult] = useState<WhatIfResult | null>(null)
  const [error, setError] = useState("")

  const login = async () => {
    setLoginError("")
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) {
      setLoginError(data.error ?? "Login failed")
      return
    }
    setUser(data.user)
  }

  const logout = async () => {
    await fetch("/api/auth", { method: "DELETE" })
    setUser(null)
  }

  const score = async () => {
    setError("")
    setResult(null)
    const res = await fetch("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountRef: form.accountRef,
        amountCents: Number(form.amountCents),
        hour: Number(form.hour),
        country: form.country,
        device: form.device,
        category: form.category,
        velocity1h: Number(form.velocity1h),
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      setError(data.error ?? "Scoring failed")
      return
    }
    setResult(data)
  }

  if (!user) {
    return (
      <div className="card login-wrap">
        <h2>Sign in</h2>
        <p className="muted">
          The what-if desk scores hypothetical transactions, so it sits behind auth. Seeded analysts:{" "}
          <code>analyst@tripwire.test</code> / <code>admin@tripwire.test</code> with your <code>SEED_PASSWORD</code>{" "}
          (default <code>ChangeMe123!</code>).
        </p>
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="analyst@tripwire.test" />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {loginError && <p className="err-text">{loginError}</p>}
        <p>
          <button className="primary" onClick={login}>
            Sign in
          </button>
        </p>
      </div>
    )
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value })

  return (
    <>
      <div className="card">
        <h2>
          What-if scoring desk{" "}
          <span className="badge">
            {user.name} · {user.role}
          </span>{" "}
          <button className="ghost" onClick={logout}>
            Sign out
          </button>
        </h2>
        <p className="muted">
          Describe a hypothetical transaction and score it against a real account&apos;s baseline with the stored
          isolation forest + rules. Try the default (a 3am foreign electronics splurge), then dial it back to
          something boring and watch the score collapse.
        </p>
        <div className="form-grid">
          <div>
            <label>Account ref</label>
            <input value={form.accountRef} onChange={set("accountRef")} />
          </div>
          <div>
            <label>Amount (cents)</label>
            <input value={form.amountCents} onChange={set("amountCents")} />
          </div>
          <div>
            <label>Hour of day (0-23)</label>
            <input value={form.hour} onChange={set("hour")} />
          </div>
          <div>
            <label>Country (2 letters)</label>
            <input value={form.country} onChange={set("country")} />
          </div>
          <div>
            <label>Device</label>
            <input value={form.device} onChange={set("device")} />
          </div>
          <div>
            <label>Category</label>
            <input value={form.category} onChange={set("category")} />
          </div>
          <div>
            <label>Txns in prior hour</label>
            <input value={form.velocity1h} onChange={set("velocity1h")} />
          </div>
          <div>
            <label>&nbsp;</label>
            <button className="primary" onClick={score}>
              Score it
            </button>
          </div>
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>

      {result && (
        <div className="card">
          <h2>
            Verdict <RiskPill score={result.riskScore} />
          </h2>
          <div className="stat-grid">
            <div className="stat accent">
              <div className="v">{result.riskScore}</div>
              <div className="k">blended risk</div>
            </div>
            <div className="stat">
              <div className="v">{result.ruleScore}</div>
              <div className="k">rules score</div>
            </div>
            <div className="stat">
              <div className="v">{result.isoScore.toFixed(3)}</div>
              <div className="k">isolation forest</div>
            </div>
          </div>
          <h3>Reasons</h3>
          {result.ruleReasons.length > 0 ? (
            result.ruleReasons.map((r, i) => (
              <div className="reason" key={i}>
                <span className="pts">+{r.points}</span>
                {r.detail} <span className="muted">({r.rule})</span>
              </div>
            ))
          ) : (
            <p className="muted">No rules fired — this looks like normal behavior for {result.accountRef}.</p>
          )}
          <p className="muted">
            Baseline for {result.accountRef}: typical {money(result.profile.meanAmountCents)} ±{" "}
            {money(result.profile.stdAmountCents)}, active {result.profile.activeHours[0]}:00-
            {result.profile.activeHours[1]}:00, home {result.profile.homeCountry}, device{" "}
            {result.profile.usualDevice}, categories {result.profile.categories.join(", ")}.
          </p>
        </div>
      )}
    </>
  )
}
