// Start decisions (see GLOSSARY.md): does a job need a runner at all? Decided in main's code, in the short route job
// (or CI's static job), before the long job starts: GitHub bills every job at least a minute, a 75-minute job that
// starts only to find it has nothing to do costs a runner and a lane wait, and a rule in a release branch's YAML stays
// stale until a back-merge. decide() and ciPlan() are pure; `pipe start` and `pipe ci plan` gather the facts and act.
import { storyOf, sprintOf, uiFacing } from "./conventions.mjs";
import { STATUS } from "./gate.mjs";
import { fixRoundsUsed, MAX_FIX_ROUNDS } from "./verdict.mjs";

/** What kind of branch this is: story | release | backmerge | maintenance. One rule for every workflow. Pure. */
export function branchKind(ref) {
  const r = String(ref || "");
  if (sprintOf(r)) return "release";
  if (r.startsWith("backmerge-")) return "backmerge";
  return storyOf(r) ? "story" : "maintenance";
}

/**
 * CI's plan for a branch, from what changed against its base (files: null when the diff failed, which fails closed:
 * everything is assumed). Release PRs and back-merges test in the staging regression, not in a scratch org of their
 * own. Returns { kind, sf, org, ui, target, all }. Pure.
 */
export function ciPlan({ ref, base, files }) {
  const kind = branchKind(ref);
  const sf = files === null || files.some((f) => f.startsWith("force-app/"));
  const target = kind === "release" ? `sprint:${sprintOf(ref)}` : kind === "backmerge" ? `sprint:${sprintOf(base) || ""}` : ref;
  return { kind, sf, org: kind === "release" || kind === "backmerge" ? false : sf, ui: files === null || uiFacing(files).length > 0, target, all: kind !== "story" && kind !== "maintenance" };
}

/**
 * May this job start? kind: review | fix | ui-test. facts: { ai, branch, labels: [name], rounds: { n, limit } | null,
 * changed: [file] | null (against the base; null if unknown), pushed: [file] | null (this push only, for a review on
 * a push), mode: ai | run, hasSpec }. Returns { run: true } or { run: false, why, off?, status?, stop? }:
 * off: the AI flag is off (say so on the PR); status: a verdict to post on the head instead; stop: the fix rounds
 * are used up (block the PR and say what a person can do). Pure.
 */
export function decide(kind, f) {
  const ai = f.ai || {};
  const labels = f.labels || [];
  const bk = branchKind(f.branch);
  if (kind === "review") {
    if (!ai.review) return { run: false, off: "AI_REVIEW", why: "AI review is off" };
    if (bk === "release" || bk === "backmerge") return { run: false, why: "release PRs and back-merges were reviewed story by story" };
    if (Array.isArray(f.pushed) && f.pushed.length && f.pushed.every((p) => p.startsWith("e2e/"))) return { run: false, why: "a spec-only push needs no review (the gate accepts e2e-only changes)" };
    if (Array.isArray(f.changed) && f.changed.length < 300 && !f.changed.some((p) => p.startsWith("force-app/") || p.startsWith("e2e/"))) {
      return { run: false, why: "nothing reviewable", status: { context: STATUS.review, state: "success", description: "not needed: no Salesforce source or specs changed" } };
    }
    return { run: true };
  }
  if (kind === "fix") {
    if (!ai.fix) return { run: false, off: "AI_FIX", why: "AI fix is off" };
    if (bk !== "story") return { run: false, why: "only story PRs get AI fixes" };
    if (labels.includes("blocked")) return { run: false, why: "blocked: a person is on it" };
    if (f.rounds && f.rounds.n >= f.rounds.limit) return { run: false, stop: true, why: `${f.rounds.n} of ${f.rounds.limit} fix rounds used since a person last pushed` };
    return { run: true };
  }
  if (kind === "ui-test") {
    if (f.mode === "ai" && !ai.uiTest) return { run: false, off: "AI_UI_TEST", why: "AI UI test is off" };
    if (f.mode !== "ai" && !f.hasSpec) {
      const key = storyOf(f.branch);
      return { run: false, why: "no committed spec", status: { context: STATUS.ui, state: "failure", description: `no spec e2e/story-${key}.spec.ts committed` } };
    }
    return { run: true };
  }
  throw new Error(`start: unknown kind "${kind}" (review, fix or ui-test)`);
}

/** What a person reads when a flag is off (the PR comment). Pure. */
export const offMessage = (flag) => ({
  AI_REVIEW: "AI review is off (repository variable `AI_REVIEW`). A person's approval is the review; or turn it on in Settings > Secrets and variables > Actions > Variables.",
  AI_FIX: "AI fix is off (repository variable `AI_FIX`). Push the fix yourself, or turn it on in Settings > Secrets and variables > Actions > Variables.",
  AI_UI_TEST: "AI UI test is off (repository variable `AI_UI_TEST`). Commit `e2e/story-<key>.spec.ts` yourself and label the PR `test`, or turn it on in Settings > Secrets and variables > Actions > Variables.",
})[flag];

