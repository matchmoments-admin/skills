// Actions: what a person can make the pipeline do from a story or a pull request (see CONTEXT.md: Action). One
// catalogue behind two doors: a tick box on the card (the card offers only the actions that make sense now) and a
// comment command (/plan, /start, /build, /review, /fix, /test, /ship, /uat-pass ...). Both doors end in perform(), so
// a tick and a command do exactly the same thing. Who may act is checked here too: write access, never a bot.
//
// Effects: a label (applied as the pipeline App, so its workflow starts), a trusted commit status from an agent-free job
// (the sign-off and UAT verdicts the gate reads), or a workflow dispatch.
import { STATUS } from "./gate.mjs";
import { storyOf, nextSprint, sprintOfMilestoneTitle } from "./conventions.mjs";

export const ACTIONS = {
  spec: { label: "📝 Write the spec with Claude: the problem, the solution, user stories, decisions, open questions", on: "issue", adds: ["ai:spec"], flag: "plan" },
  tickets: { label: "🧩 Split it into stories with Claude (you approve the breakdown before anything is created)", on: "issue", adds: ["ai:tickets"], flag: "plan" },
  "create-stories": { label: "✅ Create these stories", on: "issue" },
  plan: { label: "🧭 Plan it with Claude: it proposes the build and asks its questions", on: "issue", adds: ["ai:plan"], flag: "plan" },
  start: { label: "▶️ Start: create the branch and a production-shaped scratch org", on: "issue", adds: ["start"] },
  build: { label: "🤖 Build it with Claude", on: "issue", adds: ["ai:implement"], flag: "implement" },
  hotfix: { label: "🚑 Start it as an urgent production fix", on: "issue", adds: ["hotfix", "start"] },
  review: { label: "🔍 Run the AI review again", on: "pr", adds: ["ai:review"], flag: "review" },
  fix: { label: "🛠 Fix the review findings and failed checks with Claude", on: "pr", adds: ["ai:fix"], flag: "fix" },
  "ai-test": { label: "🧪 Have Claude write and run the UI test", on: "pr", adds: ["ai:test"], flag: "uiTest" },
  test: { label: "🧪 Run the committed UI test", on: "pr", adds: ["test"] },
  ship: { label: "🚀 Sign off: merge it into the sprint when everything is green", on: "pr" },
  "uat-pass": { label: "✅ UAT passed: tested in UAT, ready for production", on: "pr" },
  "uat-login": { label: "🔑 Send me a UAT login (Salesforce emails you a link to set a password)", on: "pr" },
  gate: { label: "🔁 Check again (re-run the gate)", on: "pr" },
  "fix-story": { label: "🛠 Open a fix story for the failing tests (it goes into the sprint; Plan / Start / Build it like any story)", on: "pr" },
  "org-login": { label: "🔑 Send me a login to this story's scratch org (to see the feature yourself)", on: "pr" },
  sprint: { label: "🏁 Start the next sprint (release branch, staging org, milestone)", on: "any" },
  "release-cut": { label: "📦 Cut the sprint's release (the release PR: staging, UAT, approval, production)", on: "any" },
  ci: { label: "🔁 Re-run CI", on: "pr" },
  staging: { label: "🔁 Re-run the staging regression", on: "pr" },
  uat: { label: "🔁 Deploy this commit to UAT again", on: "pr" },
};
// the comment commands, and the action each one is
const COMMANDS = { "/spec": "spec", "/tickets": "tickets", "/plan": "plan", "/start": "start", "/build": "build", "/hotfix": "hotfix", "/review": "review", "/fix": "fix",
  "/test": "test", "/ui-test": "ai-test", "/ship": "ship", "/uat-pass": "uat-pass", "/uat-fail": "uat-fail", "/gate": "gate", "/ci": "ci",
  "/staging": "staging", "/uat": "uat", "/fix-story": "fix-story", "/login": "org-login", "/sprint-start": "sprint", "/release-cut": "release-cut", "/help": "help" };

const MARK = (id) => `<!-- act:${id} -->`;

/** A comment's command: { id, arg } (e.g. /uat-fail <why>), or null. */
export function command(body) {
  const line = String(body || "").split("\n")[0].trim();
  const [word, ...rest] = line.split(/\s+/);
  const id = COMMANDS[word?.toLowerCase()];
  return id ? { id, arg: rest.join(" ").slice(0, 100) } : null;
}

/** The tick boxes for these actions (unticked; each line carries its action's marker). */
export function checklist(ids) {
  if (!ids.length) return [];
  return ["**Do it from here:** tick a box; the pipeline does it and the card updates.", "", ...ids.map((id) => `- [ ] ${ACTIONS[id].label} ${MARK(id)}`)];
}

/** Which boxes a person ticked: lines that went from [ ] to [x] between two versions of a card. */
export function ticked(before, after) {
  const box = (text, checked) => new Set([...String(text || "").matchAll(new RegExp(`^- \\[${checked ? "[xX]" : " "}\\].*<!-- act:([a-z-]+) -->`, "gm"))].map((m) => m[1]));
  const was = box(before, false), now = box(after, true);
  return [...now].filter((id) => was.has(id) && ACTIONS[id]);
}

