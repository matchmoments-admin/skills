// The code host: the GitHub calls the pipeline makes, behind one interface (see CONTEXT.md: Code host). Where a GitHub
// quirk lives (commit statuses vs check runs, the App's identity, the run link), and where a call is made once per
// process however many callers ask (the open release branch, a story's PR, a PR's gate facts). Tests pass a fake `io`.
// A second host (Bitbucket, GitLab) would be a second adapter with this interface.
import { gather } from "./gate.mjs";
import { openRelease as pickOpenRelease } from "./conventions.mjs";
import { recorder } from "./events.mjs";
import { appToken } from "./board.mjs";

export function codeHost({ io, env = process.env, sleep = () => {}, log = () => {}, fetcher = globalThis.fetch }) {
  const repo = env.GH_REPO || env.GITHUB_REPOSITORY;
  const repoUrl = `${env.GITHUB_SERVER_URL || "https://github.com"}/${repo}`;
  const memo = new Map();
  const once = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };

  /** A REST call: parsed JSON, {} for an empty reply, or { status, message } for an HTTP error (never throws). */
  function api(method, path, body) {
    try {
      const out = io.run("gh", ["api", "-X", method, path, ...(body ? ["--input", "-"] : [])], { input: body ? JSON.stringify(body) : undefined, quiet: true });
      return out && String(out).trim() ? JSON.parse(out) : {};
    } catch (e) {
      return { status: Number((String(e.message).match(/HTTP (\d{3})/) || [])[1]) || 500, message: e.message };
    }
  }

  const host = {
    repo, repoUrl, api,
    /** This workflow run's page: the "watch it live" link. */
    runUrl: env.GITHUB_RUN_ID ? `${repoUrl}/actions/runs/${env.GITHUB_RUN_ID}` : undefined,

    /** The open sprint's release branch (from the API: works in any checkout, with or without git credentials). */
    openRelease: () => once("open-release", () => pickOpenRelease((io.gh(["api", `repos/${repo}/git/matching-refs/heads/release/`], { allowFail: true }) || []).map((r) => r.ref.replace("refs/heads/", "origin/")))),

    /** A story branch's latest PR (any state), or null. */
    storyPr: (branch) => once(`pr:${branch}`, () => (io.gh(["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,state,title,baseRefName,headRefOid"]) || [])[0] || null),

    /** The facts the gate decides on, gathered once per process (a card refreshed every minute reuses them). */
    prFacts: (number, opts) => once(`facts:${number}`, () => gather(number, io, opts)),

    /** A verdict as a commit status on an exact commit, linked to this run. Agent-free steps only (see gate.mjs). */
    status(sha, context, state, description) {
      io.gh(["api", `repos/${repo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${context}`, "-f", `description=${String(description).slice(0, 139)}`, ...(host.runUrl ? ["-f", `target_url=${host.runUrl}`] : [])]);
    },

    /** A check run on a commit, created once and updated as work progresses (the live view on the PR). */
    checkRun(sha, name) {
      if (!sha || !repo) return { update: () => {} };
      const made = api("POST", `repos/${repo}/check-runs`, { name, head_sha: sha, status: "in_progress", details_url: host.runUrl, output: { title: "Starting", summary: "Starting" } });
      const id = made?.id || null;
      return { update: (output, conclusion) => { if (id) api("PATCH", `repos/${repo}/check-runs/${id}`, conclusion ? { status: "completed", conclusion, output } : { output }); } };
    },

    /** Start a workflow on main (or a ref) with inputs. */
    dispatch(workflow, inputs = {}, ref = null) {
      io.gh(["workflow", "run", workflow, ...(ref ? ["--ref", ref] : []), ...Object.entries(inputs).flatMap(([k, v]) => ["-f", `${k}=${v}`])]);
    },

    /** A workflow's runs (newest first). */
    workflowRuns: (file, query = "") => io.ghPages(`repos/${repo}/actions/workflows/${file}/runs?per_page=100${query ? `&${query}` : ""}`, "workflow_runs"),

    /** GraphQL as the pipeline App (organisation projects need it; the Actions token cannot reach them). */
    async appGraphql(query, variables) {
      const { PIPELINE_APP_ID: appId, PIPELINE_APP_PRIVATE_KEY: privateKey } = env;
      if (!appId || !privateKey) throw new Error("the pipeline App's credentials are not in this step");
      const token = await once("app-token", () => appToken({ appId, privateKey, repo, fetcher }));
      const r = await (await fetcher("https://api.github.com/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }) })).json();
      if (r.errors) throw new Error(r.errors.map((e) => e.message).join("; "));
      return r.data;
    },
    hasApp: () => Boolean(env.PIPELINE_APP_ID && env.PIPELINE_APP_PRIVATE_KEY),

    /** The event log (pipeline/src/events.mjs): one recorder per process, so a token that cannot write is found once. */
    record: recorder({ api, repo, env, log, sleep }),
  };
  return host;
}
