// The gate: may this PR merge, and how? (see GLOSSARY.md: Gate, Verdict, Sign-off)
// evaluate() is pure: it takes recorded GitHub facts and returns the decision. facts.mjs gather() fetches those facts;
// this module does no IO (a test enforces it).
//
// Trust model: a verdict counts only as a commit status (pipeline/ai-review, pipeline/ui-test) on the exact commit
// it judged (or an earlier one, if everything since only touched e2e/), posted by an agent-free job with the
// Actions token. Labels are for people to read; the gate does not trust them. Human approval is a review whose
// commit_id is the head (same e2e-only allowance). `ready` counts only if applied after the head was pushed.
//
// AI is optional (facts.ai, from the AI_* repo variables). Required verdicts: the AI review only when AI_REVIEW is on;
// the UI test when the change is UI-facing and either AI_UI_TEST is on or the PR commits its story spec. A failed
// verdict on the code always blocks, whatever the flags. With every flag off, CI plus a person's approval is the gate.
import { CHECKS, LIVE_TESTS_CHECK, storyOf, sprintOf, uiNeeded, storySpec, isPipelineAuthor, isHumanAuthor, setting, touchesPipeline } from "./conventions.mjs";

// signoff: a person's sign-off on a story PR into the sprint (a ticked box or /ship), recorded by an agent-free job.
// approval: the gate's record of the approval it accepted, posted when it decides to merge (close-out reads it, so a
// policy change after the merge never rewrites who approved).
// uiRegression: every UI spec passed on the staging org on this code (once per release by default: UI_REGRESSION)
export const STATUS = { review: "pipeline/ai-review", ui: "pipeline/ui-test", uat: "pipeline/uat", signoff: "pipeline/sign-off", approval: "pipeline/approval", uiRegression: "pipeline/ui-regression" };
/** The gate's own verdict on the PR's head. The branch rules require it, so GitHub's merge button stays locked until
 *  the gate is satisfied; admins (and any team the rules name) can still bypass in an emergency. */
export const GATE_STATUS = "pipeline/gate";

/** What pipeline/gate says for a decision: success when it may merge; failure when something failed (evaluate() says
 *  so in decision.blocking, where it adds the reason); else pending. */
export function gateStatus(decision) {
  // a route that validates against production keeps the merge button locked until production accepts it
  if (decision.mergeable && decision.validate) return { state: "pending", description: "Ready: validating against production before merging" };
  if (decision.mergeable) return { state: "success", description: "All requirements met: the gate merges it" };
  const r = decision.reasons || [];
  const failed = decision.blocking === "failure";
  const first = String(r[0] || "waiting").replace(/\s*\(Review changes > Approve\)/, "");
  const more = r.length > 1 ? ` (+${r.length - 1} more)` : "";
  return { state: failed ? "failure" : "pending", description: `${first}${more}`.slice(0, 139) };
}

/** What starts after a merge (staging, a release, a back-merge, deleting the story org): the gate uses it, and so does an emergency merge. */
export function followUps(pr, files = [], { forceApp = files.some((f) => f.startsWith("force-app/")) } = {}) {
  const r = route(pr);
  if (!r) return [];
  // A release branch runs its own copy of the workflows (staging is started on it, so its check lands on the release
  // PR): a workflow fix on main reaches the open sprint only by a back-merge (story #166's staging run).
  const workflows = files.some((f) => f.startsWith(".github/workflows/"));
  // the gate's rules live in pipeline/src: a change there re-decides open PRs the old rules passed (story #193, E12)
  const gateCode = files.some((f) => /^pipeline\/src\/(gate|conventions|start|journey)\.mjs$/.test(f));
  const when = { "release-if-force-app": forceApp ? "release" : null, "backmerge-if-workflows": workflows ? "backmerge" : null, "regate-if-gate-code": gateCode ? "regate" : null };
  return RULES[r].after.map((a) => (a in when ? when[a] : a)).filter(Boolean);
}
export const TRUSTED_STATUS_CREATORS = ["github-actions[bot]"];
/**
 * Did a run of main's (or a release branch's) workflows post this? Any workflow can post as github-actions[bot],
 * including one a story branch adds and later removes; so the verdicts that unlock a merge with nobody looking (the AI
 * review, a sign-off) count only from a run of a trusted file: not a pull_request or branch push run (those run the
 * branch's own workflow files), and a dispatch only on main or a release branch. run: the Actions run, or null when the
 * status links no run (unknown: not trusted). Pure.
 */
