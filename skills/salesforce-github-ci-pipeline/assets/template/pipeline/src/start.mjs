// Start decisions (see GLOSSARY.md): does a job need a runner at all? Decided in main's code, in the short route job
// (or CI's static job), before the long job starts: GitHub bills every job at least a minute, a 75-minute job that
// starts only to find it has nothing to do costs a runner and a lane wait, and a rule in a release branch's YAML stays
// stale until a back-merge. decide() and ciPlan() are pure; `pipe start` and `pipe ci plan` gather the facts and act.
import { storyOf, sprintOf, uiFacing } from "./conventions.mjs";
import { STATUS, standing, carriedFrom, CARRY } from "./gate.mjs";
import { CHECKS } from "./conventions.mjs";
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
export function ciPlan({ ref, base, files, carried = null }) {
  const kind = branchKind(ref);
  const sf = files === null || files.some((f) => f.startsWith("force-app/"));
  const target = kind === "release" ? `sprint:${sprintOf(ref)}` : kind === "backmerge" ? `sprint:${sprintOf(base) || ""}` : ref;
  // carried: an earlier commit of this branch whose Salesforce tests passed, with nothing under force-app changed
  // since (gate.CARRY's no-sf rule): the org already holds this source, so no deploy and no Apex run (story #193
  // deployed five times, three of them for spec-only pushes). The check is skipped, which the gate counts as passed.
  const org = kind === "release" || kind === "backmerge" ? false : sf && !carried;
  return { kind, sf, org, ui: files === null || uiFacing(files).length > 0, target, all: kind !== "story" && kind !== "maintenance", carried: carried || "" };
}

/**
 * The commit CI's Salesforce tests carry from (ciPlan's `carried`), or null: the newest of the branch's last 15
 * commits on which "Salesforce tests" passed, with nothing under force-app changed from it to the checkout (gate.CARRY,
 * rule no-sf). Story and maintenance branches only (release PRs and back-merges test in staging). io: git, host.
 */
export function ciCarry({ ref, base, git, host }) {
  if (!["story", "maintenance"].includes(branchKind(ref))) return null;
  const shas = (git(["rev-list", "--no-merges", "--max-count=15", `origin/${base}..HEAD`], { allowFail: true }) || "").split("\n").filter(Boolean);
  // the newest run of the check on that commit must be the success (a later failure, or a re-run, is the truth)
  const latest = (runs) => [...runs].sort((a, b) => String(a.started_at).localeCompare(String(b.started_at))).pop();
  const passed = shas.filter((sha) => latest(host.api("GET", `repos/${host.repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CHECKS.apex)}`)?.check_runs || [])?.conclusion === "success");
  const changedSince = (sha) => { const d = git(["diff", "--name-only", sha, "HEAD"], { allowFail: true }); return d === null ? null : d.split("\n").filter(Boolean); };
  return carriedFrom(CARRY.apex, { head: git(["rev-parse", "HEAD"], { allowFail: true }), passed, changedSince });
}

/** The staging regression an earlier release-branch commit passed, if nothing it tests changed since (gate.CARRY
 *  staging, #237): the commit that carries it, or null. Same shape as ciCarry, on the release branch's own history. */
export function stagingCarry({ git, host }) {
  const shas = (git(["rev-list", "--max-count=15", "HEAD~1"], { allowFail: true }) || "").split("\n").filter(Boolean);
  const latest = (runs) => [...runs].sort((a, b) => String(a.started_at).localeCompare(String(b.started_at))).pop();
  const passed = shas.filter((sha) => latest(host.api("GET", `repos/${host.repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CHECKS.staging)}`)?.check_runs || [])?.conclusion === "success");
  const changedSince = (sha) => { const d = git(["diff", "--name-only", sha, "HEAD"], { allowFail: true }); return d === null ? null : d.split("\n").filter(Boolean); };
  return carriedFrom(CARRY.staging, { head: git(["rev-parse", "HEAD"], { allowFail: true }), passed, changedSince });
}

/**
 * May this job start? kind: review | fix | ui-test. facts: { ai, branch, labels: [name], rounds: { n, limit } | null,
 * changed: [file] | null (against the base; null if unknown), pushed: [file] | null (this push only, for a review on
 * a push), mode: ai | run, hasSpec, review / ui: the verdict that stands on the head (gate.standing), explicit: a
 * person asked (a label or ticked box), which runs again whatever stands }. Returns { run: true } or { run: false, why, off?, status?, stop? }:
 * off: the AI flag is off (say so on the PR); status: a verdict to post on the head instead; stop: the fix rounds
 * are used up (block the PR and say what a person can do). Pure.
 */
