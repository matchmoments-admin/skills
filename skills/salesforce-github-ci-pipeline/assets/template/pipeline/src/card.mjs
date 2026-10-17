// The story card: one comment on the story (GitHub issue or Jira ticket), edited in place at every stage, that tells
// a non-technical person where the story is, what is next, and links straight to it. storyCard() is pure: built from the
// same facts and decision the gate uses (gate.gather / gate.evaluate), so the card and the gate cannot disagree.
// storyCards() puts it on the story and its PR (and moves the board), through the code host and the tracker.
import { CHECKS, storyBranch, aiFeatures, context, setting, sprintOf, storyOf } from "./conventions.mjs";
import { latestCheck, approval, requiredVerdicts, evaluate, route, standing, checkState, STATUS } from "./gate.mjs";
import { planContext, planState } from "./plan.mjs";
import { stageOf, moveCard } from "./board.mjs";
import { checklist, allowed } from "./actions.mjs";
import { notice, slackNotifier } from "./notify.mjs";
import { needs as whoIsNeeded } from "./journey.mjs";

export const CARD_TITLE = "Pipeline status";
export const CARD_MARK = "<!-- pipeline:story-card -->";

const ICON = { done: "✅", running: "⏳", waiting: "⬜", failed: "❌", off: "➖" };
// the gate's own reading of a check (gate.checkState), in the card's words
const stateOf = (c) => ({ passed: "done", failed: "failed", missing: "waiting", running: "running" })[checkState(c)];

/**
 * input: { key, repoUrl, branch, base, ai, pr?, facts?, decision? }
 *   pr/facts/decision are absent before the PR exists. facts = gate.gather(), decision = gate.evaluate(facts).
 * returns markdown.
 */
