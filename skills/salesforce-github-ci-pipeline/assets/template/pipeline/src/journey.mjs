// The journey (see GLOSSARY.md: Journey): the order a change travels in, and what starts next when a stage finishes.
// Stages used to chain themselves from their own partial view (a review's pass started a UI test that had already
// passed on that commit; UAT waited for a staging run that had finished before the release PR existed). Now each
// stage's job ends with `pipe next --after <stage>`, and this module decides from the head's Standing. Pure:
// nextSteps() takes Standing and settings and returns what to start; `pipe next` gathers and acts.
import { STATUS, standing, phaseOf, requiredVerdicts } from "./gate.mjs";
import { CHECKS, uiNeeded, storyOf, sprintOf } from "./conventions.mjs";

/** The stages, in order. Story PRs: into the sprint's release branch; the release PR: into main, then production. */
export const STAGES = {
  story: ["start", "build", "ci", "review", "fix", "ui-test", "sign-off", "merge", "staging"],   // ci and review in parallel
  release: ["release-pr", "ci", "staging", "uat", "approval", "validation", "merge", "production", "close-out"],
};

// A result that still needs its stage: none on the head, or one an earlier commit had that no longer carries.
const owed = (v) => phaseOf(v) === "owed";
// CI's org job on the head: passed, or skipped because nothing needed an org (a carried result counts as passed)
const ciPassed = (st) => st.checks?.[CHECKS.apex]?.state === "passed";
// The head is the AI UI test's own spec commit: the run that pushed it is still going and reports on that commit. Its
// push started CI, and CI ending before that report started a second UI test, which pushed again (4 runs on #242).
const specPush = (st) => /^test\(e2e\): story [\w-]+$/.test(st.ctx?.pr?.commits?.at(-1)?.messageHeadline || "");

/**
 * What starts after `after` finished (review | ci | staging | release-pr | org-freed | any), given the head's Standing (st, from
 * gate.standing) and settings: { ai: { fix, uiTest, autoChain }, uat, uiNeeded }. Returns
 * [{ start: "fix" | "ui-test", mode? } | { dispatch: workflow, inputs }] with a why on each; [] when nothing is owed.
 */
export function nextSteps(after, st, { ai = {}, uat = false, uiNeeded = true, pr = null } = {}) {
  // any: whatever is owed now, whichever stage finished last (the reconcile sweep: a dropped event costs one tick)
  if (after === "any") {
    const seen = new Set();
    return ["review", "ci", "staging"].flatMap((a) => nextSteps(a, st, { ai, uat, uiNeeded, pr })).filter((s) => !seen.has(s.start || s.dispatch) && seen.add(s.start || s.dispatch));
  }
  const out = [];
  if (after === "review") {
    if (!ai.autoChain || !["feature", "hotfix"].includes(st.route)) return out;
    if (st.review.state === "failure" && ai.fix) out.push({ start: "fix", why: "the AI review asks for changes" });
    // the UI test only when its verdict on this exact commit is owed (one that passed or is running still stands), and
    // only once CI's org job has passed on it: both need the story org, and a UI test started while CI held the org
    // waited on a billed runner, then superseded CI with its spec push (#230). CI's own finish starts it otherwise.
    if (st.review.state === "success" && ai.uiTest && uiNeeded && owed(st.ui) && ciPassed(st) && !specPush(st)) out.push({ start: "ui-test", mode: "ai", why: "the review passed and the change is UI-facing" });
    return out;
  }
  if (after === "ci") {
    if (!ai.autoChain || !["feature", "hotfix"].includes(st.route)) return out;
    if (st.review.state === "success" && ai.uiTest && uiNeeded && owed(st.ui) && ciPassed(st) && !specPush(st)) out.push({ start: "ui-test", mode: "ai", why: "CI passed after the review did, and the change is UI-facing" });
    return out;
  }
  if (["staging", "release-pr", "org-freed"].includes(after)) {
    // UAT follows the staging regression on the release PR's head, whichever finished last (the release PR can open
    // after staging passed, story #193), and is retried when an org slot frees up
    if (st.route !== "release") return out;
    const staging = st.checks?.[CHECKS.staging];
    // the UI regression runs once per release (#273): when the release PR is open and its head has staging's Apex pass
    // but no UI pass, a staging run does it (a run going now does it itself: only a finished one counts as passed).
    // It runs beside UAT, which uses another org; a failed one is not owed, so it never loops.
    if (staging?.state === "passed" && owed(st.uiRegression) && st.ctx?.pr?.headRefName) out.push({ dispatch: "staging-deploy.yml", inputs: {}, ref: st.ctx.pr.headRefName, why: "the release PR is open and its head has no UI regression yet" });
    if (!uat) return out;
    if (staging?.state === "passed" && owed(st.uat)) out.push({ dispatch: "uat-deploy.yml", inputs: { pr: String(pr) }, why: "staging passed on this commit and UAT does not have it" });
    // the release PR opened before staging passed: build UAT's org now, alongside staging, so UAT after it is quick
    else if (after === "release-pr" && owed(st.uat)) out.push({ dispatch: "uat-deploy.yml", inputs: { pr: String(pr), warm: "true" }, why: "UAT's org is built while staging runs" });
    return out;
  }
  throw new Error(`journey: unknown stage "${after}" (review, ci, staging, release-pr, org-freed or any)`);
}

