// The code host: the GitHub calls the pipeline makes, behind one interface (see GLOSSARY.md: Code host). Where a GitHub
// quirk lives (commit statuses vs check runs, the App's identity, the run link), and where a call is made once per
// process however many callers ask (the open release branch, a story's PR, a PR's gate facts). Tests pass a fake `io`.
// A second host (Bitbucket, GitLab) would be a second adapter with this interface.
import { gather } from "./facts.mjs";
import { openRelease as pickOpenRelease, aiFeatures, setting } from "./conventions.mjs";
import { recorder, event, pathOf, BRANCH } from "./events.mjs";
import { PIPELINE_ROOT } from "./io.mjs";

/** A commit's check runs (every page; name: only that check), through the io seam. host.checkRuns, and close-out,
 *  which has io but no host. */
export const checkRunsOn = ({ ghPages }, repo, sha, name = null) =>
  (ghPages(`repos/${repo}/commits/${sha}/check-runs?per_page=100${name ? `&check_name=${encodeURIComponent(name)}` : ""}`, "check_runs") || []).filter((c) => !name || c.name === name);

/** Is this gh call a read? Default deny (#438 review): `gh api` with no method or GET only (-X GET, -XGET, --method GET,
 *  --method=GET), no body (-f, -F, --field, --raw-field, --input, joined forms too: they make it a POST), no method
 *  override header, not GraphQL; or `gh pr|issue|release|run view|list|diff|checks` (not --web). Anything else is a
 *  write and keeps the Actions token. Pure. */
export function isRead(args = []) {
  const [a, b] = args;
  if (a === "api") {
    if (args.length < 2 || args.slice(1).includes("graphql")) return false;
    for (let i = 1; i < args.length; i++) {
      const x = String(args[i]);
      if (x === "-X" || x === "--method") { if (!/^GET$/i.test(args[++i] || "")) return false; }
      else if (x.startsWith("-X")) { if (!/^-XGET$/i.test(x)) return false; }
      else if (x.startsWith("--method=")) { if (!/^--method=GET$/i.test(x)) return false; }
      else if (/^-[fF]/.test(x) || /^--(field|raw-field|input)(=|$)/.test(x)) return false;
      else if (x === "-H" || x === "--header") { if (/method-override/i.test(args[++i] || "")) return false; }
      else if (/^(-H|--header=)/.test(x) && /method-override/i.test(x)) return false;
    }
    return true;
  }
  return ["pr", "issue", "release", "run"].includes(a) && ["view", "list", "diff", "checks"].includes(b) && !args.includes("--web");
}

const refusedBy = (e) => /HTTP 401|Bad credentials/i.test(String(e?.message || e));

/** The io seam with its reads sent with another token (the pipeline App's): `token()` gives it, or null for the Actions
 *  token; writes go through untouched. A read GitHub refuses with a 401 (an expired or revoked token) is told to
 *  `refused(token)` and made again, once, on the Actions token. */
export function readsWith(io, token, refused = () => {}) {
  const as = (t, o = {}) => ({ ...o, env: { ...o.env, GH_TOKEN: t } });
  function viaApp(o, onApp, plain) {
    const t = token();
    if (!t) return plain();
    try { return onApp(t); } catch (e) {
      if (refusedBy(e)) { refused(t); return plain(); }
      if (o?.allowFail) return null;
      throw e;
    }
  }
  return {
    ...io,
    gh: (args, o) => (isRead(args) ? viaApp(o, (t) => io.gh(args, { ...as(t, o), allowFail: false }), () => io.gh(args, o)) : io.gh(args, o)),
    ghPages: (path, key, o) => viaApp(o, (t) => io.ghPages(path, key, as(t, o)), () => io.ghPages(path, key, o)),
  };
}

/** Every read permission the fact reads need of the App (statuses, check runs, reviews and PRs, issue events and
 *  comments, runs, compares and refs, the activity feed). A token missing any is never used for reads (#438 review). */
export const APP_READS_NEED = ["actions", "checks", "contents", "issues", "metadata", "pull_requests", "statuses"];
const TOKEN_TTL = 50 * 60e3;   // an installation token lives an hour: minted again before then

/** The App's installation token, minted in a child process so a sync read can ask for it: { token, permissions }. */
export function mintAppSync({ appId, privateKey, repo }, run) {
  const board = new URL("pipeline/src/board.mjs", `file://${PIPELINE_ROOT}`).href;
  const script = `import { mintInstallation } from ${JSON.stringify(board)}; let s = ""; for await (const c of process.stdin) s += c; process.stdout.write(JSON.stringify(await mintInstallation(JSON.parse(s))));`;
  try { return JSON.parse(run(process.execPath, ["--input-type=module", "-e", script], { input: JSON.stringify({ appId, privateKey, repo }), quiet: true })); }
  catch (e) { throw new Error(`minting failed${String(e.message).split(" failed").pop().replace(/\s+/g, " ").slice(0, 300)}`); }   // the reason, never the script (nor the key: it goes on stdin)
}

