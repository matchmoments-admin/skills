// The scratch-org fleet: which live orgs nothing needs (orphans), capacity, refusals, and deletion through the Dev Hub.
// Part of Org provisioning (pipeline/src/org.mjs): orgRegistry composes these methods with the provisioning core.
import { join } from "node:path";
import { storyOf } from "../conventions.mjs";
import { sfFailure } from "../io.mjs";

export const DEVHUB = "devhub";
/**
 * Which live scratch orgs nothing needs any more (pure). Orgs whose description the pipeline did not make are left alone.
 *   ci-*                 a CI run's temporary org older than tempHours: its run failed before its cleanup, or died
 *   issue-N / KEY-N      the story merged or closed (isStoryDone): a merged story's org that a late job rebuilt (E16)
 *   staging-S, uat-S     sprint S is not the open sprint (shipped or abandoned)
 *   pool-N               the warm pool holds more than ORG_POOL (it was lowered: the newest go first), or it is
 *                        older than poolHours (a claimed org keeps only the days it has left: the janitor makes a fresh one)
 */
export function findOrphans(records, { now = new Date(), isStoryClosed = () => false, isStoryDone = isStoryClosed, openSprint = null, tempHours = 2, poolSize = null, poolHours = 72 } = {}) {
  const out = [];
  if (poolSize !== null) {
    const pool = records.filter((r) => POOL.test(r.Description || "")).sort((a, b) => String(a.CreatedDate).localeCompare(String(b.CreatedDate)));
    const stale = pool.filter((r) => (now - new Date(r.CreatedDate || now)) / 3600e3 > poolHours);
    for (const r of stale) out.push({ username: r.SignupUsername, description: r.Description, why: `a pool org older than ${poolHours} h (a story would get only its last days)` });
    const fresh = pool.filter((r) => !stale.includes(r));
    for (const r of fresh.slice(Math.max(0, poolSize))) out.push({ username: r.SignupUsername, description: r.Description, why: `the warm pool is ${poolSize} (ORG_POOL)` });
  }
  for (const r of records) {
    const d = r.Description || "";
    const age = (now - new Date(r.CreatedDate || now)) / 3600e3;
    let why = null;
    if (/^ci-/.test(d) && age > tempHours) why = `CI org ${Math.round(age)} h old (its run did not clean up)`;
    else if (/^issue-\d+$|^[A-Z][A-Z0-9]+-\d+$/.test(d) && isStoryDone(d)) why = "story merged or closed";
    else if (/^(staging|uat)-(.+)$/.test(d) && d.replace(/^(staging|uat)-/, "") !== openSprint) why = "sprint no longer open";
    if (why) out.push({ username: r.SignupUsername, description: d, why });
  }
  return out;
}

/** Is a Description one of this pipeline's orgs? (story, staging, UAT, CI temporary, snapshot source, warm pool) */
export const isPipelineOrg = (d) => /^(issue-\d+|[A-Z][A-Z0-9]+-\d+|staging-.+|uat-.+|ci-.+|snapshot-.+|pool-\d+)$/.test(String(d || ""));
/** A warm pool org: made ahead from the snapshot (ORG_POOL), claimed by the next story that needs an org. */
export const POOL = /^pool-\d+$/;

/** The pool orgs to make now: up to `size`, each only while a slot stays free beyond the reserve (a story or staging
 *  that needs an org must never find the pool holding it). Pure: { records, size, limits, reserve } -> [description]. */
export function poolToMake({ records = [], size = 0, limits = {}, reserve = 0 }) {
  const have = new Set(records.map((r) => r.Description).filter((d) => POOL.test(d || "")));
  const free = (limits.active?.remaining ?? 0) - reserve - 1, daily = (limits.daily?.remaining ?? 0) - 1;   // never the last slot or the day's last org
  const out = [];
  for (let n = 1; n <= size && out.length < Math.min(free, daily); n++) if (!have.has(`pool-${n}`)) out.push(`pool-${n}`);
  return out;
}

