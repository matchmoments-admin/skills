// The CI runner on GitHub Actions: one of the two CiRunner adapters (the other runs on Buildkite). A job (jobs.mjs) is
// a workflow started by workflow_dispatch, or a repository_dispatch event where the starting run may hold no
// actions: write (a released lane, a story waiting for an org slot).
//
// CiRunner: start(job, inputs, { ref }) · runId · runUrl · runs(job, { dispatched, limit }) → [{ id, title, active,
// conclusion, createdAt }] · agentRan(runId) · publish({ outputs, summary }).
import { appendFileSync } from "node:fs";
import { job } from "../jobs.mjs";

const workflow = (file) => ({ workflow: file });
const event = (type) => ({ event: type });
/** How each job starts here. A job missing from this map cannot start on Actions (the contract test checks all). */
export const ACTIONS_JOBS = Object.freeze({
  "issue-start": event("jira-start"),
  gate: workflow("gate.yml"),
  ci: workflow("ci.yml"),
  staging: workflow("staging-deploy.yml"),
  "uat-deploy": workflow("uat-deploy.yml"),
  "uat-login": workflow("uat-login.yml"),
  release: workflow("release.yml"),
  "back-merge": workflow("back-merge.yml"),
  "sprint-start": workflow("sprint-start.yml"),
  "release-cut": workflow("release-cut.yml"),
  "story-retrieve": workflow("story-retrieve.yml"),
  "story-data": workflow("story-data.yml"),
  "scratch-janitor": workflow("scratch-janitor.yml"),
  "lane-wake": event("lane-freed"),
  "ai-review": workflow("ai-review.yml"),
  "ai-fix": workflow("ai-fix.yml"),
  "ui-test": workflow("ui-test.yml"),
});

/** Did this run's jobs run the agent step? jobs: the run's jobs API list. Unknown jobs (an API error) count as yes,
 *  so a limit counted from them always holds. Pure. */
export const ranAgent = (jobs) => !Array.isArray(jobs) || jobs.some((j) => (j.steps || []).some((s) => /claude-agent/.test(s.name || "") && ["success", "failure"].includes(s.conclusion)));

/** A workflow run as every runner reports one. Pure. */
export const runOf = (r) => ({ id: r.id, title: r.display_title, active: r.status !== "completed", conclusion: r.status === "completed" ? r.conclusion : null, createdAt: r.created_at });

/**
 * io: the gh seam; api: the code host's REST call (its reads go with the App's token when that is on); repo,
 * repoUrl: the repository the workflows live in.
 */
export function actionsRunner({ io, api, repo, repoUrl, env = process.env }) {
  return {
    /** This run's id (a job's own run is not one of its earlier runs) and its page: the "watch it live" link. */
    runId: env.GITHUB_RUN_ID,
    runUrl: env.GITHUB_RUN_ID ? `${repoUrl}/actions/runs/${env.GITHUB_RUN_ID}` : undefined,

    /** Start a job on main (or a ref). The ref is always named: without one gh looks up the default branch, which a
     *  token without contents: read cannot (this broke /ship and /uat-pass). An event carries the inputs as its payload. */
    start(name, inputs = {}, { ref = "main" } = {}) {
      const how = ACTIONS_JOBS[job(name)];
      if (how.event) io.gh(["api", `repos/${repo}/dispatches`, "-f", `event_type=${how.event}`, ...Object.entries(inputs).flatMap(([k, v]) => ["-f", `client_payload[${k}]=${v}`])]);
      else io.gh(["workflow", "run", how.workflow, "--ref", ref, ...Object.entries(inputs).flatMap(([k, v]) => ["-f", `${k}=${v}`])]);
    },

    /** A job's newest runs (one page, newest first): dispatched ones only when asked. */
    runs(name, { dispatched = false, limit = 100 } = {}) {
      const how = ACTIONS_JOBS[job(name)];
      if (!how.workflow) return [];
      const r = api("GET", `repos/${repo}/actions/workflows/${how.workflow}/runs?per_page=${limit}${dispatched ? "&event=workflow_dispatch" : ""}`);
      if (r?.status && !r.workflow_runs) throw new Error(`could not list ${how.workflow}'s runs (${r.status}): ${String(r.message).split("\n")[0]}`);   // never read as "none": a limit counted from them must hold
      return (r?.workflow_runs || []).map(runOf);
    },

    /** Did run `id` get as far as running the agent (not stopped before it, e.g. on a permission)? */
    agentRan: (id) => ranAgent(api("GET", `repos/${repo}/actions/runs/${id}/jobs`)?.jobs),

    /** Step outputs (multi-line safe) and the run's summary, when running in Actions. */
    publish({ outputs = {}, summary = "" } = {}) {
      if (env.GITHUB_OUTPUT) for (const [k, v] of Object.entries(outputs)) { const s = String(v ?? ""); appendFileSync(env.GITHUB_OUTPUT, s.includes("\n") ? `${k}<<__PIPE__\n${s}\n__PIPE__\n` : `${k}=${s}\n`); }
      if (summary && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary + "\n");
    },
  };
}
