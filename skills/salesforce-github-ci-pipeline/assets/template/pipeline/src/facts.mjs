// PR facts: what the gate decides on, read from GitHub through the io seam (see GLOSSARY.md: Standing). gather() is the one
// reader of a PR's statuses, reviews, check runs, labels, comments and compares; statusOn() reads one exact commit's
// trusted result; landedOf() whether a blocking story landed. The decisions on these facts (Standing, the gate) live in
// gate.mjs, which does no IO (28 Oct review: moved out of gate.mjs, so the module everything reads stays pure).
import { storyOf, setting } from "./conventions.mjs";
import { STATUS, GATE_STATUS, PROVEN, trustedRun, verdictFor, route, blockersOf } from "./gate.mjs";
import { approverOf, approverList, lastPusherOf } from "./approval.mjs";

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
      if ([...Object.values(STATUS), GATE_STATUS].includes(s.context)) statuses.push({ sha: c.oid, context: s.context, state: s.state, description: s.description, url: s.target_url, created_at: s.created_at, creator: { login: s.creator?.login } });
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
  const approvers = approverList(setting("APPROVERS")), approvalMode = setting("APPROVAL_MODE");
  // who pushed: GitHub's push records for the branch (the newest page is enough), as well as the commits' authors
  const pushes = (gh(["api", `repos/${repo}/activity?ref=${encodeURIComponent(`refs/heads/${pr.headRefName}`)}&per_page=50`], { allowFail: true }) || []);
  return { pr, reviews, checkRuns, labelEvents, comments, statuses, diffsToHead, compare, ai, uat, rolledBack, blockers,
    approvers, approvalMode, storyApprover: approverOf(body), lastPusher: lastPusherOf(pr.commits, Array.isArray(pushes) ? pushes : []) };
}

/** The newest trusted status of `context` on exactly `sha`, read the way Standing reads an exact result: close-out's
 *  UAT signer on the merged release head, regate's gate success. ghPages: the io seam. */
export function statusOn(ghPages, repo, sha, context) {
  const statuses = ghPages(`repos/${repo}/commits/${sha}/statuses?per_page=100`).filter((s) => s.context === context)
    .map((s) => ({ sha, context: s.context, state: s.state, description: s.description, url: s.target_url, created_at: s.created_at, creator: { login: s.creator?.login } }));
  return verdictFor(context, { statuses, head: sha });
}

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
