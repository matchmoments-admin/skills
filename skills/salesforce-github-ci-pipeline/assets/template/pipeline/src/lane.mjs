// A lane: one job at a time in an org, and a queue that never drops anyone (see CONTEXT.md: Lane).
//
// GitHub's concurrency groups keep only the newest waiting run and cancel the one before it, which silently loses a
// fix, a test run, or a required check when different jobs share an org. A lane is a git ref, refs/locks/<name>, created
// atomically through the API (a second create fails), pointing at a commit whose message says who holds it. Waiters
// poll; a holder whose run has finished (crashed, cancelled) or that is older than the TTL is taken over with a
// fast-forward-only update, so two waiters can never both take it. Costs one API call per poll while waiting.
// `api(method, path, body)` is the seam: it returns the parsed JSON, or { status } for an HTTP error.

const WAITING = Symbol("waiting");

export function lane({ api, repo, holder, now = () => Date.now(), sleep, log = () => {}, ttlMinutes = 150 }) {
  const ref = (name) => `refs/locks/${name}`;
  const path = (name) => `repos/${repo}/git/${ref(name)}`;
  const me = JSON.stringify({ ...holder, at: new Date(now()).toISOString() });
  const read = (msg) => { try { return JSON.parse(msg); } catch { return {}; } };
  const same = (h) => h.run === holder.run && h.job === holder.job;

  /** The commit that says "held by me" (on top of `parent` when taking over a stale lock). */
  const claim = (tree, parent) => api("POST", `repos/${repo}/git/commits`, { message: me, tree, parents: parent ? [parent] : [] });

  /** Is a holder gone? Its run finished, or it is older than the TTL (a job that never released). */
  function stale(h) {
    if (!h.run) return true;
    if (now() - new Date(h.at || 0).getTime() > ttlMinutes * 60e3) return true;
    const run = api("GET", `repos/${repo}/actions/runs/${h.run}`);
    return run?.status === "completed";
  }

  function tryOnce(name, tree) {
    const made = api("POST", `repos/${repo}/git/refs`, { ref: ref(name), sha: claim(tree).sha });
    if (!made?.status) return true;
    const cur = api("GET", path(name));
    if (cur?.status === 404) return WAITING;                                   // released between the two calls: retry
    const sha = cur?.object?.sha;
    const h = read(api("GET", `repos/${repo}/git/commits/${sha}`)?.message);
    if (same(h)) return true;                                                  // this job already holds it (a retried step)
    if (!stale(h)) return { waitingFor: h };
    log(`lane ${name}: taking over from run ${h.run} (${h.job || "?"}), which finished or timed out`);
    const took = api("PATCH", path(name), { sha: claim(tree, sha).sha, force: false });   // fast-forward only: one winner
    return took?.status ? WAITING : true;
  }

  return {
    /** Wait for the lane and hold it. Throws after timeoutMinutes. */
    acquire(name, { timeoutMinutes = 45, pollSeconds = 20 } = {}) {
      const tree = api("GET", `repos/${repo}/git/commits/${holder.sha}`)?.tree?.sha;
      if (!tree) throw new Error(`lane ${name}: cannot read commit ${holder.sha}`);
      const until = now() + timeoutMinutes * 60e3;
      let told = null;
      for (;;) {
        const r = tryOnce(name, tree);
        if (r === true) { log(`lane ${name}: held by run ${holder.run} (${holder.job})`); return true; }
        if (r !== WAITING && r.waitingFor.run !== told) { told = r.waitingFor.run; log(`lane ${name}: waiting for run ${told} (${r.waitingFor.job || "?"}), queued since ${r.waitingFor.at || "?"}`); }
        if (now() > until) throw new Error(`lane ${name}: still busy after ${timeoutMinutes} minutes (run ${told}); try again later`);
        sleep(pollSeconds * 1000);
      }
    },

    /** Let the next job in. Only the holder releases; a lane someone took over is theirs. */
    release(name) {
      const cur = api("GET", path(name));
      if (!cur?.object?.sha) return false;
      const h = read(api("GET", `repos/${repo}/git/commits/${cur.object.sha}`)?.message);
      if (!same(h)) { log(`lane ${name}: held by run ${h.run}, not this job: left alone`); return false; }
      api("DELETE", path(name));
      log(`lane ${name}: released`);
      return true;
    },
  };
}