export const PROVEN = [STATUS.review, STATUS.signoff, STATUS.uiRegression];   // uiRegression: posted by staging-deploy on a release branch (#273)
export function trustedRun(run) {
  if (!run || !run.event) return false;
  const onTrusted = run.head_branch === "main" || /^release\//.test(String(run.head_branch || ""));
  if (["pull_request", "pull_request_review", "pull_request_review_comment"].includes(run.event)) return false;
  if (["push", "workflow_dispatch"].includes(run.event)) return onTrusted;
  // pull_request_target runs the base branch's file: trusted only when the base is main or a release branch (a PR
  // based on a story branch would run that branch's own workflow)
  if (run.event === "pull_request_target") return (run.pull_requests || []).some((p) => /^(main|release\/.+)$/.test(String(p.base?.ref || "")));
  return ["issue_comment", "issues", "schedule", "workflow_run", "repository_dispatch"].includes(run.event);
}

/**
 * Can a story branch still be built towards its base? (before /build; git is the io seam). Its base moving on since
 * /start is fine: the build merges it in. What is not: a branch aimed at main (a hotfix) that carries unreleased sprint
 * work, i.e. its fork point with the open release branch is not in main (the hotfix label was added after /start).
 */
export function branchRoute(git, { branch, base, release = null }) {
  if (base !== "main" || !release) return { ok: true };
  const fork = git(["merge-base", `origin/${branch}`, `origin/${release}`], { allowFail: true });
  if (!fork || git(["merge-base", "--is-ancestor", fork, "origin/main"], { allowFail: true }) !== null) return { ok: true };
  return { ok: false, why: `${branch} carries unreleased ${release} work but is aimed at main (was the hotfix label added after /start?). Start the story again from main.` };
}

/** Which gate route a PR takes, or null if no gate applies. */
export function route(pr) {
  const head = pr.headRefName || "", base = pr.baseRefName || "";
  if (base === "main" && sprintOf(head)) return "release";
  if (head.startsWith("backmerge-") && sprintOf(base)) return "backmerge";
  if (base === "main") return storyOf(head) ? "hotfix" : "maintenance";
  if (sprintOf(base)) return "feature";
  return null;
}

export const RULES = {
  feature:     { checks: [CHECKS.static, CHECKS.apex], verdicts: true,  approval: "sign-off", validate: false, merge: "squash", after: ["staging", "delete-story-org"] },
  hotfix:      { checks: [CHECKS.static, CHECKS.apex], verdicts: true,  approval: "review",   validate: true,  merge: "squash", after: ["release", "delete-story-org"], pure: true },
  release:     { checks: [CHECKS.static, CHECKS.apex, CHECKS.staging], verdicts: false, approval: "review", validate: true, merge: "merge", after: ["release"] },
  // A back-merge carries code that is already approved and in production: green CI is enough, if it really is one.
  backmerge:   { checks: [CHECKS.static, CHECKS.apex], verdicts: false, approval: "none", validate: false, merge: "merge", after: ["staging"], trusted: true },
  // Pipeline maintenance into main (no story): CI and an approval; production work only if Salesforce source changed.
  maintenance: { checks: [CHECKS.static, CHECKS.apex], verdicts: false, approval: "review", validate: "if-force-app", merge: "squash", after: ["release-if-force-app", "backmerge-if-workflows", "regate-if-gate-code"] },
};

