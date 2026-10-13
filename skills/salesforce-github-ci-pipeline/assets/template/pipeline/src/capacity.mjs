// Capacity (see references/capacity.md in the skill): how much load this pipeline can carry, and what to set to carry
// more. `pipe capacity` reads the Dev Hub's scratch-org allowances, production's user licences and the UI specs, takes
// the team's shape from flags, and says how many stories can be in flight, what the staging regression will take, which
// scale settings to use (UI_SHARDS, UI_RUNNER, UI_WORKERS) and what a month costs. plan() is pure; gather() reads.
import { readdirSync, readFileSync, existsSync } from "node:fs";

/** Measured on this pipeline (sf-lifecycle-labs, Oct 2026, 2-core GitHub runners); every one can be overridden. */
export const MEASURED = {
  testSeconds: 35,          // one UI test, one browser on a 2-core runner (staging: 35 tests in 18 min)
  shardSetupMinutes: 2.5,   // a UI shard's own checkout, login, browser install
  deployMinutes: 3.5,       // the release branch into the staging org
  apexMinutes: 2.5,         // every Apex and Flow test (grows with the code)
  storyMinutes: 42,         // billed per story: start 9, build 8, CI 8, review 3, UI test 12, gate 2
  releaseOtherMinutes: 15,  // per release besides staging: UAT (warm), validation, deploy, close-out, back-merge
  usdPerMinute: 0.006,      // a standard 2-core Linux runner; larger runners cost about the same per core
  aiUsdPerStory: 2.5,       // Claude build, review, fix and UI test, all switches on
  reservedOrgs: 1,          // staging holds an active scratch org all sprint; UAT's comes at release, after story orgs end
  fixedMonthlyMinutes: 250, // janitor every 6 h, snapshot refresh, baseline, metrics, CI on main
};

/**
 * The plan for a team. devhub { activeMax, dailyMax, activeUsed }, team { devs, storiesPerSprint, sprintDays,
 * inFlight }, ui { tests, personaTests, testSeconds }, runner { cores }, personaSlots (persona specs that may run at
 * once: 1 in a scratch org with few user licences), uatSandbox (UAT needs no scratch org), targetMinutes (the staging
 * UI regression's wall time to aim for). Returns { orgs, ui, cost, settings, advice[] }. Pure.
 */
export function plan({ devhub = {}, team = {}, ui = {}, runner = {}, personaSlots = 1, uatSandbox = false, targetMinutes = 10, m = MEASURED } = {}) {
  const devs = team.devs || 2, sprintDays = team.sprintDays || 10, stories = team.storiesPerSprint || devs * 3;
  const inFlight = team.inFlight || devs;
  const reserved = m.reservedOrgs + (devhub.activeUsed || 0);   // activeUsed: orgs held outside the pipeline
  const inFlightMax = Math.max(0, (devhub.activeMax ?? 3) - reserved);
  const dailyNeeded = Math.ceil(inFlight / 2 + (reserved + 1) / sprintDays);   // a story org lives ~2 days; staging, UAT, snapshot per sprint
  // at release, UAT's scratch stand-in needs a slot too (none with a UAT sandbox): story orgs are gone by then, unless a
  // fix story runs during the release (#254)
  const orgs = { activeMax: devhub.activeMax ?? null, dailyMax: devhub.dailyMax ?? null, inFlight, inFlightMax, activeNeeded: reserved + inFlight, atRelease: reserved + (uatSandbox ? 0 : 1), dailyNeeded };

  const sec = ui.testSeconds || m.testSeconds, tests = ui.tests || 0, persona = Math.min(ui.personaTests || 0, tests);
  const workers = Math.max(1, Math.floor((runner.cores || 2) / 2));   // one Lightning browser per 2 cores (#268)
  const personaMin = (persona * sec) / 60 / Math.max(1, personaSlots), otherMin = ((tests - persona) * sec) / 60;
  const wall = (s) => (s === 1
    ? (workers > 1 ? Math.max(personaMin, otherMin / Math.max(1, workers - (persona ? 1 : 0))) : personaMin + otherMin)
    : Math.max(persona ? personaMin : 0, otherMin / ((persona ? s - 1 : s) * workers)) + m.shardSetupMinutes);
  let shards = 1;
  for (let s = 2; s <= 8 && wall(shards) > targetMinutes; s++) if (wall(s) < wall(shards) - 0.5) shards = s;
  const uiOut = { tests, personaTests: persona, workers, serialMinutes: round(personaMin + otherMin), shards, wallMinutes: round(wall(shards)), personaFloorMinutes: round(personaMin) };

  const coreFactor = Math.max(1, (runner.cores || 2) / 2);
  const stagingBilled = m.deployMinutes + m.apexMinutes + (shards > 1 ? personaMin + otherMin / workers + shards * m.shardSetupMinutes : uiOut.wallMinutes) * coreFactor;
  const releasesPerMonth = 21 / sprintDays, storiesPerMonth = stories * releasesPerMonth;
  const monthlyMinutes = m.fixedMonthlyMinutes + storiesPerMonth * m.storyMinutes + releasesPerMonth * (stagingBilled + m.releaseOtherMinutes);
  const cost = { stagingBilledMinutes: round(stagingBilled), storiesPerMonth: round(storiesPerMonth), monthlyMinutes: Math.round(monthlyMinutes),
    monthlyActionsUsd: round(monthlyMinutes * m.usdPerMinute), monthlyAiUsd: round(storiesPerMonth * m.aiUsdPerStory) };

  const settings = { UI_SHARDS: shards > 1 ? String(shards) : null, UI_RUNNER: (runner.cores || 2) > 2 ? runner.label || `${runner.cores}-core runner label` : null, UI_WORKERS: workers > 1 ? String(workers) : null };
  const advice = [];
  if (inFlight > inFlightMax) advice.push(`The Dev Hub allows ${orgs.activeMax} active scratch orgs: with staging${devhub.activeUsed ? ` and ${devhub.activeUsed} held outside the pipeline` : ""} that is ${plural(inFlightMax, "story", "stories")} in flight, not ${inFlight}. Move the Dev Hub to an Enterprise or Unlimited org (far higher allowances), use a sandbox for staging or UAT (SF_UAT_USERNAME), or keep fewer stories in flight; the rest wait in line (waiting:org).`);
  if (orgs.dailyMax !== null && dailyNeeded > orgs.dailyMax) advice.push(`About ${dailyNeeded} scratch orgs a day are needed and the Dev Hub allows ${orgs.dailyMax}.`);
  if (shards > 1) advice.push(`Set UI_SHARDS=${shards}: the staging UI regression takes about ${uiOut.wallMinutes} min instead of ${uiOut.serialMinutes}, for about ${round(shards * m.shardSetupMinutes)} more billed minutes a release.`);
  if (persona && personaMin > targetMinutes) advice.push(`The persona specs are the floor (${uiOut.personaFloorMinutes} min): they run one at a time because they share the org's user licences. A staging sandbox has production's licences (raise personaSlots), or keep persona checks to the criteria that need them.`);
  if ((runner.cores || 2) <= 2 && wall(shards) > targetMinutes * 1.5) advice.push("Larger runners (GitHub Team or Enterprise, or self-hosted): set UI_RUNNER to a 4- or 8-core label and UI_WORKERS to half its cores. Never more browsers than cores/2: Lightning is CPU-heavy and specs time out.");
  if (!advice.length) advice.push("The defaults carry this load.");
  return { orgs, ui: uiOut, cost, settings, advice };
}

