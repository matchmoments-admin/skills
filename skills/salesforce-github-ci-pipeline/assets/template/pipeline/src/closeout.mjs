// Close-out after a production release (see GLOSSARY.md). plan() is pure; gather() reads GitHub and git;
// apply() acts through the tracker and the org registry.
import { storyOf, sprintOf, releaseBranch, setting } from "./conventions.mjs";

/**
 * Inputs:
 *   releases:  [{ sprint, inMain }]            open release branches and whether main now contains them
 *   mergedIntoRelease: { [sprint]: [headRefName] }   PR heads merged into each release branch
 *   sprintStories: { [sprint]: [{ key, state }] }    stories the tracker holds for the sprint
 *   mergedIntoMain: [{ number, headRefName }]  PRs merged straight into main since the previous release
 * Output: { sprint, ship[], carry[], hotfix[{key, pr}], deleteOrgs[], deleteBranch }
 */
export function plan({ releases = [], mergedIntoRelease = {}, sprintStories = {}, mergedIntoMain = [] }) {
  const shipping = releases.filter((r) => r.inMain).map((r) => r.sprint);
  if (shipping.length > 1) throw new Error(`More than one sprint is in main at once: ${shipping.join(", ")}`);
  const sprint = shipping[0] || null;
  const out = { sprint, ship: [], carry: [], hotfix: [], deleteOrgs: [], deleteBranch: null };
  if (sprint) {
    const shipped = new Set((mergedIntoRelease[sprint] || []).map(storyOf).filter(Boolean));
    for (const s of sprintStories[sprint] || []) {
      if (shipped.has(s.key)) { out.ship.push(s.key); out.deleteOrgs.push(`story:${s.key}`); }
      else if (s.state !== "CLOSED") out.carry.push(s.key);
    }
    out.deleteOrgs.push(`sprint:${sprint}`, `uat:${sprint}`);   // the UAT stand-in, if one was made (no-op otherwise)
    out.deleteBranch = releaseBranch(sprint);
  }
  for (const pr of mergedIntoMain) {
    if (sprintOf(pr.headRefName)) continue;            // the release PR itself
    const key = storyOf(pr.headRefName);
    if (!key || out.ship.includes(key)) continue;      // pipeline-maintenance PRs have no story
    out.hotfix.push({ key, pr: pr.number });
    out.deleteOrgs.push(`story:${key}`);
  }
  return out;
}

export async function gather({ gh, git }, tracker, { sha = "HEAD", previous = null } = {}) {
  git(["fetch", "-q", "--prune", "origin", "+refs/heads/release/*:refs/remotes/origin/release/*", "--tags"], { allowFail: true });
  const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/release/"]).split("\n").filter(Boolean);
  // A sprint has shipped when its release PR merged into main. (Being an ancestor of main is not enough:
  // a freshly cut release branch with nothing merged yet is one, and a hotfix must not close that sprint.)
  const releases = branches.map((b) => {
    const sprint = sprintOf(b);
    const merged = gh(["pr", "list", "--head", releaseBranch(sprint), "--base", "main", "--state", "merged", "--json", "number"]) || [];
    return { sprint, inMain: merged.length > 0 };
  });
  const mergedIntoRelease = {}, sprintStories = {};
  for (const { sprint, inMain } of releases) {
    if (!inMain) continue;
    mergedIntoRelease[sprint] = (gh(["pr", "list", "--base", releaseBranch(sprint), "--state", "merged", "--limit", "200", "--json", "headRefName"]) || []).map((p) => p.headRefName);
    sprintStories[sprint] = await tracker.sprintStories(sprint);
  }
  // New in this release = merged into main, in the shipped SHA, and not already in the previous release's tag (both
  // given by the release run: main may have moved on since, and HEAD^ is not the previous release).
  const prevTag = previous;
  const inRef = (oid, ref) => git(["merge-base", "--is-ancestor", oid, ref], { allowFail: true }) !== null;
  const mergedIntoMain = (gh(["pr", "list", "--base", "main", "--state", "merged", "--limit", "100", "--json", "number,headRefName,mergeCommit"]) || [])
    .filter((p) => p.mergeCommit?.oid && inRef(p.mergeCommit.oid, sha) && !(prevTag && inRef(p.mergeCommit.oid, prevTag)));
  return { releases, mergedIntoRelease, sprintStories, mergedIntoMain };
}