/** Latest conclusion of a named check run, by start time ("missing" if it never ran). */
export function latestCheck(checkRuns, name) {
  const runs = checkRuns.filter((c) => c.name === name).sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  return runs.length ? runs[runs.length - 1].conclusion || runs[runs.length - 1].status || "pending" : "missing";
}
/**
 * One reading of a check's conclusion for the gate, the cards and the board: "passed" | "failed" | "running" | "missing".
 * A job skipped by its own `if:` (nothing to deploy) passes, as in GitHub's rules. Pure.
 */
// cancelled and stale are not failures: a newer CI run on the same head cancels the older one (cancel-in-progress),
// and a red gate in that window would be wrong; they wait for a run that finishes
export function checkState(conclusion) {
  if (conclusion === "success" || conclusion === "skipped") return "passed";
  if (["failure", "error", "timed_out", "action_required", "neutral", "startup_failure"].includes(conclusion)) return "failed";
  return ["missing", "cancelled", "stale"].includes(conclusion) ? "missing" : "running";
}
export const checkPassed = (conclusion) => checkState(conclusion) === "passed";

/**
 * Each result and what it depends on (see GLOSSARY.md: Standing). A result on an earlier commit still counts on the
 * head when no file changed since is one of its inputs; "exact" results count only on the commit they judged.
 *   inputs   (file) => does this file change what the result proved? or "exact"
 *   running  the inputs a result still being produced (pending) carries over, when not its own: the AI UI test's own
 *            spec push keeps it running (the card said "run it again" while it ran, 14 Oct); UAT pending on an
 *            older commit is UAT owed on the head (release 2027-w01: the journey read it as running, /uat-pass refused)
 *   proof    a check-run result: the check that exists only where its tests really ran (start.carriedFrom reads it)
 * A file list that is unknown (null: a diverged history, a failed diff) never carries.
 */
const spec = (f) => f.startsWith("e2e/");
/** What the staging regression tests: Salesforce source, specs, seed and org config, and the code that builds and runs
 *  staging. A release-branch commit that changes none of these (a back-merge of other pipeline work) keeps the
 *  regression an earlier commit passed (#237). */
export const STAGING_INPUTS = /^(force-app\/|e2e\/|data\/|config\/|baseline\/|sfdx-project\.json$|package(-lock)?\.json$|playwright\.config\.ts$|\.github\/actions\/|\.github\/workflows\/staging-deploy\.yml$|pipeline\/src\/(org|tests|evidence|baseline|io|settings|conventions|harness)\.mjs$|pipeline\/src\/org\/)/;   // settings: the seed and baseline defaults; harness: main's copy over the specs
const UI_ONLY = /^(e2e\/|playwright\.config\.ts$)/;
export const RESULTS = {
  // a review or a sign-off: the code, not its specs (a spec-only push keeps them)
  [STATUS.review]: { inputs: (f) => !spec(f) },
  [STATUS.signoff]: { inputs: (f) => !spec(f) },
  // the UI test: the spec IS that test, so a changed spec has not passed yet (story #166: a weakened spec rode on an
  // earlier pass); while it runs, its own spec commit keeps it running
  [STATUS.ui]: { inputs: "exact", running: (f) => !spec(f) },
  // UAT (a person signed off that code) and the gate's approval record (for the exact commit merged)
  [STATUS.uat]: { inputs: "exact" },
  [STATUS.approval]: { inputs: "exact" },
  [GATE_STATUS]: { inputs: "exact" },
  // CI's Salesforce tests: nothing under force-app changed, and no pipeline file (a commit whose workflows were the
  // branch's own could have faked that pass)
  apex: { inputs: (f) => f.startsWith("force-app/") || touchesPipeline([f]).length > 0, proof: CHECKS.apex },
  // staging's Apex and Flow run: specs are the UI regression's input, not theirs (release 2027-w01 re-ran 149 Apex
  // tests for a one-line spec fix); proven only where the tests really ran (a superseded or UI-only run has no check)
  staging: { inputs: (f) => STAGING_INPUTS.test(f) && !UI_ONLY.test(f), proof: LIVE_TESTS_CHECK },
  [STATUS.uiRegression]: { inputs: (f) => STAGING_INPUTS.test(f) },
};
/** Does `result` on commit `sha` still count on `head`, given the files changed between them? running: it is still
 *  being produced (pending). Pure. */
