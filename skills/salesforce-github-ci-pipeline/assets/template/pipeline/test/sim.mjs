// The simulated code host (see GLOSSARY.md): an in-memory GitHub that answers the gh calls the real modules make, so a
// test runs gather, the gate, the journey, the cards and the actions on one world, the way a live run does. Bugs at
// the joins between those modules (the UAT deadlock, an early mention) were found only in live runs before (15 Oct
// review: none of 52 bugs was found by a unit test first). Dependency-free; no network.
//
// world.io is the io seam codeHost({ io }) takes. Statuses, check runs, reviews, comments and commits live per repo; a
// commit graph answers compare. Pushes and dispatches start workflow runs (world.inflight), which a scenario finishes
// (world.finish), as GitHub would: the journey then reacts, unless the event is dropped.
import { codeHost } from "../src/github.mjs";

export const REPO = "o/r";
const BOT = { login: "github-actions[bot]", type: "Bot" };

/** A small seeded PRNG (mulberry32): fuzz runs are reproducible from their seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function world({ start = Date.parse("2026-10-14T00:00:00Z"), aiReview = false } = {}) {
  process.env.GH_REPO = REPO;   // gate.gather reads the repository from the process, as in CI
  let clock = start;
  const tick = () => new Date((clock += 60e3)).toISOString();
  const s = {
    n: 0,
    commits: { root: { sha: "root", parents: [], files: [], headline: "init", authors: [], at: tick() } },
    branches: { main: "root" },
    prs: {}, issues: {}, statuses: {}, checks: {}, reviews: {}, comments: {}, events: {}, runs: {}, labels: {},
    calls: [], tokens: [], inflight: [], aiReview,
  };
  const sha = () => `s${String(++s.n).padStart(39, "0")}`;

  // ---- the commit graph
  const ancestors = (x) => { const seen = new Set(), todo = [x]; while (todo.length) { const c = todo.pop(); if (c && !seen.has(c)) { seen.add(c); todo.push(...(s.commits[c]?.parents || [])); } } return seen; };
  const tip = (ref) => s.branches[String(ref).replace(/^origin\//, "")] || ref;
  function compare(a, b) {
    const A = ancestors(tip(a)), B = ancestors(tip(b));
    if (!s.commits[tip(a)] || !s.commits[tip(b)]) return null;
    const ahead = [...B].filter((c) => !A.has(c)).map((c) => s.commits[c]).sort((x, y) => x.at.localeCompare(y.at));
    const behind = [...A].filter((c) => !B.has(c));
    return { status: behind.length && ahead.length ? "diverged" : ahead.length ? "ahead" : behind.length ? "behind" : "identical",
      ahead_by: ahead.length, behind_by: behind.length, commits: ahead.map((c) => ({ sha: c.sha })),
      files: [...new Set(ahead.flatMap((c) => c.files))].map((filename) => ({ filename })) };
  }

  // ---- runs: every status a job posts links its run (gate.trustedRun reads it)
  function run({ event = "workflow_dispatch", branch = "main", workflow = "x.yml", status = "completed" } = {}) {
    const id = String(1000 + Object.keys(s.runs).length);
    s.runs[id] = { id: Number(id), event, head_branch: branch, status, name: workflow, path: `.github/workflows/${workflow}`, pull_requests: [] };
    return id;
  }
  const runUrl = (id) => `https://github.com/${REPO}/actions/runs/${id}`;

  function postStatus(on, context, state, description = "", { runId = run(), creator = BOT } = {}) {
    (s.statuses[on] ||= []).push({ context, state, description, target_url: runUrl(runId), created_at: tick(), creator });
  }
  function postCheck(on, name, conclusion, output = null) {
    (s.checks[on] ||= []).push({ name, status: conclusion ? "completed" : "in_progress", conclusion, started_at: tick(), output });
  }

  // ---- what gh answers
  function prView(number) {
    const p = s.prs[number];
    const head = tip(p.head);
    const commits = (p.state === "MERGED" ? p.commits : compare(p.base, p.head)?.commits.map((c) => c.sha) || []).map((c) => s.commits[c])
      .map((c) => ({ oid: c.sha, messageHeadline: c.headline, committedDate: c.at, authors: c.authors.map((login) => ({ login })) }));
    return { number: p.number, title: p.title, state: p.state, isDraft: Boolean(p.draft), mergeable: "MERGEABLE", baseRefName: p.base, headRefName: p.head,
      headRefOid: p.state === "MERGED" ? p.mergedHead : head, labels: (s.labels[number] || []).map((name) => ({ name })), author: { login: p.author },
      commits, url: `https://github.com/${REPO}/pull/${number}` };
  }
  function api(path) {
    let m;
    const p = path.replace(/^repos\/o\/r\//, "").replace(/\?.*$/, "");
    if ((m = p.match(/^compare\/(.+)\.\.\.(.+)$/))) return compare(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    if ((m = p.match(/^actions\/runs\/(\d+)$/))) return s.runs[m[1]] || null;
    if ((m = p.match(/^collaborators\/([^/]+)\/permission$/))) return { permission: m[1].startsWith("outsider") ? "read" : "write" };
    if (p === "activity") return [];
    // the runs going now (reconcile skips a PR with one): what a scenario has in flight, as GitHub lists them
    if (p === "actions/runs") return { workflow_runs: /status=in_progress/.test(path) ? s.inflight.map((r) => ({ head_branch: r.ref, status: "in_progress", display_title: r.inputs?.pr ? `${r.workflow.replace(".yml", "")} PR #${r.inputs.pr}` : r.workflow.replace(".yml", "") })) : [] };
    if (p === "git/matching-refs/heads/release/") return Object.keys(s.branches).filter((b) => b.startsWith("release/")).map((b) => ({ ref: `refs/heads/${b}` }));
    if ((m = p.match(/^commits\/([^/]+)\/pulls$/))) return Object.values(s.prs).filter((x) => x.mergedHead === m[1] || tip(x.head) === m[1]).map((x) => ({ number: x.number }));
    if ((m = p.match(/^branches\/(.+)$/))) return s.branches[decodeURIComponent(m[1])] ? { name: m[1] } : { status: 404 };
    if (p === "pulls") return Object.values(s.prs).filter((x) => x.state === "OPEN" && x.base === "main").map((x) => ({ number: x.number }));
    return null;
  }
  function pages(path) {
    let m;
    const p = path.replace(/^repos\/o\/r\//, "").replace(/\?.*$/, "");
    if ((m = p.match(/^pulls\/(\d+)\/reviews$/))) return s.reviews[m[1]] || [];
    if ((m = p.match(/^commits\/([^/]+)\/check-runs$/))) return s.checks[m[1]] || [];
    if ((m = p.match(/^commits\/([^/]+)\/statuses$/))) return [...(s.statuses[m[1]] || [])].reverse();   // newest first, as GitHub lists them
    if ((m = p.match(/^issues\/(\d+)\/events$/))) return s.events[m[1]] || [];
    if ((m = p.match(/^issues\/(\d+)\/comments$/))) return s.comments[m[1]] || [];
    return [];
  }
  const io = {
    gh(args, o = {}) {
      s.calls.push(["gh", ...args].join(" ")); s.tokens.push([o.env?.GH_TOKEN || "actions", ["gh", ...args].join(" ")]);   // which token each call carried (#427)
      const [a, b] = args;
      if (a === "pr" && b === "view") { const v = prView(args[2]); return args.includes("commits") && args.at(-1) === "commits" ? { commits: v.commits } : v; }
      if (a === "pr" && b === "list") {
        const head = args[args.indexOf("--head") + 1];
        return Object.values(s.prs).filter((x) => (!args.includes("--head") || x.head === head) && (!args.includes("--state") || ["all", x.state.toLowerCase()].includes(args[args.indexOf("--state") + 1]))).map((x) => prView(x.number));
      }
      if (a === "issue" && b === "view") return s.issues[args[2]] ? { body: s.issues[args[2]].body, state: s.issues[args[2]].state, title: s.issues[args[2]].title } : null;
      if (a === "issue" && b === "list") return [];
      if (a === "issue" && b === "comment") { (s.comments[args[2]] ||= []).push({ body: args[args.indexOf("--body") + 1], created_at: tick(), user: BOT, author_association: "NONE" }); return ""; }
      if (a === "workflow" && b === "run") {
        const inputs = Object.fromEntries(args.flatMap((x, i) => (args[i - 1] === "-f" ? [x.split("=")] : [])));
        s.inflight.push({ workflow: args[2], ref: args[args.indexOf("--ref") + 1], inputs, event: "workflow_dispatch" });
        return "";
      }
      if (a === "api" && /\/statuses\/[^/]+$/.test(b)) {
        const f = Object.fromEntries(args.flatMap((x, i) => (args[i - 1] === "-f" ? [[x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]] : [])));
        postStatus(b.split("/").pop(), f.context, f.state, f.description, { runId: s.actingRun });
        return {};
      }
      if (a === "api") return api(args.filter((x) => !x.startsWith("-")).at(-1));
      return null;
    },
    ghPages: (path, key, o = {}) => { s.tokens.push([o.env?.GH_TOKEN || "actions", `gh api --paginate ${path}`]); return pages(path); },
    run(cmd, args, o = {}) {
      s.calls.push([cmd, ...args].join(" ")); s.tokens.push([o.env?.GH_TOKEN || "actions", [cmd, ...args].join(" ")]);
      const method = args[args.indexOf("-X") + 1], path = args[args.indexOf("-X") + 2];
      if (method === "GET") { const r = api(path); return r === null ? "" : JSON.stringify(r); }
      if (method === "POST" && /check-runs$/.test(path)) return JSON.stringify({ id: 1 });
      return "{}";
    },
  };

  const w = {
    state: s, io, compare, run, now: () => new Date(clock).toISOString(),
    /** A fresh code host on this world (facts are cached per host, as per process in CI: take a new one per step). */
    host(env = {}) {
      return codeHost({ io, env: { GH_REPO: REPO, GITHUB_RUN_ID: s.actingRun || run(), PIPELINE_EVENTS: "off", ...env } });
    },
    /** A commit on a branch (made from `from` when the branch is new). */
    commit(branch, files, { by = "dev", headline = "change", from = "main" } = {}) {
      const c = { sha: sha(), parents: [tip(s.branches[branch] ? branch : from)], files, headline, authors: by ? [by] : [], at: tick() };
      s.commits[c.sha] = c;
      s.branches[branch] = c.sha;
      return c.sha;
    },
    branch(name, from = "main") { s.branches[name] = tip(from); return s.branches[name]; },
    tip,
    story(key, { approver = null, title = `Story ${key}` } = {}) {
      s.issues[key] = { title, state: "OPEN", body: `### Summary\n\n${title}\n\n### Approver\n\n${approver ? `@${approver}` : "_No response_"}\n` };
    },
    pr(number, { head, base, title = `PR ${number}`, author = "dev" }) {
      s.prs[number] = { number, head, base, title, state: "OPEN", author };
      if (s.aiReview && /^issue-/.test(head)) w.review(number, tip(head));
      return number;
    },
    /** A push: a commit, and the workflows a push starts (CI on a story or release branch; staging on a release). */
    push(branch, files, opts = {}) {
      const c = w.commit(branch, files, opts);
      if (/^(issue-|release\/)/.test(branch)) s.inflight.push({ workflow: "ci.yml", ref: branch, sha: c, event: "push" });
      if (/^release\//.test(branch)) s.inflight.push({ workflow: "staging-deploy.yml", ref: branch, sha: c, event: "push" });
      // the AI review runs on each push to an open story PR; a spec-only push keeps the review it had (start.decide)
      const open = Object.values(s.prs).find((p) => p.head === branch && p.state === "OPEN");
      if (s.aiReview && open && /^issue-/.test(branch) && !files.every((f) => f.startsWith("e2e/"))) w.review(open.number, c);
      return c;
    },
    status: (on, context, state, description, opts) => postStatus(on, context, state, description, opts),
    /** The AI review starts on a commit (start.startJob: pending on it from the trusted route job, then the run). */
    review(number, on) {
      postStatus(on, "pipeline/ai-review", "pending", "Claude is reviewing this code", { runId: run({ event: "pull_request_target", branch: s.prs[number].head, workflow: "ai-review.yml" }) });
      s.runs[Object.keys(s.runs).at(-1)].pull_requests = [{ base: { ref: s.prs[number].base } }];
      s.inflight.push({ workflow: "ai-review.yml", ref: s.prs[number].head, sha: on, event: "pull_request", pr: number });
    },
    check: (on, name, conclusion, output) => postCheck(on, name, conclusion, output),
    approve(number, login) { (s.reviews[number] ||= []).push({ user: { login, type: "User" }, state: "APPROVED", commit_id: tip(s.prs[number].head), submitted_at: tick() }); },
    comment(number, login, body) { (s.comments[number] ||= []).push({ body, created_at: tick(), user: { login, type: "User" }, author_association: "MEMBER" }); },
    merge(number) { const p = s.prs[number]; p.mergedHead = tip(p.head); p.commits = compare(p.base, p.head).commits.map((c) => c.sha); s.branches[p.base] = p.mergedHead; p.state = "MERGED"; },
    /** Take the next in-flight run (optionally the first matching), as GitHub finishing it. */
    take(match = () => true) { const i = s.inflight.findIndex(match); return i < 0 ? null : s.inflight.splice(i, 1)[0]; },
    /** Act as a run of a workflow: statuses posted meanwhile link it (trusted when it is main's or a release's). */
    acting(opts) { s.actingRun = run(opts); return s.actingRun; },
    /** A copy to try something on (an action) without changing this world. */
    fork() { const c = world({ start: clock, aiReview: s.aiReview }); Object.assign(c.state, structuredClone(s)); return c; },
  };
  return w;
}