/** The one comment when Claude's fix rounds are used up. Pure. */
export const stopMessage = (limit) => `Claude has had ${limit} fix rounds on this change since the last push by a person, so it stops here. **What you can do:** push a fix yourself (the count starts again, and the review re-runs), or, if the AI review is wrong, comment \`/review-ok <why>\` to accept the change anyway.`;

const WORKFLOW = { review: "ai-review.yml", fix: "ai-fix.yml", "ui-test": "ui-test.yml" };

/**
 * Gather the facts for decide(), then act: dispatch the job on main, or post its verdict, say the flag is off, or stop
 * the fix rounds (block the PR, say what a person can do, once). The one door into review, fix and the UI test: the
 * route jobs (labels, ticked boxes, comments, auto-chain) and CI's autofix all come through here.
 * deps: { host, gh, cards, ai }. Returns the decision.
 */
export async function startJob(kind, pr, { host, gh, cards, ai, mode = "run", before = null, after = null, log = () => {} }) {
  const p = gh(["pr", "view", String(pr), "--json", "headRefName,baseRefName,headRefOid,labels,state"]);
  if (p.state !== "OPEN") return { run: false, why: `the PR is ${String(p.state).toLowerCase()}` };
  const labels = (p.labels || []).map((l) => l.name);
  const files = (a, b) => { const c = host.api("GET", `repos/${host.repo}/compare/${a}...${b}`); return Array.isArray(c?.files) ? c.files.map((f) => f.filename) : null; };
  if (kind === "review" && before) gh(["pr", "edit", String(pr), "--remove-label", "blocked"], { allowFail: true });   // a person pushed: AI fixes may resume
  const key = storyOf(p.headRefName);
  const d = decide(kind, {
    ai, branch: p.headRefName, labels, mode,
    changed: kind === "review" ? files(p.baseRefName, p.headRefOid) : null,
    pushed: kind === "review" && before ? files(before, after || p.headRefOid) : null,
    rounds: kind === "fix" ? { n: fixRoundsUsed(pr, { host, gh }), limit: MAX_FIX_ROUNDS } : null,
    hasSpec: kind === "ui-test" && mode !== "ai" ? Boolean(key && host.api("GET", `repos/${host.repo}/contents/e2e/story-${key}.spec.ts?ref=${p.headRefOid}`)?.sha) : false,
  });
  const label = { review: "ai:review", fix: "ai:fix", "ui-test": mode === "ai" ? "ai:test" : "test" }[kind];
  if (d.run) { host.dispatch(WORKFLOW[kind], kind === "ui-test" ? { pr, mode } : { pr }); return d; }
  log(`not started: ${d.why}`);
  if (d.off) gh(["pr", "comment", String(pr), "--body", offMessage(d.off)], { allowFail: true });
  if (d.status) {
    host.status(p.headRefOid, d.status.context, d.status.state, d.status.description);
    if (d.status.state === "failure") gh(["pr", "edit", String(pr), "--add-label", "ui:fail"], { allowFail: true });
  }
  if (d.stop && !labels.includes("blocked")) gh(["pr", "comment", String(pr), "--body", stopMessage(MAX_FIX_ROUNDS)], { allowFail: true });
  gh(["pr", "edit", String(pr), "--remove-label", label, ...(d.stop ? ["--add-label", "blocked"] : [])], { allowFail: true });
  if (d.stop && key) await cards.refresh(key, { activity: { state: "failed", what: "Claude's fix rounds are used up: a person needs to look", url: host.runUrl, retry: "push a fix yourself, or comment /review-ok <why> if the review is wrong" } });
  else if (d.status && cards) await cards.refreshPr(pr);
  return d;
}

/**
 * What starts after a merge, the same for the gate and an emergency merge (follow-ups from gate.followUps): the next
 * workflows first (staging on the release branch, so its check lands on the release PR; the release, with the
 * validated job and tree when the gate validated; a back-merge), then the card, then cleanup that cannot fail the merge
 * (the story's org; the in-sprint label). deps: { host, gh, cards, removeOrg, log }.
 */
export async function startFollowUps(after, { pr, base, sha, job = "", tree = "", story = "" }, { host, gh, cards, removeOrg, log = () => {} }) {
  const steps = String(after || "").split(/\s+/).filter(Boolean);
  for (const step of steps) {
    if (step === "staging") host.dispatch("staging-deploy.yml", {}, base);
    if (step === "release") host.dispatch("release.yml", { sha, ...(job ? { validated_job: job } : {}), ...(tree ? { validated_tree: tree } : {}) });
    if (step === "backmerge") host.dispatch("back-merge.yml");
  }
  if (pr) await cards.refreshPr(pr);
  for (const step of steps) {
    if (step === "delete-story-org" && story) { try { removeOrg(`story:${story}`); } catch (e) { log(`::warning::could not delete the story org (the janitor will): ${e.message}`); } }
    if (step === "staging" && /^\d+$/.test(String(story))) gh(["issue", "edit", String(story), "--add-label", "in-sprint"], { allowFail: true });   // merged, ships with the release
  }
  return steps;
}
