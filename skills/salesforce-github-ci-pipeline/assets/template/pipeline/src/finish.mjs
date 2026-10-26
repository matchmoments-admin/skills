// Finishing a stage, and the reconcile sweep (see GLOSSARY.md: Finish, Reconcile). Every job that produces a result
// ends with one step, `pipe finish <stage>`, which does the same things in the same order: the verdict on the commit it
// judged (and the label people read), its event, the gate re-run when a person has acted, the card, then what the
// journey owes next. The order used to be each workflow's own bash (15 Oct review: a lane released before its status,
// a planned UI regression that failed to start recorded nothing).
// reconcile() is level-triggered: on each open PR nothing is running for, it asks Standing what is owed and starts it,
// so a dropped workflow_run (GitHub lost them for half an hour on 13 Oct) costs one hourly tick (reconcile.yml), not a stalled story.
import { STATUS, standing, nudge, route } from "./gate.mjs";
import { notStarted } from "./improve.mjs";

/** What each stage posts: its result's status context, the labels people read, and the journey step after it. */
export const STAGE = {
  review: { context: STATUS.review, after: "review", labels: { success: "review:pass", failure: "review:changes" }, clear: ["review:pass", "review:changes", "ai:review"] },
  "ui-test": { context: STATUS.ui, labels: { success: "ui:pass", failure: "ui:fail" }, clear: ["ui:pass", "ui:fail", "test", "ai:test"] },
  ci: { context: STATUS.ui, after: "ci" },             // CI posts the UI test as not needed when nothing is UI-facing
  staging: { context: STATUS.uiRegression, after: "staging" },
  uat: { context: STATUS.uat },
};

/**
 * The verdict a finished stage posts: { state, description, label } or null (nothing to post). Pure.
 *   review     outcome pass | changes | not-needed (detail: why) | anything else (no verdict came)
 *   ui-test    outcome success | failure; hasSpec, weak (what the spec check found too little), kind (Jev's guess), story
 *   ci         outcome no-ui (nothing UI-facing changed) | anything else
 *   staging    outcome success | failure (the UI regression ran) | anything else; planned: it was due (a setup that
 *              failed before it ran is a failure, so nothing waits on it)
 *   uat        outcome deployed; detail: sandbox | scratch org
 */
export function verdictOf(stage, { outcome = "", detail = "", weak = "", kind = "", hasSpec = true, planned = false, story = "" } = {}) {
  if (stage === "review") {
    if (outcome === "pass") return { state: "success", description: "AI review passed", label: true };
    if (outcome === "changes") return { state: "failure", description: "AI review asks for changes", label: true };
    if (outcome === "not-needed") return { state: "success", description: `not needed: ${detail}` };
    return { state: "error", description: "the review posted no verdict: tick Run the AI review again" };
  }
  if (stage === "ui-test") {
    if (!hasSpec) return { state: "failure", description: `no spec e2e/story-${story}.spec.ts committed`, label: true };
    if (outcome === "success" && weak) return { state: "failure", description: `the spec passed but checks too little: ${weak}`, label: true };
    if (outcome === "success") return { state: "success", description: "UI test passed", label: true };
    return { state: "failure", description: `the spec failed${kind && kind !== "unknown" ? ` (Jev guesses: ${kind})` : ""}`, label: true };
  }
  if (stage === "ci") return outcome === "no-ui" ? { state: "success", description: "not needed: no UI-facing changes" } : null;
  if (stage === "staging") {
    if (outcome === "success") return { state: "success", description: "every UI spec passed on the staging org" };
    if (outcome === "failure") return { state: "failure", description: "a UI spec failed on the staging org" };
    return planned ? { state: "failure", description: "the UI regression could not run (its setup or the deploy failed): see the staging run" } : null;
  }
  if (stage === "uat") return outcome === "deployed" ? { state: "pending", description: `In UAT (${detail || "scratch org"}): test it, then tick UAT passed on the release card` } : null;
  throw new Error(`finish: unknown stage "${stage}" (${Object.keys(STAGE).join(", ")})`);
}

/**
 * Finish a stage on PR `pr` (or the open release PR of `branch`): the verdict on `sha`, then the gate, the card and
 * the journey, in that order, with facts gathered after the verdict. deps: { host, gh, cards, next(after, pr), record, log }.
 */