export function carries(result, sha, head, files, { running = false } = {}) {
  const row = RESULTS[result];
  if (!row) throw new Error(`carries: unknown result "${result}"`);
  if (sha === head) return true;
  const inputs = (running && row.running) || row.inputs;
  if (inputs === "exact" || !Array.isArray(files)) return false;
  return !files.some(inputs);
}
/** True if every file changed between a commit and the head is under e2e/ (an approval's rule: the review's). */
const onlySpecsSince = (sha, head, diffsToHead) => carries(STATUS.review, sha, head, diffsToHead[sha]);

/**
 * The newest earlier commit whose result still carries to the head (CI's or staging's Salesforce tests), or null.
 * passed: commits (newest first) on which the result's proof succeeded; changedSince(sha): files from it to the head,
 * or null. Pure apart from changedSince.
 */
export function carriedFrom(result, { head, passed = [], changedSince }) {
  for (const sha of passed) if (carries(result, sha, head, changedSince(sha))) return sha;
  return null;
}
/** A result's phase for the journey and the cards: owed (none, or one that no longer counts), running, passed, failed. */
/**
 * The AI review verdict's text, written only here (REVIEW) and read only by reviewKindOf, so no module matches status
 * descriptions itself: passed, changes (asks for changes), not-needed (a success no AI looked at: nothing reviewable,
 * or Jev judged it low risk), overruled (a person accepted the change over it, with a reason), budget (the story's AI
 * budget is spent), running, none (no verdict came). Pure.
 */
export const REVIEW = {
  passed: () => "AI review passed",
  changes: () => "AI review asks for changes",
  notNeeded: (why) => `not needed: ${why}`,
  overruled: (who, why) => `AI review overruled by @${who}${why ? `: ${why}` : ""}`.slice(0, 139),
  budget: () => "the story's AI budget is spent: an approver's /budget-ok, then Run the AI review again",
  running: () => "Claude is reviewing this code",
  none: () => "the review posted no verdict: tick Run the AI review again",
};
export function reviewKindOf(state, description) {
  const d = String(description || "");
  if (state === "pending") return "running";
  if (/^not needed\b/i.test(d)) return "not-needed";
  if (/^AI review overruled by @/.test(d)) return "overruled";
  if (state === "success") return "passed";
  if (/AI budget is spent/.test(d)) return "budget";
  return state === "failure" ? "changes" : "none";
}

export const phaseOf = (v) => (!v || ["missing", "stale"].includes(v.state) ? "owed" : v.state === "pending" ? "running" : v.state === "success" ? "passed" : "failed");
/** The verdict a status context gives the head: { state: "success" | "failure" | "stale" | "missing" | ... }. */
export function verdictFor(context, { statuses = [], head, diffsToHead = {}, pr = null }) {
  const mine = statuses.filter((s) => s.context === context && TRUSTED_STATUS_CREATORS.includes(s.creator?.login) && s.trusted !== false)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (!mine.length) return { state: "missing", phase: "owed" };
  // the newest commit's result first, then the newest by time on it: a run on an older commit that finished late (a
  // review of a superseded push) must not hide the one running on a newer commit (scenario fuzz, 15 Oct)
  const order = [...(pr?.commits || []).map((c) => c.oid), head];
  const rank = (sha) => order.lastIndexOf(sha);
  const top = Math.max(...mine.map((s) => rank(s.sha)));
  const last = top >= 0 ? mine.filter((s) => rank(s.sha) === top).at(-1) : mine[mine.length - 1];
  if (!carries(context, last.sha, head, diffsToHead[last.sha], { running: last.state === "pending" })) return { state: "stale", phase: "owed", sha: last.sha };
  // who acted, once: the sign-off's or UAT's signer, the person who overruled a review ("... by @login")
  const who = String(last.description || "").match(/@([A-Za-z0-9-]+)/)?.[1] || null;
  const v = { state: last.state, phase: phaseOf(last), description: last.description || "", url: last.url || null, sha: last.sha, at: last.created_at || null, who };
  return context === STATUS.review ? { ...v, kind: reviewKindOf(last.state, last.description) } : v;
}

