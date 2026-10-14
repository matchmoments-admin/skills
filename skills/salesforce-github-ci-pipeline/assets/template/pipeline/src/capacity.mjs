// Capacity (see references/capacity.md in the skill): how much load this pipeline carries for a team. `pipe org
// capacity` reads the Dev Hub's scratch-org allowances and the UI specs, takes the team's shape from flags, and says how
// many stories can be in flight, how long the staging UI regression takes (one browser, one runner: a Lightning page is
// CPU-heavy, #268) and what a month costs. plan() is pure; gather() reads.
import { readdirSync, readFileSync, existsSync } from "node:fs";

/** Measured on this pipeline (sf-lifecycle-labs, Oct 2026, 2-core GitHub runners); every one can be overridden. */
export const MEASURED = {
  testSeconds: 35,          // one UI test on the staging org (35 tests in 18 min)
  deployMinutes: 3.5,       // the release branch into the staging org
  apexMinutes: 2.5,         // every Apex and Flow test (grows with the code)
  storyMinutes: 42,         // billed per story: start 9, build 8, CI 8, review 3, UI test 12, gate 2
  releaseOtherMinutes: 15,  // per release besides staging: UAT (warm), validation, deploy, close-out, back-merge
  fixedMonthlyMinutes: 250, // janitor, snapshot refresh, baseline, metrics, CI on main
  usdPerMinute: 0.006,      // a standard 2-core Linux runner
  aiUsdPerStory: 2.5,       // Claude build, review, fix and UI test, all switches on
  reservedOrgs: 1,          // staging holds an active scratch org all sprint; UAT's comes at release, after story orgs end
  uiWarnMinutes: 20,        // a staging UI regression longer than this is worth a look (it grows with every story)
};

/**
 * The plan for a team. devhub { activeMax, dailyMax, activeUsed (held outside the pipeline) }, team { devs,
 * storiesPerSprint, sprintDays, inFlight }, ui { tests, testSeconds }, uatSandbox (UAT needs no scratch org).
 * Returns { orgs, ui, cost, advice[] }. Pure.
 */
export function plan({ devhub = {}, team = {}, ui = {}, uatSandbox = false, m = MEASURED } = {}) {
  const devs = team.devs || 2, sprintDays = team.sprintDays || 10, stories = team.storiesPerSprint || devs * 3;
  const inFlight = team.inFlight || devs;
  const reserved = m.reservedOrgs + (devhub.activeUsed || 0);
  const inFlightMax = Math.max(0, (devhub.activeMax ?? 3) - reserved);
  const dailyNeeded = Math.ceil(inFlight / 2 + (reserved + 1) / sprintDays);   // a story org lives ~2 days; staging, UAT, snapshot per sprint
  // at release, UAT's scratch stand-in needs a slot too (none with a UAT sandbox): story orgs are gone by then
  const orgs = { activeMax: devhub.activeMax ?? null, dailyMax: devhub.dailyMax ?? null, inFlight, inFlightMax, activeNeeded: reserved + inFlight, atRelease: reserved + (uatSandbox ? 0 : 1), dailyNeeded };

  const sec = ui.testSeconds || m.testSeconds, tests = ui.tests || 0;
  const uiOut = { tests, minutes: round((tests * sec) / 60), perStoryMinutes: round((2.5 * sec) / 60) };

  const stagingMinutes = m.deployMinutes + m.apexMinutes + uiOut.minutes;
  const releasesPerMonth = 21 / sprintDays, storiesPerMonth = stories * releasesPerMonth;
  const monthlyMinutes = m.fixedMonthlyMinutes + storiesPerMonth * m.storyMinutes + releasesPerMonth * (stagingMinutes + m.releaseOtherMinutes);
  const cost = { stagingMinutes: round(stagingMinutes), storiesPerMonth: round(storiesPerMonth), monthlyMinutes: Math.round(monthlyMinutes),
    monthlyActionsUsd: round(monthlyMinutes * m.usdPerMinute), monthlyAiUsd: round(storiesPerMonth * m.aiUsdPerStory) };

  const advice = [];
  if (inFlight > inFlightMax) advice.push(`The Dev Hub allows ${orgs.activeMax} active scratch orgs: with staging${devhub.activeUsed ? ` and ${devhub.activeUsed} held outside the pipeline` : ""} that is ${plural(inFlightMax, "story", "stories")} in flight, not ${inFlight}. Move the Dev Hub to an Enterprise or Unlimited org (far higher allowances), use a sandbox for UAT (SF_UAT_USERNAME), or keep fewer stories in flight; the rest wait in line (waiting:org).`);
  if (orgs.dailyMax !== null && dailyNeeded > orgs.dailyMax) advice.push(`About ${dailyNeeded} scratch orgs a day are needed and the Dev Hub allows ${orgs.dailyMax}.`);
  if (uiOut.minutes > m.uiWarnMinutes) advice.push(`The staging UI regression takes about ${uiOut.minutes} min and grows about ${uiOut.perStoryMinutes} min with every story. Retire specs whose stories are covered elsewhere, and keep each story's spec to its acceptance criteria.`);
  if (!advice.length) advice.push("The defaults carry this load.");
  return { orgs, ui: uiOut, cost, advice };
}

const round = (n) => Math.round(n * 10) / 10;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The UI specs' test count. */
export function countSpecs(dir = "e2e", read = (f) => readFileSync(f, "utf8")) {
  if (!existsSync(dir)) return { tests: 0 };
  let tests = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".spec.ts"))) tests += (read(`${dir}/${f}`).match(/\btest\(\s*["'`]/g) || []).length;
  return { tests };
}

/** Live inputs: the Dev Hub's allowances (orgs.limits()) and the specs; the team's shape from flags. */
export function gather({ limits, flag = () => null, has = () => false, specs = countSpecs() }) {
  const l = limits();
  const num = (n, d) => (flag(n) ? Number(flag(n)) : d);
  return {
    devhub: { activeMax: l.active.max, dailyMax: l.daily.max, activeUsed: num("in-use", 0) },
    team: { devs: num("devs", 2), storiesPerSprint: num("stories", undefined), sprintDays: num("sprint-days", 10), inFlight: num("in-flight", undefined) },
    ui: { ...specs, testSeconds: num("test-seconds", undefined) },
    uatSandbox: has("uat-sandbox"),
  };
}

/** The plan as Markdown (for a terminal or an issue). */
export function report(p) {
  return [
    "## Pipeline capacity",
    "",
    `- **Stories in flight:** ${p.orgs.inFlight} wanted, ${p.orgs.inFlightMax} possible (${p.orgs.activeMax ?? "?"} active scratch orgs; ${p.orgs.activeNeeded} needed with staging, ${p.orgs.atRelease} at release with UAT). About ${p.orgs.dailyNeeded} new orgs a day (allowance ${p.orgs.dailyMax ?? "?"}).`,
    `- **Staging regression:** about ${p.cost.stagingMinutes} min (UI: ${p.ui.tests} tests, about ${p.ui.minutes} min, one browser).`,
    `- **Cost a month:** about ${p.cost.monthlyMinutes} Actions minutes ($${p.cost.monthlyActionsUsd}) for ${p.cost.storiesPerMonth} stories when nothing fails, plus about $${p.cost.monthlyAiUsd} of Claude with every AI switch on. Failures and re-runs add to it: keep a margin.`,
    "",
    ...p.advice.map((a) => `- ${a}`),
  ].join("\n");
}