/** Safe to run again after a partial failure: closed stories, deleted orgs and branches are skipped. */
export async function apply(p, { tag, tracker, orgs, git, gh, cards = null, log = console.error }) {
  for (const key of p.ship) if ((await tracker.story(key)).state === "OPEN") await tracker.done(key, `Shipped in release ${p.sprint} (${tag}).`);
  for (const key of p.carry) await tracker.carry(key, p.sprint, `Not finished in sprint ${p.sprint}; carried over to the next sprint.`);
  // PRs still aimed at the release branch would be closed or retargeted at main by GitHub when it is deleted.
  if (p.deleteBranch && gh) {
    for (const pr of gh(["pr", "list", "--base", p.deleteBranch, "--state", "open", "--limit", "1000", "--json", "number,headRefName"]) || []) {
      gh(["pr", "close", String(pr.number), "--comment", `Sprint ${p.sprint} shipped without this change, so it is carried over. Its branch \`${pr.headRefName}\` is kept: start the story again in the next sprint.`]);
      log(`closed carried-over PR #${pr.number}`);
    }
  }
  for (const { key, pr } of p.hotfix) {
    const s = await tracker.story(key);
    if (s.state === "OPEN") await tracker.done(key, `Hotfix released in ${tag} (PR #${pr}).`);
    else await tracker.comment(key, `Hotfix released in ${tag} (PR #${pr}).`);   // closed early by an old "Closes #" PR: still say so
  }
  // a spec is done when its stories are: close it, say where it shipped (its card would otherwise say "work on it")
  const done = new Set([...p.ship, ...p.hotfix.map((h) => h.key)].map(String));
  const specs = new Map();   // spec -> its stories that shipped now
  for (const key of done) { const m = String((await tracker.story(key).catch(() => ({})))?.body || "").match(/Part of spec #(\d+)/); if (m) specs.set(m[1], [...(specs.get(m[1]) || []), key]); }
  for (const [n, mine] of specs) {
    const open = (gh?.(["issue", "list", "--state", "open", "--search", `"Part of spec #${n}" in:body`, "--json", "number"], { allowFail: true }) || []).map((i) => String(i.number)).filter((k) => !done.has(k));
    if (open.length) { log(`spec #${n} stays open: stories ${open.map((k) => `#${k}`).join(", ")} have not shipped`); continue; }
    if ((await tracker.story(n)).state === "OPEN") await tracker.done(n, `Shipped: every story of this spec is in production (${tag}).`);
    await cards?.newStory(n, { spec: true, stage: "shipped", stories: mine, tag });
  }
  if (p.sprint) await tracker.closeSprint(p.sprint);
  for (const target of p.deleteOrgs) {
    try { orgs.remove(target); } catch (e) { log(`could not delete ${target}: ${e.message}`); }
  }
  if (p.deleteBranch) {
    // git first; then the API (a shallow or credential-less checkout cannot push). A branch left behind blocks the
    // next sprint-start ("still open"), so a failure is said out loud, never swallowed.
    const exists = () => git(["ls-remote", "--exit-code", "--heads", "origin", p.deleteBranch], { allowFail: true }) !== null;
    git(["push", "origin", "--delete", p.deleteBranch], { allowFail: true });
    if (exists() && gh) gh(["api", "-X", "DELETE", `repos/${process.env.GH_REPO || process.env.GITHUB_REPOSITORY}/git/refs/heads/${p.deleteBranch}`], { allowFail: true });
    if (exists()) log(`::warning::could not delete ${p.deleteBranch}; delete it by hand before the next sprint-start`);
    else log(`deleted ${p.deleteBranch}`);
  }
  log(`close-out: sprint=${p.sprint || "none"} shipped=[${p.ship}] carried=[${p.carry}] hotfixes=[${p.hotfix.map((h) => h.key)}]`);
}

/** The release PR's body: what merged into the sprint and the sprint's stories. */
export async function releaseNotes({ gh }, tracker, sprint) {
  const merged = gh(["pr", "list", "--base", releaseBranch(sprint), "--state", "merged", "--limit", "200", "--json", "number,title,author"]) || [];
  const stories = await tracker.sprintStories(sprint);
  return [
    `## Release ${sprint}`, "", "### Merged changes",
    ...(merged.length ? merged.map((p) => `- #${p.number} ${p.title} (@${p.author.login})`) : ["none"]), "",
    "### Sprint stories", ...(stories.length ? stories.map((s) => `- #${s.key} ${s.title}${s.state === "CLOSED" ? " (closed)" : ""}`) : ["none"]), "",
    "### How this ships",
    "- CI and the staging regression must be green on the release branch.",
    ...(String(setting("UAT_ENABLED")).toLowerCase() === "true" ? ["- It deploys to UAT: test it there (the card links it and can email you a login), then tick **UAT passed** on the card."] : []),
    "- Approve this PR (Files changed > Review changes > Approve). The gate validates it against production, merges it, and the release job quick-deploys exactly what was validated.",
  ].join("\n");
}