export function codeHost({ io, env = process.env, sleep = () => {}, log = () => {}, fetcher = globalThis.fetch, now = () => Date.now(), mintApp = (creds) => mintAppSync(creds, io.run) }) {
  const repo = env.GH_REPO || env.GITHUB_REPOSITORY;
  const repoUrl = `${env.GITHUB_SERVER_URL || "https://github.com"}/${repo}`;
  const memo = new Map();
  const once = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
  // The pipeline App's installation token, minted on first use and again before its hour ends (TOKEN_TTL)
  let installation = null;
  const appCreds = () => ({ appId: env.PIPELINE_APP_ID, privateKey: env.PIPELINE_APP_PRIVATE_KEY, repo });
  function appInstallation() {
    if (!installation || now() - installation.at >= TOKEN_TTL) installation = { ...mintApp(appCreds()), at: now() };
    return installation;
  }
  // APP_TOKEN_READS (#427): the token reads are sent with, or null for the Actions token. Decided on the first read, so
  // a process that only writes mints nothing; off, no key in this step, a missing permission or a failed mint: null for
  // the rest of the process, said once (a notice for no key, a warning for the others: never a silent degrade)
  let readsOff = false;
  function readToken() {
    if (readsOff) return null;
    if (setting("APP_TOKEN_READS", env) !== "true") { readsOff = true; return null; }
    if (!host.hasApp()) { readsOff = true; log("::notice::APP_TOKEN_READS is on, but the pipeline App's credentials are not in this step: reads use the Actions token"); return null; }
    try {
      const i = appInstallation();
      const missing = APP_READS_NEED.filter((p) => !["read", "write"].includes(i.permissions?.[p]));
      if (missing.length) { readsOff = true; log(`::warning::APP_TOKEN_READS is on, but the pipeline App lacks ${missing.map((p) => `${p}: read`).join(", ")}: reads stay on the Actions token (add the permission to the App and approve it on the installation)`); return null; }
      return i.token;
    } catch (e) { readsOff = true; installation = null; log(`::warning::APP_TOKEN_READS: the pipeline App's token could not be minted (${e.message}): reads stay on the Actions token`); return null; }
  }
  const refused = (t) => { if (installation?.token === t) installation = null; };   // a 401: the next read mints anew
  const reads = readsWith(io, readToken, refused);

  /** A REST call: parsed JSON, {} for an empty reply, or { status, message } for an HTTP error (never throws). A GET
   *  goes with the reads' token (#438 review); one the App's token is refused on (401) is made again on the Actions token. */
  function api(method, path, body) {
    const call = (o = {}) => {
      try {
        const out = io.run("gh", ["api", "-X", method, path, ...(body ? ["--input", "-"] : [])], { input: body ? JSON.stringify(body) : undefined, quiet: true, ...o });
        return out && String(out).trim() ? JSON.parse(out) : {};
      } catch (e) {
        return { status: Number((String(e.message).match(/HTTP (\d{3})/) || [])[1]) || 500, message: e.message };
      }
    };
    const t = method === "GET" && !body ? readToken() : null;
    if (!t) return call();
    const r = call({ env: { GH_TOKEN: t } });
    if (r?.status === 401) { refused(t); return call(); }
    return r;
  }

  const host = {
    repo, repoUrl, api,
    /** This workflow run's page: the "watch it live" link. */
    runUrl: env.GITHUB_RUN_ID ? `${repoUrl}/actions/runs/${env.GITHUB_RUN_ID}` : undefined,

    /** The open sprint's release branch (from the API: works in any checkout, with or without git credentials). */
    openRelease: () => once("open-release", () => pickOpenRelease((reads.gh(["api", `repos/${repo}/git/matching-refs/heads/release/`], { allowFail: true }) || []).map((r) => r.ref.replace("refs/heads/", "origin/")))),

    /** A story branch's latest PR (any state), or null. */
    storyPr: (branch) => once(`pr:${branch}`, () => (reads.gh(["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,state,title,baseRefName,headRefOid"]) || [])[0] || null),

    /** A commit's check runs, every page, or only the named check's runs (in no promised order: sort by started_at). */
    checkRuns: (sha, name = null) => checkRunsOn(reads, repo, sha, name),

    /** A release branch's open release PR into main (its number), or null. */
    releasePrOf: (branch) => {
      const b = String(branch || "").replace(/^origin\//, "");
      return b ? once(`release-pr:${b}`, () => (reads.gh(["pr", "list", "--head", b, "--base", "main", "--state", "open", "--json", "number"], { allowFail: true }) || [])[0]?.number || null) : null;
    },

    /** Drop what this process remembered about a PR, after starting work on it, so its card is built from fresh facts. */
    forget: (number) => { memo.delete(`facts:${number}`); },

    /** The facts the gate decides on, gathered once per process (a card refreshed every minute reuses them). Always
     *  with the same options (the open release, the AI flags, UAT): a caller that passed fewer once made a later card
     *  show "AI review off" from the cached facts. */
    prFacts: (number) => once(`facts:${number}`, () => gather(String(number), reads, { openReleaseBranch: host.openRelease(), ai: aiFeatures(env), uat: setting("UAT_ENABLED", env) === "true" })),

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
    workflowRuns: (file, query = "", perPage = 100) => reads.gh(["api", `repos/${repo}/actions/workflows/${file}/runs?per_page=${perPage}${query ? `&${query}` : ""}`])?.workflow_runs || [],

    /** GraphQL as the pipeline App (organisation projects need it; the Actions token cannot reach them). */
    async appGraphql(query, variables) {
      if (!host.hasApp()) throw new Error("the pipeline App's credentials are not in this step");
      const { token } = appInstallation();
      io.count?.("app", "graphql");   // by fetch, outside gh: counted here (#422)
      const r = await (await fetcher("https://api.github.com/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }) })).json();
      if (r.errors) throw new Error(r.errors.map((e) => e.message).join("; "));
      return r.data;
    },
    hasApp: () => Boolean(env.PIPELINE_APP_ID && env.PIPELINE_APP_PRIVATE_KEY),

    /** The event log (pipeline/src/events.mjs): one recorder per process, so a token that cannot write is found once. */
    record: recorder({ api, repo, env, log, sleep }),

    /** The GitHub calls this process made (#422), counted where they run (io.usage: counted() in io.mjs), per token and
     *  budget, recorded at stop() as one "api" event: only when the process made calls, with the hour's totals from one
     *  GET /rate_limit (free) read then, and the event's own write counted. One attempt and no wait (it runs at exit):
     *  a conflict on the metrics branch drops it with a notice. Only in Actions, with the event log on and API_METER
     *  not off. Nothing is read when the meter starts. */
    meter(command, { pr } = {}) {
      const off = { stop: () => null };
      if (!io.usage || !repo || !env.GITHUB_RUN_ID || env.PIPELINE_EVENTS === "off" || setting("API_METER", env) === "off") return off;
      let stopped = false;
      return {
        stop() {
          if (stopped) return null;
          stopped = true;
          const u = io.usage();
          if (!(u.actions.rest + u.actions.graphql + u.app.rest + u.app.graphql)) return null;
          const used = { rest: u.actions.rest + 1, graphql: u.actions.graphql,   // + 1: this event's own write
            ...(u.app.rest || u.app.graphql ? { appRest: u.app.rest, appGraphql: u.app.graphql } : {}),
            ...windowOf(io.gh(["api", "rate_limit"], { allowFail: true })?.resources),
            // the App's own hour (#427), read on its own token when this process used it for reads
            ...(installation?.token && (u.app.rest || u.app.graphql) ? appWindow(io.gh(["api", "rate_limit"], { allowFail: true, env: { GH_TOKEN: installation.token } })?.resources) : {}) };
          try {
            const e = event("api", { command, pr: pr ? Number(pr) : undefined, ...used }, env);
            const r = api("PUT", `repos/${repo}/contents/${pathOf(e)}`, { message: `event: api ${command}`, content: Buffer.from(JSON.stringify(e) + "\n").toString("base64"), branch: BRANCH });
            if (r?.status) log(`::notice::api counts not recorded (${r.status}): one attempt at exit, no retry`);
          } catch (err) { log(`::notice::api counts not recorded: ${err.message}`); }
          return used;
        },
      };
    },

  };
  return host;
}

/** The hour's totals for the job's token from GET /rate_limit's resources: used and limit per budget, and when the
 *  window resets. {} when unread. Pure. */
/** The App token's hour from its own GET /rate_limit: used, limit and reset of its REST budget (#427). Pure. */
export function appWindow(r) {
  return r?.core ? { appCoreUsed: r.core.used, appCoreLimit: r.core.limit, appCoreReset: new Date(r.core.reset * 1000).toISOString() } : {};
}

export function windowOf(r) {
  if (!r?.core) return {};
  return { coreUsed: r.core.used, coreLimit: r.core.limit, coreReset: new Date(r.core.reset * 1000).toISOString(), graphqlUsed: r.graphql?.used, graphqlLimit: r.graphql?.limit };
}