export function storyCard({ key, repoUrl, branch, base, ai = {}, pr = null, facts = null, decision = null, shipped = null, activity = null, planned = false, releasePr = null }) {
  const now = activityLine(activity);
  const rows = [];
  const prUrl = pr ? `${repoUrl}/pull/${pr.number}` : null;
  const branchLink = pr?.state === "MERGED" ? `\`${branch}\`` : `[\`${branch}\`](${repoUrl}/tree/${encodeURIComponent(branch)})`;   // merged branches are deleted
  if (planned) rows.push(["done", "Plan agreed", "the **Build plan** comment on this story, with the answers to it, is part of the spec"]);
  rows.push(["done", "Branch and scratch org", `${branchLink} from \`${base}\`; org \`${branch}\` (production's shape, its customisations and test data)`]);

  let next;
  if (!pr) {
    rows.push(["waiting", "Build", ai.implement ? `build on ${branchLink} and open a PR into \`${base}\`, or comment **/build** on this story` : `build on ${branchLink} and open a PR into \`${base}\``]);
    next = ai.implement ? "Build it, or tick **Build it with Claude** below." : `Build it on ${branchLink} and open a pull request.`;
    // an admin can build it by clicking in the story's org, then bring the changes in (story-retrieve)
    return render(key, next, rows, now, allowed([...(planned ? [] : ["plan"]), "build", "org-login-admin", "retrieve", "org-login"], ai));
  }

  const merged = pr.state === "MERGED";
  const st = facts ? standing(facts) : null;   // what counts on the head: the gate's own reading of every result
  rows.push(["done", "Pull request", `[#${pr.number}](${prUrl})${pr.title ? ` ${pr.title}` : ""}`]);
  const ci = [CHECKS.static, CHECKS.apex].map((n) => stateOf(st?.checks[n]?.conclusion || "missing"));
  const ciState = ci.includes("failed") ? "failed" : ci.every((s) => s === "done") ? "done" : "running";
  // the live "Salesforce tests" check (pipeline/src/tests.mjs) says how far the tests are, while they run
  const live = (facts?.checkRuns || []).filter((c) => c.name === "Salesforce tests").sort((x, y) => String(x.started_at).localeCompare(String(y.started_at))).pop();
  const liveTitle = live?.output?.title ? ` (${live.output.title})` : "";
  rows.push([ciState, "CI (tests in a scratch org)", ciState === "failed" ? `[see what failed](${prUrl}/checks)${liveTitle}` : ciState === "done" ? `static checks, deploy and tests passed${liveTitle}` : `[running](${prUrl}/checks)${liveTitle}`]);

  const ctx = { ...(facts || {}), head: pr.headRefOid };
  for (const v of requiredVerdicts(facts || {}, key)) {
    const { state: got, url } = (v.context === STATUS.review ? st?.review : st?.ui) || { state: "missing" };
    const label = v.context === STATUS.review ? "AI review" : "UI test";
    const shots = url && /#issuecomment-|\/browse\//.test(url) ? `: **[see the screenshots](${url})**` : "";   // UI evidence (UI_EVIDENCE)
    if (got === "success") rows.push(["done", label, v.context === STATUS.review ? "passed" : `passed in the scratch org${shots}`]);
    else if (["failure", "error"].includes(got)) rows.push(["failed", label, v.context === STATUS.review ? `asks for changes: [read the comments](${prUrl})` : `[see the report](${prUrl}/checks)`]);
    else if (v.required) rows.push([got === "stale" ? "waiting" : "running", label, got === "stale" ? `run it again (${v.how})` : `waiting (${v.how})`]);
    else rows.push(["off", label, v.context === STATUS.review ? "off: your approval is the review" : "not needed"]);
  }

  const a = st ? st.approval : approval(ctx, { signOff: base !== "main" });   // the route's rule, as the gate applies it
  const approved = merged || a.ok;
  const signOff = base === "main" ? "(Review changes > Approve)" : "(Review changes > Approve), or tick **Sign off** below";
  rows.push([approved ? "done" : "waiting", "Approval", approvalText(a, { merged, prUrl, how: signOff, approver: facts?.storyApprover })]);
  rows.push([shipped ? "done" : merged ? "done" : "waiting", "Merged", merged ? `into \`${base}\`; the staging regression runs next` : "merges by itself when everything above is green"]);
  rows.push([shipped ? "done" : "waiting", "In production", shipped ? `released in [${shipped.tag}](${shipped.url})` : base === "main" ? "ships right after the merge" : "ships with the sprint's release"]);

  if (shipped) next = `Done: live in production since [${shipped.tag}](${shipped.url}).`;
  else if (merged) next = base === "main" ? "Nothing to do: it is shipping to production now." : "Nothing to do: it ships with the sprint release.";
  else if (pr.state === "CLOSED") next = "The pull request was closed without merging (a carried-over story is closed when its sprint ships). To work on it again, tick **Start** below: a new branch and org from the current sprint.";
  else {
    const failed = rows.find((r) => r[0] === "failed");
    const waiting = rows.find((r) => r[0] === "waiting" || r[0] === "running");
    if (failed) next = failed[1].startsWith("CI") ? `Fix the failing tests ([see what failed](${prUrl}/checks))${ai.fix ? ": tick **Fix … with Claude** below, or push a fix" : `, then push to ${branchLink}`}.`
      : failed[1] === "AI review" ? `Address the review comments on [#${pr.number}](${prUrl})${ai.fix ? ", or tick **Fix … with Claude** below" : ""}.`
      : `Fix the UI test failure ([report](${prUrl}/checks))${ai.fix ? ": tick **Fix … with Claude**, or fix it yourself and tick **Run the UI test**" : ", then tick **Run the UI test** below"}.`;
    else if (decision?.other?.length) next = `Blocked: ${decision.other[0]}.`;   // what no row shows (a draft, conflicts, a blocker...)
    else if (decision?.mergeable) next = "Nothing to do: merging now.";
    else if (waiting && waiting[1] !== "Approval" && waiting[0] === "running") next = `Waiting for ${waiting[1].toLowerCase()}. You can approve now: **[Approve here](${prUrl}/files)**.`;
    else if (waiting && waiting[1] === "Approval") next = `**[Approve here](${prUrl}/files)**: everything else is green.`;
    else next = waiting ? `${waiting[1]}: ${waiting[2]}` : "Waiting.";
  }
  const mergedActions = merged && !shipped && base !== "main" && !releasePr ? ["release-cut"] : [];   // nobody has cut the release yet
  if (mergedActions.length) next = `${next} When the sprint's stories are merged, tick **Cut the sprint's release** below.`;
  // who the story needs now (journey.needs, from Standing): its approver once everything else passed (notifyNeeds
  // mentions them once)
  const needs = st && !merged ? whoIsNeeded(st, facts, { decision, prUrl, key }) : null;
  return render(key, next, rows, now, merged ? mergedActions : pr.state === "CLOSED" ? ["start"] : storyActions(rows, { ai, base, ci: ciState, decision }), { needs });
}