/**
 * Gather, decide, act: what starts after `after` on PR `pr` (without one, the open release PR: staging finished, or
 * an org slot freed up). Starts go through the start decision (startJob), dispatches straight to the workflow. A freed
 * slot goes to UAT first (the release waits on it), else to the story that has waited longest for one (waiting:org).
 * deps: { host, gh, cards, ai, uat, startJob, jev, log } (jev: AI_TRIAGE's fix gate, start.fixGate). Returns { steps, said }.
 */
export async function next(after, pr, deps) {
  const r = await prNext(after, pr, deps);
  return after === "org-freed" && !r.steps.length ? startWaiting(deps) || r : r;
}

async function prNext(after, pr, { host, gh, cards, ai, uat, startJob, jev = null, budgetOf, log = () => {} }) {
  if (!pr) {
    const rel = String(host.openRelease() || "").replace(/^origin\//, "");
    pr = rel ? host.releasePrOf(rel) : null;
  }
  if (!pr) return { steps: [], said: `nothing starts after ${after}: no pull request` };
  const facts = host.prFacts(pr);
  if (facts.pr.state !== "OPEN") return { steps: [], said: `nothing starts after ${after}: PR #${pr} is ${String(facts.pr.state).toLowerCase()}` };
  const files = facts.compare?.prFiles;
  const steps = nextSteps(after, standing(facts), { ai, uat, uiNeeded: uiNeeded(files), pr });
  for (const s of steps) {
    log(`next after ${after}: ${s.start || s.dispatch} (${s.why})`);
    if (s.start) await startJob(s.start, pr, { host, gh, cards, ai, jev, budgetOf, mode: s.mode || "run", log });
    else host.dispatch(s.dispatch, s.inputs, s.ref);
  }
  return { steps, said: steps.length ? `started: ${steps.map((x) => `${x.start || x.dispatch} (${x.why})`).join("; ")}` : `nothing owed after ${after} on PR #${pr}` };
}

/** The stories that have waited longest for a scratch-org slot (label waiting:org), started again, as many as the Dev
 *  Hub has slots free past ORG_RESERVE (freeSlots(); unknown or unreadable: one), so a sweep that frees several slots
 *  on a bigger Dev Hub starts several, not one per janitor tick. Each start checks its own slot again (issue-start), so
 *  a miscount only puts a story back in line. null if none waits. */
function startWaiting({ host, gh, freeSlots = () => 1, log = () => {} }) {
  let n = 1;
  try { n = Math.max(1, Math.min(10, Number(freeSlots()) || 1)); } catch { n = 1; }
  const ws = (gh(["issue", "list", "--state", "open", "--label", "waiting:org", "--json", "number,labels,createdAt", "--limit", "50"], { allowFail: true }) || [])
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(0, n);
  if (!ws.length) return null;
  for (const w of ws) {
    gh(["issue", "edit", String(w.number), "--remove-label", "waiting:org"], { allowFail: true });
    host.repoDispatch("jira-start", { key: String(w.number), labels: (w.labels || []).map((l) => l.name).filter((l) => l !== "waiting:org").join(",") });
    log(`next after org-freed: started story #${w.number} (it was waiting for a scratch-org slot)`);
  }
  const which = `${ws.length === 1 ? "story" : "stories"} ${ws.map((w) => `#${w.number}`).join(", ")}`;
  return { steps: ws.map((w) => ({ dispatch: "issue-start", why: `story #${w.number} waited for a slot` })), said: `started ${which}, which ${ws.length === 1 ? "was" : "were"} waiting for a scratch-org slot` };
}

/**
 * Who the change needs now, from Standing (never from how a card lays out its rows: the release mentioned its approvers
 * as its PR opened, half an hour before staging and UAT). A release in UAT: its testers. Then, once every result before
 * approval passed and nothing failed: the story's approver (or APPROVERS), or a release's approvers. null: nobody.
 * facts: facts.gather(); decision: gate.evaluate(); testers: UAT_TESTERS logins. Returns { who, what } | null. Pure.
 */
export function needs(st, facts, { decision = null, testers = [], prUrl = "", key = null } = {}) {
  const pr = facts.pr;
  if (pr.state !== "OPEN" || decision?.other?.length) return null;
  const passed = (v) => phaseOf(v) === "passed";
  const checks = Object.values(st.checks || {});
  if (checks.some((c) => c.state === "failed")) return null;
  if (st.route === "release") {
    const sprint = sprintOf(pr.headRefName) || pr.headRefName;
    if (facts.uat && phaseOf(st.uat) === "running") return { who: testers, what: `release ${sprint} is in UAT: test it, then tick **UAT passed** on ${prUrl}` };
    const before = [...checks.map((c) => c.state === "passed"), passed(st.uiRegression), ...(facts.uat ? [passed(st.uat)] : [])];
    return !st.approval.ok && before.every(Boolean) ? { who: facts.approvers || [], what: `release ${sprint} is ready for your approval: ${prUrl}/files` } : null;
  }
  key ||= storyOf(pr.headRefName);
  const verdicts = requiredVerdicts(facts, key).filter((v) => v.required).map((v) => (v.context === STATUS.review ? st.review : st.ui));
  const failed = [st.review, st.ui].some((v) => phaseOf(v) === "failed");
  if (st.approval.ok || failed || !checks.every((c) => c.state === "passed") || !verdicts.every(passed)) return null;
  return { who: facts.storyApprover ? [facts.storyApprover] : facts.approvers || [], what: `story #${key} is ready for your approval: ${prUrl}/files` };
}

/** The verdict contexts each stage owns (what the card and the gate read for it). */
export const OWNS = { review: STATUS.review, "ui-test": STATUS.ui, "sign-off": STATUS.signoff, uat: STATUS.uat };
