// What every stage of the pipeline must agree on, checked on a simulated world (sim.mjs) after each step of a scenario,
// through the real modules: gather, Standing, the gate, the journey, the cards and the actions. Plus a model of what
// each workflow does when GitHub finishes its run (finish), so a scenario plays the pipeline, not a hand-made Standing.
import { standing, evaluate, route, STATUS } from "../src/gate.mjs";
import { nextSteps, next } from "../src/journey.mjs";
import { storyCard, releaseCard, needsOf } from "../src/card.mjs";
import { act } from "../src/actions.mjs";
import { CHECKS, storyOf, aiFeatures } from "../src/conventions.mjs";

const ICON = { "✅": "done", "⏳": "running", "⬜": "waiting", "❌": "failed", "➖": "off" };

/** Everything a person and the pipeline see on PR `number` now: facts, Standing, the gate's decision, the card. */
export function observe(w, number, env = {}) {
  const host = w.host(env);
  const facts = host.prFacts(number);
  const st = standing(facts), decision = evaluate(facts);
  const pr = facts.pr;
  const body = route(pr) === "release"
    ? releaseCard({ repoUrl: host.repoUrl, pr, facts, decision, uat: facts.uat })
    : storyCard({ key: storyOf(pr.headRefName), repoUrl: host.repoUrl, branch: pr.headRefName, base: pr.baseRefName, ai: facts.ai, pr, facts, decision });
  const rows = Object.fromEntries(body.split("\n").map((l) => l.match(/^\| (\S+) \| ([^|]+?) \| (.*) \|$/)).filter((m) => m && ICON[m[1]]).map((m) => [m[2], { state: ICON[m[1]], text: m[3] }]));
  const offers = [...body.matchAll(/<!-- act:([a-z-]+) -->/g)].map((m) => m[1]);
  return { host, facts, st, decision, body, rows, offers, needs: needsOf(body) };
}

// which card row stands for which result, and which in-flight workflow produces it
const ROWS = [
  { row: "AI review", result: "review", workflow: "ai-review.yml" },
  { row: "UI test", result: "ui", workflow: "ui-test.yml" },
  { row: "UI regression (every UI spec)", result: "uiRegression", workflow: "staging-deploy.yml" },
  { row: "UAT sign-off", result: "uat", workflow: "uat-deploy.yml" },
];

/** The invariants: a list of what broke on PR `number` (empty when all hold). */
export async function violations(w, number, env = {}) {
  const o = observe(w, number, env);
  const out = [];
  const inflight = w.state.inflight;
  const open = o.facts.pr.state === "OPEN";
  // 1. the card agrees with Standing: done only on a pass on the head, never "running" over a result that is stale or
  //    passed, and "run it again" only when no run that produces the result is going (it said so while Claude's UI
  //    test ran, 14 Oct)
  for (const r of ROWS) {
    const row = o.rows[r.row], v = o.st[r.result];
    if (!row || !v || !open) continue;
    if (row.state === "done" && v.state !== "success") out.push(`1: card row "${r.row}" is done but Standing says ${v.state}`);
    if (row.state === "running" && ["stale", "success"].includes(v.state)) out.push(`1: card row "${r.row}" is running but Standing says ${v.state}`);
    // a run counts when it judges the head, or a commit only specs changed since (its result carries)
    const head = o.facts.pr.headRefOid;
    const judgesHead = (x) => !x.sha || x.sha === head || (w.compare(x.sha, head)?.files || [{}]).every((f) => String(f.filename).startsWith("e2e/"));
    if (/run it again/.test(row.text) && inflight.some((x) => x.workflow === r.workflow && judgesHead(x))) out.push(`1: card row "${r.row}" says run it again while ${r.workflow} runs on it`);
  }
  // 3. a person is called only when there is something for them: approvers once every stage before Approval is done
  const names = Object.keys(o.rows), before = names.slice(0, names.indexOf("Approval")).filter((k) => !["done", "off"].includes(o.rows[k].state));
  if (o.needs && /approval/.test(o.needs.what) && before.length) out.push(`3: approvers called while ${before.join(", ")} not done`);
  // 4. what the card offers, the action accepts: UAT passed while the card says the release is in UAT
  if (open && o.offers.includes("uat-pass") && o.rows["UAT sign-off"]?.state === "running") {
    const r = await actAs(w.fork(), number, "tester", "/uat-pass");
    if (!r.done) out.push(`4: the card offers UAT passed but /uat-pass refuses: ${r.text.slice(0, 120)}`);
  }
  // 2. nothing is stuck: when nothing runs and nothing failed, the gate waits only on people (an approval, a sign-off,
  //    a UAT test). Anything else it waits on (a check, a verdict, the UI regression, UAT's deploy) must be in flight
  //    (a dropped workflow_run on 13 Oct left releases waiting on nothing)
  const person = /^(not approved|no sign-off|approval does not count|your approval|waiting for UAT sign-off|the PR is a draft)/;
  const machine = o.decision.reasons.filter((x) => !person.test(x));
  if (open && !inflight.length && o.decision.blocking !== "failure" && machine.length && !Object.values(o.rows).some((r) => r.state === "failed")) {
    out.push(`2: stuck: nothing runs; the gate waits on: ${machine.join("; ")}`);
  }
  return out;
}