/** The pool orgs to make again (pure): those whose snapshot holds another production baseline than `current`, only while
 *  the current snapshot holds `current` (`fresh`), so a new pool org would be better. baselineOf: snapshot name -> id. */
export function stalePool({ records = [], current = null, fresh = null, baselineOf = () => null }) {
  if (!current || fresh !== current) return [];
  return records.filter((r) => POOL.test(r.Description || "") && baselineOf(r.Snapshot) !== current);
}

/**
 * Why a new org cannot be created now, or null. Names who holds the slots (another project's orgs share the Dev Hub's
 * limit: story #193's /start failed on one), and keeps `reserve` slots free for staging, UAT and CI. Unknown limits
 * (the call failed) do not block: creation then fails with Salesforce's own message. Pure.
 */
export function capacityProblem({ active = {}, daily = {} }, holders = [], reserve = 0) {
  const who = () => {
    const ours = holders.filter(isPipelineOrg), others = holders.filter((d) => !isPipelineOrg(d));
    return ` In use: ${[...ours, ...others.map((d) => `${d || "(no description)"} (not this pipeline)`)].join(", ") || "unknown"}.`;
  };
  if (reserve && active.remaining <= reserve) return `Only ${active.remaining} scratch org slot(s) free and ${reserve} kept for staging, UAT and CI (ORG_RESERVE): merge or close a story first.${who()}`;
  if (active.remaining === 0) return `No free scratch org slot (${active.max} active is the Dev Hub's limit). Merge or delete a story first, or run scratch-janitor.${who()}`;
  if (daily.remaining === 0) return `The Dev Hub has created its ${daily.max} scratch orgs for today; the count resets at 00:00 UTC.`;
  return null;
}

/** Salesforce refuses an org from a shape that a release has aged (E5): refresh the shape and try once more. */
export const shapeOutdated = (message) => sfFailure(message) === "shape";   // io.SF_FAILURES, the one table

/** A job for a PR never rebuilds the story org once that PR is no longer open (a late UI test rebuilt issue-193 after
 *  its merge and took the slot UAT needed, E16). Jobs without a PR (start, build) always may: a reopened story gets its
 *  org back. Pure: prState is the job's PR's state, or null. */
export function createRefusal(org, prState = null) {
  if (org?.kind !== "story" || !prState || prState === "OPEN") return null;
  return `story ${org.key}'s PR is ${String(prState).toLowerCase()}: its org is not rebuilt (the job that wanted it is too late)`;
}

/** createRefusal() for a job that names its PR (--pr), its state read through the gh seam. */
export const storyRefusal = (gh, pr) => (org) => (pr ? createRefusal(org, gh(["pr", "view", String(pr), "--json", "state"], { allowFail: true })?.state || null) : null);

/** Is a story org left over from a merge? The branch's latest PR merged, none is open, and the org was made before that
 *  merge (one made after belongs to a story reopened and started again). Pure. */
export const mergedBefore = (prs = [], orgCreated) => {
  if (prs.some((p) => p.state === "OPEN")) return false;
  const merged = prs.filter((p) => p.state === "MERGED").map((p) => String(p.mergedAt || "")).sort().pop();
  return Boolean(merged && orgCreated && String(orgCreated) < merged);
};

/** The live orgs whose story is done: closed in the tracker, or merged after the org was made (mergedBefore). records:
 *  [{ Description, CreatedDate }]; gh reads the branch's PRs. For sweep(). */
export async function doneStoryOrgs(records, { tracker, gh, log = () => {} }) {
  const done = new Set();
  for (const r of records) {
    const d = r.Description || "", key = storyOf(d);
    if (!key) continue;
    try {
      const prs = gh(["pr", "list", "--head", d, "--state", "all", "--limit", "20", "--json", "state,mergedAt"], { allowFail: true }) || [];
      if (mergedBefore(prs, r.CreatedDate) || (await tracker.story(key)).state === "CLOSED") done.add(d);
    } catch (e) { log(`skipped ${d}: ${e.message}`); }
  }
  return done;
}