/** Only actions whose AI switch is on (ai = aiFeatures()). */
export const allowed = (ids, ai = {}) => ids.filter((id) => ACTIONS[id] && (!ACTIONS[id].flag || ai[ACTIONS[id].flag]));

/** May this person act? Write access (admin, maintain or write), and never a bot. */
export function mayAct({ login, type, permission }) {
  return type !== "Bot" && !/\[bot\]$/.test(String(login || "")) && ["admin", "maintain", "write"].includes(permission);
}

/**
 * Do it. where: { number, isPr, pr?: { headRefName, headRefOid, baseRefName } }; who: the login (for the record).
 * deps: { host, appGh (gh as the pipeline App), gh (gh with the Actions token), inUat(sha) }. Returns what was done.
 */
export function perform(id, arg, where, who, { host, appGh, gh, inUat }) {
  const a = ACTIONS[id];
  if (id === "uat-fail" || id === "uat-pass") {
    const pr = where.pr;
    if (!pr || !/^release\//.test(pr.headRefName) || pr.baseRefName !== "main") return { said: "UAT sign-off applies to release pull requests only." };
    if (!inUat(pr.headRefOid)) return { said: `UAT is not running \`${pr.headRefOid.slice(0, 7)}\` (the release PR's latest commit) yet: it redeploys after the staging regression. Sign off when **Ready for UAT** names this commit.` };
    const pass = id === "uat-pass";
    host.status(pr.headRefOid, STATUS.uat, pass ? "success" : "failure", pass ? `Signed off in UAT by @${who}` : `UAT failed (@${who}): ${arg || "see the comments"}`);
    host.dispatch("gate.yml", { pr: where.number });
    return { done: pass ? `UAT signed off by @${who} on ${pr.headRefOid.slice(0, 7)}` : `UAT marked failed by @${who}` };
  }
  if (!a) return { said: null };
  if (id === "sprint") { host.dispatch("sprint-start.yml", { sprint: arg || where.nextSprint }); return { done: `starting sprint ${arg || where.nextSprint}` }; }
  if (id === "release-cut") { host.dispatch("release-cut.yml"); return { done: "cutting the sprint's release" }; }
  if (a.on === "pr" && !where.isPr) return { said: `\`${id}\` works on a pull request.` };
  if (a.on === "issue" && where.isPr) return { said: `\`${id}\` works on the story (the issue).` };
  if (id === "ship") {
    const pr = where.pr;
    if (pr.baseRefName === "main") return { said: `Pull requests into main need a GitHub approval: **[Approve here](${host.repoUrl}/pull/${where.number}/files)** (Review changes > Approve).` };
    host.status(pr.headRefOid, STATUS.signoff, "success", `Signed off by @${who}`);
    host.dispatch("gate.yml", { pr: where.number });
    return { done: `signed off by @${who} on ${pr.headRefOid.slice(0, 7)}` };
  }
  if (id === "gate") { host.dispatch("gate.yml", { pr: where.number }); return { done: "re-running the gate" }; }
  if (id === "ci") { host.dispatch("ci.yml", { ref: where.pr.headRefName }, where.pr.headRefName); return { done: "re-running CI" }; }
  if (id === "staging") { host.dispatch("staging-deploy.yml", {}, where.pr.headRefName); return { done: "re-running the staging regression" }; }
  if (id === "uat") { host.dispatch("uat-deploy.yml", { pr: where.number, again: "true" }); return { done: "deploying to UAT again" }; }
  if (id === "uat-login") { host.dispatch("uat-login.yml", { pr: where.number, who }); return { done: `sending @${who} a UAT login` }; }
  if (id === "org-login") { host.dispatch("uat-login.yml", { pr: where.number, who, target: where.pr.headRefName }); return { done: `sending @${who} a login to ${where.pr.headRefName}` }; }
  if (id === "fix-story") {
    // a sprint story for what failed on the release (the failing checks' own lists), so it goes through the normal flow
    const failed = (gh(["api", `repos/${host.repo}/commits/${where.pr.headRefOid}/check-runs?per_page=100`]) || {}).check_runs?.filter((c) => c.conclusion === "failure") || [];
    const lines = failed.flatMap((c) => String(c.output?.text || "").split("\n").filter((l) => /^\| (test|component|coverage) \|/.test(l)).slice(0, 20));
    const body = ["### Summary", "", `Release PR #${where.number} cannot ship: ${failed.map((c) => c.name).join(", ") || "a check"} failed. Fix what is listed below on the sprint branch.`, "",
      "### Acceptance criteria", "", "- Every test listed under Out of scope's \"What failed\" passes in the staging regression", "- The production validation passes on the release PR", "- No production code changes beyond what the failures need", "",
      "### Access", "", "No change", "", "### Where to see it in the UI", "", `The release card on #${where.number} shows the staging regression and production validation green.`, "",
      "### Out of scope", "", "Anything not needed to make the listed checks pass.", "", "What failed:", "", "| | what | problem |", "|---|---|---|", ...lines].join("\n");
    const url = appGh(["issue", "create", "--title", `Story: Fix the release ${where.pr.headRefName.replace(/^release\//, "")}: failing checks`, "--label", "feature", "--body", body]);
    return { said: `Opened ${url}: its card offers Plan / Start / Build. When it merges, staging and UAT run again on the release.` };
  }
  // labels start the action's own workflow; remove first, since adding a label that is already there fires nothing
  for (const l of a.adds || []) {
    appGh(["issue", "edit", String(where.number), "--remove-label", l], { allowFail: true });
    appGh(["issue", "edit", String(where.number), "--add-label", l]);
  }
  return { done: `${id} started by @${who}` };
}

/** The /help reply. */
export function help(isPr) {
  return isPr
    ? "**On a pull request:** `/review` AI review · `/fix` AI fixes the findings · `/test` runs the UI test (`/ui-test`: Claude writes it) · `/ship` signs off (story PRs into the sprint; PRs into main need **Approve**) · `/gate` checks again · `/ci` re-runs CI · on a release PR `/uat-pass`, `/uat-fail <why>`, `/uat`, `/staging`. Or tick the boxes on the card."
    : "**On a story:** `/plan` Claude proposes the build and asks its questions · `/start` creates its branch and scratch org · `/build` has Claude build it · `/hotfix` starts it as an urgent production fix. **On a spec (bigger work):** `/spec` Claude writes the spec · `/tickets` splits it into stories for you to approve. Or tick the boxes on the card.";
}

/**
 * The whole action, as both workflows run it: check the person, work out what they asked for (a command, or the boxes
 * ticked between two versions of the card), do it, say anything that needs saying, and refresh the card (clearing the
 * box). deps: { io, host, cards, log, appToken }. Returns a one-line summary.
 */
export async function act({ number, isPr, who, whoType, command: text = null, before = null, after = null, commentId = null }, { io, host, cards, log = () => {}, appToken, createStories = null }) {
  const permission = host.api("GET", `repos/${host.repo}/collaborators/${who}/permission`)?.permission;
  if (!mayAct({ login: who, type: whoType, permission })) return `@${who} cannot act here (${permission || "no access"})`;
  const requested = text !== null ? [command(text)].filter(Boolean) : ticked(before, after).map((id) => ({ id, arg: "" }));
  if (!requested.length) return "no action";
  const pr = isPr ? io.gh(["pr", "view", String(number), "--json", "number,headRefName,headRefOid,baseRefName,state"]) : null;
  const sprints = requested.some((r) => r.id === "sprint") ? (io.gh(["api", `repos/${host.repo}/milestones?state=all&per_page=100`]) || []).map((m) => sprintOfMilestoneTitle(m.title)).filter(Boolean) : [];
  const appGh = (args, o) => io.gh(args, { ...o, env: { GH_TOKEN: appToken || process.env.GH_TOKEN } });
  const inUat = (sha) => io.ghPages(`repos/${host.repo}/commits/${sha}/statuses?per_page=100`)
    .some((s) => s.context === STATUS.uat && s.creator?.login === "github-actions[bot]" && String(s.description || "").startsWith("In UAT"));
  for (const { id, arg } of requested) {
    if (id === "help") { io.gh(["issue", "comment", String(number), "--body", help(isPr)]); continue; }
    if (id === "create-stories") {   // agent-free: the approved breakdown (this comment) becomes Story issues
      const r = createStories({ gh: appGh, repo: host.repo, spec: number, body: after, log });
      io.gh(["api", "-X", "PATCH", `repos/${host.repo}/issues/comments/${commentId}`, "-f", `body=${r.body}`]);
      host.record("stage", { story: String(number), what: r.already ? "stories already created" : `created stories ${r.numbers.map((n) => `#${n}`).join(" ")} by @${who}`, state: "running" });
      await cards.newStory(String(number), { spec: true, stage: "created", stories: r.numbers });
      continue;
    }
    const r = perform(id, arg, { number, isPr, pr, nextSprint: nextSprint(sprints) }, who, { host, appGh, gh: io.gh, inUat });
    if (r.said) io.gh(["issue", "comment", String(number), "--body", r.said]);
    if (r.done) { log(r.done); host.record("stage", { story: storyOf(pr?.headRefName || "") || (isPr ? undefined : String(number)), pr: isPr ? Number(number) : undefined, what: `${id} by @${who}`, state: "running" }); }
  }
  // the card again (the box cleared, the action's workflow takes over the Now line); a spec's comments are not cards
  const onCard = (after || "").includes("<!-- pipeline:story-card -->") || text !== null;
  if (onCard && !requested.every((r) => ["spec", "tickets", "create-stories"].includes(r.id))) {
    if (isPr) await cards.refreshPr(number); else await cards.refresh(String(number)).catch(() => {});
  } else if (commentId && after && !requested.some((r) => r.id === "create-stories")) {
    io.gh(["api", "-X", "PATCH", `repos/${host.repo}/issues/comments/${commentId}`, "-f", `body=${after.replace(/^- \[[xX]\]/gm, "- [ ]")}`]);   // untick: the workflow said what it does
  }
  return requested.map((r) => r.id).join(", ");
}