/** The approving reviews that cover the code as it is now: latest decisive review per human, on the head (or e2e-only since). */
function approvingReviews({ reviews = [], head, diffsToHead = {} }) {
  const latest = new Map();
  for (const r of [...reviews].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))) {
    if (r.user?.type !== "User") continue;
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) latest.set(r.user.login, r);
  }
  return [...latest.values()].filter((r) => r.state === "APPROVED" && onlySpecsSince(r.commit_id, head, diffsToHead));
}
/** Who approved the code as it is now (logins)? */
export const reviewApprovers = (ctx) => approvingReviews(ctx).map((r) => r.user.login);
/** Has a person approved the code as it is now (any person; approval() applies the team's rule)? */
export const humanApproval = (ctx) => reviewApprovers(ctx).length > 0;

// the approval policy (who may approve whose change, solo mode) lives in approval.mjs; re-exported for callers and tests
export { approverOf, approverList, lastPusherOf, approvalProblem, authorityProblem } from "./approval.mjs";
import { approverOf, approverList, lastPusherOf, approvalProblem, authorityProblem, isSolo, soloBasis } from "./approval.mjs";

/** The approval policy's facts from a PR's statuses: the kind of AI review that stands on the head (REVIEW). "not
 *  needed" is a success no AI looked at: it is not a second pair of eyes for solo mode. */
const policyCtx = (ctx) => {
  const r = verdictFor(STATUS.review, ctx);
  return { ...ctx, aiReviewOn: Boolean(ctx.ai?.review), aiReview: ["missing", "stale"].includes(r.state) ? null : r.kind };
};
/** approvalProblem() on a PR's facts. */
export const approvalProblemFor = (ctx, login) => approvalProblem(policyCtx(ctx), login);
/** authorityProblem() on a PR's facts (approve, overrule, budget). */
export const authorityProblemFor = (ctx, action, login) => authorityProblem(action, policyCtx(ctx), login);

/**
 * Does a person's approval cover the code as it is now (Sign-off)? Reviews on the head; with signOff, also a ticked
 * Sign off or /ship (the trusted pipeline/sign-off status) and `ready` or /ship after the push. Each is checked
 * against approvalProblem(). Returns { ok, by: [login], who: [{ login, at, how }], refused: [{ login, why }] }. Pure.
 */
export function approval(ctx, { signOff = false } = {}) {
  const seen = approvingReviews(ctx).map((r) => ({ login: r.user.login, at: r.submitted_at, how: "approved the pull request" }));
  if (signOff) {
    const s = verdictFor(STATUS.signoff, ctx);
    if (s.state === "success") seen.push({ login: s.who || "", at: s.at, how: "ticked Sign off" });
    seen.push(...readyEvents(ctx).map(([at, login, how]) => ({ login, at, how })));
  }
  const who = [], refused = [];
  for (const a of seen) {
    if (who.some((w) => w.login === a.login) || refused.some((r) => r.login === a.login)) continue;
    const why = approvalProblemFor(ctx, a.login);
    if (why) refused.push({ login: a.login, why }); else who.push(isSolo(ctx, a.login) ? { ...a, how: `${a.how} (solo: ${soloBasis(policyCtx(ctx).aiReview)})`, solo: true } : a);
  }
  return { ok: who.length > 0, by: who.map((w) => w.login), who, refused };
}

