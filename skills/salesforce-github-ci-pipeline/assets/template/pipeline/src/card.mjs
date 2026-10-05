// The story card: one comment on the story (GitHub issue or Jira ticket), edited in place at every stage, that tells
// a non-technical person where the story is, what is next, and links straight to it. Pure: built from the same facts
// and decision the gate uses (gate.gather / gate.evaluate), so the card and the gate cannot disagree.
import { CHECKS } from "./conventions.mjs";
import { latestCheck, verdictFor, humanApproval, requiredVerdicts, STATUS } from "./gate.mjs";

export const CARD_TITLE = "Pipeline status";
export const CARD_MARK = "<!-- pipeline:story-card -->";

const ICON = { done: "✅", running: "⏳", waiting: "⬜", failed: "❌", off: "➖" };
const stateOf = (c) => (c === "success" ? "done" : ["failure", "error", "cancelled", "timed_out"].includes(c) ? "failed" : c === "missing" ? "waiting" : "running");

/**
 * input: { key, repoUrl, branch, base, ai, pr?, facts?, decision? }
 *   pr/facts/decision are absent before the PR exists. facts = gate.gather(), decision = gate.evaluate(facts).
 * returns markdown.
 */
export function storyCard({ key, repoUrl, branch, base, ai = {}, pr = null, facts = null, decision = null, shipped = null, activity = null, planned = false }) {
  const now = activityLine(activity);
  const rows = [];
  const prUrl = pr ? `${repoUrl}/pull/${pr.number}` : null;
  const branchLink = pr?.state === "MERGED" ? `\`${branch}\`` : `[\`${branch}\`](${repoUrl}/tree/${encodeURIComponent(branch)})`;   // merged branches are deleted
  if (planned) rows.push(["done", "Plan agreed", "the **Build plan** comment on this story, with the answers to it, is part of the spec"]);
  rows.push(["done", "Branch and scratch org", `${branchLink} from \`${base}\`; org \`${branch}\` (production's shape)`]);

  let next;
  if (!pr) {
    rows.push(["waiting", "Build", ai.implement ? `build on ${branchLink} and open a PR into \`${base}\`, or comment **/build** on this story` : `build on ${branchLink} and open a PR into \`${base}\``]);
    next = ai.implement ? "Build it, or comment **/build** to have the AI build it." : `Build it on ${branchLink} and open a pull request.`;
    return render(key, next, rows, now);
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
    const got = verdictFor(v.context, ctx).state;
    const label = v.context === STATUS.review ? "AI review" : "UI test";
    if (got === "success") rows.push(["done", label, v.context === STATUS.review ? "passed" : "passed in the scratch org"]);
    else if (["failure", "error"].includes(got)) rows.push(["failed", label, v.context === STATUS.review ? `asks for changes: [read the comments](${prUrl})` : `[see the report](${prUrl}/checks)`]);
    else if (v.required) rows.push([got === "stale" ? "waiting" : "running", label, got === "stale" ? `run it again (${v.how})` : `waiting (${v.how})`]);
    else rows.push(["off", label, v.context === STATUS.review ? "off: your approval is the review" : "not needed"]);
  }

  const approved = merged || humanApproval(ctx);
  const signOff = base === "main" ? "(Review changes > Approve)" : "(Review changes > Approve), or comment **/ship** on the PR";
  rows.push([approved ? "done" : "waiting", "Approval", approved ? "approved" : `**[Approve here](${prUrl}/files)** ${signOff}`]);
  rows.push([shipped ? "done" : merged ? "done" : "waiting", "Merged", merged ? `into \`${base}\`; the staging regression runs next` : "merges by itself when everything above is green"]);
  rows.push([shipped ? "done" : "waiting", "In production", shipped ? `released in [${shipped.tag}](${shipped.url})` : base === "main" ? "ships right after the merge" : "ships with the sprint's release"]);

  if (shipped) next = `Done: live in production since [${shipped.tag}](${shipped.url}).`;
  else if (merged) next = base === "main" ? "Nothing to do: it is shipping to production now." : "Nothing to do: it ships with the sprint release.";
  else if (pr.state === "CLOSED") next = "The pull request was closed without merging.";
  else {
    const failed = rows.find((r) => r[0] === "failed");
    const waiting = rows.find((r) => r[0] === "waiting" || r[0] === "running");
    if (failed) next = failed[1].startsWith("CI") ? `Fix the failing tests: [see what failed](${prUrl}/checks), then push to ${branchLink}.`
      : failed[1] === "AI review" ? `Address the review comments on [#${pr.number}](${prUrl})${ai.fix ? ", or add the label **ai:fix**" : ""}.`
      : `Fix the UI test failure ([report](${prUrl}/checks)), then label the PR **test** again.`;
    else if (decision?.mergeable) next = "Nothing to do: merging now.";
    else if (waiting && waiting[1] !== "Approval" && waiting[0] === "running") next = `Waiting for ${waiting[1].toLowerCase()}. You can approve now: **[Approve here](${prUrl}/files)**.`;
    else if (waiting && waiting[1] === "Approval") next = `**[Approve here](${prUrl}/files)**: everything else is green.`;
    else next = waiting ? `${waiting[1]}: ${waiting[2]}` : "Waiting.";
  }
  return render(key, next, rows, now);
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

/** Remove the diagram (for trackers that cannot draw Mermaid). */
export const withoutMap = (body) => body.replace(/```mermaid[\s\S]*?```\n*/g, "");

function render(key, next, rows, now = null) {
  return [
    CARD_MARK,
    `### ${CARD_TITLE} (kept up to date by the pipeline)`,
    "",
    ...(now ? [now, ""] : []),
    `**Next:** ${next}`,
    "",
    storyMap(rows),
    "",
    "| | Stage | Details |",
    "|---|---|---|",
    ...rows.map(([s, stage, d]) => `| ${ICON[s]} | ${stage} | ${d} |`),
  ].join("\n");
}
