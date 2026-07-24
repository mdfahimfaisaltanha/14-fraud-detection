// Detector 2: Isolation Forest — INFERENCE side.
//
// Core idea (Liu, Ting & Zhou 2008): anomalies are few and different, so
// random axis-aligned splits isolate them in FEWER cuts than normal points.
// Score = 2^(-E[pathLength] / c(sampleSize)); ~0.5 is average, →1 is anomalous.
//
// TRAINING lives in scripts/score.mjs (builds the trees, stores the forest as
// JSON in model_store). This module only walks stored trees, so the what-if
// API can score a hypothetical transaction without retraining. The node shape
// here must match what score.mjs writes: internal {f, v, l, r}, leaf {n}.

export type IsoNode = {
  f?: number // feature index to split on (internal nodes)
  v?: number // split value
  l?: IsoNode
  r?: IsoNode
  n?: number // leaf: number of training points that landed here
}

export type IsoForest = {
  trees: IsoNode[]
  sample: number // subsample size used per tree (256)
}

// Average unsuccessful-search path length in a BST of n nodes — the paper's
// c(n) normalizer, also used to extend paths at size-n leaves.
export function avgPathLen(n: number): number {
  if (n <= 1) return 0
  return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n
}

export function pathLength(node: IsoNode, x: number[], depth = 0): number {
  if (node.l === undefined || node.r === undefined || node.f === undefined || node.v === undefined) {
    return depth + avgPathLen(node.n ?? 1)
  }
  return pathLength(x[node.f] < node.v ? node.l : node.r, x, depth + 1)
}

export function isoScore(forest: IsoForest, x: number[]): number {
  const mean = forest.trees.reduce((s, t) => s + pathLength(t, x), 0) / forest.trees.length
  return Math.pow(2, -mean / avgPathLen(forest.sample))
}

// Blend the two detectors into one 0-100 risk score.
// Rules are already 0-100. Iso scores concentrate in ~[0.35, 0.75] in
// practice, so rescale that band to [0,1] before blending 50/50.
// MIRROR WARNING: duplicated in scripts/score.mjs.
export function riskScore(rule0to100: number, iso0to1: number): number {
  const ruleN = rule0to100 / 100
  const isoN = Math.max(0, Math.min(1, (iso0to1 - 0.35) / 0.4))
  return Math.round(100 * (0.5 * ruleN + 0.5 * isoN))
}
