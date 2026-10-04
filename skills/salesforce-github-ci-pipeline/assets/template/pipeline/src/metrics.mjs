// Delivery telemetry: the four DORA measures plus how the pipeline itself is doing, from GitHub data alone.
//   summarize(facts) is pure (tested); gather(io, {days}) reads PRs, releases and workflow runs.
import { route } from "./gate.mjs";
import { fixRounds } from "./verdict.mjs";

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
export function summarize({ days, prs, releases, runs, fixCommits = {} }) {
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
    counts: { features: features.length, hotfixes: hotfixes.length, releases: releases.length },
  };
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
    ...Object.entries(s.pipeline).map(([n, w]) => `| ${n} | ${w.runs} | ${w.successRate}% | ${v(w.medianMinutes)} |`),
  ].join("\n");
}

export function gather(io, { days = 28 } = {}) {
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
  return { days, prs, releases, runs, fixCommits };
}
