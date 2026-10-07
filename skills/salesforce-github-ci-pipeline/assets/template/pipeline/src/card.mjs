// The story card: one comment on the story (GitHub issue or Jira ticket), edited in place at every stage, that tells
// a non-technical person where the story is, what is next, and links straight to it. storyCard() is pure: built from the
// same facts and decision the gate uses (gate.gather / gate.evaluate), so the card and the gate cannot disagree.
// storyCards() puts it on the story and its PR (and moves the board), through the code host and the tracker.
import { CHECKS, storyBranch, aiFeatures, context, setting, sprintOf, storyOf } from "./conventions.mjs";
import { latestCheck, verdictFor, humanApproval, requiredVerdicts, evaluate, route, STATUS } from "./gate.mjs";
import { planContext } from "./plan.mjs";
import { stageOf, moveCard } from "./board.mjs";
import { checklist, allowed } from "./actions.mjs";

export const CARD_TITLE = "Pipeline status";
export const CARD_MARK = "<!-- pipeline:story-card -->";

const ICON = { done: "✅", running: "⏳", waiting: "⬜", failed: "❌", off: "➖" };
const stateOf = (c) => (c === "success" ? "done" : ["failure", "error", "cancelled", "timed_out"].includes(c) ? "failed" : c === "missing" ? "waiting" : "running");

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
  rows.push(["done", "Branch and scratch org", `${branchLink} from \`${base}\`; org \`${branch}\` (production's shape)`]);

  let next;
  if (!pr) {
    rows.push(["waiting", "Build", ai.implement ? `build on ${branchLink} and open a PR into \`${base}\`, or comment **/build** on this story` : `build on ${branchLink} and open a PR into \`${base}\``]);
    next = ai.implement ? "Build it, or tick **Build it with Claude** below." : `Build it on ${branchLink} and open a pull request.`;
    return render(key, next, rows, now, allowed([...(planned ? [] : ["plan"]), "build"], ai));
  }

  const merged = pr.state === "MERGED";
  rows.push(["done", "Pull request", `[#${pr.number}](${prUrl})${pr.title ? ` ${pr.title}` : ""}`]);
  const ci = [CHECKS.static, CHECKS.apex].map((n) => stateOf(latestCheck(facts?.checkRuns || [], n)));
  const ciState = ci.includes("failed") ? "failed" : ci.every((s) => s === "done") ? "done" : "running";
  // the live "Salesforce tests" check (pipeline/src/tests.mjs) says how far the tests are, while they run
  const live = (facts?.checkRuns || []).filter((c) => c.name === "Salesforce tests").sort((x, y) => String(x.started_at).localeCompare(String(y.started_at))).pop();
  const liveTitle = live?.output?.title ? ` (${live.output.title})` : "";
  rows.push([ciState, "CI (tests in a scratch org)", ciState === "failed" ? `[see what failed](${prUrl}/checks)${liveTitle}` : ciState === "done" ? `static checks, deploy and tests passed${liveTitle}` : `[running](${prUrl}/checks)${liveTitle}`]);

  const ctx = { ...(facts || {}), head: pr.headRefOid };
  for (const v of requiredVerdicts(facts || {}, key)) {
    const { state: got, url } = verdictFor(v.context, ctx);
    const label = v.context === STATUS.review ? "AI review" : "UI test";
    const shots = url && /#issuecomment-|\/browse\//.test(url) ? `: **[see the screenshots](${url})**` : "";   // UI evidence (UI_EVIDENCE)
    if (got === "success") rows.push(["done", label, v.context === STATUS.review ? "passed" : `passed in the scratch org${shots}`]);
    else if (["failure", "error"].includes(got)) rows.push(["failed", label, v.context === STATUS.review ? `asks for changes: [read the comments](${prUrl})` : `[see the report](${prUrl}/checks)`]);
    else if (v.required) rows.push([got === "stale" ? "waiting" : "running", label, got === "stale" ? `run it again (${v.how})` : `waiting (${v.how})`]);
    else rows.push(["off", label, v.context === STATUS.review ? "off: your approval is the review" : "not needed"]);
  }

  const approved = merged || humanApproval(ctx) || verdictFor(STATUS.signoff, ctx).state === "success";
  const signOff = base === "main" ? "(Review changes > Approve)" : "(Review changes > Approve), or tick **Sign off** below";
  rows.push([approved ? "done" : "waiting", "Approval", approved ? "approved" : `**[Approve here](${prUrl}/files)** ${signOff}`]);
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
    else if (decision?.mergeable) next = "Nothing to do: merging now.";
    else if (waiting && waiting[1] !== "Approval" && waiting[0] === "running") next = `Waiting for ${waiting[1].toLowerCase()}. You can approve now: **[Approve here](${prUrl}/files)**.`;
    else if (waiting && waiting[1] === "Approval") next = `**[Approve here](${prUrl}/files)**: everything else is green.`;
    else next = waiting ? `${waiting[1]}: ${waiting[2]}` : "Waiting.";
  }
  const mergedActions = merged && !shipped && base !== "main" && !releasePr ? ["release-cut"] : [];   // nobody has cut the release yet
  if (mergedActions.length) next = `${next} When the sprint's stories are merged, tick **Cut the sprint's release** below.`;
  return render(key, next, rows, now, merged ? mergedActions : pr.state === "CLOSED" ? ["start"] : storyActions(rows, { ai, base, ci: ciState, decision }));
}

