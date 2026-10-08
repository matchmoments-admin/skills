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
import { CHECKS, storyOf, sprintOf, uiFacing, storySpec, isPipelineAuthor } from "./conventions.mjs";

// signoff: a person's sign-off on a story PR into the sprint (a ticked box or /ship), recorded by an agent-free job.
export const STATUS = { review: "pipeline/ai-review", ui: "pipeline/ui-test", uat: "pipeline/uat", signoff: "pipeline/sign-off" };
/** The gate's own verdict on the PR's head. The branch rules require it, so GitHub's merge button stays locked until
 *  the gate is satisfied; admins (and any team the rules name) can still bypass in an emergency. */
export const GATE_STATUS = "pipeline/gate";

/** What pipeline/gate says for a decision: success when it may merge; failure when something failed; else pending. */
export function gateStatus(decision) {
  if (decision.mergeable) return { state: "success", description: "All requirements met: the gate merges it" };
  const r = decision.reasons || [];
  const failed = r.some((x) => /did not pass|is failure|UAT failed|production rejected|merge conflicts/.test(x));
  const first = String(r[0] || "waiting").replace(/\s*\(Review changes > Approve\)/, "");
  const more = r.length > 1 ? ` (+${r.length - 1} more)` : "";
  return { state: failed ? "failure" : "pending", description: `${first}${more}`.slice(0, 139) };
}

/** After a merge the gate did not make (an emergency bypass): the follow-ups the gate would have started. */
export function followUps(pr, files = []) {
  const r = route(pr);
  if (!r) return [];
  const forceApp = files.some((f) => f.startsWith("force-app/"));
  return RULES[r].after.map((a) => (a === "release-if-force-app" ? (forceApp ? "release" : null) : a)).filter(Boolean);
}
export const TRUSTED_STATUS_CREATORS = ["github-actions[bot]"];

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
  maintenance: { checks: [CHECKS.static, CHECKS.apex], verdicts: false, approval: "review", validate: "if-force-app", merge: "squash", after: ["release-if-force-app"] },
};

/** Latest conclusion of a named check run, by start time ("missing" if it never ran). */
export function latestCheck(checkRuns, name) {
  const runs = checkRuns.filter((c) => c.name === name).sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  return runs.length ? runs[runs.length - 1].conclusion || runs[runs.length - 1].status || "pending" : "missing";
}

/** True if every file changed between a commit and the head is under e2e/ (the UI tester's spec). */
const onlySpecsSince = (sha, head, diffsToHead) =>
  sha === head || (Array.isArray(diffsToHead[sha]) && diffsToHead[sha].every((f) => f.startsWith("e2e/")));

/** The verdict a status context gives the head: { state: "success" | "failure" | "stale" | "missing" | ... }. */
export function verdictFor(context, { statuses = [], head, diffsToHead = {} }) {
  const mine = statuses.filter((s) => s.context === context && TRUSTED_STATUS_CREATORS.includes(s.creator?.login))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (!mine.length) return { state: "missing" };
  const last = mine[mine.length - 1];
  if (!onlySpecsSince(last.sha, head, diffsToHead)) return { state: "stale", sha: last.sha };
  return { state: last.state, description: last.description || "", url: last.url || null };
}

/** Has a person approved the code as it is now? Latest decisive review per human, on the head (or e2e-only since). */
export function humanApproval({ reviews = [], head, diffsToHead = {} }) {
  const latest = new Map();
  for (const r of [...reviews].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))) {
    if (r.user?.type !== "User") continue;
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) latest.set(r.user.login, r);
  }
  return [...latest.values()].some((r) => r.state === "APPROVED" && onlySpecsSince(r.commit_id, head, diffsToHead));
}

/** `ready` counts if a person applied it after the head commit was pushed (first check on the head, server time). */
export const SIGN_OFF_COMMENT = /^\/ship\b/;
const CAN_SIGN_OFF = ["OWNER", "MEMBER", "COLLABORATOR"];
export function readyAfterPush({ labelEvents = [], checkRuns = [], comments = [] }) {
  const pushedAt = checkRuns.map((c) => c.started_at).filter(Boolean).sort()[0];
  const label = labelEvents.filter((e) => e.event === "labeled" && e.label?.name === "ready" && e.actor?.type !== "Bot").map((e) => e.created_at);
  // `/ship` in a comment by a person with write access counts the same as the `ready` label.
  const ship = comments.filter((c) => SIGN_OFF_COMMENT.test(String(c.body || "").trim()) && c.user?.type !== "Bot" && CAN_SIGN_OFF.includes(c.author_association)).map((c) => c.created_at);
  const ready = [...label, ...ship].sort().pop();
  return Boolean(pushedAt && ready && ready >= pushedAt);
}

/** Which verdicts this PR needs, given the AI flags and what it changes (prFiles: files changed against its base). */
export function requiredVerdicts({ ai = {}, compare = {} }, story) {
  const files = compare.prFiles;                       // undefined if the comparison failed: assume UI-facing
  const ui = !files || uiFacing(files).length > 0;
  const spec = Boolean(story) && Array.isArray(files) && files.includes(storySpec(story));
  return [
    { context: STATUS.review, what: "AI review", required: Boolean(ai.review), how: "it starts when the PR opens; or tick Run the AI review again" },
    { context: STATUS.ui, what: "UI test", required: ui && (Boolean(ai.uiTest) || spec), how: ai.uiTest ? "tick Have Claude write and run the UI test" : "tick Run the committed UI test" },
  ];
}

