// The scratch-org fleet: which live orgs nothing needs (orphans), capacity, and deletion through the Dev Hub.
// DERIVED from sf-lifecycle-labs pipeline/src/org/fleet.mjs: orphans are judged by open branches, not by GitHub PRs and
// the tracker; no story refusal (ENGINE.md). orgRegistry composes these methods with the provisioning core.
import { join } from "node:path";
import { descriptionFor, isPipelineOrg, storyOf } from "../conventions.mjs";
import { sfFailure } from "../io.mjs";

export const DEVHUB = process.env.DEVHUB_ALIAS || "devhub";
/**
 * Which live scratch orgs nothing needs any more (pure). Orgs whose description the pipeline did not make are left alone.
 *   ci-*        a CI run's temporary org older than tempHours: its run failed before its cleanup, or died
 *   feat-*      no open branch maps to it any more (merged or deleted): openBranches is the remote's branch list
 * openBranches null (unknown) never deletes a feature org.
 */
export function findOrphans(records, { now = new Date(), openBranches = null, prefix = process.env.ORG_PREFIX || "feat-", tempHours = 2 } = {}) {
  const wanted = openBranches ? new Set(openBranches.map((b) => storyOf(b)).filter(Boolean).map((k) => descriptionFor(k, prefix))) : null;
  const out = [];
  for (const r of records) {
    const d = r.Description || "";
    const age = (now - new Date(r.CreatedDate || now)) / 3600e3;
    let why = null;
    if (/^ci-/.test(d) && age > tempHours) why = `CI org ${Math.round(age)} h old (its run did not clean up)`;
    else if (wanted && d.startsWith(prefix) && !wanted.has(d)) why = "no open branch uses it (merged or deleted)";
    if (why) out.push({ username: r.SignupUsername, description: d, why });
  }
  return out;
}

/**
 * Why a new org cannot be created now, or null. Names who holds the slots (another project's orgs share the Dev Hub's
 * limit), and keeps `reserve` slots free (ORG_RESERVE). Unknown limits
 * (the call failed) do not block: creation then fails with Salesforce's own message. Pure.
 */
export function capacityProblem({ active = {}, daily = {} }, holders = [], reserve = 0) {
  const who = () => {
    const ours = holders.filter((d) => isPipelineOrg(d)), others = holders.filter((d) => !isPipelineOrg(d));
    return ` In use: ${[...ours, ...others.map((d) => `${d || "(no description)"} (not this pipeline)`)].join(", ") || "unknown"}.`;
  };
  if (reserve && active.remaining <= reserve) return `Only ${active.remaining} scratch org slot(s) free and ${reserve} kept free (ORG_RESERVE): merge or delete a feature branch first.${who()}`;
  if (active.remaining === 0) return `No free scratch org slot (${active.max} active is the Dev Hub's limit). Merge or delete a feature branch, or run the sweep.${who()}`;
  if (daily.remaining === 0) return `The Dev Hub has created its ${daily.max} scratch orgs for today; the count resets at 00:00 UTC.`;
  return null;
}

/** Salesforce refuses an org from a shape that a release has aged (E5): refresh the shape and try once more. */
export const shapeOutdated = (message) => sfFailure(message) === "shape";   // io.SF_FAILURES, the one table

/** The registry's fleet methods. ctx: orgRegistry's shared context (sf, log, env, ...). */
export function fleetMethods({ sf, sleep, log, keyFile, packages, env, baselineDir, seedDir, record, snapshotRefused, refuseSnapshot, baseline, seedId, active, deleteRecord }) {
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
    limits() {
      const raw = sf(["limits", "api", "display", "-o", DEVHUB], { allowFail: true });
      const l = Array.isArray(raw) ? raw : [];
      const pick = (n) => l.find((x) => x.name === n) || {};
      return { active: pick("ActiveScratchOrgs"), daily: pick("DailyScratchOrgs") };   // unknown limits read as undefined, not 0
    },
  };
}
