// TypeSafe Jev: a decision model that answers typed questions (yes/no, choice, score) with probabilities, for a
// fraction of a cent. The pipeline uses it only for cheap triage behind AI_TRIAGE; it never writes code or reviews.
// Ported from fare-radar src/jev.ts (itself from safeverify). Contract: never throws. Every failure is
// { ok: false, reason } and the caller falls back to what it would do without Jev.
//
// Vendor facts (docs.typesafe.ai): POST /v1/systemone {state, model, questions}; questions run in parallel.
// noul criteria must be {true, false}; score criteria are ordered levels, lowest first, `score` a float index.
// $0.042 per million input tokens, output free, 64k tokens a request. Keys start `apik` (secret TYPESAFE_API_KEY).
import { uiFacing } from "./conventions.mjs";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
const TIMEOUT_MS = 8_000;
const MAX_STATE_CHARS = 120_000;   // well under 64k tokens

/** The seam: production binds the key and fetch; tests pass a fake fetch. */
export function typesafeJev(apiKey, fetcher = fetch) {
  const key = String(apiKey || "").trim();
  return async (state, questions) => {
    if (!key) return { ok: false, reason: "no-key" };
    let res;
    try {
      res = await fetcher(JEV_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ state, model: JEV_MODEL, questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, reason: err?.name === "TimeoutError" ? "timeout" : "http_error" };
    }
    if (res.status === 429) return { ok: false, reason: "rate_limited", status: 429 };
    if (!res.ok) return { ok: false, reason: "http_error", status: res.status };
    let body;
    try { body = await res.json(); } catch { return { ok: false, reason: "bad_shape" }; }
    return parseResponse(body) || { ok: false, reason: "bad_shape" };
  };
}

export function parseResponse(body) {
  if (!body || typeof body !== "object" || typeof body.model !== "string" || !body.answers) return null;
  const answers = {};
  for (const [id, a] of Object.entries(body.answers)) {
    if (a?.type === "noul" && typeof a.noul === "number") answers[id] = { type: "noul", noul: a.noul };
    else if (a?.type === "score" && typeof a.score === "number") answers[id] = { type: "score", score: a.score, confidence: a.confidence ?? 0 };
    else if (a?.type === "choice" && typeof a.choice === "string") answers[id] = { type: "choice", choice: a.choice, confidence: a.confidence ?? 0 };
  }
  return { ok: true, answers, model: body.model, inputTokens: body.usage?.input_tokens ?? 0 };
}

const clip = (s) => String(s || "").slice(-MAX_STATE_CHARS);

// ---- UI failure triage --------------------------------------------------------------------------------------
export const UI_FAILURE = {
  flake: "the environment or timing failed (login, redirect, timeout, network, org not ready); the same code would likely pass on a re-run",
  test: "the test itself is wrong (bad locator, wrong expectation, wrong navigation) while the feature may work",
  feature: "the feature does not do what the story says (missing field, wrong value, element not on the page)",
};
const MIN_CONFIDENCE = 0.6;

/** Classify a failed Playwright run. Returns { kind: "flake"|"test"|"feature"|"unknown", confidence, why }. */
export async function triageUiFailure(jev, { log, story = "" }) {
  const r = await jev({ playwright_output: clip(log), story: clip(story).slice(0, 4000) }, {
    kind: { type: "choice", instructions: "A Playwright UI test of a Salesforce feature failed. Which best explains the failure?", criteria: UI_FAILURE },
  });
  if (!r.ok) return { kind: "unknown", confidence: 0, why: `Jev unavailable (${r.reason})` };
  const a = r.answers.kind;
  if (!a || a.confidence < MIN_CONFIDENCE) return { kind: "unknown", confidence: a?.confidence ?? 0, why: "Jev was not confident" };
  return { kind: a.choice, confidence: a.confidence, why: UI_FAILURE[a.choice] || "" };
}

// ---- Review triage ------------------------------------------------------------------------------------------
// Deterministic first: these always get the full AI review, whatever Jev says.
const ALWAYS_REVIEW = [/\/classes\//, /\/triggers\//, /\/flows\//, /\/workflows\//, /\/approvalProcesses\//, /\/permissionsets\//, /\/profiles\//, /\/sharingRules\//, /\/permissionsetgroups\//,
  /\/lwc\//, /\/aura\//, /\/namedCredentials\//, /\/connectedApps\//, /\/remoteSiteSettings\//];
export const RISK_LEVELS = ["trivial: text, labels or descriptions only", "low: simple declarative metadata", "medium: behaviour changes users will notice", "high: logic, data or access changes"];
const MAX_SKIP_SCORE = 1.0;

/** Should the full AI review run? Returns { review: boolean, why }. Any doubt means review. */
export async function triageReview(jev, { files, diff }) {
  const forced = files.filter((f) => ALWAYS_REVIEW.some((re) => re.test(f)));
  if (forced.length) return { review: true, why: `always reviewed: ${forced.slice(0, 3).join(", ")}` };
  if (!files.some((f) => f.startsWith("force-app/") || f.startsWith("e2e/"))) return { review: false, why: "no Salesforce source or specs changed" };
  const r = await jev({ changed_files: files, diff: clip(diff), ui_facing: uiFacing(files) }, {
    risk: { type: "score", instructions: "How risky is this Salesforce metadata change to production users?", criteria: RISK_LEVELS },
  });
  if (!r.ok) return { review: true, why: `Jev unavailable (${r.reason})` };
  const a = r.answers.risk;
  if (!a || a.confidence < MIN_CONFIDENCE) return { review: true, why: "Jev was not confident" };
  return a.score <= MAX_SKIP_SCORE
    ? { review: false, why: `low risk per Jev (${a.score.toFixed(2)} of 0-3)` }
    : { review: true, why: `risk ${a.score.toFixed(2)} of 0-3 per Jev` };
}
