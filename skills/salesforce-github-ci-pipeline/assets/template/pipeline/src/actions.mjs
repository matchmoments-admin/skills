// Actions: what a person can make the pipeline do from a story or a pull request (see CONTEXT.md: Action). One
// catalogue behind two doors: a tick box on the card (the card offers only the actions that make sense now) and a
// comment command (/plan, /start, /build, /review, /fix, /test, /ship, /uat-pass ...). Both doors end in perform(), so
// a tick and a command do exactly the same thing. Who may act is checked here too: write access, never a bot.
//
// Effects: a label (applied as the pipeline App, so its workflow starts), a trusted commit status from an agent-free job
// (the sign-off and UAT verdicts the gate reads), or a workflow dispatch.
import { STATUS } from "./gate.mjs";
import { storyOf } from "./conventions.mjs";

export const ACTIONS = {
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
  gate: { label: "🔁 Check again (re-run the gate)", on: "pr" },
  ci: { label: "🔁 Re-run CI", on: "pr" },
  staging: { label: "🔁 Re-run the staging regression", on: "pr" },
  uat: { label: "🔁 Deploy this commit to UAT again", on: "pr" },
};
// the comment commands, and the action each one is
const COMMANDS = { "/plan": "plan", "/start": "start", "/build": "build", "/hotfix": "hotfix", "/review": "review", "/fix": "fix",
  "/test": "test", "/ui-test": "ai-test", "/ship": "ship", "/uat-pass": "uat-pass", "/uat-fail": "uat-fail", "/gate": "gate", "/ci": "ci",
  "/staging": "staging", "/uat": "uat", "/help": "help" };

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
    : "**On a story:** `/plan` Claude proposes the build and asks its questions · `/start` creates its branch and scratch org · `/build` has Claude build it · `/hotfix` starts it as an urgent production fix. Or tick the boxes on the card.";
}

/**
 * The whole action, as both workflows run it: check the person, work out what they asked for (a command, or the boxes
 * ticked between two versions of the card), do it, say anything that needs saying, and refresh the card (clearing the
 * box). deps: { io, host, cards, log, appToken }. Returns a one-line summary.
 */
export async function act({ number, isPr, who, whoType, command: text = null, before = null, after = null }, { io, host, cards, log = () => {}, appToken }) {
  const permission = host.api("GET", `repos/${host.repo}/collaborators/${who}/permission`)?.permission;
  if (!mayAct({ login: who, type: whoType, permission })) return `@${who} cannot act here (${permission || "no access"})`;
  const requested = text !== null ? [command(text)].filter(Boolean) : ticked(before, after).map((id) => ({ id, arg: "" }));
  if (!requested.length) return "no action";
  const pr = isPr ? io.gh(["pr", "view", String(number), "--json", "number,headRefName,headRefOid,baseRefName,state"]) : null;
  const appGh = (args, o) => io.gh(args, { ...o, env: { GH_TOKEN: appToken || process.env.GH_TOKEN } });
  const inUat = (sha) => io.ghPages(`repos/${host.repo}/commits/${sha}/statuses?per_page=100`)
    .some((s) => s.context === STATUS.uat && s.creator?.login === "github-actions[bot]" && String(s.description || "").startsWith("In UAT"));
  for (const { id, arg } of requested) {
    if (id === "help") { io.gh(["issue", "comment", String(number), "--body", help(isPr)]); continue; }
    const r = perform(id, arg, { number, isPr, pr }, who, { host, appGh, gh: io.gh, inUat });
    if (r.said) io.gh(["issue", "comment", String(number), "--body", r.said]);
    if (r.done) { log(r.done); host.record("stage", { story: storyOf(pr?.headRefName || "") || (isPr ? undefined : String(number)), pr: isPr ? Number(number) : undefined, what: `${id} by @${who}`, state: "running" }); }
  }
  if (isPr) await cards.refreshPr(number); else await cards.refresh(String(number)).catch(() => {});
  return requested.map((r) => r.id).join(", ");
}
