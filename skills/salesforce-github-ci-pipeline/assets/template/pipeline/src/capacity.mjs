// Capacity (see references/capacity.md in the skill): how much load this pipeline carries for a team. `pipe org
// capacity` reads the Dev Hub's scratch-org allowances and the UI specs, takes the team's shape from flags, and says how
// many stories can be in flight, how long the staging UI regression takes (one browser, one runner: a Lightning page is
// CPU-heavy, #268) and what a month costs. plan() is pure; gather() reads.
import { readdirSync, readFileSync, existsSync } from "node:fs";

/** Measured on the reference pipeline (Oct 2026, 2-core GitHub runners); every one can be overridden. */
export const MEASURED = {
  testSeconds: 35,          // one UI test on the staging org (35 tests in 18 min)
  deployMinutes: 3.5,       // the release branch into the staging org
  apexMinutes: 2.5,         // every Apex and Flow test (grows with the code)
  storyMinutes: 42,         // billed per story: start 9, build 8, CI 8, review 3, UI test 12, gate 2
  releaseOtherMinutes: 15,  // per release besides staging: UAT (warm), validation, deploy, close-out, back-merge
  fixedMonthlyMinutes: 250, // janitor, snapshot refresh, baseline, metrics, CI on main
  usdPerMinute: 0.006,      // a standard 2-core Linux runner
  aiUsdPerStory: 2.5,       // Claude build, review, fix and UI test, all switches on
  reservedOrgs: 1,          // staging holds an active scratch org all sprint (UAT's stand-in is counted apart: plan())
  uiWarnMinutes: 20,        // a staging UI regression longer than this is worth a look (it grows with every story)
  uiStepMinutes: 45,        // the UI regression step's own timeout in staging-deploy.yml (the lane wait is outside it)
};

/** The staging UI regression against its step's budget: { minutes, budget, near } (near: past 70% of it, the point to
 *  split the specs across runners with Playwright's --shard before a release's regression times out). Pure. */
export function uiBudget(tests, m = MEASURED) {
  const minutes = round((tests * m.testSeconds) / 60);
  return { minutes, budget: m.uiStepMinutes, near: minutes > 0.7 * m.uiStepMinutes };
}

/**
 * The plan for a team. devhub { activeMax, dailyMax, activeUsed (active orgs other projects hold: never this pipeline's
 * staging, UAT or story orgs, which the plan counts itself) }, team { devs,
 * storiesPerSprint, sprintDays, inFlight }, ui { tests, testSeconds }, uatSandbox (UAT needs no scratch org), uiPolicy
 * (UI_REGRESSION: "release", the UI regression once per release; "every", on every staging run).
 * Returns { orgs, ui, cost, advice[] }. Pure.
 */
