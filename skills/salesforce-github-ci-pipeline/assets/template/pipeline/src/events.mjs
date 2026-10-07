// The delivery event log: one small JSON file per thing that happened, appended to the `metrics` branch (see GLOSSARY.md:
// Event log). The pipeline commands that know an outcome record it themselves (a test run, a production validation, a
// gate decision, an org made or deleted, an agent's cost, a release), so workflows need no extra steps and nothing is
// reconstructed from leftovers later. Writing never fails the caller. The weekly metrics read the log (summarize()).
//
// Storage: the Contents API creates events/<yyyy>/<mm>/<dd>/<time>-<run>-<random>.json on `metrics`: one call, a new
// path each time, so writers never conflict on a file. Readers fetch the branch once.

export const BRANCH = "metrics";
const KINDS = ["stage", "tests", "validation", "gate", "release", "rollback", "org", "agent", "verdict", "lane", "evidence"];

/** The event as stored: what happened plus where (run, workflow, job). Pure. */
export function event(kind, data = {}, env = process.env, now = new Date()) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown event kind: ${kind}`);
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  return { v: 1, at: now.toISOString(), kind, ...clean, run: env.GITHUB_RUN_ID || null, workflow: env.GITHUB_WORKFLOW || null, job: env.GITHUB_JOB || null };
}

export const pathOf = (e, rand = Math.random().toString(36).slice(2, 8)) =>
  `events/${e.at.slice(0, 4)}/${e.at.slice(5, 7)}/${e.at.slice(8, 10)}/${e.at.replace(/[-:.]/g, "")}-${e.run || "local"}-${e.kind}-${rand}.json`;

/** record(kind, data): best effort, one API call (`api` is the gh seam: (method, path, body) -> json | { status }). */
export function recorder({ api, repo, env = process.env, log = () => {}, sleep = () => {} }) {
  let broken = false;
  return function record(kind, data) {
    if (broken || !repo || env.PIPELINE_EVENTS === "off") return false;
    try {
      const e = event(kind, data, env);
      for (let i = 0; i < 6; i++) {
        const r = api("PUT", `repos/${repo}/contents/${pathOf(e)}`, { message: `event: ${kind}${e.story ? ` ${e.story}` : ""}`, content: Buffer.from(JSON.stringify(e) + "\n").toString("base64"), branch: BRANCH });
        if (!r?.status) return true;
        if (r.status === 403 || r.status === 404) { broken = true; log(`::notice::events not recorded (${r.status}): this job's token cannot write the ${BRANCH} branch`); return false; }
        sleep((500 + Math.random() * 1500) * (i + 1));   // 409: the branch moved under a concurrent write; jitter so writers spread
      }
    } catch (err) { log(`::notice::event ${kind} not recorded: ${err.message}`); }
    return false;
  };
}

