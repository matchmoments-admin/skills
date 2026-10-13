// A lane: one job at a time in an org, and a queue that never drops anyone (see GLOSSARY.md: Lane).
//
// GitHub's concurrency groups keep only the newest waiting run and cancel the one before it, which silently loses a
// fix, a test run, or a required check when different jobs share an org. A lane is a git ref, refs/locks/<name>, created
// atomically through the API (a second create fails), pointing at a commit whose message says who holds it. Waiters
// poll; a holder whose run has finished (crashed, cancelled) or that is older than the TTL is taken over with a
// fast-forward-only update, so two waiters can never both take it. API budget: a waiting poll is one read of the ref
// (the holder's commit is read once, its run checked every few minutes, the claim commit made once per acquire), every
// 30 s with jitter: about 120 requests an hour per waiting job, inside the 1,000/hour token budget at scale.
// `api(method, path, body)` is the seam: it returns the parsed JSON, or { status } for an HTTP error.
//
// Parking (#236): a job that can wait cheaply does not poll on a billed runner. `park` looks once; if the lane is busy
// the job writes a waiter ref, refs/lane-waits/<lane>/<ms>-<kind>-<run>-<jobId>, and ends, giving its runner back.
// The holder's release sends a lane-freed event; lane-wake.yml then re-runs the oldest waiter's job (`wake`). A second
// waiter of the same kind in the same lane is dropped: the one already queued does the same work when it runs.

const WAITING = Symbol("waiting");
const WAIT_REF = /^(\d+)-(.+)-(\d+)-(\d+)$/;
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

  // The claim commit needs a tree that stays reachable: main's. (A PR job's GITHUB_SHA is GitHub's test-merge
  // commit, which is replaced when the base moves; a claim on its tree then fails, which once looked like waiting.)
  const mainTree = () => api("GET", `repos/${repo}/commits/main`)?.commit?.tree?.sha;
  const waitPath = (name) => `refs/lane-waits/${name}/`;
  /** The lane's parked jobs, oldest first: { ref, at, kind, run, jobId }. */
  const waiters = (name) => {
    const refs = api("GET", `repos/${repo}/git/matching-refs/${waitPath(name).slice(5)}`);
    return (Array.isArray(refs) ? refs : []).map((r) => [r.ref, WAIT_REF.exec(r.ref.slice(waitPath(name).length))])
      .filter(([, m]) => m).map(([ref, m]) => ({ ref, at: Number(m[1]), kind: m[2], run: m[3], jobId: m[4] })).sort((a, b) => a.at - b.at);
  };
  const unpark = (w) => api("DELETE", `repos/${repo}/git/${w.ref}`);

  return {
    waiters,

    /** Hold the lane now, or park: { held } | { parked, waitingFor } | { dropped, waitingFor } (the same kind already
     *  waits). kind: the job's role in the lane (fix, write, run); jobId: this job's id, which wake re-runs. */
    park(name, { kind, jobId }) {
      const tree = mainTree();
      if (!tree) throw new Error(`lane ${name}: cannot read main`);
      const look = () => { const r = tryOnce(name, tree); if (r?.error) throw new Error(`lane ${name}: ${r.error}`); return r; };
      let r = look();
      if (r === true) return { held: true };
      const waitingFor = r?.waitingFor || {};
      if (waiters(name).some((w) => w.kind === kind)) return { dropped: true, waitingFor };
      const sha = api("GET", `repos/${repo}/commits/main`)?.sha;
      const me = { ref: `${waitPath(name)}${now()}-${kind}-${holder.run}-${jobId}` };
      const made = api("POST", `repos/${repo}/git/refs`, { ref: me.ref, sha });
      if (made?.status) throw new Error(`lane ${name}: could not park (${made.status}: ${made.message || ""})`);
      r = look();   // the holder may have released between the first look and the waiter ref: nobody would wake us
      if (r === true) { unpark(me); return { held: true }; }
      const h = r?.waitingFor || waitingFor;
      if (h.run) onWait(h);
      return { parked: true, waitingFor: h };
    },

    /** The oldest parked job, taken off the queue, if the lane is free or its holder has finished; else null. The
     *  caller re-runs its job (which then parks again if another job got in first). */
    wake(name) {
      const cur = api("GET", path(name));
      if (cur?.object?.sha && !stale(read(api("GET", `repos/${repo}/git/commits/${cur.object.sha}`)?.message))) return null;
      const w = waiters(name)[0];
      if (w) unpark(w);
      return w || null;
    },

    /** Wait for the lane and hold it. Throws after timeoutMinutes. */
    acquire(name, { timeoutMinutes = 45, pollSeconds = 30 } = {}) {
      let tree = mainTree();
      if (!tree) throw new Error(`lane ${name}: cannot read main`);
      const until = now() + timeoutMinutes * 60e3;
      let told = null, errors = 0, polls = 0;
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
        // back off (30 s, 60 s, 2 min, then 3 min) so many waiters stay far inside the API's hourly limit; jitter keeps them apart
        sleep(Math.min(180, pollSeconds * 2 ** Math.min(3, polls++)) * 1000 * (0.8 + Math.random() * 0.4));
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

/** This job's id (wake re-runs it): the in-progress job of this run attempt on this runner. null if not found. */
export function jobId({ api, repo, env = process.env }) {
  const jobs = api("GET", `repos/${repo}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT || 1}/jobs?per_page=100`)?.jobs || [];
  const mine = jobs.filter((j) => j.status === "in_progress" && j.runner_name === env.RUNNER_NAME);
  return mine.length === 1 ? String(mine[0].id) : null;
}

/** Re-run the oldest parked job if the lane is free. A job can be re-run only once its whole run has ended, which a
 *  parked job's run does within a minute or two (its later jobs skip): wait up to waitMinutes for that. */
export function wakeNext({ api, repo, l, name, sleep, log = () => {}, now = () => Date.now(), waitMinutes = 5 }) {
  const w = l.wake(name);
  if (!w) return log(`lane ${name}: nobody to wake (busy, or no one parked)`) || null;
  for (const until = now() + waitMinutes * 60e3; api("GET", `repos/${repo}/actions/runs/${w.run}`)?.status !== "completed" && now() < until;) sleep(15e3);
  const r = api("POST", `repos/${repo}/actions/jobs/${w.jobId}/rerun`);
  log(r?.status ? `::warning::lane ${name}: could not re-run job ${w.jobId} of run ${w.run} (${r.status}: ${r.message || ""})` : `lane ${name}: re-ran ${w.kind} (job ${w.jobId}, run ${w.run}), parked since ${new Date(w.at).toISOString()}`);
  return w;
}