/** `ready` counts if a person applied it after the head commit was pushed (first check on the head, server time). */
export const SIGN_OFF_COMMENT = /^\/ship\b/;
const CAN_SIGN_OFF = ["OWNER", "MEMBER", "COLLABORATOR"];
/** [at, login, how] for each `ready` label or /ship after the head was pushed. */
function readyEvents({ labelEvents = [], checkRuns = [], comments = [] }) {
  const pushedAt = checkRuns.map((c) => c.started_at).filter(Boolean).sort()[0];
  if (!pushedAt) return [];
  const label = labelEvents.filter((e) => e.event === "labeled" && e.label?.name === "ready" && e.actor?.type !== "Bot").map((e) => [e.created_at, e.actor?.login || "someone", "labelled it ready"]);
  // `/ship` in a comment by a person with write access counts the same as the `ready` label.
  const ship = comments.filter((c) => SIGN_OFF_COMMENT.test(String(c.body || "").trim()) && c.user?.type !== "Bot" && CAN_SIGN_OFF.includes(c.author_association)).map((c) => [c.created_at, c.user?.login || "someone", "commented /ship"]);
  return [...label, ...ship].filter(([at]) => at >= pushedAt);
}
export const readyBy = (facts) => [...new Set(readyEvents(facts).map(([, login]) => login))];
export const readyAfterPush = (facts) => readyBy(facts).length > 0;

/** Which verdicts this PR needs, given the AI flags and what it changes (prFiles: files changed against its base). */
export function requiredVerdicts({ ai = {}, compare = {} }, story) {
  const files = compare.prFiles;                       // undefined if the comparison failed: assume UI-facing
  const ui = uiNeeded(files);
  const spec = Boolean(story) && Array.isArray(files) && files.includes(storySpec(story));
  return [
    { context: STATUS.review, what: "AI review", required: Boolean(ai.review), how: "it starts when the PR opens and after each push; or tick Run the AI review again" },
    { context: STATUS.ui, what: "UI test", required: ui && (Boolean(ai.uiTest) || spec), how: ai.uiTest ? "tick Have Claude write and run the UI test" : "tick Run the committed UI test" },
  ];
}

/**
 * What still stands on the PR's head (see GLOSSARY.md: Standing): each verdict, the approval under the route's rule,
 * and each required check. The one place that decides whether an earlier result still counts (trusted creator,
 * spec-only carry, exact head for the UI test and UAT, nobody approves their own push). The gate, the cards, the
 * board and the delivery record all read it. Pure: facts from facts.gather().
 */
export function standing(facts) {
  const { pr, checkRuns = [] } = facts;
  const r = route(pr);
  const rules = r ? RULES[r] : null;
  const ctx = { ...facts, head: pr.headRefOid };
  const kind = rules?.approval || "review";
  return {
    route: r, rules, ctx,
    review: verdictFor(STATUS.review, ctx), ui: verdictFor(STATUS.ui, ctx), signoff: verdictFor(STATUS.signoff, ctx), uat: verdictFor(STATUS.uat, ctx), uiRegression: verdictFor(STATUS.uiRegression, ctx),
    record: verdictFor(STATUS.approval, ctx), gate: verdictFor(GATE_STATUS, ctx),
    approval: kind === "none" ? { ok: true, by: [], who: [], refused: [], none: true } : approval(ctx, { signOff: kind === "sign-off" }),
    checks: Object.fromEntries((rules?.checks || [CHECKS.static, CHECKS.apex]).map((n) => { const c = latestCheck(checkRuns, n); return [n, { conclusion: c, state: checkState(c) }]; })),
  };
}

/**
 * The gate's record of the approval it accepted (the trusted pipeline/approval status on the head, posted when it
 * decides to merge), and its reading. The delivery record reads this, not the approval rule as it is at close-out:
 * an APPROVERS change after the merge must not rewrite who approved (story #193's "Approved by: n/a"). Pure.
 */
export function approvalRecord(a) {
  if (a?.none) return "no approval needed (route)";
  const w = a?.who?.[0];
  return w ? `@${w.login} (${w.how}, ${String(w.at || "").slice(0, 16)}Z)`.slice(0, 139) : "no approval";
}
export function readApprovalRecord(description) {
  const m = String(description || "").match(/^@([A-Za-z0-9-]+) \((.+), ([0-9T:-]+)Z\)$/);
  return m ? { by: m[1], how: m[2], at: `${m[3]}:00Z` } : null;
}

