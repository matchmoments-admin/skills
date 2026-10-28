// The code host: the GitHub calls the pipeline makes, behind one interface (see GLOSSARY.md: Code host). Where a GitHub
// quirk lives (commit statuses vs check runs, the App's identity, the run link), and where a call is made once per
// process however many callers ask (the open release branch, a story's PR, a PR's gate facts). Tests pass a fake `io`.
// A second host (Bitbucket, GitLab) would be a second adapter with this interface.
import { gather } from "./facts.mjs";
import { openRelease as pickOpenRelease, aiFeatures, setting } from "./conventions.mjs";
import { recorder } from "./events.mjs";
import { appToken } from "./board.mjs";

/** A commit's check runs (every page; name: only that check), through the io seam. host.checkRuns, and close-out,
 *  which has io but no host. */
export const checkRunsOn = ({ ghPages }, repo, sha, name = null) =>
  (ghPages(`repos/${repo}/commits/${sha}/check-runs?per_page=100${name ? `&check_name=${encodeURIComponent(name)}` : ""}`, "check_runs") || []).filter((c) => !name || c.name === name);

export function codeHost({ io, env = process.env, sleep = () => {}, log = () => {}, fetcher = globalThis.fetch, now = () => Date.now() }) {
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

    /** A commit's check runs, every page, or only the named check's runs (in no promised order: sort by started_at). */
    checkRuns: (sha, name = null) => checkRunsOn(io, repo, sha, name),

    /** A release branch's open release PR into main (its number), or null. */
    releasePrOf: (branch) => {
      const b = String(branch || "").replace(/^origin\//, "");
      return b ? once(`release-pr:${b}`, () => (io.gh(["pr", "list", "--head", b, "--base", "main", "--state", "open", "--json", "number"], { allowFail: true }) || [])[0]?.number || null) : null;
    },

    /** Drop what this process remembered about a PR, after starting work on it, so its card is built from fresh facts. */
    forget: (number) => { memo.delete(`facts:${number}`); },

    /** The facts the gate decides on, gathered once per process (a card refreshed every minute reuses them). Always
     *  with the same options (the open release, the AI flags, UAT): a caller that passed fewer once made a later card
     *  show "AI review off" from the cached facts. */
    prFacts: (number) => once(`facts:${number}`, () => gather(String(number), io, { openReleaseBranch: host.openRelease(), ai: aiFeatures(env), uat: setting("UAT_ENABLED", env) === "true" })),

    /** A verdict as a commit status on an exact commit, linked to this run. Agent-free steps only (see gate.mjs). */
    status(sha, context, state, description, url = host.runUrl) {
      io.gh(["api", `repos/${repo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${context}`, "-f", `description=${String(description).slice(0, 139)}`, ...(url ? ["-f", `target_url=${url}`] : [])]);
    },

    /** A check run on a commit, created once and updated as work progresses (the live view on the PR). Progress is
     *  sent only when its title changed and at most once a minute (a long run polls every 15 s); the result always. */
    checkRun(sha, name) {
      if (!sha || !repo) return { update: () => {} };
      const made = api("POST", `repos/${repo}/check-runs`, { name, head_sha: sha, status: "in_progress", details_url: host.runUrl, output: { title: "Starting", summary: "Starting" } });
      const id = made?.id || null;
      let last = { title: "Starting", at: now() };
      return {
        update: (output, conclusion) => {
          if (!id) return;
          if (!conclusion && (output?.title === last.title || now() - last.at < 60e3)) return;
          last = { title: output?.title, at: now() };
          api("PATCH", `repos/${repo}/check-runs/${id}`, conclusion ? { status: "completed", conclusion, output } : { output });
        },
      };
    },

    /** Start a workflow on main (or a ref) with inputs. The ref is always named: without one gh looks up the default
     *  branch, which a token without contents: read cannot (this broke /ship and /uat-pass). */
    dispatch(workflow, inputs = {}, ref = "main") {
      io.gh(["workflow", "run", workflow, "--ref", ref, ...Object.entries(inputs).flatMap(([k, v]) => ["-f", `${k}=${v}`])]);
    },

    /** A repository_dispatch event (it starts workflows even when sent with the Actions token), e.g. a waiting story's
     *  start: repoDispatch("jira-start", { key: "200", labels: "feature" }). */
    repoDispatch(type, payload = {}) {
      io.gh(["api", `repos/${repo}/dispatches`, "-f", `event_type=${type}`, ...Object.entries(payload).flatMap(([k, v]) => ["-f", `client_payload[${k}]=${v}`])]);
    },

    /** A workflow's newest runs (one page, newest first: callers need the recent ones, never the whole history). */
    workflowRuns: (file, query = "", perPage = 100) => io.gh(["api", `repos/${repo}/actions/workflows/${file}/runs?per_page=${perPage}${query ? `&${query}` : ""}`])?.workflow_runs || [],

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
