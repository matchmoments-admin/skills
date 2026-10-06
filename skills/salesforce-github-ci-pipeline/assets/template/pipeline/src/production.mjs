// Production validation: a check-only deploy of exactly what will ship, with the tests the platform requires, watched
// live. validate() drives it through the io seam (async deploy, polled report, onProgress); progressOutput() is pure.
// The quick deploy afterwards reuses this validation and runs no tests.
//
// Test level: RunRelevantTests (Salesforce beta, Spring '26: the platform picks the Apex tests affected by what the
// deploy changes; 75% coverage per deployed class still applies) unless PROD_TEST_LEVEL says otherwise. If the org
// rejects the level, it falls back to every test class in the repo (RunSpecifiedTests), the previous behaviour.
// Flow tests never run in a deploy: they run in CI and in the staging regression.

import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const errors = [];
  const start = (lvl) => {
    try { return io.sf(["project", "deploy", "validate", "-o", org, ...source, ...levelArgs(lvl, allTests), "--async"]); }
    catch (e) { errors.push(`${lvl}: ${e.message}`); return null; }
  };
  let used = level;
  let started = start(level);
  if ((!started?.id) && level === "RunRelevantTests") { used = "all"; started = start("all"); }   // org does not offer the beta
  if (!started?.id) throw new Error(`could not start the production validation: ${errors.join(" | ") || "no deploy id returned"}`);
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

/**
 * Validate the checkout against production, live on a "Production validation" check: components removed since
 * `deletionsFrom` (the previous release) go as post-destructive changes, so the quick deploy removes them too.
 * Returns validate()'s result plus { out, seconds }.
 */
export function validateCheckout(io, { host, sha, level, deletionsFrom, sleep, log = () => {} }) {
  const src = io.sourceFiles();
  const allTests = src.files.filter((p) => p.endsWith(".cls")).filter((p) => /@istest/i.test(src.read(p))).map((p) => p.split("/").pop().replace(/\.cls$/, ""));
  let source = src.dirs.flatMap((d) => ["-d", d]);
  if (deletionsFrom) {
    const out = mkdtempSync(join(tmpdir(), "delta-"));
    io.run("sf", ["sgd", "source", "delta", "--from", deletionsFrom, "--to", "HEAD", "--output-dir", out, ...src.dirs.flatMap((d) => ["--source-dir", d])], { quiet: true, allowFail: true });
    const destructive = join(out, "destructiveChanges", "destructiveChanges.xml");
    if (existsSync(destructive) && readFileSync(destructive, "utf8").includes("<members>")) {
      log(`deleting since ${deletionsFrom}: ${[...readFileSync(destructive, "utf8").matchAll(/<members>([^<]+)/g)].map((m) => m[1]).join(", ")}`);
      io.run("sf", ["project", "generate", "manifest", ...src.dirs.flatMap((d) => ["--source-dir", d]), "--output-dir", out, "--name", "full"], { quiet: true });
      source = ["--manifest", join(out, "full.xml"), "--post-destructive-changes", destructive];
    }
  }
  const instance = io.sf(["org", "display", "-o", "devhub"], { allowFail: true })?.instanceUrl;
  const deployStatusUrl = instance ? `${instance.replace(".my.salesforce.com", ".lightning.force.com")}/lightning/setup/DeployStatus/home` : undefined;
  const check = host.checkRun(sha, "Production validation");
  log(`production validation with ${level} (fallback: every test class)`);
  const started = Date.now();
  const p = validate(io, {
    source, level, allTests, sleep,
    onProgress: (st) => { check.update(progressOutput(st, { deployStatusUrl })); log(`  ${st.status}: components ${st.components.done}/${st.components.total}, tests ${st.tests.done}/${st.tests.total}`); },
  });
  const out = progressOutput(p, { deployStatusUrl, done: true });
  check.update(out, p.ok ? "success" : "failure");
  return { ...p, out, seconds: Math.round((Date.now() - started) / 1000) };
}
