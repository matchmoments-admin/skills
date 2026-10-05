// Delivery telemetry: the four DORA measures plus how the pipeline itself is doing, from GitHub data alone.
//   summarize(facts) is pure (tested); gather(io, {days}) reads PRs, releases and workflow runs.
import { route } from "./gate.mjs";
import { fixRounds } from "./verdict.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOUR = 3600e3;
const hours = (a, b) => (new Date(b) - new Date(a)) / HOUR;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

/**
 * facts: { days, prs: [{number, headRefName, baseRefName, createdAt, mergedAt, labels:[{name}]}],
 *          releases: [{tagName, createdAt}], runs: [{name, conclusion, run_started_at, updated_at}],
 *          fixCommits: {<pr>: n} }
 */
export function summarize({ days, prs, releases, runs, fixCommits = {}, transcripts = [] }) {
  const merged = prs.filter((p) => p.mergedAt);
  const byRoute = (r) => merged.filter((p) => route(p) === r);
  const features = byRoute("feature"), hotfixes = byRoute("hotfix");

  const workflows = {};
  for (const r of runs.filter((r) => r.conclusion && r.conclusion !== "skipped")) {
    const w = (workflows[r.name] ||= { runs: 0, success: 0, minutes: [] });
    w.runs++;
    if (r.conclusion === "success") w.success++;
    w.minutes.push((new Date(r.updated_at) - new Date(r.run_started_at)) / 60e3);
  }
  const pipeline = Object.fromEntries(Object.entries(workflows).sort().map(([n, w]) => [n, {
    runs: w.runs, successRate: Math.round((100 * w.success) / w.runs), medianMinutes: round1(median(w.minutes)),
  }]));

  const reviewed = features.filter((p) => p.labels?.some((l) => l.name.startsWith("review:")));
  const firstPass = reviewed.filter((p) => !(fixCommits[p.number] > 0));
  return {
    days,
    dora: {
      deploymentsPerWeek: round1((releases.length * 7) / days),
      leadTimeHours: round1(median(features.map((p) => hours(p.createdAt, p.mergedAt)))),   // story PR opened -> in the release branch
      changeFailureRate: releases.length ? Math.round((100 * hotfixes.length) / releases.length) : null,   // % of releases that needed a hotfix
      timeToRestoreHours: round1(median(hotfixes.map((p) => hours(p.createdAt, p.mergedAt)))),
    },
    ai: {
      storiesReviewed: reviewed.length,
      passedFirstReview: reviewed.length ? Math.round((100 * firstPass.length) / reviewed.length) : null,
      medianFixRounds: median(reviewed.map((p) => fixCommits[p.number] || 0)),
    },
    pipeline,
    aiCost: aiCost(transcripts),
    counts: { features: features.length, hotfixes: hotfixes.length, releases: releases.length },
  };
}

/** Claude usage per role from the agents' transcripts ({ role, total_cost_usd, num_turns, duration_ms }).
 *  On a subscription token the cost is the API-equivalent figure, not a bill. */
export function aiCost(transcripts) {
  const roles = {};
  for (const t of transcripts) {
    const r = (roles[t.role] ||= { runs: 0, usd: 0, turns: [], minutes: [] });
    r.runs++;
    r.usd += Number(t.total_cost_usd) || 0;
    r.turns.push(Number(t.num_turns) || 0);
    r.minutes.push((Number(t.duration_ms) || 0) / 60e3);
  }
  const byRole = Object.fromEntries(Object.entries(roles).sort().map(([k, r]) => [k, {
    runs: r.runs, usd: Math.round(r.usd * 100) / 100, perRunUsd: Math.round((r.usd / r.runs) * 100) / 100,
    medianTurns: median(r.turns), medianMinutes: round1(median(r.minutes)),
  }]));
  const total = Object.values(byRole).reduce((a, r) => ({ runs: a.runs + r.runs, usd: Math.round((a.usd + r.usd) * 100) / 100 }), { runs: 0, usd: 0 });
  return { byRole, total };
}