/** The registry's fleet methods. ctx: orgRegistry's shared context (sf, log, env, ...). */
export function fleetMethods({ sf, sleep, log, keyFile, packages, env, baselineDir, seedDir, record, snapshotRefused, refuseSnapshot, baseline, seedId, active, deleteRecord, changed = () => {}, snapshotBaselineOf = () => null }) {
  return {
    /** Delete every live org with this description (works when the alias was never set: a half-made CI org). */
    removeTagged(description) {
      let n = 0;
      for (const r of active().filter((x) => x.Description === description)) {
        if (deleteRecord(r.SignupUsername)) { n++; log(`deleted ${description} (${r.SignupUsername})`); }
        else log(`could not delete ${description} (${r.SignupUsername}); the janitor will retry`);
      }
      if (!n) log(`no live org tagged ${description}`);
      return n;
    },
    /** Find and delete orphans (see findOrphans). Returns what was deleted, with why. */
    sweep(facts) {
      const gone = [];
      for (const o of findOrphans(active(), facts)) {
        if (deleteRecord(o.username)) { gone.push(o); log(`deleted ${o.description}: ${o.why}`); }
        else log(`could not delete ${o.description} (${o.why})`);
      }
      return gone;
    },
    /**
     * Claim a warm pool org for this org (a story's): its Description becomes the story's, so find() and attach() see it
     * as the story's own. Null when the pool is empty (or off). The Dev Hub's ScratchOrgInfo Description is editable.
     */
    claimPool(org) {
      if (org.kind !== "story" || !(Number(env.ORG_POOL) > 0)) return null;
      // the newest first: the most days left (an org's expiry cannot be extended). Two stories starting at once may pick
      // the same pool org: only the one whose Description stuck has it, and the other tries the next pool org rather than
      // spending a daily slot on a new one (27 Oct review). Up to three tries; then a new org. A pool org whose snapshot
      // holds the current production baseline comes before a newer one that does not: it skips the baseline deploy (#426).
      const tried = new Set(), current = baseline();
      const behind = (x) => (current && snapshotBaselineOf(x.Snapshot) === current ? 0 : 1);
      for (let i = 0; i < 3; i++) {
        const r = active().filter((x) => POOL.test(x.Description || "") && !tried.has(x.SignupUsername))
          .sort((a, b) => behind(a) - behind(b) || String(b.CreatedDate).localeCompare(String(a.CreatedDate)))[0];
        if (!r) return null;
        tried.add(r.SignupUsername);
        const ok = sf(["data", "update", "record", "-o", DEVHUB, "-s", "ScratchOrgInfo", "-w", `SignupUsername='${r.SignupUsername}'`, "-v", `Description='${org.description}'`], { allowFail: true });
        changed();   // read the Dev Hub again: only the claim whose Description stuck is ours
        const mine = ok && active().some((x) => x.SignupUsername === r.SignupUsername && x.Description === org.description);
        if (!mine) { log(`::warning::could not claim ${r.Description}: trying the next pool org`); continue; }
        record("org", { action: "claimed", org: org.description, from: r.Description });
        log(`claimed warm pool org ${r.Description} for ${org.alias}`);
        // the snapshot it was made from (ScratchOrgInfo.Snapshot) and the baseline that snapshot holds
        return { fromSnapshot: true, pooled: r.Description, snapshot: r.Snapshot || null, baseline: snapshotBaselineOf(r.Snapshot) };
      }
      log(`::warning::no pool org could be claimed: creating ${org.alias} instead`);
      return null;
    },
    limits() {
      const raw = sf(["limits", "api", "display", "-o", DEVHUB], { allowFail: true });
      const l = Array.isArray(raw) ? raw : [];
      const pick = (n) => l.find((x) => x.name === n) || {};
      return { active: pick("ActiveScratchOrgs"), daily: pick("DailyScratchOrgs") };   // unknown limits read as undefined, not 0
    },
  };
}
