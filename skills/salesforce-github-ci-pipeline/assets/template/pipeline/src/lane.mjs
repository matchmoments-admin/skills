// A lane: one job at a time in an org, and a queue that never drops anyone (see CONTEXT.md: Lane).
//
// GitHub's concurrency groups keep only the newest waiting run and cancel the one before it, which silently loses a
// fix, a test run, or a required check when different jobs share an org. A lane is a git ref, refs/locks/<name>, created
// atomically through the API (a second create fails), pointing at a commit whose message says who holds it. Waiters
// poll; a holder whose run has finished (crashed, cancelled) or that is older than the TTL is taken over with a
// fast-forward-only update, so two waiters can never both take it. API budget: a waiting poll is one read of the ref
// (the holder's commit is read once, its run checked every few minutes, the claim commit made once per acquire), every
// 30 s with jitter: about 120 requests an hour per waiting job, inside the 1,000/hour token budget at scale.
// `api(method, path, body)` is the seam: it returns the parsed JSON, or { status } for an HTTP error.

const WAITING = Symbol("waiting");
const STALE_CHECK_MS = 3 * 60e3;

export function lane({ api, repo, holder, now = () => Date.now(), sleep, log = () => {}, ttlMinutes = 150, onWait = () => {} }) {
  const ref = (name) => `refs/locks/${name}`;
  const path = (name) => `repos/${repo}/git/${ref(name)}`;
  const me = JSON.stringify({ ...holder, at: new Date(now()).toISOString() });
  const read = (msg) => { try { return JSON.parse(msg); } catch { return {}; } };
  const same = (h) => h.run === holder.run && h.job === holder.job;

  /** The commit that says "held by me" (on top of `parent` when taking over a stale lock). */
  const claim = (tree, parent) => api("POST", `repos/${repo}/git/commits`, { message: me, tree, parents: parent ? [parent] : [] });

  /** Is a holder gone? Its run finished, or it is older than the TTL (a job that never released). The run is looked up
   *  at most every few minutes per holder. */
  const runChecked = new Map();
  function stale(h) {
    if (!h.run) return true;
    if (now() - new Date(h.at || 0).getTime() > ttlMinutes * 60e3) return true;
    const last = runChecked.get(h.run);
    if (last && now() - last.at < STALE_CHECK_MS) return last.done;
    const done = api("GET", `repos/${repo}/actions/runs/${h.run}`)?.status === "completed";
    runChecked.set(h.run, { at: now(), done });
    return done;
  }
  const holders = new Map();   // commit sha -> holder (commits never change)
  let mine = null;             // this acquire's claim commit, made once

  function tryOnce(name, tree) {
    const cur = api("GET", path(name));
    if (cur?.status === 404) {                                                 // free: claim it (atomic: one creator wins)
      if (!mine) {
        const c = claim(tree);
        if (!c?.sha) return { error: `could not write the claim (${c?.status || "?"}: ${c?.message || "no sha"})` };
        mine = c.sha;
      }
      const made = api("POST", `repos/${repo}/git/refs`, { ref: ref(name), sha: mine });
      if (!made?.status) return true;
      if (made.status !== 422) { mine = null; return { error: `could not create the lock (${made.status}: ${made.message || ""})` }; }
      return WAITING;                                                          // someone else won the race
    }
    if (cur?.status) return { error: `could not read the lock (${cur.status}: ${cur.message || ""})` };
    const sha = cur?.object?.sha;
    if (!holders.has(sha)) holders.set(sha, read(api("GET", `repos/${repo}/git/commits/${sha}`)?.message));
    const h = holders.get(sha);
    if (same(h)) return true;                                                  // this job already holds it (a retried step)
    if (!stale(h)) return { waitingFor: h };
    log(`lane ${name}: taking over from run ${h.run} (${h.job || "?"}), which finished or timed out`);
    const took = api("PATCH", path(name), { sha: claim(tree, sha).sha, force: false });   // fast-forward only: one winner
    return took?.status ? WAITING : true;
  }

  return {
    /** Wait for the lane and hold it. Throws after timeoutMinutes. */
    acquire(name, { timeoutMinutes = 45, pollSeconds = 30 } = {}) {
      // The claim commit needs a tree that stays reachable: main's. (A PR job's GITHUB_SHA is GitHub's test-merge
      // commit, which is replaced when the base moves; a claim on its tree then fails, which once looked like waiting.)
      const mainTree = () => api("GET", `repos/${repo}/commits/main`)?.commit?.tree?.sha;
      let tree = mainTree();
      if (!tree) throw new Error(`lane ${name}: cannot read main`);
      const until = now() + timeoutMinutes * 60e3;
      let told = null, errors = 0;
      for (;;) {
        const r = tryOnce(name, tree);
        if (r === true) { log(`lane ${name}: held by run ${holder.run} (${holder.job})`); return true; }
        if (r?.error) {
          log(`::warning::lane ${name}: ${r.error}; retrying`);
          tree = mainTree() || tree;
          if (++errors >= 5) throw new Error(`lane ${name}: ${r.error} (5 times in a row)`);
        } else errors = 0;
        if (r !== WAITING && r.waitingFor && r.waitingFor.run !== told) { told = r.waitingFor.run; onWait(r.waitingFor); log(`lane ${name}: waiting for run ${told} (${r.waitingFor.job || "?"}), queued since ${r.waitingFor.at || "?"}`); }
        if (now() > until) throw new Error(`lane ${name}: still busy after ${timeoutMinutes} minutes (run ${told}); try again later`);
        sleep(pollSeconds * 1000 * (0.8 + Math.random() * 0.4));   // jitter: waiters do not poll in step
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