export function decide(kind, f) {
  const ai = f.ai || {};
  const labels = f.labels || [];
  const bk = branchKind(f.branch);
  if (kind === "review") {
    if (!ai.review) return { run: false, off: "AI_REVIEW", why: "AI review is off" };
    // a verdict that still stands on the head (a re-ready, a spec-only push) is not reviewed again unless a person asks
    if (!f.explicit && f.review && ["success", "failure"].includes(f.review.state)) return { run: false, why: `the AI review of this code still stands (${f.review.state === "success" ? "passed" : "asked for changes"} on ${String(f.review.sha || "").slice(0, 7)})` };
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
    // Claude does not rewrite a spec that passed (or is running) on this exact commit, unless a person asks
    if (f.mode === "ai" && !f.explicit && f.ui && ["success", "pending"].includes(f.ui.state)) return { run: false, why: `the UI test ${f.ui.state === "success" ? "already passed" : "is running"} on this exact commit` };
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
export async function startJob(kind, pr, { host, gh, cards, ai, mode = "run", before = null, after = null, explicit = false, log = () => {} }) {
  const p = gh(["pr", "view", String(pr), "--json", "headRefName,baseRefName,headRefOid,labels,state"]);
  if (p.state !== "OPEN") return { run: false, why: `the PR is ${String(p.state).toLowerCase()}` };
  const labels = (p.labels || []).map((l) => l.name);
  const files = (a, b) => { const c = host.api("GET", `repos/${host.repo}/compare/${a}...${b}`); return Array.isArray(c?.files) ? c.files.map((f) => f.filename) : null; };
  if (kind === "review" && before) gh(["pr", "edit", String(pr), "--remove-label", "blocked"], { allowFail: true });   // a person pushed: AI fixes may resume
  const key = storyOf(p.headRefName);
  const st = (kind === "review" || (kind === "ui-test" && mode === "ai")) && host.prFacts ? standing(host.prFacts(pr)) : null;   // what stands on the head
  const d = decide(kind, {
    ai, branch: p.headRefName, labels, mode, explicit, review: st?.review || null, ui: st?.ui || null,
    changed: kind === "review" ? files(p.baseRefName, p.headRefOid) : null,
    pushed: kind === "review" && before ? files(before, after || p.headRefOid) : null,
    rounds: kind === "fix" ? { n: fixRoundsUsed(pr, { host, gh }), limit: MAX_FIX_ROUNDS } : null,
    hasSpec: kind === "ui-test" && mode !== "ai" ? Boolean(key && host.api("GET", `repos/${host.repo}/contents/e2e/story-${key}.spec.ts?ref=${p.headRefOid}`)?.sha) : false,
  });
  const label = { review: "ai:review", fix: "ai:fix", "ui-test": mode === "ai" ? "ai:test" : "test" }[kind];
  if (d.run) {
    // Claude's UI test is running on this head: the gate and the journey see it (no second writer), until its verdict
    if (kind === "ui-test" && mode === "ai") host.status(p.headRefOid, STATUS.ui, "pending", "Claude is writing and running the UI test");
    host.dispatch(WORKFLOW[kind], kind === "ui-test" ? { pr, mode } : { pr });
    return d;
  }
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
 * (the story's org, then UAT if it waited for that slot; the in-sprint label). deps: { host, gh, cards, removeOrg,
 * orgFreed, regate, log }.
 */
export async function startFollowUps(after, { pr, base, sha, job = "", tree = "", story = "" }, { host, gh, cards, removeOrg, orgFreed = async () => {}, regate = () => [], log = () => {} }) {
  const steps = String(after || "").split(/\s+/).filter(Boolean);
  for (const step of steps) {
    if (step === "staging") host.dispatch("staging-deploy.yml", {}, base);
    if (step === "release") host.dispatch("release.yml", { sha, ...(job ? { validated_job: job } : {}), ...(tree ? { validated_tree: tree } : {}) });
    if (step === "backmerge") host.dispatch("back-merge.yml");
  }
  if (pr) await cards.refreshPr(pr);
  for (const step of steps) {
    if (step === "delete-story-org" && story) {
      try { if (removeOrg(`story:${story}`)) await orgFreed(); } catch (e) { log(`::warning::could not delete the story org (the janitor will): ${e.message}`); }
    }
    // the gate's own rules changed on main: a success it posted on an open PR under the old rules is re-decided (E12)
    if (step === "regate") { try { log(`re-deciding the gate on ${regate().map((n) => `#${n}`).join(", ") || "no open PR"}`); } catch (e) { log(`::warning::could not re-run the gate on open PRs: ${e.message}`); } }
    if (step === "staging" && /^\d+$/.test(String(story))) gh(["issue", "edit", String(story), "--add-label", "in-sprint"], { allowFail: true });   // merged, ships with the release
  }
  return steps;
}