/** A person's comment command through the real action handler. Returns { done (a status was posted), text (said) }. */
export async function actAs(w, number, who, text) {
  const before = (w.state.comments[number] || []).length, statuses = JSON.stringify(w.state.statuses);
  w.comment(number, who, text);
  w.acting({ event: "issue_comment", branch: "main", workflow: "pr-command.yml" });
  await act({ number, isPr: true, who, whoType: "User", command: text }, { io: w.io, host: w.host(), cards: { refreshPr: async () => {}, refresh: async () => {} }, log: () => {} });
  const said = (w.state.comments[number] || []).slice(before + 1).map((c) => c.body).join("\n");
  return { done: JSON.stringify(w.state.statuses) !== statuses, text: said };
}

const releasePrOf = (w, branch) => Object.values(w.state.prs).find((p) => p.head === branch && p.base === "main" && p.state === "OPEN")?.number || null;

/**
 * GitHub finishes an in-flight run: what that workflow posts, then (unless the event is dropped) the journey's next
 * steps, through the real journey.next. outcome: "success" | "failure". Models ci.yml, staging-deploy.yml (Apex and
 * Flow, then the UI regression once per release: its plan, simplified to "owed on this commit") and uat-deploy.yml.
 */
export async function finish(w, run, { outcome = "success", drop = false, env = {} } = {}) {
  if (!run) return null;
  // a dispatch runs on what its ref (or, for UAT, its PR's head) holds when it starts; a push on the pushed commit
  const sha = run.sha || (run.inputs?.pr ? w.tip(w.state.prs[run.inputs.pr].head) : w.tip(run.ref));
  // the review's verdict is posted by its agent-free job, which a workflow_run of main's file starts (trusted)
  w.acting(run.workflow === "ai-review.yml" ? { event: "workflow_run", branch: "main", workflow: run.workflow } : { event: run.event, branch: run.ref, workflow: run.workflow });
  if (run.workflow === "ci.yml") {
    w.check(sha, CHECKS.static, "success");
    w.check(sha, CHECKS.apex, outcome);
  } else if (run.workflow === "staging-deploy.yml") {
    w.check(sha, "Salesforce tests", outcome);
    w.check(sha, CHECKS.staging, outcome);
    const rel = releasePrOf(w, run.ref);
    if (rel && outcome === "success" && w.tip(run.ref) === sha) {
      const o = observe(w, rel, env);
      if (["missing", "stale"].includes(o.st.uiRegression.state)) w.status(sha, STATUS.uiRegression, "success", "every UI spec passed", { runId: w.state.actingRun });
    }
  } else if (run.workflow === "ai-review.yml") {
    w.status(sha, STATUS.review, outcome, outcome === "success" ? "AI review passed" : "AI review asks for changes", { runId: w.state.actingRun });
  } else if (run.workflow === "ui-test.yml" && !run.pushed && run.sha && w.tip(run.ref) !== run.sha) {
    // someone pushed while Claude wrote the spec: its push is rejected (not a fast-forward); the run job still checks
    // out the branch and reports on its head (ui-test.yml: run and report run always())
    w.status(w.tip(run.ref), STATUS.ui, "failure", "no spec committed", { runId: w.state.actingRun });
    return run;
  } else if (run.workflow === "ui-test.yml" && !run.pushed) {
    // Claude writes the spec and pushes it (CI runs on that push), then reports on that commit: two steps, so the
    // invariants are checked while it runs
    const spec = w.push(run.ref, [`e2e/story-${run.ref.replace("issue-", "")}.spec.ts`], { by: "claude", headline: `test(e2e): story ${run.ref.replace("issue-", "")}` });
    w.state.inflight.push({ ...run, sha: spec, pushed: true });
    return run;
  } else if (run.workflow === "ui-test.yml") {
    w.status(run.sha, STATUS.ui, outcome, outcome === "success" ? "UI test passed" : "UI test failed", { runId: w.state.actingRun });
    return run;
  } else if (run.workflow === "uat-deploy.yml") {
    const seen = (w.state.statuses[sha] || []).some((s) => s.context === STATUS.uat);
    if (!seen || run.inputs?.again === "true") w.status(sha, STATUS.uat, "pending", "In UAT (scratch org): test it, then tick UAT passed", { runId: w.state.actingRun });
  }
  if (drop) return run;
  const after = { "ci.yml": "ci", "staging-deploy.yml": "staging", "ai-review.yml": "review" }[run.workflow];
  const pr = run.workflow === "uat-deploy.yml" ? null : releasePrOf(w, run.ref) || Object.values(w.state.prs).find((p) => p.head === run.ref && p.state === "OPEN")?.number;
  if (after && pr) await next(after, pr, nextDeps(w, env));
  return run;
}

/** What journey.next needs, on the simulated world (Claude's jobs are recorded as in-flight runs). */
export const nextDeps = (w, env = {}) => {
  const host = w.host(env);
  const f = (n) => host.prFacts(n);
  return { host, gh: w.io.gh, cards: { refreshPr: async () => {} }, ai: aiFeatures(env), uat: env.UAT_ENABLED === "true" || process.env.UAT_ENABLED === "true",
    // the start decision posts the UI test as pending on the head, then dispatches it (start.startJob)
    startJob: async (kind, pr) => {
      const head = f(pr).pr;
      if (kind === "ui-test") w.status(head.headRefOid, STATUS.ui, "pending", "Claude is writing the UI test", { runId: w.acting({ event: "workflow_dispatch", workflow: "ui-test.yml" }) });
      w.state.inflight.push({ workflow: kind === "fix" ? "ai-fix.yml" : "ui-test.yml", ref: head.headRefName, sha: head.headRefOid, event: "workflow_dispatch" });
    }, log: () => {} };
};
