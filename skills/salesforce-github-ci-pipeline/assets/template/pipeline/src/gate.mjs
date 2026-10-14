// The gate: may this PR merge, and how? (see GLOSSARY.md: Gate, Verdict, Sign-off)
// evaluate() is pure: it takes recorded GitHub facts and returns the decision. gather() fetches those facts.
//
// Trust model: a verdict counts only as a commit status (pipeline/ai-review, pipeline/ui-test) on the exact commit
// it judged (or an earlier one, if everything since only touched e2e/), posted by an agent-free job with the
// Actions token. Labels are for people to read; the gate does not trust them. Human approval is a review whose
// commit_id is the head (same e2e-only allowance). `ready` counts only if applied after the head was pushed.
//
// AI is optional (facts.ai, from the AI_* repo variables). Required verdicts: the AI review only when AI_REVIEW is on;
// the UI test when the change is UI-facing and either AI_UI_TEST is on or the PR commits its story spec. A failed
// verdict on the code always blocks, whatever the flags. With every flag off, CI plus a person's approval is the gate.
import { CHECKS, storyOf, sprintOf, uiNeeded, storySpec, isPipelineAuthor, isHumanAuthor, setting, touchesPipeline } from "./conventions.mjs";

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
 * Does a result on an earlier commit still count on the head? One rule per result (see GLOSSARY.md: Standing):
 *   specs    a review or sign-off: only specs (e2e/) changed since
 *   exact    the UI test (the spec IS that test), UAT (a person signed off that code), the gate's approval record
 *   no-sf    CI's Salesforce tests: nothing under force-app changed since (a spec-only push needs no deploy), and no
 *            pipeline file either: a commit whose workflows were the branch's own could have faked that pass
 * files: what changed from that commit to the head (null if unknown, which never carries). Pure.
 */
export const CARRY = { [STATUS.review]: "specs", [STATUS.signoff]: "specs", [STATUS.ui]: "exact", [STATUS.uat]: "exact", [STATUS.approval]: "exact", apex: "no-sf", staging: "no-staging-input", [STATUS.uiRegression]: "no-staging-input" };
/** What the staging regression tests: Salesforce source, specs, seed and org config, and the code that builds and runs
 *  staging. A release-branch commit that changes none of these (a back-merge of other pipeline work) keeps the
 *  regression an earlier commit passed (#237). */
export const STAGING_INPUTS = /^(force-app\/|e2e\/|data\/|config\/|baseline\/|sfdx-project\.json$|package(-lock)?\.json$|playwright\.config\.ts$|\.github\/actions\/|\.github\/workflows\/staging-deploy\.yml$|pipeline\/src\/(org|tests|evidence|baseline|io)\.mjs$|pipeline\/src\/org\/)/;
export function carries(rule, sha, head, files) {
  if (sha === head) return true;
  if (rule === "exact" || !Array.isArray(files)) return false;
  if (rule === "no-staging-input") return !files.some((f) => STAGING_INPUTS.test(f));
  return rule === "no-sf" ? !files.some((f) => f.startsWith("force-app/")) && !touchesPipeline(files).length : files.every((f) => f.startsWith("e2e/"));
}
/** True if every file changed between a commit and the head is under e2e/ (the UI tester's spec). */
const onlySpecsSince = (sha, head, diffsToHead) => carries("specs", sha, head, diffsToHead[sha]);

/**
 * The newest earlier commit whose result still carries to the head (CI's Salesforce tests, rule no-sf), or null.
 * passed: commits (newest first, the head excluded) on which that check succeeded; changedSince(sha): files from it
 * to the head, or null. Pure apart from changedSince.
 */
