// Shipping: getting one merge commit into production, keyed by its SHA (see GLOSSARY.md: Shipping).
//
// The gate validates a candidate it builds itself (the base branch's tip with the PR merged in), while it holds the
// lock that serialises everything landing on main, so production checks exactly what main will contain. The release
// takes the merge commit's SHA and the tree the gate validated: it quick-deploys only when that SHA has exactly that
// tree, and validates again otherwise. A SHA already shipped (tagged, or inside a later release's tag) is a no-op, so
// re-runs, retries and a newer release replacing a queued older one are all safe. Close-out works from the SHA and the
// release before it, never from wherever main has moved to since.

export const TAG_GLOB = "v*";

/** The newest release tag reachable from a ref (the previous release), or null before the first one. */
export const lastRelease = (git, ref) => git(["describe", "--tags", "--abbrev=0", "--match", TAG_GLOB, ref], { allowFail: true }) || null;

/**
 * Build the candidate in an existing clone `dir`: the base's tip with the PR's head merged in, exactly as the merge
 * will. Refuses if the PR moved after the gate decided. Returns { base, head, tree, since } (since: the previous
 * release, for deletions).
 */
export function buildCandidate(git, { pr, base, head, dir }) {
  const g = (args, o) => git(["-C", dir, ...args], o);
  g(["fetch", "-q", "--tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/pull/${pr}/head:refs/remotes/origin/pr-${pr}`]);
  const got = g(["rev-parse", `refs/remotes/origin/pr-${pr}`]);
  if (got !== head) throw new Error(`PR #${pr} moved to ${got.slice(0, 7)} after the gate decided on ${head.slice(0, 7)}; the gate runs again on the new commit`);
  const baseSha = g(["rev-parse", `refs/remotes/origin/${base}`]);
  g(["checkout", "-q", "--detach", baseSha]);
  g(["-c", "user.name=pipeline", "-c", "user.email=pipeline@users.noreply.github.com", "merge", "-q", "--no-ff", "--no-edit", head]);
  return { base: baseSha, head, tree: g(["rev-parse", "HEAD^{tree}"]), since: lastRelease(g, baseSha) };
}

/**
 * What a release run does for a SHA (pure).
 * facts: { sha, onMain, shippedIn: [tags containing sha, oldest first], tree: the SHA's tree,
 *          validated: { job, tree } from the gate, previous: the release before it }
 * Returns { action: "skip" | "quick" | "validate", tag?, job?, previous, why }.
 */
export function releasePlan({ sha, onMain, shippedIn = [], tree, validated = {}, previous = null }) {
  const short = String(sha).slice(0, 7);
  if (!onMain) throw new Error(`${short} is not on main: only main ships`);
  if (shippedIn.length) return { action: "skip", tag: shippedIn[0], previous, why: `${short} already shipped in ${shippedIn[0]}` };
  if (validated.job && validated.tree === tree) return { action: "quick", job: validated.job, previous, why: `the gate validated this exact tree (${validated.job})` };
  return {
    action: "validate", previous,
    why: validated.job ? `the merged tree is not the one the gate validated (main moved, or an emergency merge): validating ${short} again` : `no gate validation for ${short}: validating it here`,
  };
}

export function gatherRelease(git, { sha, validated = {} }) {
  git(["fetch", "-q", "--tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], { allowFail: true });
  const full = git(["rev-parse", sha || "origin/main"]);
  const shippedIn = (git(["tag", "--contains", full, "--list", TAG_GLOB, "--sort=creatordate"], { allowFail: true }) || "").split("\n").filter(Boolean);
  return {
    sha: full,
    onMain: git(["merge-base", "--is-ancestor", full, "origin/main"], { allowFail: true }) !== null,
    shippedIn, tree: git(["rev-parse", `${full}^{tree}`]), validated,
    // the release before this one (for an already-shipped SHA, the one before its tag, so a re-run closes out the same)
    previous: lastRelease(git, shippedIn.length ? `${shippedIn[0]}^` : full),
  };
}

/** After landing: re-run the gate for every other approved PR into the same base. GitHub keeps one waiting run per
 *  concurrency group and cancels the one before, so a ship that was queued is never lost. Returns the PRs re-run. */
export function renudge({ gh }, host, { base, except }, nudge) {
  const prs = gh(["pr", "list", "--base", base, "--state", "open", "--limit", "1000", "--json", "number"]) || [];
  const again = prs.map((p) => p.number).filter((n) => String(n) !== String(except) && nudge(n).action === "dispatch");
  for (const n of again) host.dispatch("gate.yml", { pr: n });
  return again;
}

/** The facts watchdog() decides on, from git, the release runs and the open issues. */
export function watchdogFacts({ git, gh }, host) {
  git(["fetch", "-q", "--tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const mainSha = git(["rev-parse", "origin/main"]);
  const previous = lastRelease(git, mainSha);
  const runs = host.workflowRuns("release.yml", "", 20);
  const last = runs.find((r) => r.status === "completed");
  return {
    mainSha, previous,
    forceAppChanged: Boolean(previous) && git(["diff", "--quiet", previous, mainSha, "--", "force-app"], { allowFail: true }) === null,
    releaseActive: runs.some((r) => ["queued", "in_progress", "waiting", "pending", "requested"].includes(r.status)),
    lastRun: last ? { sha: (String(last.display_title).match(/[0-9a-f]{40}/) || [])[0], conclusion: last.conclusion } : null,
    rolledBack: (gh(["issue", "list", "--state", "open", "--search", 'in:title "Production rolled back to"', "--json", "number"]) || []).length > 0,
  };
}

/**
 * Has something landed on main that never shipped? (the safety net for a lost or failed release dispatch; pure)
 * facts: { mainSha, previous, forceAppChanged, releaseActive, lastRun: { sha, conclusion }, rolledBack }
 */
export function watchdog({ mainSha, previous, forceAppChanged, releaseActive, lastRun = null, rolledBack = false }) {
  const short = String(mainSha).slice(0, 7);
  if (!previous) return { action: "none", why: "no release yet" };
  if (!forceAppChanged) return { action: "none", why: `main has no Salesforce changes since ${previous}` };
  if (releaseActive) return { action: "none", why: "a release is queued or running" };
  if (rolledBack) return { action: "report", why: `main has unreleased changes since ${previous}, but production was rolled back: revert or fix forward first (see the open "Production rolled back" issue)` };
  if (lastRun?.sha === mainSha && lastRun.conclusion === "failure") return { action: "report", why: `the release of ${short} failed; fix it forward or re-run the release` };
  return { action: "release", why: `main (${short}) has Salesforce changes since ${previous} that never shipped` };
}
