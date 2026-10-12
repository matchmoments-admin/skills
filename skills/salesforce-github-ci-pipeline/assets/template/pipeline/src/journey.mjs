// The journey (see GLOSSARY.md: Journey): the order a change travels in, and what starts next when a stage finishes.
// Stages used to chain themselves from their own partial view (a review's pass started a UI test that had already
// passed on that commit; UAT waited for a staging run that had finished before the release PR existed). Now each
// stage's job ends with `pipe next --after <stage>`, and this module decides from the head's Standing. Pure:
// nextSteps() takes Standing and settings and returns what to start; `pipe next` gathers and acts.
import { STATUS, standing } from "./gate.mjs";
import { CHECKS, uiFacing } from "./conventions.mjs";

/** The stages, in order. Story PRs: into the sprint's release branch; the release PR: into main, then production. */
export const STAGES = {
  story: ["start", "build", "ci", "review", "fix", "ui-test", "sign-off", "merge", "staging"],
  release: ["release-pr", "ci", "staging", "uat", "approval", "validation", "merge", "production", "close-out"],
};

// A result that still needs its stage: none on the head, or one an earlier commit had that no longer carries.
const owed = (v) => !v || ["missing", "stale"].includes(v.state);

/**
 * What starts after `after` finished (review | staging | release-pr | org-freed), given the head's Standing (st, from
 * gate.standing) and settings: { ai: { fix, uiTest, autoChain }, uat, uiNeeded }. Returns
 * [{ start: "fix" | "ui-test", mode? } | { dispatch: workflow, inputs }] with a why on each; [] when nothing is owed.
 */
export function nextSteps(after, st, { ai = {}, uat = false, uiNeeded = true, pr = null } = {}) {
  const out = [];
  if (after === "review") {
    if (!ai.autoChain || !["feature", "hotfix"].includes(st.route)) return out;
    if (st.review.state === "failure" && ai.fix) out.push({ start: "fix", why: "the AI review asks for changes" });
    // the UI test only when its verdict on this exact commit is owed (one that passed or is running still stands)
    if (st.review.state === "success" && ai.uiTest && uiNeeded && owed(st.ui)) out.push({ start: "ui-test", mode: "ai", why: "the review passed and the change is UI-facing" });
    return out;
  }
  if (["staging", "release-pr", "org-freed"].includes(after)) {
    // UAT follows the staging regression on the release PR's head, whichever finished last (the release PR can open
    // after staging passed, story #193), and is retried when an org slot frees up
    if (st.route !== "release" || !uat) return out;
    const staging = st.checks?.[CHECKS.staging];
    if (staging?.state === "passed" && owed(st.uat)) out.push({ dispatch: "uat-deploy.yml", inputs: { pr: String(pr) }, why: "staging passed on this commit and UAT does not have it" });
    return out;
  }
  throw new Error(`journey: unknown stage "${after}" (review, staging, release-pr or org-freed)`);
}

/**
 * Gather, decide, act: what starts after `after` on PR `pr` (without one, the open release PR: staging finished, or
 * an org slot freed up). Starts go through the start decision (startJob), dispatches straight to the workflow.
 * deps: { host, gh, cards, ai, uat, startJob, log }. Returns { steps, said }.
 */
export async function next(after, pr, { host, gh, cards, ai, uat, startJob, log = () => {} }) {
  if (!pr) {
    const rel = String(host.openRelease() || "").replace(/^origin\//, "");
    pr = rel ? (gh(["pr", "list", "--head", rel, "--base", "main", "--state", "open", "--json", "number"], { allowFail: true }) || [])[0]?.number : null;
  }
  if (!pr) return { steps: [], said: `nothing starts after ${after}: no pull request` };
  const facts = host.prFacts(pr);
  if (facts.pr.state !== "OPEN") return { steps: [], said: `nothing starts after ${after}: PR #${pr} is ${String(facts.pr.state).toLowerCase()}` };
  const files = facts.compare?.prFiles;
  const steps = nextSteps(after, standing(facts), { ai, uat, uiNeeded: !files || uiFacing(files).length > 0, pr });
  for (const s of steps) {
    log(`next after ${after}: ${s.start || s.dispatch} (${s.why})`);
    if (s.start) await startJob(s.start, pr, { host, gh, cards, ai, mode: s.mode || "run", log });
    else host.dispatch(s.dispatch, s.inputs);
  }
  return { steps, said: steps.length ? `started: ${steps.map((x) => `${x.start || x.dispatch} (${x.why})`).join("; ")}` : `nothing owed after ${after} on PR #${pr}` };
}

/** The verdict contexts each stage owns (what the card and the gate read for it). */
export const OWNS = { review: STATUS.review, "ui-test": STATUS.ui, "sign-off": STATUS.signoff, uat: STATUS.uat };