/** Decide from GitHub facts (see facts.gather()). Returns { route, rules, reasons[], blocking, mergeable, story, validate, after[] }. */
export function evaluate(facts) {
  const { pr, compare = {} } = facts;
  const r = route(pr);
  if (!r) return { route: null, reasons: ["not a gated pull request"], mergeable: false };
  const st = standing(facts);
  const rules = st.rules;
  const reasons = [];
  // reasons no row of the story card stands for (a draft, conflicts, blockers...): the card's Next names the first one,
  // so it never says "everything else is green" while the gate blocks (14 Oct review)
  const other = [];
  const blockedBy = (why, failed = false) => { other.push(why); if (failed) fail(why); else reasons.push(why); };
  let blocking = "pending";
  const fail = (why) => { blocking = "failure"; reasons.push(why); };
  if (pr.state && pr.state !== "OPEN") reasons.push(`the PR is ${String(pr.state).toLowerCase()}`);
  if (pr.isDraft) blockedBy("the PR is a draft: mark it ready for review");
  if (pr.mergeable === "CONFLICTING") blockedBy("it has merge conflicts with its base; update the branch", true);

  for (const [name, c] of Object.entries(st.checks)) {
    if (c.state === "failed") fail(`check "${name}" is ${c.conclusion}`);
    else if (c.state !== "passed") reasons.push(`check "${name}" is ${c.conclusion}`);
  }
  if (rules.verdicts) {
    for (const v of requiredVerdicts(facts, storyOf(pr.headRefName))) {
      const got = v.context === STATUS.review ? st.review : st.ui;
      if (v.required) {
        if (got.state === "missing") reasons.push(`${v.what} has not run on this code (${v.how})`);
        else if (got.state === "stale") reasons.push(`${v.what} judged an older commit; run it again (${v.how})`);
        else if (got.state === "pending") reasons.push(`${v.what} is running`);
        else if (got.state !== "success") fail(`${v.what} did not pass (${got.state})`);
      } else if (["failure", "error"].includes(got.state)) fail(`${v.what} did not pass (${got.state})`);
    }
  }
  // The UI regression (every UI spec on the staging org): once per release, on this code or one it carries to (#273).
  if (r === "release") {
    const u = st.uiRegression;
    if (u.state === "missing") reasons.push("the UI regression has not run on this release yet (it starts when the release PR opens)");
    else if (u.state === "stale") reasons.push("the UI regression passed on an older commit; it runs again on this one");
    else if (u.state === "pending") reasons.push("the UI regression is running");
    else if (u.state !== "success") fail(`the UI regression failed (${u.description || u.state}): see the staging regression run`);
  }
  // UAT (UAT_ENABLED): a release ships only after a person signed off the release in UAT (/uat-pass), on this code.
  if (r === "release" && facts.uat) {
    const u = st.uat;
    if (u.state === "missing") reasons.push("not in UAT yet (it deploys there after the release PR opens)");
    else if (u.state === "stale") reasons.push("UAT signed off an older version; it redeploys, then sign off again (/uat-pass)");
    else if (u.state === "pending") reasons.push("waiting for UAT sign-off: test in UAT, then tick UAT passed on the release card (or comment /uat-pass)");
    else if (u.state !== "success") fail(`UAT failed (${u.description || u.state}); fix it, or tick UAT passed after a retest`);
  }
  // a story PR that changes pipeline code (it runs with production credentials) never merges through the gate: CI's
  // guard says so too, but a branch's own workflows can fake CI's result; the gate reads the diff itself
  const pipelineFiles = rules.verdicts && Array.isArray(compare.prFiles) ? touchesPipeline(compare.prFiles) : [];
  if (pipelineFiles.length) blockedBy(`a story PR cannot change pipeline code (${pipelineFiles.slice(0, 3).join(", ")}): open a maintenance PR`, true);
  if (rules.trusted) {
    if (!isPipelineAuthor(pr.author?.login)) blockedBy("a back-merge must be opened by the pipeline");
    if (compare.headInMain !== true) blockedBy("a back-merge must contain only commits already in main");

  }
  if (rules.pure && compare.unreleasedSprintCommits > 0) {
    blockedBy(`it carries ${compare.unreleasedSprintCommits} unreleased sprint commit(s); a hotfix must branch from main`);
  }
  // production was rolled back: nothing ships to main until the bad change is reverted or fixed (the open issue says how)
  if (["release", "hotfix", "maintenance"].includes(r) && validate_(rules, compare) && facts.rolledBack) {
    blockedBy(`production was rolled back (#${facts.rolledBack}): revert or fix forward on main first, then close that issue`);
  }
  // a story whose blockers have not landed in the sprint (or shipped) waits for them
  for (const b of facts.blockers || []) if (!b.landed) blockedBy(`blocked by #${b.number}: it has not merged into the sprint yet`);
  // approvals (Approver): the story's approver, never the person who pushed the latest change, when APPROVERS is set
  if (rules.approval !== "none") {
    const a = st.approval;
    const staleApproval = !a.ok && (facts.reviews || []).some((x) => x.user?.type === "User" && x.state === "APPROVED");
    const named = facts.storyApprover ? ` by @${facts.storyApprover}` : "";
    if (!a.ok) reasons.push(a.refused.length ? `approval does not count: ${a.refused[0].why}`
      : staleApproval ? "your approval was for an older commit; approve again"
      : rules.approval === "review" ? `not approved${named} (Review changes > Approve)` : `no sign-off${named} (approve it, or comment /ship)`);
  }

  const forceApp = Boolean(compare.forceAppChanged);
  const validate = rules.validate === true || (rules.validate === "if-force-app" && forceApp);
  const after = followUps(pr, compare.prFiles || [], { forceApp });   // one rule for the gate and an emergency merge
  return { route: r, rules, reasons, other, blocking, mergeable: reasons.length === 0, story: storyOf(pr.headRefName), validate, after, standing: st };
}