/** The boxes a story PR's card offers, from where it stands (pure). */
function storyActions(rows, { ai, base, ci }) {
  const at = (stage) => rows.find((r) => r[1] === stage)?.[0];
  const ids = [];
  if (ci === "failed") ids.push("fix", "ci");
  if (at("AI review") === "failed") ids.push("fix", "review");
  else if (["waiting", "running"].includes(at("AI review"))) ids.push("review");
  if (["failed", "waiting"].includes(at("UI test"))) ids.push(ai.uiTest ? "ai-test" : "test");
  if (at("UI test") === "failed") ids.push("fix");   // the fixer reads the Playwright error
  if (at("Approval") === "waiting" && base !== "main") ids.push("ship");
  if (at("Approval") === "waiting") ids.push("org-login");   // the approver can see the feature in the story's org
  return allowed([...new Set(ids)], ai);
}

/** The card on a story before /start (or a spec issue: where the spec stands; stage: new | spec | breakdown | created). */
export function newStoryCard({ key, ai = {}, spec = false, stage = "new", stories = [] }) {
  if (spec) {
    const rows = [[stage === "new" ? "waiting" : "done", "Spec", stage === "new" ? "not written yet" : "written: the **Spec** comment below"],
      [["breakdown", "created"].includes(stage) ? "done" : "waiting", "Story breakdown", ["breakdown", "created"].includes(stage) ? "proposed: the **Story breakdown** comment below" : "after the spec"],
      [stage === "created" ? "done" : "waiting", "Stories", stage === "created" ? stories.map((n) => `#${n}`).join(", ") : "created when you approve the breakdown"]];
    const next = { new: ai.plan ? "Tick **Write the spec with Claude**; answer its questions, then split it into stories." : "Write the spec in a comment, then open a story for each slice.",
      spec: "Read the **Spec** below: answer its questions (then /spec revises it), or tick **Split it into stories** on it.",
      breakdown: "Check the **Story breakdown** below; tick **Create these stories** on it (or reply with changes and /tickets).",
      created: `Done: the stories are created (${stories.map((n) => `#${n}`).join(", ")}); each one's card offers Plan and Start.` }[stage];
    return render(key, next, rows, null, stage === "new" ? allowed(["spec"], ai) : []);
  }
  return render(key, ai.plan ? "Bigger story? Tick **Plan it with Claude** first. Small story? Tick **Start**." : "Tick **Start** when you are ready to work on it.",
    [["waiting", "Branch and scratch org", "created when you start the story"]], null, allowed(["plan", "start", "hotfix"], ai));
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
  const ctx = { ...facts, head: pr.headRefOid };
  const merged = pr.state === "MERGED";
  const rows = [];
  rows.push(["done", "What ships", stories.length ? stories.map((s) => `#${s.key} ${s.title}`).join("; ") : `everything merged into \`${pr.headRefName}\``]);
  const ci = [CHECKS.static, CHECKS.apex].map((n) => stateOf(latestCheck(runs, n)));
  const ciState = merged ? "done" : ci.includes("failed") ? "failed" : ci.every((s) => s === "done") ? "done" : "running";
  rows.push([ciState, "CI (every test, staging org)", ciState === "failed" ? `[see what failed](${prUrl}/checks)` : ciState === "done" ? "passed" : `[running](${prUrl}/checks)`]);
  const staging = merged ? "done" : stateOf(latestCheck(runs, CHECKS.staging));
  rows.push([staging, "Staging regression (Apex, Flow and UI)", staging === "failed" ? `[see what failed](${repoUrl}/actions/workflows/staging-deploy.yml)` : staging === "done" ? "passed on this commit" : "runs after each merge into the sprint"]);
  if (uat) {
    const u = merged ? { state: "success" } : verdictFor(STATUS.uat, ctx);
    const open = u.url ? `**[open UAT](${u.url})** (⌘/Ctrl-click: a new tab; GitHub links cannot open one themselves)` : "open UAT";
    const how = /scratch org/.test(u.description || "") ? " (no login yet? tick **Send me a UAT login**)" : " (your UAT sandbox login)";
    const row = { success: ["done", "signed off"], failure: ["failed", `failed: ${u.description || "see the comments"}`], pending: ["running", `in UAT now: ${open}${how}, test it, then tick **UAT passed**`],
      stale: ["waiting", "signed off an older commit: it redeploys, then sign off again"], missing: ["waiting", "deploys after the staging regression"] }[u.state] || ["waiting", u.state];
    rows.push([row[0], "UAT sign-off", row[1]]);
  }
  const approved = merged || humanApproval(ctx);
  rows.push([approved ? "done" : "waiting", "Approval", approved ? "approved" : `**[Approve here](${prUrl}/files)** (Review changes > Approve)`]);
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
    if (at("UAT sign-off") === "running" && /scratch org/.test(verdictFor(STATUS.uat, ctx).description || "")) ids.push("uat-login");
    if (at("UAT sign-off") === "waiting" && staging === "done") ids.push("uat");
    if (approved && !failed) ids.push("gate");
    if (validation === "failed") ids.push("gate");
  }
  if (shipped) ids.push("sprint");
  return render(`release ${sprint}`, next, rows, activityLine(activity), [...new Set(ids)], { release: true });
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


function render(key, next, rows, now = null, actions = [], { release = false } = {}) {
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
  ].join("\n");
}