/** Decide from GitHub facts (see gather()). Returns { route, rules, reasons[], mergeable, story, validate, after[] }. */
export function evaluate(facts) {
  const { pr, checkRuns = [], compare = {} } = facts;
  const r = route(pr);
  if (!r) return { route: null, reasons: ["not a gated pull request"], mergeable: false };
  const rules = RULES[r];
  const ctx = { ...facts, head: pr.headRefOid };
  const reasons = [];
  if (pr.state && pr.state !== "OPEN") reasons.push(`the PR is ${String(pr.state).toLowerCase()}`);
  if (pr.isDraft) reasons.push("the PR is a draft");
  if (pr.mergeable === "CONFLICTING") reasons.push("it has merge conflicts with its base; update the branch");

  for (const name of rules.checks) {
    const c = latestCheck(checkRuns, name);
    if (c !== "success") reasons.push(`check "${name}" is ${c}`);
  }
  if (rules.verdicts) {
    for (const v of requiredVerdicts(facts, storyOf(pr.headRefName))) {
      const got = verdictFor(v.context, ctx);
      if (v.required) {
        if (got.state === "missing") reasons.push(`${v.what} has not run on this code (${v.how})`);
        else if (got.state === "stale") reasons.push(`${v.what} judged an older commit; run it again (${v.how})`);
        else if (got.state !== "success") reasons.push(`${v.what} did not pass (${got.state})`);
      } else if (["failure", "error"].includes(got.state)) reasons.push(`${v.what} did not pass (${got.state})`);
    }
  }
  // UAT (UAT_ENABLED): a release ships only after a person signed off the release in UAT (/uat-pass), on this code.
  if (r === "release" && facts.uat) {
    const u = verdictFor(STATUS.uat, ctx);
    if (u.state === "missing") reasons.push("not in UAT yet (it deploys there after the release PR opens)");
    else if (u.state === "stale") reasons.push("UAT signed off an older version; it redeploys, then sign off again (/uat-pass)");
    else if (u.state === "pending") reasons.push("waiting for UAT sign-off: test in UAT, then tick UAT passed on the release card (or comment /uat-pass)");
    else if (u.state !== "success") reasons.push(`UAT failed (${u.description || u.state}); fix it, or tick UAT passed after a retest`);
  }
  if (rules.trusted) {
    if (!isPipelineAuthor(pr.author?.login)) reasons.push("a back-merge must be opened by the pipeline");
    if (compare.headInMain !== true) reasons.push("a back-merge must contain only commits already in main");

  }
  if (rules.pure && compare.unreleasedSprintCommits > 0) {
    reasons.push(`it carries ${compare.unreleasedSprintCommits} unreleased sprint commit(s); a hotfix must branch from main`);
  }
  // production was rolled back: nothing ships to main until the bad change is reverted or fixed (the open issue says how)
  if (["release", "hotfix", "maintenance"].includes(r) && validate_(rules, compare) && facts.rolledBack) {
    reasons.push(`production was rolled back (#${facts.rolledBack}): revert or fix forward on main first, then close that issue`);
  }
  // a story whose blockers have not landed in the sprint (or shipped) waits for them
  for (const b of facts.blockers || []) if (!b.landed) reasons.push(`blocked by #${b.number}: it has not merged into the sprint yet`);
  const approved = humanApproval(ctx);
  const staleApproval = !approved && (facts.reviews || []).some((x) => x.user?.type === "User" && x.state === "APPROVED");
  if (rules.approval === "review" && !approved) reasons.push(staleApproval ? "your approval was for an older commit; approve again" : "not approved (Review changes > Approve)");
  const signedOff = verdictFor(STATUS.signoff, ctx).state === "success";
  if (rules.approval === "sign-off" && !approved && !signedOff && !readyAfterPush(facts)) reasons.push(staleApproval ? "your approval was for an older commit; approve again" : "no sign-off (approve it, or comment /ship)");

  const forceApp = Boolean(compare.forceAppChanged);
  const validate = rules.validate === true || (rules.validate === "if-force-app" && forceApp);
  const after = rules.after.map((a) => (a === "release-if-force-app" ? (forceApp ? "release" : null) : a)).filter(Boolean);
  return { route: r, rules, reasons, mergeable: reasons.length === 0, story: storyOf(pr.headRefName), validate, after };
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
  const comments = ghPages(`repos/${repo}/issues/${prNumber}/comments?per_page=100`).map((c) => ({ body: c.body, created_at: c.created_at, author_association: c.author_association, user: { type: c.user?.type } }));
  const statuses = [];
  for (const c of pr.commits || []) {
    for (const s of ghPages(`repos/${repo}/commits/${c.oid}/statuses?per_page=100`)) {
      if (Object.values(STATUS).includes(s.context)) statuses.push({ sha: c.oid, context: s.context, state: s.state, description: s.description, url: s.target_url, created_at: s.created_at, creator: { login: s.creator?.login } });
    }
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
  return { pr, reviews, checkRuns, labelEvents, comments, statuses, diffsToHead, compare, ai, uat, rolledBack, blockers };
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
  // a ticked Sign off (or /ship): the trusted pipeline/sign-off status on the head
  const signedOff = ghPages(`repos/${repo}/commits/${pr.headRefOid}/statuses?per_page=100`)
    .some((s) => s.context === STATUS.signoff && s.state === "success" && TRUSTED_STATUS_CREATORS.includes(s.creator?.login));
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