/** The Approval row: who approved, or who should and how; a refused approval says why (approval() in gate.mjs). */
function approvalText(a, { merged, prUrl, how, approver, team = [] }) {
  if (merged) return "approved";
  if (a.ok) return `approved by ${a.by.map((l) => `@${l}`).join(", ")}`;
  const who = approver ? `@${approver} (the approver): ` : team.length ? `an approver (${team.map((l) => `@${l}`).join(", ")}): ` : "";
  return `${who}**[Approve here](${prUrl}/files)** ${how}${a.refused.length ? `. Not counted: ${a.refused.map((r) => r.why).join("; ")}` : ""}`;
}

/** The boxes a story PR's card offers, from where it stands (pure). */
function storyActions(rows, { ai, base, ci }) {
  const at = (stage) => rows.find((r) => r[1] === stage)?.[0];
  const ids = [];
  if (ci === "failed") ids.push("fix", "ci");
  if (at("AI review") === "failed") ids.push("fix", "review", "review-ok");
  else if (["waiting", "running"].includes(at("AI review"))) ids.push("review");
  if (["failed", "waiting"].includes(at("UI test"))) ids.push(ai.uiTest ? "ai-test" : "test");
  if (at("UI test") === "failed") ids.push("fix");   // the fixer reads the Playwright error
  if (at("Approval") === "waiting" && base !== "main") ids.push("ship");
  if (at("Approval") === "waiting") ids.push("org-login");   // the approver can see the feature in the story's org
  ids.push("org-login-admin", "retrieve");   // a change made by clicking in the story's org comes in as a commit
  return allowed([...new Set(ids)], ai);
}

/** The card on a story before /start (or a spec issue: where the spec stands; stage: new | writing | spec | story | shipped;
 *  questions: the spec's open questions, as written, or how many). */
