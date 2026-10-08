// A test run: which tests a change needs (selectTests, pure), running them in an org with live progress (runTests,
// through the io seam), and what people see (checkOutput / summaryMarkdown, pure). CI, the staging regression and
// the story card all use this one module, so "what ran, and did it pass" has one answer.
//
// Selection rules (safe by default: when in doubt, everything):
//   a changed test class runs itself; a changed class runs every test class that names it;
//   a changed trigger or record-triggered Flow runs the test classes that name its object, plus the Flow's tests;
//   a changed field, validation rule, record type or object runs the test classes that name its object; a changed
//   permission set the test classes that name it (they assign it);
//   other metadata (layouts, pages, settings...), a deletion, or anything no test names: all local tests.
// The skill salesforce-scratch-org-tests runs this same file (its scripts/engine/tests.mjs is a verbatim copy, kept
// identical by scripts/skills-sync.sh and checked in CI), so both skills select tests alike.

const base = (p) => p.split("/").pop();
const isApex = (p) => /\.cls(-meta\.xml)?$/.test(p);
const isTrigger = (p) => /\.trigger(-meta\.xml)?$/.test(p);
const isFlow = (p) => /\/flows\/[^/]+\.flow-meta\.xml$/.test(p);
const isFlowTest = (p) => /\.flowtest-meta\.xml$/.test(p);
const flowOfTest = (src) => (src.match(/<flowApiName>([^<]+)<\/flowApiName>/) || [])[1];
const objectOf = (p) => (p.match(/\/objects\/([^/]+)\//) || [])[1] || null;
const isPermissionSet = (p) => p.endsWith(".permissionset-meta.xml");

/**
 * changed/deleted: source paths that differ from the base; files: every source path; read(path) -> text.
 * Returns { mode: "none" | "relevant" | "all", apex: [class], flows: ["Flow.Test"], why }.
 */
export function selectTests({ changed, deleted = [], files, read, mode = "relevant" }) {
  const flowTests = files.filter(isFlowTest).map((p) => `${flowOfTest(read(p))}.${base(p).replace(".flowtest-meta.xml", "")}`);
  const all = (why) => ({ mode: "all", apex: [], flows: flowTests, why });
  if (mode === "all") return all("all tests requested");   // first: a full run never depends on what changed
  if (!changed.length && !deleted.length) return { mode: "none", apex: [], flows: [], why: "no Salesforce source changed" };
  if (deleted.length) return all(`a deletion (${base(deleted[0])}) can affect anything`);

  const tests = files.filter((p) => p.endsWith(".cls")).filter((p) => /@istest/i.test(read(p)))
    .map((p) => ({ name: base(p).replace(/\.cls$/, ""), src: read(p) }));
  const naming = (word) => tests.filter((t) => new RegExp(`\\b${word}\\b`).test(t.src)).map((t) => t.name);
  const apex = new Set(), flows = new Set();

  for (const p of changed) {
    if (isApex(p)) {
      const n = base(p).replace(/\.cls(-meta\.xml)?$/, "");
      if (tests.some((t) => t.name === n)) { apex.add(n); continue; }
      const hit = naming(n);
      if (!hit.length) return all(`no test names ${n}`);
      hit.forEach((t) => apex.add(t));
    } else if (isTrigger(p)) {
      const src = read(p.replace(/-meta\.xml$/, ""));
      const obj = (src.match(/^\s*trigger\s+\w+\s+on\s+(\w+)/im) || [])[1];
      const hit = [...new Set([...naming(base(p).replace(/\.trigger(-meta\.xml)?$/, "")), ...(obj ? naming(obj) : [])])];
      if (!hit.length) return all(`no test covers trigger ${base(p)}`);
      hit.forEach((t) => apex.add(t));
    } else if (isFlow(p)) {
      const flow = base(p).replace(".flow-meta.xml", "");
      const start = (read(p).match(/<start>[\s\S]*?<\/start>/) || [""])[0];
      const obj = (start.match(/<object>([^<]+)<\/object>/) || [])[1];
      flowTests.filter((t) => t.startsWith(`${flow}.`)).forEach((t) => flows.add(t));
      if (obj) naming(obj).forEach((t) => apex.add(t));
    } else if (isFlowTest(p)) {
      flows.add(`${flowOfTest(read(p))}.${base(p).replace(".flowtest-meta.xml", "")}`);
    } else if (objectOf(p)) {
      // a field, validation rule, record type... (or the object itself) affects the tests that use its object
      const hit = naming(objectOf(p));
      if (!hit.length) return all(`no test names ${objectOf(p)} (changed ${base(p)})`);
      hit.forEach((t) => apex.add(t));
    } else if (isPermissionSet(p)) {
      const hit = naming(base(p).replace(".permissionset-meta.xml", ""));
      if (!hit.length) return all(`no test names permission set ${base(p)}`);
      hit.forEach((t) => apex.add(t));
    } else {
      return all(`${base(p)} is metadata that can affect anything`);
    }
  }
  if (!apex.size && !flows.size) return all("nothing specific found");
  return { mode: "relevant", apex: [...apex].sort(), flows: [...flows].sort(), why: `${changed.length} changed file(s)` };
}

/** Changed non-test Apex classes and triggers: in a relevant run, each must reach the coverage minimum. */
export const changedCode = (changed, files, read) =>
  [...new Set(changed.filter((p) => /\.(cls|trigger)$/.test(p)).filter((p) => !(p.endsWith(".cls") && files.includes(p) && /@istest/i.test(read(p))))
    .map((p) => base(p).replace(/\.(cls|trigger)$/, "")))];

/**
 * Run the plan in an org. onProgress(state) is called after every poll with
 * { phase: "apex" | "flows" | "done", apex: { classes, classesDone, ran, passed, failed, failures[] }, flows: {...} }.
 * Returns the final state plus coverage { [name]: percent } and orgWide.
 */
/**
 * Select, run and judge the tests a checkout needs against `base` (or all), live on a "Salesforce tests" check run.
 * onProgress(state, title) is for the story card. Returns { plan, state, result, seconds }; result is null when there
 * was nothing to run.
 */
export function runForCheckout(io, { host, alias, base, sha, all = false, min = 75, outDir, sleep, level = "RunRelevantTests", onProgress = () => {}, log = () => {} }) {
  const src = io.sourceFiles({ base });
  const plan = selectTests({ changed: src.changed, deleted: src.deleted, files: src.files, read: src.read, mode: all ? "all" : "relevant" });
  log(`tests: ${plan.mode} (${plan.why})${plan.mode === "relevant" ? `: ${[...plan.apex, ...plan.flows].join(", ")}` : ""}`);
  const check = host.checkRun(sha, "Salesforce tests");
  const started = Date.now();
  if (plan.mode === "none") { check.update({ title: "No Salesforce changes", summary: plan.why }, "success"); return { plan, state: null, result: null, seconds: 0 }; }
  const classPath = (cls) => src.files.find((p) => p.endsWith(`/${cls}.cls`)) || null;
  const progress = (st) => {
    const out = checkOutput(st, { plan, classPath });
    check.update(out);
    log(`  apex ${st.apex.passed}/${st.apex.ran} passed (${st.apex.classesDone}/${st.apex.classes} classes)${st.phase === "flows" ? " · flow tests running" : ""}`);
    onProgress(st, out.title.replace(/^Running: /, ""));
  };
  // a story's Apex tests: Salesforce's own choice (RunRelevantTests) when the org offers it and it ran some; else ours
  const relevant = plan.mode === "relevant" && level === "RunRelevantTests" ? runRelevant(io, { alias, changed: src.changed.filter((p) => src.files.includes(p)), sleep, onProgress: progress, log }) : null;
  if (relevant) Object.assign(plan, { apex: relevant.chosen, why: `${plan.why}; Apex tests chosen by Salesforce (RunRelevantTests)`, chosenBy: "salesforce" });
  const state = runTests(io, { alias, plan, sleep, outDir, onProgress: progress, apexDone: relevant?.state });
  const result = verdict(state, { plan, changedCode: changedCode(src.changed, src.files, src.read), min });
  check.update(checkOutput(state, { plan, result, classPath }), result.ok ? "success" : "failure");
  for (const f of [...state.apex.failures, ...state.flows.failures]) log(`  FAIL ${f.test}: ${f.message}`);
  return { plan, state, result, seconds: Math.round((Date.now() - started) / 1000) };
}

/**
 * RunRelevantTests (Salesforce beta, API 66+): validate just the changed components in the story org, where everything
 * is already deployed, and let the platform pick the Apex tests they affect (test classes declare
 * @IsTest(testFor='ApexClass:X') to be picked; critical=true always runs). Deploy and validate only: no
 * `sf apex run test` equivalent. Returns { chosen: [class], state } (state.apex and state.coverage filled), or null
 * when the org rejects the level or it ran no tests (it can run none silently), so the caller uses its own selection.
 */
export function runRelevant(io, { alias, changed, sleep, onProgress = () => {}, log = () => {}, pollMs = 15000, maxPolls = 80 }) {
  // a bundle (LWC, Aura) deploys as its folder; any other source file names its own component
  const parts = [...new Set(changed.filter((p) => p.startsWith("force-app/")).map((p) => p.match(/^(.*\/(?:lwc|aura)\/[^/]+)\//)?.[1] || p))];
  if (!parts.length) return null;
  let id;
  try { id = io.sf(["project", "deploy", "validate", "-o", alias, ...parts.flatMap((p) => ["--source-dir", p]), "--test-level", "RunRelevantTests", "--async"])?.id; }
  catch (e) { log(`RunRelevantTests not used (${String(e.message).slice(0, 200)}): our own test selection runs instead`); return null; }
  if (!id) return null;
  const state = { phase: "apex", apex: { classes: 0, classesDone: 0, ran: 0, passed: 0, failed: 0, failures: [], finished: false }, flows: { ran: 0, passed: 0, failed: 0, failures: [], finished: false }, coverage: {}, orgWide: null };
  let r = {};
  for (let i = 0; i < maxPolls; i++) {
    r = io.sf(["project", "deploy", "report", "-o", alias, "--job-id", id], { allowFail: true }) || {};
    Object.assign(state.apex, { ran: Number(r.numberTestsCompleted) || 0, failed: Number(r.numberTestErrors) || 0 });
    state.apex.passed = state.apex.ran - state.apex.failed;
    onProgress(state);
    if (r.done || ["Succeeded", "SucceededPartial", "Failed", "Canceled"].includes(r.status)) break;
    sleep(pollMs);
  }
  const rt = r.details?.runTestResult || {};
  const list = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  const ran = Number(rt.numTestsRun ?? r.numberTestsCompleted) || 0;
  if (!ran) { log(`RunRelevantTests ran no tests (${r.status || "no report"}${r.errorMessage ? `: ${r.errorMessage}` : ""}): our own test selection runs instead`); return null; }
  const failures = list(rt.failures).map((f) => ({ test: `${f.name}.${f.methodName}`, cls: f.name, message: f.message || "", stack: f.stackTrace || "" }));
  const chosen = [...new Set([...list(rt.successes), ...list(rt.failures)].map((t) => t.name).filter(Boolean))].sort();
  Object.assign(state.apex, { classes: chosen.length, classesDone: chosen.length, ran, passed: ran - failures.length, failed: failures.length, failures, finished: true, running: [] });
  for (const c of list(rt.codeCoverage)) {
    const all = Number(c.numLocations) || 0;
    if (all) state.coverage[c.name] = Math.round((100 * (all - (Number(c.numLocationsNotCovered) || 0))) / all);
  }
  log(`RunRelevantTests: Salesforce chose ${chosen.join(", ") || "no classes"} (${ran} tests)`);
  return { chosen, state };
}

export function runTests(io, { alias, plan, onProgress = () => {}, sleep, pollMs = 15000, maxPolls = plan.mode === "all" ? 240 : 80, outDir, apexDone = null }) {
  // maxPolls x pollMs: 20 minutes for a story's tests, 60 for everything (a large org); the jobs allow for it. A run
  // that does not finish is aborted, so the next job in the org's lane does not deploy under running tests.
  const state = { phase: "apex", apex: { classes: 0, classesDone: 0, ran: 0, passed: 0, failed: 0, failures: [], finished: false },
    flows: { ran: 0, passed: 0, failed: 0, failures: [], finished: false }, coverage: {}, orgWide: null };
  if (apexDone) Object.assign(state, { apex: apexDone.apex, coverage: apexDone.coverage });   // RunRelevantTests already ran them
  const runApex = !apexDone && (plan.mode === "all" || plan.apex.length > 0);
  if (runApex) {
    const level = plan.mode === "all" ? ["--test-level", "RunLocalTests"] : ["--test-level", "RunSpecifiedTests", ...plan.apex.flatMap((t) => ["--tests", t])];
    const id = io.sf(["apex", "run", "test", "-o", alias, ...level, "--code-coverage"]).testRunId;
    for (let i = 0; i < maxPolls; i++) {
      const items = io.sf(["data", "query", "-o", alias, "-q", `SELECT Id, Status, ApexClass.Name FROM ApexTestQueueItem WHERE ParentJobId = '${id}'`]).records || [];
      const results = io.sf(["data", "query", "-o", alias, "-q", `SELECT Outcome, MethodName, Message, StackTrace, ApexClass.Name FROM ApexTestResult WHERE AsyncApexJobId = '${id}'`]).records || [];
      const done = items.filter((q) => ["Completed", "Failed", "Aborted"].includes(q.Status)).length;
      Object.assign(state.apex, {
        classes: items.length, classesDone: done, ran: results.length,
        passed: results.filter((r) => r.Outcome === "Pass").length, failed: results.filter((r) => r.Outcome !== "Pass").length,
        failures: results.filter((r) => r.Outcome !== "Pass").map((r) => ({ test: `${r.ApexClass?.Name}.${r.MethodName}`, cls: r.ApexClass?.Name, message: r.Message || "", stack: r.StackTrace || "" })),
        running: items.filter((q) => q.Status === "Processing").map((q) => q.ApexClass?.Name),
      });
      onProgress(state);
      if (items.length && done === items.length) { state.apex.finished = true; break; }
      if (i === maxPolls - 1) {
        for (const q of items.filter((x) => ["Queued", "Holding", "Preparing", "Processing"].includes(x.Status))) {
          io.sf(["data", "update", "record", "-o", alias, "-s", "ApexTestQueueItem", "-i", q.Id, "-v", "Status=Aborted"], { allowFail: true });
        }
        break;
      }
      sleep(pollMs);
    }
    const final = io.sf(["apex", "get", "test", "-o", alias, "-i", id, "--code-coverage", ...(outDir ? ["--output-dir", `${outDir}/apex`] : [])], { allowFail: true });
    for (const c of final?.coverage?.coverage || []) state.coverage[c.name] = c.coveredPercent;
    state.orgWide = Number(String(final?.summary?.orgWideCoverage || "").replace("%", "")) || null;
  }
  if (plan.flows.length) {
    state.phase = "flows"; onProgress(state);
    const id = io.sf(["flow", "run", "test", "-o", alias, "--test-level", "RunSpecifiedTests", ...plan.flows.flatMap((t) => ["--tests", t])]).testRunId;
    for (let i = 0; i < maxPolls; i++) {
      const r = io.sf(["flow", "get", "test", "-o", alias, "--test-run-id", id, ...(outDir ? ["--output-dir", `${outDir}/flow`] : [])], { allowFail: true });
      const outcome = r?.summary?.outcome;
      if (["Passed", "Failed", "Completed"].includes(outcome)) {
        state.flows.finished = true;
        const tests = r.tests || [];
        Object.assign(state.flows, { ran: tests.length, passed: tests.filter((t) => /^pass/i.test(t.Outcome || t.outcome)).length,
          failed: tests.filter((t) => !/^pass/i.test(t.Outcome || t.outcome)).length,
          failures: tests.filter((t) => !/^pass/i.test(t.Outcome || t.outcome)).map((t) => ({ test: t.FullName || t.fullName, message: t.Message || t.message || "" })) });
        break;
      }
      sleep(pollMs);
    }
  }
  state.phase = "done";
  onProgress(state);
  return state;
}

/** Pass or fail, and why. Relevant runs gate the changed code's own coverage; full runs gate org-wide coverage. */
export function verdict(state, { plan, changedCode = [], min = 75 }) {
  const reasons = [];
  const apexPlanned = plan.mode === "all" || plan.apex.length > 0;
  if (apexPlanned && !state.apex.finished) reasons.push("the Apex tests did not finish in time");
  if (plan.mode === "all" && state.apex.finished && state.apex.ran === 0) reasons.push("no Apex tests ran in a full run");
  if (plan.flows.length && !state.flows.finished) reasons.push("the Flow tests did not finish in time");
  if (plan.mode === "all" && state.apex.ran > 0 && state.orgWide === null) reasons.push("org-wide coverage is unknown");
  if (state.apex.failed) reasons.push(`${state.apex.failed} Apex test(s) failed`);
  if (state.flows.failed) reasons.push(`${state.flows.failed} Flow test(s) failed`);
  if (plan.mode === "all" && state.orgWide !== null && state.orgWide < min) reasons.push(`org-wide coverage ${state.orgWide}% is below ${min}%`);
  if (plan.mode === "relevant") {
    for (const c of changedCode) {
      const pct = state.coverage[c];
      if (pct === undefined) reasons.push(`${c} has no coverage from the selected tests`);
      else if (pct < min) reasons.push(`${c} coverage ${pct}% is below ${min}%`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

const line = (stack) => Number((String(stack).match(/line (\d+)/) || [])[1]) || 1;

/** The GitHub check run's output: a title for the PR, a summary, and an annotation per failure. */
export function checkOutput(state, { plan, result = null, classPath = () => null }) {
  const a = state.apex, f = state.flows;
  const apexPart = plan.mode === "all" || plan.apex.length ? `Apex ${a.passed}/${a.ran}${a.classes ? ` (${a.classesDone}/${a.classes} classes)` : ""}` : null;
  const flowPart = plan.flows.length ? `Flow ${f.passed}/${f.ran || plan.flows.length}` : null;
  const parts = [apexPart, flowPart].filter(Boolean).join(" · ");
  const title = result ? `${result.ok ? "Passed" : "Failed"}: ${parts}` : `Running: ${parts}${a.running?.length ? ` · ${a.running[0]}` : ""}`;
  const summary = [
    `**Scope:** ${plan.mode === "all" ? "all local tests" : "tests for this change"} (${plan.why}).`,
    plan.mode === "relevant" ? `**Apex classes:** ${plan.apex.join(", ") || "none"} · **Flow tests:** ${plan.flows.join(", ") || "none"}` : "",
    result && !result.ok ? `\n**Why it failed:**\n${result.reasons.map((r) => `- ${r}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
  const failures = [...a.failures, ...f.failures];
  const text = failures.length ? ["| Test | Message |", "|---|---|", ...failures.map((x) => `| ${x.test} | ${String(x.message).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`)].join("\n") : "";
  const annotations = a.failures.map((x) => ({ path: classPath(x.cls), start_line: line(x.stack), end_line: line(x.stack), annotation_level: "failure",
    title: x.test, message: x.message || "failed" })).filter((x) => x.path).slice(0, 50);
  return { title, summary, text, annotations };
}

/** The run summary table (GITHUB_STEP_SUMMARY). */
export function summaryMarkdown(state, { plan, result }) {
  const cov = Object.entries(state.coverage).sort().map(([n, p]) => `| ${n} | ${p}% |`);
  return [
    `### Salesforce tests: ${result.ok ? "passed" : "failed"}`,
    "", `Scope: ${plan.mode === "all" ? "all local tests" : "tests for this change"} (${plan.why})`, "",
    "| | ran | passed | failed |", "|---|---|---|---|",
    `| Apex | ${state.apex.ran} | ${state.apex.passed} | ${state.apex.failed} |`,
    `| Flow | ${state.flows.ran} | ${state.flows.passed} | ${state.flows.failed} |`,
    ...(result.reasons.length ? ["", ...result.reasons.map((r) => `- ${r}`)] : []),
    ...(cov.length ? ["", "| Class | Coverage |", "|---|---|", ...cov] : []),
  ].join("\n");
}