/** Does a story PR wait only for a person's approval, everything else green? Its scratch org is then idle until a change
 *  or a login needs it, so a story waiting for a slot may have it (FREE_IDLE_ORGS, journey.freeIdleOrgs). The approval
 *  is evaluate()'s last reason, so it is the only one. Pure: evaluate()'s result. */
export function onlyApprovalLeft(d) {
  if (d?.route !== "feature" || d.mergeable || d.blocking === "failure" || !d.standing || d.standing.approval?.ok) return false;
  return d.reasons.length === 1;
}

const validate_ = (rules, compare) => rules.validate === true || (rules.validate === "if-force-app" && Boolean(compare.forceAppChanged));

/** Re-run the gate when a person has acted (or the PR needs no one), so it merges when its last input lands: an
 *  approval that counts under the route's rule (a review, a ticked Sign off, /ship, `ready`), or one that does not,
 *  so the gate says why. Standing decides, as for the gate itself: the trusted sign-off, its carry, nobody approving
 *  their own push (it used to read the statuses itself and took any approving review). Pure: facts from facts.gather(). */
export function nudge(facts) {
  const pr = facts.pr;
  if (pr.state !== "OPEN") return { action: "none", why: "PR is not open" };
  if (route(pr) === "backmerge") return { action: "dispatch" };
  const a = standing(facts).approval;
  return a.ok || a.refused.length ? { action: "dispatch" } : { action: "none", why: "not signed off yet" };
}

/** The stories a story's body says block it ("Blocked by #12, #14"). Pure. */
export const blockersOf = (body) => [...new Set([...String(body || "").matchAll(/Blocked by ((?:#\d+(?:\s*(?:,|and|&)\s*(?:and\s*)?)?)+)/gi)].flatMap((m) => [...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1]))))];

/** What a story blocked at Start says (the issue comment). Pure. */
export function blockedMessage(waiting) {
  const one = waiting.length === 1;
  return `⏸ Not started: this story is blocked by ${waiting.map((n) => `#${n}`).join(", ")}, which ${one ? "has" : "have"} not merged yet. Nothing was created (no branch, no scratch org). Tick **Start** again once ${one ? "it has" : "they have"} merged.`;
}