export function newStoryCard({ key, ai = {}, spec = false, stage = "new", stories = [], tag = null, questions: asked = 0, plan = null }) {
  if (spec) {
    const list = Array.isArray(asked) ? asked : [], questions = Array.isArray(asked) ? asked.length : asked;
    const story = stories[0];
    const made = ["story", "shipped"].includes(stage);
    const asks = questions ? `${questions === 1 ? "1 open question" : `${questions} open questions`}` : "";
    const specRow = { new: ["waiting", "not written yet"], writing: ["running", "Claude is writing it (a few minutes): wait for it"] }[stage]
      || ["done", `written: the **Spec** comment below${asks ? `, with **${asks}**` : ""}`];
    const rows = [[specRow[0], "Spec", specRow[1]],
      [made ? "done" : "waiting", "Story", made ? `#${story}${stage === "story" ? ": its card offers **Plan** and **Start**" : ""}` : "not made yet: tick **Make it a story** above when the spec is right"],
      ...(stage === "shipped" ? [["done", "In production", `released in ${tag}`]] : [])];
    // the boxes are on the card itself (the stage icons below are not boxes): rewrite with the comments, or make the story
    const change = "To change it, reply with your answers or changes in a comment, then tick **Write the spec with Claude** above (or comment `/spec`).";
    const next = { new: ai.plan ? "Tick **Write the spec with Claude** below; then answer its questions." : "Write the spec in a comment (problem, solution, user stories, decisions), then open a story for it.",
      writing: "Nothing yet: Claude is writing the spec. This card updates when it is done.",
      spec: `Read the **Spec** comment below. ${asks ? `It has **${asks}**. ` : ""}${change} When it is right, tick **Make it a story** above${asks ? " (the spec's guesses then stand for any question you leave)" : ""}.`,
      story: `Done: the spec is story #${story}. Work on it there (Plan, Start, Build).`,
      shipped: `Done: shipped in ${tag} (story ${stories.map((n) => `#${n}`).join(", ")}).` }[stage];
    const boxes = { new: ["spec"], spec: ["spec", questions ? "story-anyway" : "story"] }[stage] || [];
    // the questions themselves, folded (Slack's answer box shows them too: notify.buttons)
    const shown = stage === "spec" && list.length ? `${next}\n\n<details><summary>The open questions</summary>\n\n${list.join("\n")}\n\n</details>` : next;
    return render(key, shown, rows, null, allowed(boxes, ai));
  }
  // plan: where its build plan stands (plan.planState): Claude planning, failed, or ready with its open questions
  const asks = plan?.questions?.length ? `${plan.questions.length === 1 ? "1 open question" : `${plan.questions.length} open questions`}` : "";
  const planRow = !plan ? [] : [{ writing: ["running", "Build plan", "Claude is planning the build (2 to 5 minutes): wait for it"], failed: ["failed", "Build plan", "Claude could not plan it: tick **Plan it with Claude** again, or **Start** without a plan"] }[plan.stage]
    || ["done", "Build plan", `written: the **Build plan** comment below${asks ? `, with **${asks}**` : ""}`]];
  const next = !plan ? (ai.plan ? "Bigger story? Tick **Plan it with Claude** first. Small story? Tick **Start**." : "Tick **Start** when you are ready to work on it.")
    : { writing: "Nothing yet: Claude is planning the build. This card updates when it is done.", failed: "Tick **Plan it with Claude** to try again, or **Start** to go ahead without a plan." }[plan.stage]
    || `Read the **Build plan** comment below. ${asks ? `It has **${asks}**: answer in a comment, then tick **Plan it with Claude** again (or comment \`/plan\`). ` : "To change it, reply with your changes in a comment, then tick **Plan it with Claude** again. "}When it is right, tick **Start**${asks ? " (the plan's guesses then stand for any question you leave)" : ""}.`;
  const shown = plan?.questions?.length ? `${next}\n\n<details><summary>The open questions</summary>\n\n${plan.questions.join("\n")}\n\n</details>` : next;
  return render(key, shown, [...planRow, ["waiting", "Branch and scratch org", "created when you start the story"]], null, plan?.stage === "writing" ? [] : allowed(["plan", "start", "hotfix"], ai));
}

/**
 * The release card: one comment on the release PR (release/<sprint> -> main) that says what ships, where it stands and
 * what to do next, with the same boxes as a story card. Pure: built from the gate's facts and decision.
 * input: { repoUrl, pr, facts, decision, uat (UAT_ENABLED), stories: [{ key, title, state }], shipped, activity }
 */
export function releaseCard({ repoUrl, pr, facts = {}, decision = null, uat = false, stories = [], shipped = null, activity = null }) {
  const prUrl = `${repoUrl}/pull/${pr.number}`;
  const sprint = sprintOf(pr.headRefName) || pr.headRefName;
  const runs = facts.checkRuns || [];
  const st = standing({ ...facts, pr });   // the gate's own reading of every result on the head
  const merged = pr.state === "MERGED";
  const rows = [];
  rows.push(["done", "What ships", stories.length ? stories.map((s) => `#${s.key} ${s.title}`).join("; ") : `everything merged into \`${pr.headRefName}\``]);
  const ci = [CHECKS.static, CHECKS.apex].map((n) => stateOf(st.checks[n]?.conclusion || "missing"));
  const ciState = merged ? "done" : ci.includes("failed") ? "failed" : ci.every((s) => s === "done") ? "done" : "running";
  rows.push([ciState, "CI (every test, staging org)", ciState === "failed" ? `[see what failed](${prUrl}/checks)` : ciState === "done" ? "passed" : `[running](${prUrl}/checks)`]);
  const staging = merged ? "done" : stateOf(st.checks[CHECKS.staging]?.conclusion || "missing");
  rows.push([staging, "Staging regression", staging === "failed" ? `[see what failed](${repoUrl}/actions/workflows/staging-deploy.yml)` : staging === "done" ? "passed on this commit" : "runs after each merge into the sprint"]);
  // every UI spec, once per release (#273): it starts when the release PR opens, beside UAT
  const ui = merged ? { state: "success" } : st.uiRegression;
  const uiRow = { success: ["done", "every UI spec passed"], failure: ["failed", `[see what failed](${repoUrl}/actions/workflows/staging-deploy.yml)`],
    stale: ["waiting", "passed on an older commit: it runs again"], pending: ["running", "running on the staging org"], missing: ["running", "runs once per release, now that the release PR is open"] }[ui.state] || ["waiting", ui.state];
  rows.push([uiRow[0], "UI regression (every UI spec)", uiRow[1]]);
  if (uat) {
    const u = merged ? { state: "success" } : st.uat;
    const open = u.url ? `**[open UAT](${u.url})** (⌘/Ctrl-click: a new tab; GitHub links cannot open one themselves)` : "open UAT";
    const how = /scratch org/.test(u.description || "") ? " (no login yet? tick **Send me a UAT login**)" : " (your UAT sandbox login)";
    const row = { success: ["done", "signed off"], failure: ["failed", `failed: ${u.description || "see the comments"}`], pending: ["running", `in UAT now: ${open}${how}, test it, then tick **UAT passed**`],
      stale: ["waiting", "signed off an older commit: it redeploys, then sign off again"], missing: ["waiting", "deploys after the staging regression"] }[u.state] || ["waiting", u.state];
    rows.push([row[0], "UAT sign-off", row[1]]);
  }
  const a = st.approval;
  const approved = merged || a.ok;
  rows.push([approved ? "done" : "waiting", "Approval", approvalText(a, { merged, prUrl, how: "(Review changes > Approve)", approver: null, team: facts.approvers })]);
  const v = stateOf(latestCheck(runs, "Production validation"));
  const validation = merged ? "done" : latestCheck(runs, "Production validation") === "missing" ? "waiting" : v;
  rows.push([validation, "Production validation", validation === "failed" ? `production rejected it: [see why](${prUrl}/checks)` : validation === "done" ? "passed (check-only deploy with the relevant tests)" : validation === "running" ? `[running](${prUrl}/checks)` : "runs when everything above is green"]);
  rows.push([merged ? "done" : "waiting", "Merged into main", merged ? "merged" : "the gate merges it after the validation"]);
  rows.push([shipped ? "done" : merged ? "running" : "waiting", "In production", shipped ? `released as [${shipped.tag}](${shipped.url}); stories closed, sprint closed, its orgs deleted` : merged ? "deploying the validated change" : "quick-deploys exactly what was validated"]);

  const at = (stage) => rows.find((r) => r[1] === stage)?.[0];
  const failed = rows.find((r) => r[0] === "failed");
  let next;
  if (shipped) next = `Done: sprint ${sprint} is live in production ([${shipped.tag}](${shipped.url})). Tick **Start the next sprint** when you are ready.`;
  else if (merged) next = "Nothing to do: it is deploying to production.";
  else if (pr.state === "CLOSED") next = "The release pull request was closed without merging.";
  else if (failed) next = failed[1].startsWith("UAT") ? `UAT failed: ${failed[2]}. Fix it with a story (or tick **Open a fix story**), or tick **UAT passed** after a retest.`
    : `${failed[1].startsWith("Production") ? "Production rejected it" : `${failed[1]} failed`}: tick **Open a fix story** below (it lists what failed and goes through the sprint like any story), then the release runs again.`;
  else if (at("UAT sign-off") === "running") next = "Test it in UAT, then tick **UAT passed** below (or comment `/uat-fail <why>`).";
  else if (at("Approval") === "waiting") next = `**[Approve here](${prUrl}/files)** when you are happy for sprint ${sprint} to go to production${at("UAT sign-off") && at("UAT sign-off") !== "done" ? " (it also needs the UAT sign-off)" : ""}.`;
  else if (decision?.mergeable || validation === "running") next = "Nothing to do: the gate is validating it against production, then it merges and ships.";
  else next = `Waiting: ${(decision?.reasons || ["the checks above"])[0]}.`;

  const ids = [];
  if (!merged && pr.state === "OPEN") {
    if (ciState === "failed") ids.push("ci");
    if (staging === "failed") ids.push("staging");
    if (["running", "failed"].includes(at("UAT sign-off"))) ids.push("uat-pass");
    if (at("UAT sign-off") === "failed") ids.push("uat");
    if ([ciState, staging, validation].includes("failed")) ids.push("fix-story");
    if (at("UAT sign-off") === "running" && /scratch org/.test(st.uat.description || "")) ids.push("uat-login");
    if (at("UAT sign-off") === "waiting" && staging === "done") ids.push("uat");
    if (approved && !failed) ids.push("gate");
    if (validation === "failed") ids.push("gate");
  }
  if (shipped) ids.push("sprint");
  // who the release needs now (journey.needs, from Standing): the UAT testers while it is in UAT, then the approvers once
  // everything before approval passed (notifyNeeds mentions them once)
  const needs = merged || failed ? null : whoIsNeeded(st, { ...facts, pr, uat }, { decision, testers: testers(), prUrl });
  return render(`release ${sprint}`, next, rows, activityLine(activity), [...new Set(ids)], { release: true, needs });
}

/**
 * What is happening right now, with a link to watch it: { state: "running" | "failed", what, url, retry }.
 * Workflows set it while they work and clear it when they finish, so the issue always says what is going on.
 */
export function activityLine(a) {
  if (!a?.what) return null;
  const link = a.url ? (a.state === "failed" ? ` · **[see what went wrong](${a.url})**` : ` · **[watch it live](${a.url})**`) : "";
  return a.state === "failed" ? `❌ **Failed:** ${a.what}${link}${a.retry ? ` · ${a.retry}` : ""}` : `⏳ **Now:** ${a.what}${link}`;
}

/** The card before a branch or org exists: the first thing anyone sees after /start. */
export function startingCard({ key, activity }) {
  return render(key, "Wait: the pipeline is setting this story up.", [["running", "Branch and scratch org", "being created"]], activityLine(activity));
}

const SHORT = { "Plan agreed": "Plan", "Branch and scratch org": "Branch + org", "Build": "Build", "Pull request": "Pull request", "CI (tests in a scratch org)": "CI",
  "AI review": "AI review", "UI test": "UI test", "Approval": "Approval", "Merged": "Merged", "In production": "Production" };

/** The stages as a left-to-right flow, coloured by state (GitHub draws Mermaid in comments; Jira gets the table only). */
export function storyMap(rows) {
  const nodes = rows.map(([state, stage], i) => `  s${i}["${ICON[state]} ${(SHORT[stage] || stage).replace(/"/g, "'")}"]:::${state}`);
  return [
    "```mermaid",
    "flowchart LR",
    ...nodes,
    `  ${rows.map((_, i) => `s${i}`).join(" --> ")}`,
    "  classDef done fill:#d6f5e3,stroke:#1d7a4c,color:#14202b",
    "  classDef running fill:#fdf0d5,stroke:#946000,color:#14202b",
    "  classDef failed fill:#f8e3e3,stroke:#a93838,color:#14202b",
    "  classDef waiting fill:#eef1f4,stroke:#9aa7b3,color:#5a6977",
    "  classDef off fill:#ffffff,stroke:#c8d0d8,stroke-dasharray:4 3,color:#9aa7b3",
    "```",
  ].join("\n");
}


/** Who a card needs now, as a hidden line on it: <!-- pipeline:needs login,login|what -->. A change of it is what
 *  notifies (notifyNeeds): cards are edited in place, and GitHub never notifies on an edit (14 Oct review). */
const NEEDS = "<!-- pipeline:needs ";
export const needsLine = (needs) => (needs?.who?.length ? `${NEEDS}${needs.who.join(",")}|${needs.what} -->` : "");
export function needsOf(body) {
  const m = String(body || "").match(/<!-- pipeline:needs ([^|]*)\|(.*?) -->/);
  return m ? { who: m[1].split(",").filter(Boolean), what: m[2] } : null;
}
/** One comment naming the people a card now needs, when that changed since the card was last written (GitHub). */
export async function notifyNeeds({ tracker, number, body, mark = CARD_MARK }) {
  if (!tracker?.prior || !tracker?.comment) return false;
  const now = needsOf(body), before = needsOf(await tracker.prior(number, mark).catch(() => ""));
  if (!now?.who?.length || (before && before.who.join() === now.who.join() && before.what === now.what)) return false;
  await tracker.comment(number, `${now.who.map((w) => `@${w}`).join(" ")}: ${now.what}`);
  return true;
}
const testers = () => { try { return Object.keys(JSON.parse(setting("UAT_TESTERS") || "{}")); } catch { return []; } };

function render(key, next, rows, now = null, actions = [], { release = false, needs = null } = {}) {
  return [
    CARD_MARK,
    `### ${release ? `Release status: ${key.replace(/^release /, "sprint ")}` : CARD_TITLE} (kept up to date by the pipeline)`,
    "",
    ...(now ? [now, ""] : []),
    `**Next:** ${next}`,
    "",
    ...(actions.length ? [...checklist(actions), ""] : []),
    storyMap(rows),
    "",
    "| | Stage | Details |",
    "|---|---|---|",
    ...rows.map(([s, stage, d]) => `| ${ICON[s]} | ${stage} | ${d} |`),
    ...(needsLine(needs) ? ["", needsLine(needs)] : []),
  ].join("\n");
}

/**
 * Refresh story cards. host: the code host (github.mjs); tracker: where the story lives; prTracker: comments on PRs.
 * refresh(key, { light }) with light=true reuses this process's facts and leaves the board alone: two edits, for the
 * Now line while tests run. Never throws: a card is information, not a gate.
 */
export function storyCards({ host, tracker, prTracker, log = () => {}, slack = slackNotifier({ log }) }) {
  const seen = new Map();
  // write a card; with Slack set up, tell the channel when its turn changed (the card before against the card after)
  async function write(t, key, body, { name = null, kinds } = {}) {
    const before = slack && t.prior ? await t.prior(key, CARD_MARK).catch(() => "") : "";
    const url = await t.card(key, body, CARD_MARK, CARD_TITLE);
    if (!slack) return url;
    const title = name ?? (await tracker.story(key).catch(() => null))?.title?.replace(/^(Story|Spec):\s*/i, "") ?? "";
    const m = notice({ before, after: body, key, title, url: typeof url === "string" ? url : "", kinds, actions: setting("SLACK_ACTIONS") === "true" });
    if (m) await slack(m);
    return url;
  }
  async function facts(key, base) {
    const branch = storyBranch(key);
    const pr = host.storyPr(branch);
    const ai = aiFeatures();
    const openRel = host.openRelease();
    const f = pr ? host.prFacts(pr.number) : null;
    const planned = Boolean(planContext(await tracker.comments(key).catch(() => [])).plan);
    const releasePr = pr?.state === "MERGED" && openRel ? (host.api("GET", `repos/${host.repo}/pulls?state=open&base=main&head=${host.repo.split("/")[0]}:${openRel}`) || [])[0]?.number || null : null;
    return { branch, pr, ai, facts: f, planned, releasePr, base: pr?.baseRefName || base || context({ key, openReleaseBranch: openRel }).BASE_BRANCH || "main" };
  }
  return {
    async refresh(key, { base = null, tag = null, activity = null, light = false } = {}) {
      try {
        let c = light ? seen.get(key) : null;
        if (!c) { c = await facts(key, base); seen.set(key, c); }
        // not started (no PR, no branch): the card offers Plan and Start, never "branch and org" it does not have
        if (!c.pr && !tag && !activity && host.api("GET", `repos/${host.repo}/branches/${encodeURIComponent(c.branch)}`)?.status === 404) {
          const s = await tracker.story(key).catch(() => null);
          const plan = planState(await tracker.comments(key).catch(() => []));
          if (!(s?.labels || []).includes("spec")) await write(tracker, key, newStoryCard({ key, ai: aiFeatures(), plan }), { name: s?.title || "" });
          return;
        }
        const body = storyCard({ key, repoUrl: host.repoUrl, branch: c.branch, ai: c.ai, pr: c.pr, facts: c.facts, decision: c.facts ? evaluate(c.facts) : null, planned: c.planned, base: c.base, releasePr: c.releasePr,
          shipped: tag ? { tag, url: `${host.repoUrl}/releases/tag/${tag}` } : null, activity });
        await write(tracker, key, body, { kinds: ["you", "failed"] });
        if (c.pr) {
          await notifyNeeds({ tracker: prTracker, number: c.pr.number, body }).catch((e) => log(`::warning::nobody notified: ${e.message}`));
          await prTracker.card(c.pr.number, body, CARD_MARK, CARD_TITLE);   // the same card on the PR
        }
        if (!light) await syncBoard({ host, key, pr: c.pr, facts: c.facts, shipped: Boolean(tag), log });
      } catch (e) { log(`::warning::story card for ${key} not updated: ${e.message}`); }
    },
    async starting(key, activity) {
      await tracker.card(key, startingCard({ key, activity }), CARD_MARK, CARD_TITLE).catch((e) => log(`::warning::${e.message}`));
    },
    /** A new story's card (before /start): what to do first, with the boxes to do it. */
    async newStory(key, { spec = false, stage = "new", stories = [], tag = null, questions = 0 } = {}) {
      await write(tracker, key, newStoryCard({ key, ai: aiFeatures(), spec, stage, stories, tag, questions }), { kinds: ["you", "failed"] }).catch((e) => log(`::warning::${e.message}`));
    },
    /** The card of the pull request a commit was merged by (the release workflow knows only the SHA). */
    async refreshCommit(sha, opts) {
      const n = (host.api("GET", `repos/${host.repo}/commits/${sha}/pulls`) || [])[0]?.number;
      return n ? this.refreshPr(n, opts) : null;
    },
    /** The card for a pull request, whatever it is: a release PR gets the release card; a story PR its story's. */
    async refreshPr(number, { activity = null, tag = null } = {}) {
      try {
        const facts = host.prFacts(number);
        const pr = facts.pr;
        if (route(pr) === "release") {
          const stories = await tracker.sprintStories(sprintOf(pr.headRefName)).catch(() => []);
          const body = releaseCard({ repoUrl: host.repoUrl, pr, facts, decision: evaluate(facts), uat: facts.uat, stories, activity,
            shipped: tag ? { tag, url: `${host.repoUrl}/releases/tag/${tag}` } : null });
          await notifyNeeds({ tracker: prTracker, number: pr.number, body }).catch((e) => log(`::warning::nobody notified: ${e.message}`));
          await write(prTracker, pr.number, body, { name: `release ${sprintOf(pr.headRefName)}` });
          return "release";
        }
        const key = storyOf(pr.headRefName);
        if (key) { await this.refresh(key, { activity, tag }); return "story"; }
        return null;
      } catch (e) { log(`::warning::card for PR #${number} not updated: ${e.message}`); return null; }
    },
  };
}

/** Move the story on the delivery board, when BOARD_PROJECT is set and the App's credentials are in this step. */
async function syncBoard({ host, key, pr, facts, shipped, log }) {
  const project = setting("BOARD_PROJECT");
  if (!project || !host.hasApp() || !/^\d+$/.test(String(key))) return;
  try {
    const issueNodeId = host.api("GET", `repos/${host.repo}/issues/${key}`)?.node_id;
    const approved = Boolean(facts && standing(facts).approval.ok);   // a hotfix needs a review, not a sign-off: as the gate
    const stage = stageOf({ pr, approved, shipped });
    await moveCard({ graphql: host.appGraphql, org: host.repo.split("/")[0], project, issueNodeId, stage });
    log(`board: story ${key} -> ${stage}`);
  } catch (e) { log(`::warning::board not updated for ${key}: ${e.message}`); }
}