export async function finish(stage, { pr = null, branch = null, sha = null, url = null, ...f }, { host, gh, cards, next, record = () => {}, log = () => {} }) {
  const s = STAGE[stage];
  const v = verdictOf(stage, f);
  if (!pr && branch) pr = (gh(["pr", "list", "--head", branch, "--base", "main", "--state", "open", "--json", "number"], { allowFail: true }) || [])[0]?.number || null;
  const done = [];
  if (v && sha) {
    host.status(sha, s.context, v.state, v.description, url || host.runUrl);
    record("verdict", { context: s.context, state: v.state, sha, pr: pr ? Number(pr) : undefined, why: v.description.slice(0, 139) });
    done.push(`${s.context}=${v.state}`);
    if (pr && s.labels) {   // the old verdict's label goes whatever the new one is; a pass or a fail gets its own
      gh(["pr", "edit", String(pr), ...s.clear.flatMap((l) => ["--remove-label", l])], { allowFail: true });
      if (v.label && s.labels[v.state]) gh(["pr", "edit", String(pr), "--add-label", s.labels[v.state]], { allowFail: true });
    }
  }
  if (!pr) return { verdict: v, said: `${done.join(", ") || "no verdict"}; no open pull request` };
  // the gate when a person has acted (merge now if this was the last thing it waited on), then the card
  if (nudge(host.prFacts(pr)).action === "dispatch") { host.dispatch("gate.yml", { pr: String(pr) }); done.push("gate"); }
  await cards.refreshPr(pr);
  if (s.after) { const r = await next(s.after, pr); if (r?.steps?.length) done.push(r.said); }
  log(`finished ${stage} on #${pr}: ${done.join("; ") || "nothing to post"}`);
  return { verdict: v, said: done.join("; ") || "nothing to do" };
}

/**
 * The sweep: every open story and release PR that nothing is running for (no queued or running workflow run on its
 * branch or naming it), the gate re-run if a person's approval waits on a stale gate status, and whatever the journey
 * owes on its head, started. Idempotent: what was started is running at the next tick, so it is skipped. only: one PR.
 * deps: { host, gh, cards, next(after, pr), record, log }. Returns [{ pr, started: [..] } | { pr, skipped }].
 */
export async function reconcile({ host, gh, cards, next, record = () => {}, log = () => {}, only = null }) {
  const open = (gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefName,baseRefName,isDraft"]) || [])
    .filter((p) => ["feature", "hotfix", "release"].includes(route(p)) && !p.isDraft && (!only || String(p.number) === String(only)));
  const runs = ["queued", "in_progress", "waiting"].flatMap((status) => host.api("GET", `repos/${host.repo}/actions/runs?status=${status}&per_page=100`)?.workflow_runs || []);
  const busy = (p) => runs.some((r) => r.head_branch === p.headRefName || new RegExp(`#${p.number}\\b`).test(r.display_title || ""));
  const out = [];
  for (const p of open) {
    if (busy(p)) { out.push({ pr: p.number, skipped: "a run is going" }); continue; }
    const facts = host.prFacts(p.number);
    const started = [];
    // a gate production rejected stays failed on that head: re-validating the same code every tick only fails again
    const gate = standing(facts).gate;
    const rejected = gate.state === "failure" && /^Production rejected/.test(gate.description || "");
    if (nudge(facts).action === "dispatch" && gate.state !== "success" && !rejected) { host.dispatch("gate.yml", { pr: String(p.number) }); started.push("gate"); }
    const r = await next("any", p.number);
    started.push(...(r?.steps || []).map((s) => s.start || s.dispatch));
    if (started.length) {
      record("reconcile", { pr: p.number, started: started.join(",") });
      await cards.refreshPr(p.number);
      log(`reconcile #${p.number}: started ${started.join(", ")}`);
    }
    out.push({ pr: p.number, started });
  }
  return out;
}

/**
 * Runs GitHub never started (every job failed with no steps: a failed payment, the spending limit, a runner outage)
 * in the last day, re-run once each (first attempts only), so a billing stop does not leave CI red on every open PR
 * (22-24 Oct). Scheduled runs are left to their next tick. Returns the runs it re-ran.
 */
export function rerunNotStarted({ host, record = () => {}, log = () => {}, now = Date.now(), max = 10 }) {
  const since = new Date(now - 24 * 3600e3).toISOString().slice(0, 19);
  const runs = host.api("GET", `repos/${host.repo}/actions/runs?status=failure&created=>=${since}&per_page=100`)?.workflow_runs || [];
  const out = [];
  for (const r of runs.filter((x) => x.run_attempt === 1 && x.event !== "schedule")) {
    if (out.length >= max) break;
    const jobs = host.api("GET", `repos/${host.repo}/actions/runs/${r.id}/jobs?per_page=100`)?.jobs || [];
    if (!notStarted(jobs)) continue;
    host.api("POST", `repos/${host.repo}/actions/runs/${r.id}/rerun`);
    record("reconcile", { rerun: r.id, rerunOf: r.name });
    log(`re-ran ${r.name} run ${r.id} (its jobs never started)`);
    out.push(r.id);
  }
  return out;
}
