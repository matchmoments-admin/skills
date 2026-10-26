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
export async function triageUiFailure(jev, { log, story = "", ci = "" }) {
  // CI's results on the same commit (roles.ciResults): with its Apex and Flow tests green, the feature most likely works
  // and the test is the suspect (story #193: "feature" was guessed with every test passing, E10)
  const r = await jev({ playwright_output: clip(log), story: clip(story).slice(0, 4000), ...(ci ? { ci_results_on_this_commit: String(ci).slice(0, 2000) } : {}) }, {
    kind: { type: "choice", instructions: `A Playwright UI test of a Salesforce feature failed. Which best explains the failure?${ci ? " CI's Apex and Flow tests on the same commit are listed: if they passed, the feature's logic works, so prefer test or flake unless the output shows the feature itself missing." : ""}`, criteria: UI_FAILURE },
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
/** What a cheaper review model may judge: metadata with no code, access, automation or sharing. An allow-list, so a type
 *  nobody listed (Visualforce, a validation rule, a custom permission, a sharing set, an object's org-wide default,
 *  a spec) gets the full model. */
const DECLARATIVE = [/\/objects\/[^/]+\/fields\/[^/]+\.field-meta\.xml$/, /\/objects\/[^/]+\/listViews\//, /\/objects\/[^/]+\/compactLayouts\//,
  /\/objects\/[^/]+\/fieldSets\//, /\/layouts\//, /\/flexipages\//, /\/labels\//, /\/reports\//, /\/reportTypes\//, /\/dashboards\//, /\/tabs\//,
  /\/applications\//, /\/translations\//, /\/objectTranslations\//, /\.md$/];
/** A change made only of DECLARATIVE metadata: the review may use a cheaper model (config/ai-models.json review.declarative). */
export const isDeclarativeOnly = (files = []) => files.length > 0 && files.every((f) => DECLARATIVE.some((re) => re.test(f)));
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

// ---- Story readiness ----------------------------------------------------------------------------------------
export const SIZES = {
  small: "one or two components; a day or less",
  medium: "a few components; a few days",
  large: "many components, integrations or data changes; more than a week",
};

/** Are the acceptance criteria testable, and how big is the story? Returns { weak[], size } or null without an answer. */
export async function storyReadiness(jev, { criteria, title = "", body = "" }) {
  if (!criteria.length) return null;
  const questions = {};
  criteria.forEach((c, i) => {
    questions[`c${i + 1}`] = { type: "noul", instructions: `An acceptance criterion of a Salesforce story: "${c}". Could a tester check it pass or fail without asking anyone what it means?`,
      criteria: { true: "specific and testable", false: "vague, ambiguous or untestable" } };
  });
  questions.size = { type: "choice", instructions: "How big is this Salesforce story to build and test?", criteria: SIZES };
  const r = await jev({ story: clip(`${title}\n\n${body}`).slice(0, 8000) }, questions);
  if (!r.ok) return null;
  const weak = criteria.map((text, i) => ({ n: i + 1, text, p: r.answers[`c${i + 1}`]?.noul ?? 1 })).filter((w) => w.p < 0.5);
  const s = r.answers.size;
  return { weak, size: s && s.confidence >= MIN_CONFIDENCE ? s.choice : "unknown" };
}

// ---- Fix triage ---------------------------------------------------------------------------------------------
export const FINDINGS = {
  actionable: "at least one finding is a real defect or a missing or partly met acceptance criterion that a code change can fix",
  "minor-only": "every finding is minor (naming, comments, style, a nice-to-have) and none is a defect or a missed criterion",
  disputed: "the review asks for something the story, the repository's rules or Salesforce itself rule out, so no code change can satisfy it",
};
const MIN_FIX_SKIP_CONFIDENCE = 0.75;   // a skipped fix leaves the PR waiting on a person: be surer than for a skipped review

/**
 * Should Claude's chained fix run on this review? Returns { fix: boolean, kind, confidence, why }. Any doubt means fix:
 * Jev down, unsure, a failed CI (the fix mends that too) or an actionable finding. Story #261's review asked for a
 * test the platform cannot run, and two fix rounds were spent on it.
 */
export async function triageFix(jev, { review, ciFailed = false, story = "" }) {
  if (ciFailed) return { fix: true, kind: "ci", confidence: 1, why: "CI failed on the head: the fix mends that too" };
  if (!String(review || "").trim()) return { fix: true, kind: "unknown", confidence: 0, why: "no review text to judge" };
  const r = await jev({ ai_review: clip(review).slice(-20_000), story: clip(story).slice(0, 4000) }, {
    findings: { type: "choice", instructions: "An AI code review of a Salesforce change asked for changes. Which best describes its findings?", criteria: FINDINGS },
  });
  if (!r.ok) return { fix: true, kind: "unknown", confidence: 0, why: `Jev unavailable (${r.reason})` };
  const a = r.answers.findings;
  if (!a || !FINDINGS[a.choice] || a.confidence < MIN_FIX_SKIP_CONFIDENCE) return { fix: true, kind: "unknown", confidence: a?.confidence ?? 0, why: "Jev was not sure" };
  return { fix: a.choice === "actionable", kind: a.choice, confidence: a.confidence, why: FINDINGS[a.choice] };
}

/** The PR comment when a chained fix is skipped. Pure. */
export const fixSkippedMessage = (t) => `Claude's fix was not started: Jev judged the review's findings **${t.kind}** (${Math.round(t.confidence * 100)}% sure: ${t.why}). **What you can do:** if you agree, comment \`/review-ok <why>\` to accept the change; if not, tick "Fix the review findings" (or add the \`ai:fix\` label) and the fix runs.`;