export function plan({ devhub = {}, team = {}, ui = {}, uatSandbox = false, uiPolicy = "release", m = MEASURED } = {}) {
  const devs = team.devs || 2, sprintDays = team.sprintDays || 10, stories = team.storiesPerSprint || devs * 3;
  const inFlight = team.inFlight || devs;
  const reserved = m.reservedOrgs + (devhub.activeUsed || 0);
  // UAT's scratch stand-in holds a slot while a release is in UAT (none with a UAT sandbox), and the next sprint's stories
  // are in flight then: they overlap (30 Oct: staging and UAT both live left one story slot of three, #418). So the
  // stories that always fit count it; between releases one more does.
  const uat = uatSandbox ? 0 : 1;
  const inFlightMaxBetween = Math.max(0, (devhub.activeMax ?? 3) - reserved);
  const inFlightMax = Math.max(0, inFlightMaxBetween - uat);
  const dailyNeeded = Math.ceil(inFlight / 2 + (reserved + uat) / sprintDays);   // a story org lives ~2 days; staging and UAT's stand-in per sprint
  const orgs = { activeMax: devhub.activeMax ?? null, dailyMax: devhub.dailyMax ?? null, inFlight, inFlightMax, inFlightMaxBetween, uatStandIn: uat, activeNeeded: reserved + uat + inFlight, atRelease: reserved + uat, dailyNeeded };

  const sec = ui.testSeconds || m.testSeconds, tests = ui.tests || 0;
  const uiOut = { tests, minutes: round((tests * sec) / 60), perStoryMinutes: round((2.5 * sec) / 60) };

  // a staging run per story merge (deploy, Apex and Flow); the UI regression on each of them ("every") or once per release
  const every = uiPolicy === "every", mergeMinutes = m.deployMinutes + m.apexMinutes + (every ? uiOut.minutes : 0);
  const releasesPerMonth = 21 / sprintDays, storiesPerMonth = stories * releasesPerMonth;
  const uiPerMonth = every ? 0 : releasesPerMonth * (1 + uiOut.minutes);   // the release's UI run: the org already holds the code
  const monthlyMinutes = m.fixedMonthlyMinutes + storiesPerMonth * (m.storyMinutes + mergeMinutes) + uiPerMonth + releasesPerMonth * m.releaseOtherMinutes;
  const cost = { mergeMinutes: round(mergeMinutes), uiPolicy, storiesPerMonth: round(storiesPerMonth), monthlyMinutes: Math.round(monthlyMinutes),
    monthlyActionsUsd: round(monthlyMinutes * m.usdPerMinute), monthlyAiUsd: round(storiesPerMonth * m.aiUsdPerStory) };

  const advice = [];
  // a bigger Dev Hub only when the team does not fit even between releases; UAT's stand-in alone is a sandbox's job
  if (inFlight > inFlightMaxBetween) advice.push(`The Dev Hub allows ${orgs.activeMax} active scratch orgs: with staging${devhub.activeUsed ? ` and ${devhub.activeUsed} held outside the pipeline` : ""} that is ${plural(inFlightMaxBetween, "story", "stories")} in flight${uat ? ` between releases, ${inFlightMax} while a release is in UAT (its scratch stand-in takes a slot)` : ""}, not ${inFlight}. Move the Dev Hub to an Enterprise or Unlimited org (far higher allowances)${uat ? ", use a sandbox for UAT (SF_UAT_USERNAME)" : ""}, or keep fewer stories in flight; the rest wait in line (waiting:org).`);
  else if (inFlight > inFlightMax) { const wait = inFlight - inFlightMax; advice.push(`While a release is in UAT its scratch stand-in takes a slot: ${wait} of the ${inFlight} stories ${wait === 1 ? "waits" : "wait"} (waiting:org). UAT on a sandbox (SF_UAT_USERNAME) frees it.`); }
  if (orgs.dailyMax !== null && dailyNeeded > orgs.dailyMax) advice.push(`About ${dailyNeeded} scratch orgs a day are needed and the Dev Hub allows ${orgs.dailyMax}.`);
  if (every && stories > 1) advice.push(`UI_REGRESSION=every runs the UI regression on each of the ${stories} story merges a sprint; the default (once per release) saves about ${Math.round((stories - 1) * uiOut.minutes)} min a sprint.`);
  if (uiBudget(tests, { ...m, testSeconds: sec }).near) advice.push(`The staging UI regression (about ${uiOut.minutes} min) is near its ${m.uiStepMinutes}-minute step budget: split the specs across runners (Playwright --shard, a matrix in staging-deploy.yml) before it times out.`);
  else if (uiOut.minutes > m.uiWarnMinutes) advice.push(`The staging UI regression takes about ${uiOut.minutes} min and grows about ${uiOut.perStoryMinutes} min with every story. Retire specs whose stories are covered elsewhere, and keep each story's spec to its acceptance criteria.`);
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

/** uiBudget for the specs in `dir` (null without any), with the line a person reads. */
export function uiBudgetOf(dir = "e2e") {
  if (!existsSync(dir)) return null;
  const b = uiBudget(countSpecs(dir));
  return { ...b, note: b.near ? `the UI regression takes about ${b.minutes} min of its ${b.budget}-minute budget: split the specs across runners (Playwright --shard) before it times out` : `UI regression: about ${b.minutes} of ${b.budget} min` };
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
    `- **Stories in flight:** ${p.orgs.inFlight} wanted, ${p.orgs.inFlightMax} possible${p.orgs.uatStandIn ? ` while a release is in UAT (${p.orgs.inFlightMaxBetween} between releases)` : ""} (${p.orgs.activeMax ?? "?"} active scratch orgs; ${p.orgs.activeNeeded} needed with staging${p.orgs.uatStandIn ? " and UAT's stand-in" : ""}, ${p.orgs.atRelease} for the release alone). About ${p.orgs.dailyNeeded} new orgs a day (allowance ${p.orgs.dailyMax ?? "?"}).`,
    `- **Staging:** about ${p.cost.mergeMinutes} min per story merge; the UI regression (${p.ui.tests} tests, about ${p.ui.minutes} min, one browser) ${p.cost.uiPolicy === "every" ? "on every merge (UI_REGRESSION=every)" : "once per release"}.`,
    `- **Cost a month:** about ${p.cost.monthlyMinutes} Actions minutes ($${p.cost.monthlyActionsUsd}) for ${p.cost.storiesPerMonth} stories when nothing fails, plus about $${p.cost.monthlyAiUsd} of Claude with every AI switch on. Failures and re-runs add to it: keep a margin.`,
    "",
    ...p.advice.map((a) => `- ${a}`),
  ].join("\n");
}