// ---------------------------------------------------------------- reading the log
/** Every event of the last `days` days: one fetch of the branch, one `git cat-file --batch` for the files. */
export function readLog(io, { days = 28, now = new Date() } = {}) {
  if (io.git(["fetch", "-q", "--depth=1", "origin", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`], { allowFail: true }) === null) return [];   // the tip only: not every event commit
  const since = new Date(now - days * 24 * 3600e3).toISOString().slice(0, 10);
  const files = (io.git(["ls-tree", "-r", `origin/${BRANCH}`, "--", "events"], { allowFail: true }) || "").split("\n")
    .map((l) => l.match(/^\d+ blob ([0-9a-f]+)\t(events\/(\d{4})\/(\d{2})\/(\d{2})\/.+\.json)$/)).filter(Boolean)
    .filter((m) => `${m[3]}-${m[4]}-${m[5]}` >= since);
  if (!files.length) return [];
  const out = io.run("git", ["cat-file", "--batch"], { input: files.map((m) => m[1]).join("\n") + "\n", quiet: true, encoding: "buffer" });
  return parseBatch(out).flatMap((text) => { try { return [JSON.parse(text)]; } catch { return []; } });
}

/** The contents of `git cat-file --batch` output ("<sha> blob <bytes>\n<content>\n" per object). */
export function parseBatch(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ""));
  const out = [];
  for (let i = 0; i < b.length;) {
    const nl = b.indexOf(10, i);
    if (nl < 0) break;
    const size = Number(b.subarray(i, nl).toString().split(" ")[2]);
    if (!Number.isFinite(size)) break;
    out.push(b.subarray(nl + 1, nl + 1 + size).toString("utf8"));
    i = nl + 1 + size + 1;
  }
  return out;
}
const HOUR = 3600e3;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);
/** A gate reason without its specifics, so the same kind of wait counts once ("check X is pending" -> "check is pending"). */
export const reasonKind = (r) => String(r).replace(/"[^"]*"/g, "X").replace(/\([^)]*\)/g, "").replace(/\d+/g, "N").replace(/\s+/g, " ").trim();

/** Delivery and pipeline measures from the events of a window (pure). */
export function summarize(events, { days = 28 } = {}) {
  const of = (k) => events.filter((e) => e.kind === k);
  const firstSeen = {};
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) if (e.story && !firstSeen[e.story]) firstSeen[e.story] = e.at;

  const releases = of("release"), rollbacks = of("rollback");
  const lead = [], restore = [];
  for (const r of releases) {
    for (const s of r.shipped || []) if (firstSeen[s]) lead.push((new Date(r.at) - new Date(firstSeen[s])) / HOUR);
    for (const s of r.hotfixes || []) if (firstSeen[s]) restore.push((new Date(r.at) - new Date(firstSeen[s])) / HOUR);
  }
  const hotfixReleases = releases.filter((r) => !r.sprint && (r.hotfixes || []).length);

  const tests = of("tests"), vals = of("validation"), lanes = of("lane"), agents = of("agent"), shots = of("evidence");
  const gateWaits = {};
  for (const g of of("gate").filter((x) => !x.mergeable)) for (const k of new Set((g.reasons || []).map(reasonKind))) (gateWaits[k] ||= new Set()).add(g.pr);
  const failedStages = {};
  for (const s of of("stage").filter((x) => x.state === "failed")) failedStages[s.what] = (failedStages[s.what] || 0) + 1;

  const orgs = of("org"), made = {};
  let orgHours = 0;
  for (const o of [...orgs].sort((a, b) => a.at.localeCompare(b.at))) {
    if (o.action === "created") made[o.org] = o.at;
    if (o.action === "deleted" && made[o.org]) { orgHours += (new Date(o.at) - new Date(made[o.org])) / HOUR; delete made[o.org]; }
  }
  const roles = {};
  for (const a of agents) {
    const r = (roles[a.role] ||= { runs: 0, usd: 0, turns: [], minutes: [] });
    r.runs++; r.usd += Number(a.usd) || 0; r.turns.push(Number(a.turns) || 0); r.minutes.push(Number(a.minutes) || 0);
  }
  const fixRounds = {};
  for (const a of agents.filter((x) => x.role === "fix" && x.pr)) fixRounds[a.pr] = (fixRounds[a.pr] || 0) + 1;
  const firstReview = {};
  // the first real review per PR ("not needed" verdicts are not reviews)
  for (const v of of("verdict").filter((x) => x.context === "pipeline/ai-review" && !/^not needed/.test(x.why || "")).sort((a, b) => a.at.localeCompare(b.at))) firstReview[v.pr || v.story || v.sha] ??= v.state;
  const reviewed = Object.values(firstReview);

  return {
    days, events: events.length,
    dora: {
      deploymentsPerWeek: r1((releases.length * 7) / days),
      leadTimeHours: r1(median(lead)),                   // story started -> in production
      changeFailureRate: pct(hotfixReleases.length + rollbacks.length, releases.length),
      timeToRestoreHours: r1(median(restore)),            // hotfix started -> in production
    },
    counts: { releases: releases.length, hotfixReleases: hotfixReleases.length, rollbacks: rollbacks.length, storiesShipped: lead.length },
    stages: {
      tests: { runs: tests.length, passRate: pct(tests.filter((t) => t.ok).length, tests.length), medianMinutesRelevant: r1(median(tests.filter((t) => t.mode === "relevant").map((t) => t.seconds / 60))), medianMinutesAll: r1(median(tests.filter((t) => t.mode === "all").map((t) => t.seconds / 60))) },
      validation: { runs: vals.length, passRate: pct(vals.filter((v) => v.ok).length, vals.length), medianMinutes: r1(median(vals.map((v) => v.seconds / 60))) },
      lanes: { waits: lanes.length, medianMinutes: r1(median(lanes.map((l) => l.waitedSeconds / 60))), totalMinutes: r1(lanes.reduce((a, l) => a + l.waitedSeconds / 60, 0)) },
      evidence: { posts: shots.filter((e) => e.shots > 0).length, shots: shots.reduce((a, e) => a + (Number(e.shots) || 0), 0), rejected: shots.reduce((a, e) => a + (Number(e.rejected) || 0), 0),
        medianKbPerShot: r1(median(shots.filter((e) => e.shots > 0).map((e) => e.kb / e.shots))), totalKb: shots.reduce((a, e) => a + (Number(e.kb) || 0), 0) },
      orgs: { created: orgs.filter((o) => o.action === "created").length, completed: orgs.filter((o) => o.action === "completed").length, deleted: orgs.filter((o) => o.action === "deleted").length, orgHours: r1(orgHours) },
    },
    gateWaits: Object.entries(gateWaits).map(([reason, prs]) => ({ reason, prs: prs.size })).sort((a, b) => b.prs - a.prs).slice(0, 5),
    failedStages: Object.entries(failedStages).map(([what, n]) => ({ what, n })).sort((a, b) => b.n - a.n).slice(0, 5),
    ai: {
      byRole: Object.fromEntries(Object.entries(roles).sort().map(([k, r]) => [k, { runs: r.runs, usd: Math.round(r.usd * 100) / 100, perRunUsd: Math.round((r.usd / r.runs) * 100) / 100, medianTurns: median(r.turns), medianMinutes: r1(median(r.minutes)) }])),
      totalUsd: Math.round(agents.reduce((a, x) => a + (Number(x.usd) || 0), 0) * 100) / 100,
      medianFixRounds: median(Object.values(fixRounds)),
      passedFirstReview: pct(reviewed.filter((s) => s === "success").length, reviewed.length),
    },
  };
}

export function toMarkdown(s) {
  const runs = (n) => `${n} run${n === 1 ? "" : "s"}`;
  const v = (x, unit = "") => (x === null || x === undefined ? "n/a" : `${x}${unit}`);
  return [
    `## Delivery metrics from the event log, last ${s.days} days (${s.events} events)`, "",
    "| DORA | value |", "|---|---|",
    `| Deployment frequency | ${v(s.dora.deploymentsPerWeek)} releases/week (${s.counts.releases} releases) |`,
    `| Lead time (story started to in production) | ${v(s.dora.leadTimeHours, " h")} median over ${s.counts.storiesShipped} stories |`,
    `| Change failure rate ((hotfix releases + rollbacks) / releases) | ${v(s.dora.changeFailureRate, "%")} (${s.counts.hotfixReleases} hotfix, ${s.counts.rollbacks} rollback) |`,
    `| Time to restore (hotfix started to in production) | ${v(s.dora.timeToRestoreHours, " h")} |`, "",
    "| Stage | value |", "|---|---|",
    `| Scratch-org tests | ${runs(s.stages.tests.runs)}, ${v(s.stages.tests.passRate, "%")} pass; median ${v(s.stages.tests.medianMinutesRelevant, " min")} (story) / ${v(s.stages.tests.medianMinutesAll, " min")} (all) |`,
    `| Production validation | ${runs(s.stages.validation.runs)}, ${v(s.stages.validation.passRate, "%")} pass; median ${v(s.stages.validation.medianMinutes, " min")} |`,
    `| Waiting for an org's lane | ${s.stages.lanes.waits} waits, median ${v(s.stages.lanes.medianMinutes, " min")}, ${v(s.stages.lanes.totalMinutes, " runner-min")} in all |`,
    `| UI evidence | ${s.stages.evidence.posts} posts, ${s.stages.evidence.shots} screenshots (${s.stages.evidence.rejected} refused); median ${v(s.stages.evidence.medianKbPerShot, " KB")} each, ${s.stages.evidence.totalKb} KB in all |`,
    `| Scratch orgs | ${s.stages.orgs.created} created, ${s.stages.orgs.completed} finished after a failure, ${s.stages.orgs.deleted} deleted; ${v(s.stages.orgs.orgHours, " org-hours")} |`, "",
    "| What PRs waited on most (gate) | PRs |", "|---|---|",
    ...(s.gateWaits.length ? s.gateWaits.map((g) => `| ${g.reason} | ${g.prs} |`) : ["| nothing recorded | |"]), "",
    "| Stage that failed most | times |", "|---|---|",
    ...(s.failedStages.length ? s.failedStages.map((f) => `| ${f.what} | ${f.n} |`) : ["| none | |"]), "",
    "| AI role | runs | cost (API-equivalent) | per run | median turns | median minutes |", "|---|---|---|---|---|---|",
    ...Object.entries(s.ai.byRole).map(([n, r]) => `| ${n} | ${r.runs} | $${r.usd.toFixed(2)} | $${r.perRunUsd.toFixed(2)} | ${v(r.medianTurns)} | ${v(r.medianMinutes)} |`),
    `| **total** | | **$${s.ai.totalUsd.toFixed(2)}** | | | |`, "",
    `AI review passed first time on ${v(s.ai.passedFirstReview, "%")} of PRs; median AI fix rounds ${v(s.ai.medianFixRounds)}.`,
  ].join("\n");
}
