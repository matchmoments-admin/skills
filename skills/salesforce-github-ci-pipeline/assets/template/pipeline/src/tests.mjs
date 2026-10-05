// A test run: which tests a change needs (selectTests, pure), running them in an org with live progress (runTests,
// through the io seam), and what people see (checkOutput / summaryMarkdown, pure). CI, the staging regression and
// the story card all use this one module, so "what ran, and did it pass" has one answer.
//
// Selection rules (safe by default: when in doubt, everything):
//   a changed test class runs itself; a changed class runs every test class that names it;
//   a changed trigger or record-triggered Flow runs the test classes that name its object, plus the Flow's tests;
//   other metadata (fields, objects, layouts, permission sets...), a deletion, or code no test names: all local tests.
// The skill salesforce-scratch-org-tests carries the same rules in bash for CIs without Node.

const base = (p) => p.split("/").pop();
const isApex = (p) => /\.cls(-meta\.xml)?$/.test(p);
const isTrigger = (p) => /\.trigger(-meta\.xml)?$/.test(p);
const isFlow = (p) => /\/flows\/[^/]+\.flow-meta\.xml$/.test(p);
const isFlowTest = (p) => /\.flowtest-meta\.xml$/.test(p);
const flowOfTest = (src) => (src.match(/<flowApiName>([^<]+)<\/flowApiName>/) || [])[1];

/**
 * changed/deleted: source paths that differ from the base; files: every source path; read(path) -> text.
 * Returns { mode: "none" | "relevant" | "all", apex: [class], flows: ["Flow.Test"], why }.
 */
export function selectTests({ changed, deleted = [], files, read, mode = "relevant" }) {
  const flowTests = files.filter(isFlowTest).map((p) => `${flowOfTest(read(p))}.${base(p).replace(".flowtest-meta.xml", "")}`);
  const all = (why) => ({ mode: "all", apex: [], flows: flowTests, why });
  if (!changed.length && !deleted.length) return { mode: "none", apex: [], flows: [], why: "no Salesforce source changed" };
  if (mode === "all") return all("all tests requested");
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
export function runTests(io, { alias, plan, onProgress = () => {}, sleep, pollMs = 15000, maxPolls = 240, outDir }) {
  const state = { phase: "apex", apex: { classes: 0, classesDone: 0, ran: 0, passed: 0, failed: 0, failures: [] },
    flows: { ran: 0, passed: 0, failed: 0, failures: [] }, coverage: {}, orgWide: null };
  const runApex = plan.mode === "all" || plan.apex.length > 0;
  if (runApex) {
    const level = plan.mode === "all" ? ["--test-level", "RunLocalTests"] : ["--test-level", "RunSpecifiedTests", ...plan.apex.flatMap((t) => ["--tests", t])];
    const id = io.sf(["apex", "run", "test", "-o", alias, ...level, "--code-coverage"]).testRunId;
    for (let i = 0; i < maxPolls; i++) {
      const items = io.sf(["data", "query", "-o", alias, "-q", `SELECT Status, ApexClass.Name FROM ApexTestQueueItem WHERE ParentJobId = '${id}'`]).records || [];
      const results = io.sf(["data", "query", "-o", alias, "-q", `SELECT Outcome, MethodName, Message, StackTrace, ApexClass.Name FROM ApexTestResult WHERE AsyncApexJobId = '${id}'`]).records || [];
      const done = items.filter((q) => ["Completed", "Failed", "Aborted"].includes(q.Status)).length;
      Object.assign(state.apex, {
        classes: items.length, classesDone: done, ran: results.length,
        passed: results.filter((r) => r.Outcome === "Pass").length, failed: results.filter((r) => r.Outcome !== "Pass").length,
        failures: results.filter((r) => r.Outcome !== "Pass").map((r) => ({ test: `${r.ApexClass?.Name}.${r.MethodName}`, cls: r.ApexClass?.Name, message: r.Message || "", stack: r.StackTrace || "" })),
        running: items.filter((q) => q.Status === "Processing").map((q) => q.ApexClass?.Name),
      });
      onProgress(state);
      if (items.length && done === items.length) break;
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
