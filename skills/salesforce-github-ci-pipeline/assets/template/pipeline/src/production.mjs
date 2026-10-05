// Production validation: a check-only deploy of exactly what will ship, with the tests the platform requires, watched
// live. validate() drives it through the io seam (async deploy, polled report, onProgress); progressOutput() is pure.
// The quick deploy afterwards reuses this validation and runs no tests.
//
// Test level: RunRelevantTests (Salesforce beta, Spring '26: the platform picks the Apex tests affected by what the
// deploy changes; 75% coverage per deployed class still applies) unless PROD_TEST_LEVEL says otherwise. If the org
// rejects the level, it falls back to every test class in the repo (RunSpecifiedTests), the previous behaviour.
// Flow tests never run in a deploy: they run in CI and in the staging regression.

export const LEVELS = ["RunRelevantTests", "RunLocalTests", "all"];
const FINAL = ["Succeeded", "SucceededPartial", "Failed", "Canceled"];
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);

/** The --test-level arguments for a level; "all" lists every test class in the repo. */
export function levelArgs(level, allTests) {
  if (level === "all") return ["--test-level", "RunSpecifiedTests", ...allTests.flatMap((t) => ["--tests", t])];
  return ["--test-level", level];
}

const rejectsLevel = (msg) => /RunRelevantTests|test ?level|INVALID_TEST_LEVEL|not (enabled|supported|available)/i.test(String(msg));

/**
 * source: the deploy arguments (e.g. ["-d", "force-app"] or a manifest with post-destructive changes).
 * Returns { ok, id, level, status, components, tests, failures[], componentFailures[] }.
 */
export function validate(io, { org = "devhub", source, level = "RunRelevantTests", allTests = [], onProgress = () => {}, sleep, pollMs = 15000, maxPolls = 240 }) {
  const start = (lvl) => io.sf(["project", "deploy", "validate", "-o", org, ...source, ...levelArgs(lvl, allTests), "--async"], { allowFail: true });
  let used = level;
  let started = start(level);
  if ((!started?.id) && level === "RunRelevantTests") { used = "all"; started = start("all"); }   // org does not offer the beta
  if (!started?.id) throw new Error(`could not start the production validation (${used})`);
  const id = started.id;
  let r = {};
  for (let i = 0; i < maxPolls; i++) {
    r = io.sf(["project", "deploy", "report", "-o", org, "--job-id", id], { allowFail: true }) || {};
    onProgress(progress(id, used, r));
    if (r.done || FINAL.includes(r.status)) break;
    sleep(pollMs);
  }
  const p = progress(id, used, r);
  if (r.status !== "Succeeded" && used === "RunRelevantTests" && rejectsLevel(`${r.errorMessage || ""} ${r.errorStatusCode || ""}`)) {
    return validate(io, { org, source, level: "all", allTests, onProgress, sleep, pollMs, maxPolls });   // rejected late
  }
  return { ...p, ok: r.status === "Succeeded" };
}

function progress(id, level, r) {
  const rt = r.details?.runTestResult || {};
  return {
    id, level, status: r.status || "Queued",
    components: { done: Number(r.numberComponentsDeployed) || 0, total: Number(r.numberComponentsTotal) || 0, errors: Number(r.numberComponentErrors) || 0 },
    tests: { done: Number(r.numberTestsCompleted) || 0, total: Number(r.numberTestsTotal) || 0, errors: Number(r.numberTestErrors) || 0 },
    failures: arr(rt.failures).map((f) => ({ test: `${f.name}.${f.methodName}`, message: f.message || "", stack: f.stackTrace || "" })),
    componentFailures: arr(r.details?.componentFailures).map((c) => ({ name: c.fullName, type: c.componentType, problem: c.problem })),
    coverageWarnings: arr(rt.codeCoverageWarnings).map((w) => `${w.name || "org"}: ${w.message}`),
  };
}

/** The live "Production validation" check: where it is, which test level, and every failure. */
export function progressOutput(p, { deployStatusUrl, done = false } = {}) {
  const levelName = p.level === "all" ? "every test class (RunSpecifiedTests)" : p.level;
  const head = `components ${p.components.done}/${p.components.total} · tests ${p.tests.done}/${p.tests.total}`;
  const title = done ? `${p.ok ? "Passed" : "Failed"}: ${head}` : `${p.status}: ${head}`;
  const lines = [
    `**Check-only deploy to production** \`${p.id}\` with **${levelName}**.`,
    deployStatusUrl ? `Watch it in Salesforce: [Setup › Deployment Status](${deployStatusUrl}).` : "",
    p.level === "RunRelevantTests" ? "The platform chose the Apex tests affected by this deploy (Salesforce beta). Flow tests run in CI and staging, never in a deploy." : "",
  ].filter(Boolean);
  const fails = [
    ...p.componentFailures.map((c) => `| component | ${c.type} ${c.name} | ${String(c.problem).replace(/\|/g, "\\|")} |`),
    ...p.failures.map((f) => `| test | ${f.test} | ${String(f.message).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
    ...p.coverageWarnings.map((w) => `| coverage | | ${w.replace(/\|/g, "\\|")} |`),
  ];
  return { title, summary: lines.join("\n"), text: fails.length ? ["| | what | problem |", "|---|---|---|", ...fails].join("\n") : "" };
}