/**
 * Refresh story cards. host: the code host (github.mjs); tracker: where the story lives; prTracker: comments on PRs.
 * refresh(key, { light }) with light=true reuses this process's facts and leaves the board alone: two edits, for the
 * Now line while tests run. Never throws: a card is information, not a gate.
 */
export function storyCards({ host, tracker, prTracker, log = () => {} }) {
  const seen = new Map();
  async function facts(key, base) {
    const branch = storyBranch(key);
    const pr = host.storyPr(branch);
    const ai = aiFeatures();
    const openRel = host.openRelease();
    const f = pr ? host.prFacts(pr.number, { openReleaseBranch: openRel, ai }) : null;
    const planned = Boolean(planContext(await tracker.comments(key).catch(() => [])).plan);
    const releasePr = pr?.state === "MERGED" && openRel ? (host.api("GET", `repos/${host.repo}/pulls?state=open&base=main&head=${host.repo.split("/")[0]}:${openRel}`) || [])[0]?.number || null : null;
    return { branch, pr, ai, facts: f, planned, releasePr, base: pr?.baseRefName || base || context({ key, openReleaseBranch: openRel }).BASE_BRANCH || "main" };
  }
  return {
    async refresh(key, { base = null, tag = null, activity = null, light = false } = {}) {
      try {
        let c = light ? seen.get(key) : null;
        if (!c) { c = await facts(key, base); seen.set(key, c); }
        const body = storyCard({ key, repoUrl: host.repoUrl, branch: c.branch, ai: c.ai, pr: c.pr, facts: c.facts, decision: c.facts ? evaluate(c.facts) : null, planned: c.planned, base: c.base, releasePr: c.releasePr,
          shipped: tag ? { tag, url: `${host.repoUrl}/releases/tag/${tag}` } : null, activity });
        await tracker.card(key, body, CARD_MARK, CARD_TITLE);
        if (c.pr) await prTracker.card(c.pr.number, body, CARD_MARK, CARD_TITLE);   // the same card on the PR
        if (!light) await syncBoard({ host, key, pr: c.pr, facts: c.facts, shipped: Boolean(tag), log });
      } catch (e) { log(`::warning::story card for ${key} not updated: ${e.message}`); }
    },
    async starting(key, activity) {
      await tracker.card(key, startingCard({ key, activity }), CARD_MARK, CARD_TITLE).catch((e) => log(`::warning::${e.message}`));
    },
    /** A new story's card (before /start): what to do first, with the boxes to do it. */
    async newStory(key, { spec = false, stage = "new", stories = [] } = {}) {
      await tracker.card(key, newStoryCard({ key, ai: aiFeatures(), spec, stage, stories }), CARD_MARK, CARD_TITLE).catch((e) => log(`::warning::${e.message}`));
    },
    /** The card of the pull request a commit was merged by (the release workflow knows only the SHA). */
    async refreshCommit(sha, opts) {
      const n = (host.api("GET", `repos/${host.repo}/commits/${sha}/pulls`) || [])[0]?.number;
      return n ? this.refreshPr(n, opts) : null;
    },
    /** The card for a pull request, whatever it is: a release PR gets the release card; a story PR its story's. */
    async refreshPr(number, { activity = null, tag = null } = {}) {
      try {
        const facts = host.prFacts(number, { openReleaseBranch: host.openRelease(), ai: aiFeatures(), uat: setting("UAT_ENABLED") === "true" });
        const pr = facts.pr;
        if (route(pr) === "release") {
          const stories = await tracker.sprintStories(sprintOf(pr.headRefName)).catch(() => []);
          const body = releaseCard({ repoUrl: host.repoUrl, pr, facts, decision: evaluate(facts), uat: facts.uat, stories, activity,
            shipped: tag ? { tag, url: `${host.repoUrl}/releases/tag/${tag}` } : null });
          await prTracker.card(pr.number, body, CARD_MARK, CARD_TITLE);
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
    const approved = Boolean(facts && humanApproval({ ...facts, head: pr?.headRefOid }));
    const stage = stageOf({ pr, approved, shipped });
    await moveCard({ graphql: host.appGraphql, org: host.repo.split("/")[0], project, issueNodeId, stage });
    log(`board: story ${key} -> ${stage}`);
  } catch (e) { log(`::warning::board not updated for ${key}: ${e.message}`); }
}