export function toMarkdown(s) {
  const v = (x, unit = "") => (x === null || x === undefined ? "n/a" : `${x}${unit}`);
  return [
    `## Delivery metrics, last ${s.days} days`, "",
    "| DORA | value |", "|---|---|",
    `| Deployment frequency | ${v(s.dora.deploymentsPerWeek)} releases/week (${s.counts.releases} releases) |`,
    `| Lead time (story PR opened to merged) | ${v(s.dora.leadTimeHours, " h")} median over ${s.counts.features} stories |`,
    `| Change failure rate (hotfixes per release) | ${v(s.dora.changeFailureRate, "%")} |`,
    `| Time to restore (hotfix PR opened to merged) | ${v(s.dora.timeToRestoreHours, " h")} |`, "",
    "| AI | value |", "|---|---|",
    `| Stories reviewed | ${s.ai.storiesReviewed} |`,
    `| Passed the first review | ${v(s.ai.passedFirstReview, "%")} |`,
    `| Median fix rounds | ${v(s.ai.medianFixRounds)} |`, "",
    "| Workflow | runs | success | median minutes |", "|---|---|---|---|",
    ...Object.entries(s.pipeline).map(([n, w]) => `| ${n} | ${w.runs} | ${w.successRate}% | ${v(w.medianMinutes)} |`), "",
    `| AI role | runs | cost (API-equivalent) | per run | median turns | median minutes |`, "|---|---|---|---|---|---|",
    ...Object.entries(s.aiCost?.byRole || {}).map(([n, r]) => `| ${n} | ${r.runs} | $${r.usd.toFixed(2)} | $${r.perRunUsd.toFixed(2)} | ${v(r.medianTurns)} | ${v(r.medianMinutes)} |`),
    `| **total** | ${s.aiCost?.total.runs ?? 0} | **$${(s.aiCost?.total.usd ?? 0).toFixed(2)}** | | | |`, "",
    "Claude cost is read from each agent transcript (`total_cost_usd`); on a subscription token it is what the same usage would cost on the API, not a bill. Jev triage costs about $0.04 per million input tokens (a fraction of a cent per PR).",
  ].join("\n");
}

export function gather(io, { days = 28, transcripts: withTranscripts = true } = {}) {
  const since = new Date(Date.now() - days * 24 * HOUR).toISOString();
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  const prs = (io.gh(["pr", "list", "--state", "merged", "--limit", "300", "--search", `merged:>=${since.slice(0, 10)}`,
    "--json", "number,headRefName,baseRefName,createdAt,mergedAt,labels"]) || []);
  const releases = (io.gh(["release", "list", "--limit", "100", "--json", "tagName,createdAt"]) || []).filter((r) => r.createdAt >= since);
  const runs = io.ghPages(`repos/${repo}/actions/runs?per_page=100&created=>=${since.slice(0, 10)}`, "workflow_runs");
  const fixCommits = {};
  for (const p of prs) {
    const commits = io.gh(["pr", "view", String(p.number), "--json", "commits", "--jq", "[.commits[].messageHeadline]"]) || [];
    fixCommits[p.number] = fixRounds(commits);
  }
  return { days, prs, releases, runs, fixCommits, transcripts: withTranscripts ? transcripts(io, repo, since) : [] };
}

/** Each AI run's result line, from its transcript artifact (claude-transcript-<role>-<run id>, kept 30 days). */
function transcripts(io, repo, since) {
  const out = [];
  const arts = io.ghPages(`repos/${repo}/actions/artifacts?per_page=100`, "artifacts")
    .filter((a) => a.name.startsWith("claude-transcript-") && !a.expired && a.created_at >= since);
  const dir = mkdtempSync(join(tmpdir(), "transcripts-"));
  for (const a of arts) {
    const named = a.name.replace(/^claude-transcript-/, "").replace(/-\d+$/, "");
    const role = named === "ui" ? "ui-test" : named;   // older runs named the UI tester "ui"
    const into = join(dir, String(a.id));
    if (io.run("gh", ["run", "download", String(a.workflow_run.id), "-R", repo, "-n", a.name, "-D", into], { quiet: true, allowFail: true }) === null) continue;
    try {
      const msgs = JSON.parse(readFileSync(join(into, "claude-execution-output.json"), "utf8"));
      const result = [...msgs].reverse().find((m) => m.type === "result");
      if (result) out.push({ role, total_cost_usd: result.total_cost_usd, num_turns: result.num_turns, duration_ms: result.duration_ms });
    } catch { /* an unreadable transcript counts as nothing */ }
  }
  return out;
}