export function carriedFrom(rule, { head, passed = [], changedSince }) {
  for (const sha of passed) if (carries(rule, sha, head, changedSince(sha))) return sha;
  return null;
}
/** The verdict a status context gives the head: { state: "success" | "failure" | "stale" | "missing" | ... }. */
export function verdictFor(context, { statuses = [], head, diffsToHead = {} }) {
  const mine = statuses.filter((s) => s.context === context && TRUSTED_STATUS_CREATORS.includes(s.creator?.login) && s.trusted !== false)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (!mine.length) return { state: "missing" };
  const last = mine[mine.length - 1];
  // A spec-only push keeps a review or sign-off, but not the UI test: the spec IS that test, so a changed spec has
  // not passed yet (story #166: a weakened spec rode on the earlier pass). Nor UAT: a person signed off that code.
  if (!carries(CARRY[context] || "specs", last.sha, head, diffsToHead[last.sha])) return { state: "stale", sha: last.sha };
  return { state: last.state, description: last.description || "", url: last.url || null, sha: last.sha, at: last.created_at || null };
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

/** The story's approver: an "Approver: @login" line (or the story form's Approver field), else null. Pure. */
export const approverOf = (body) => String(body || "").match(/^(?:#+\s*)?\**Approver\**:?\**\s*\n*\s*@([A-Za-z0-9-]+)/im)?.[1] || null;
/** The APPROVERS setting as logins (the first is the default approver of new stories). Pure. */
export const approverList = (v) => String(v || "").split(/[\s,]+/).map((x) => x.replace(/^@/, "")).filter(Boolean);
/**
 * Who pushed the PR's latest change: the newest of (a) a push to the branch by a person (GitHub's own record of who
 * pushed: the repository activity API) and (b) a commit with a human author (not Claude, not the pipeline: a person's
 * change the App pushed for them, such as Bring my Setup changes). (a) matters: a commit whose email is not linked to
 * a GitHub account has no login, and story #193's sign-off by the person who had just pushed was accepted. Pure.
 */
export function lastPusherOf(commits = [], pushes = []) {
  const byCommit = [...commits].map((c) => [String(c.committedDate || ""), (c.authors || []).find((a) => a.login && isHumanAuthor(a.login))?.login]);
  const byPush = pushes.filter((p) => !p.activity_type || ["push", "force_push"].includes(p.activity_type))
    .map((p) => [String(p.timestamp || ""), p.actor?.type === "Bot" ? null : p.actor?.login]);
  return [...byCommit, ...byPush].filter(([, login]) => login && isHumanAuthor(login)).sort(([a], [b]) => a.localeCompare(b)).map(([, l]) => l).pop() || null;
}

/**
 * Why this person's approval does not count, or null when it does (see GLOSSARY.md: Approver). With APPROVERS unset,
 * anyone with write access approves (a team without a policy yet). With it set: never the person who pushed the
 * latest change (nobody approves their own work), and only the story's approver; with none named (a release, a
 * hotfix without one), or when the approver pushed the latest change themselves, anyone in APPROVERS. Pure.
 */
export function approvalProblem({ approvers = [], storyApprover = null, lastPusher = null }, login) {
  if (!approvers.length || !login) return null;
  const is = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  const inTeam = approvers.some((a) => is(a, login));
  if (is(login, lastPusher)) return `@${login} pushed the latest change, so ${storyApprover && !is(storyApprover, login) ? `@${storyApprover} (the approver)` : "another approver"} needs to approve`;
  if (storyApprover && !is(storyApprover, login) && !(is(storyApprover, lastPusher) && inTeam)) return `@${storyApprover} is this story's approver (change the story's Approver line to hand it over)`;
  if (!storyApprover && !inTeam) return `@${login} is not an approver (APPROVERS: ${approvers.map((a) => `@${a}`).join(", ")})`;
  return null;
}

/**
 * Does a person's approval cover the code as it is now (Sign-off)? Reviews on the head; with signOff, also a ticked
 * Sign off or /ship (the trusted pipeline/sign-off status) and `ready` or /ship after the push. Each is checked
 * against approvalProblem(). Returns { ok, by: [login], who: [{ login, at, how }], refused: [{ login, why }] }. Pure.
 */
export function approval(ctx, { signOff = false } = {}) {
  const seen = approvingReviews(ctx).map((r) => ({ login: r.user.login, at: r.submitted_at, how: "approved the pull request" }));
  if (signOff) {
    const s = verdictFor(STATUS.signoff, ctx);
    if (s.state === "success") seen.push({ login: String(s.description || "").match(/@([A-Za-z0-9-]+)/)?.[1] || "", at: s.at, how: "ticked Sign off" });
    seen.push(...readyEvents(ctx).map(([at, login, how]) => ({ login, at, how })));
  }
  const who = [], refused = [];
  for (const a of seen) {
    if (who.some((w) => w.login === a.login) || refused.some((r) => r.login === a.login)) continue;
    const why = approvalProblem(ctx, a.login);
    if (why) refused.push({ login: a.login, why }); else who.push(a);
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
 * board and the delivery record all read it. Pure: facts from gather().
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
    record: verdictFor(STATUS.approval, ctx),
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

/** Decide from GitHub facts (see gather()). Returns { route, rules, reasons[], blocking, mergeable, story, validate, after[] }. */
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

const validate_ = (rules, compare) => rules.validate === true || (rules.validate === "if-force-app" && Boolean(compare.forceAppChanged));

/** Facts for evaluate(), fetched through the io seam (all pages). */
export function gather(prNumber, { gh, ghPages }, { openReleaseBranch = null, ai = {}, uat = false } = {}) {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  const pr = gh(["pr", "view", String(prNumber), "--json", "number,state,isDraft,mergeable,baseRefName,headRefName,headRefOid,labels,author,commits,url"]);
  const head = pr.headRefOid;
  const reviews = ghPages(`repos/${repo}/pulls/${prNumber}/reviews?per_page=100`);
  const checkRuns = ghPages(`repos/${repo}/commits/${head}/check-runs?per_page=100`, "check_runs");
  const labelEvents = ghPages(`repos/${repo}/issues/${prNumber}/events?per_page=100`);
  const comments = ghPages(`repos/${repo}/issues/${prNumber}/comments?per_page=100`).map((c) => ({ body: c.body, created_at: c.created_at, author_association: c.author_association, user: { type: c.user?.type, login: c.user?.login } }));
  const statuses = [];
  for (const c of pr.commits || []) {
    for (const s of ghPages(`repos/${repo}/commits/${c.oid}/statuses?per_page=100`)) {
      if (Object.values(STATUS).includes(s.context)) statuses.push({ sha: c.oid, context: s.context, state: s.state, description: s.description, url: s.target_url, created_at: s.created_at, creator: { login: s.creator?.login } });
    }
  }
  // provenance of the verdicts that unlock a merge with nobody looking: the run that posted them (trustedRun)
  const runs = new Map();
  for (const s of statuses.filter((x) => PROVEN.includes(x.context))) {
    const id = String(s.url || "").match(/\/actions\/runs\/(\d+)/)?.[1];
    if (id && !runs.has(id)) runs.set(id, gh(["api", `repos/${repo}/actions/runs/${id}`], { allowFail: true }));
    s.trusted = trustedRun(id ? runs.get(id) : null);
  }
  const diffsToHead = {};
  const shas = new Set([...statuses.map((s) => s.sha), ...reviews.map((r) => r.commit_id)].filter((s) => s && s !== head));
  for (const sha of shas) {
    const cmp = gh(["api", `repos/${repo}/compare/${sha}...${head}`], { allowFail: true });
    diffsToHead[sha] = cmp && cmp.status !== "diverged" ? (cmp.files || []).map((f) => f.filename) : null;
  }
  const compare = {};
  const vsBase = gh(["api", `repos/${repo}/compare/${pr.baseRefName}...${head}`], { allowFail: true });
  if (vsBase && Array.isArray(vsBase.files)) compare.prFiles = vsBase.files.map((f) => f.filename);
  const vsMain = gh(["api", `repos/${repo}/compare/main...${head}`], { allowFail: true });
  if (vsMain) {
    compare.headInMain = vsMain.ahead_by === 0;
    compare.forceAppChanged = (vsMain.files || []).some((f) => f.filename.startsWith("force-app/"));
    if (openReleaseBranch && pr.baseRefName === "main") {
      const rel = gh(["api", `repos/${repo}/compare/main...${openReleaseBranch}`], { allowFail: true });
      const unreleased = new Set((rel?.commits || []).map((c) => c.sha));
      compare.unreleasedSprintCommits = (vsMain.commits || []).filter((c) => unreleased.has(c.sha)).length;
    }
  }
  // routes into main: an open rollback issue; a story: the stories its body says block it, and whether they landed
  const r = route(pr);
  const rolledBack = ["release", "hotfix", "maintenance"].includes(r) ? (gh(["issue", "list", "--state", "open", "--search", 'in:title "Production rolled back to"', "--json", "number"], { allowFail: true }) || [])[0]?.number || null : null;
  const key = storyOf(pr.headRefName);
  const body = key && /^\d+$/.test(key) ? gh(["issue", "view", key, "--json", "body"], { allowFail: true })?.body || "" : "";
  const blockers = blockersOf(body).map((n) => ({ number: n, landed: landedOf(n, gh) }));
  // the approval rule's inputs: the team (APPROVERS), the story's approver, who pushed the latest change
  const approvers = approverList(setting("APPROVERS"));
  // who pushed: GitHub's push records for the branch (the newest page is enough), as well as the commits' authors
  const pushes = (gh(["api", `repos/${repo}/activity?ref=${encodeURIComponent(`refs/heads/${pr.headRefName}`)}&per_page=50`], { allowFail: true }) || []);
  return { pr, reviews, checkRuns, labelEvents, comments, statuses, diffsToHead, compare, ai, uat, rolledBack, blockers,
    approvers, storyApprover: approverOf(body), lastPusher: lastPusherOf(pr.commits, Array.isArray(pushes) ? pushes : []) };
}

/** Re-run the gate when a person has signed off (or the PR needs no sign-off), so it merges when its last input lands.
 *  The gate itself decides whether that sign-off still covers the code. */
export function nudge(prNumber, { gh, ghPages }) {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  const pr = gh(["pr", "view", String(prNumber), "--json", "state,labels,headRefName,baseRefName,headRefOid"]);
  if (pr.state !== "OPEN") return { action: "none", why: "PR is not open" };
  if (route(pr) === "backmerge" || pr.labels.some((l) => l.name === "ready")) return { action: "dispatch" };
  const approved = ghPages(`repos/${repo}/pulls/${prNumber}/reviews?per_page=100`).some((r) => r.user?.type === "User" && r.state === "APPROVED");
  if (approved) return { action: "dispatch" };
  // a ticked Sign off (or /ship): the trusted pipeline/sign-off status on any of its last 20 commits, if it still
  // carries to the head (verdictFor's rule, the gate's own): a sign-off that no longer covers the head would start a
  // gate run, a billed minute, on every check and verdict until someone signs off again
  const listed = (gh(["pr", "view", String(prNumber), "--json", "commits"])?.commits || []).map((c) => c.oid).reverse().slice(0, 20);
  const shas = listed.length ? listed : [pr.headRefOid];
  const statuses = shas.flatMap((sha) => ghPages(`repos/${repo}/commits/${sha}/statuses?per_page=100`)
    .filter((s) => s.context === STATUS.signoff).map((s) => ({ sha, context: s.context, state: s.state, created_at: s.created_at, creator: { login: s.creator?.login } })));
  const last = statuses.filter((s) => TRUSTED_STATUS_CREATORS.includes(s.creator.login)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).pop();
  const diffsToHead = {};
  if (last && last.sha !== pr.headRefOid) {
    const cmp = gh(["api", `repos/${repo}/compare/${last.sha}...${pr.headRefOid}`], { allowFail: true });
    diffsToHead[last.sha] = cmp && cmp.status !== "diverged" ? (cmp.files || []).map((f) => f.filename) : null;
  }
  const signedOff = verdictFor(STATUS.signoff, { statuses, head: pr.headRefOid, diffsToHead }).state === "success";
  return signedOff ? { action: "dispatch" } : { action: "none", why: "not signed off yet" };
}

/** The stories a story's body says block it ("Blocked by #12, #14"). Pure. */
export const blockersOf = (body) => [...new Set([...String(body || "").matchAll(/Blocked by ((?:#\d+(?:\s*(?:,|and|&)\s*(?:and\s*)?)?)+)/gi)].flatMap((m) => [...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1]))))];

/**
 * Has a blocking story landed? Its story PR merged (into the sprint, or main for a hotfix), or the story is closed.
 * Started is not landed: the in-sprint label only says someone is working on it. Unknown (no access) counts as landed,
 * so a typo never blocks forever.
 */
export function landedOf(n, gh) {
  const i = gh(["issue", "view", String(n), "--json", "state"], { allowFail: true });
  if (!i || i.state === "CLOSED") return true;
  // merged PRs whose head is this story's branch: issue-N, or the older issue-N-slug (storyOf reads both)
  return (gh(["pr", "list", "--state", "merged", "--search", `head:issue-${n}`, "--limit", "20", "--json", "headRefName"], { allowFail: true }) || [])
    .some((p) => storyOf(p.headRefName) === String(n));
}

/** What a story blocked at Start says (the issue comment). Pure. */
export function blockedMessage(waiting) {
  const one = waiting.length === 1;
  return `⏸ Not started: this story is blocked by ${waiting.map((n) => `#${n}`).join(", ")}, which ${one ? "has" : "have"} not merged yet. Nothing was created (no branch, no scratch org). Tick **Start** again once ${one ? "it has" : "they have"} merged.`;
}