const round = (n) => Math.round(n * 10) / 10;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The UI specs: test count and how many log in as a persona (loginAs). */
export function countSpecs(dir = "e2e", read = (f) => readFileSync(f, "utf8")) {
  if (!existsSync(dir)) return { tests: 0, personaTests: 0 };
  let tests = 0, personaTests = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".spec.ts"))) {
    const text = read(`${dir}/${f}`), n = (text.match(/\btest\(\s*["'`]/g) || []).length;
    tests += n;
    if (text.includes("loginAs(")) personaTests += n;
  }
  return { tests, personaTests };
}

/** Live inputs: the Dev Hub's allowances (orgs.limits()) and the specs; the team's shape from flags. */
export function gather({ limits, flag = () => null, specs = countSpecs() }) {
  const l = limits();
  const num = (n, d) => (flag(n) ? Number(flag(n)) : d);
  return {
    devhub: { activeMax: l.active.max, dailyMax: l.daily.max, activeUsed: num("in-use", 0) },
    team: { devs: num("devs", 2), storiesPerSprint: num("stories", undefined), sprintDays: num("sprint-days", 10), inFlight: num("in-flight", undefined) },
    ui: { ...specs, testSeconds: num("test-seconds", undefined) },
    runner: { cores: num("cores", 2) },
    targetMinutes: num("target", 10),
  };
}

/** The plan as Markdown (for a terminal or an issue). */
export function report(p) {
  const set = Object.entries(p.settings).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ") || "none (the defaults)";
  return [
    "## Pipeline capacity",
    "",
    `- **Stories in flight:** ${p.orgs.inFlight} wanted, ${p.orgs.inFlightMax} possible (${p.orgs.activeMax ?? "?"} active scratch orgs; ${p.orgs.activeNeeded} needed with staging, ${p.orgs.atRelease} at release with UAT). About ${p.orgs.dailyNeeded} new orgs a day (allowance ${p.orgs.dailyMax ?? "?"}).`,
    `- **Staging UI regression:** ${p.ui.tests} tests (${p.ui.personaTests} as a persona): ${p.ui.serialMinutes} min on one browser; with ${p.ui.shards} runner(s) × ${p.ui.workers} browser(s) about **${p.ui.wallMinutes} min**.`,
    `- **Cost a month:** about ${p.cost.monthlyMinutes} Actions minutes ($${p.cost.monthlyActionsUsd}) for ${p.cost.storiesPerMonth} stories when nothing fails, plus about $${p.cost.monthlyAiUsd} of Claude with every AI switch on. Failures and re-runs add to it: keep a margin (the 13 Oct runs used about 3 times this).`,
    `- **Settings:** ${set}`,
    "",
    ...p.advice.map((a) => `- ${a}`),
  ].join("\n");
}
