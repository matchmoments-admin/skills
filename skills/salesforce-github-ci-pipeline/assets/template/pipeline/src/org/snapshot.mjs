// Scratch org snapshots: the current one new orgs start from, its age, and making a new one.
// Part of Org provisioning (pipeline/src/org.mjs): orgRegistry composes these methods with the provisioning core.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DEVHUB } from "./fleet.mjs";

/**
 * A short id of what a release can change in the org shape a snapshot is made from: the Settings metadata in the
 * source (*.settings-meta.xml, deployed to production and then captured by the release's `shape` job) and the
 * snapshot source org's scratch definition. null when there is none. A release of force-app code alone leaves it as it was.
 */
export function shapeInputsId(root, { dirs = ["force-app"], definition = "config/scratch-dev.json" } = {}) {
  const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
  const files = [...dirs.flatMap((d) => walk(join(root, d)).filter((f) => f.endsWith(".settings-meta.xml"))), join(root, definition)].filter((f) => existsSync(f)).sort();
  if (!files.length) return null;
  const h = createHash("sha256");
  for (const f of files) h.update(relative(root, f)).update("\0").update(readFileSync(f)).update("\0");
  return h.digest("hex").slice(0, 10);
}

/**
 * What a pipeline snapshot says it holds (its Dev Hub description, at most 255 characters): the production baseline's
 * id (b), the seed's (s) and the shape inputs' (h), then main's commit. The ids come first, so the cut (here only)
 * shortens the free text, never an id. Pure.
 */
export const snapshotDescription = ({ commit = "", baseline = null, seed = null, shape = null }) =>
  [baseline && `b${baseline}`, seed && `s${seed}`, shape && `h${shape}`, `main@${commit}`].filter(Boolean).join(" ").slice(0, 255);
/** The ids a snapshot's description names (null when it names none). Pure. Ids are 10 hex (baselineId), so main's
 *  short SHA (main@b1c2d3e) is never read as one; descriptions written before #430 (main@ first) still read. */
export const snapshotHolds = (description) => {
  const id = (p) => new RegExp(`(?:^|\\s)${p}([0-9a-f]{10})(?=\\s|$)`).exec(String(description || ""))?.[1] || null;
  return { baseline: id("b"), seed: id("s"), shape: id("h") };
};
const IDS = { baseline: "baseline", seed: "seed", shape: "shape inputs (production's settings, the scratch definition)" };
const ours = (list) => (Array.isArray(list) ? list : []).filter((s) => /^LCB\d+$/.test(s.SnapshotName || ""))
  .sort((a, b) => String(b.CreatedDate).localeCompare(String(a.CreatedDate)));
const at = (s) => Date.parse(String(s.CreatedDate).replace(/\+0000$/, "Z"));

/** The registry's snapshot methods. ctx: orgRegistry's shared context (sf, log, env, ...). */
export function snapshotMethods({ sf, sleep, log, keyFile, packages, env, baselineDir, seedDir, record, snapshotRefused, refuseSnapshot, baseline, seedId, shapeId, active, deleteRecord, snapshotList, snapshotBaselineOf, snapshotsChanged = () => {} }) {
  return {
    /**
     * The snapshot new orgs start from: SCRATCH_SNAPSHOT if set ("off" turns snapshots off), else the newest Active
     * pipeline snapshot (LCB...) in the Dev Hub, so no variable has to be written when a new one is made.
     */
    currentSnapshot() {
      const set = String(env.SCRATCH_SNAPSHOT || "").trim();
      if (set.toLowerCase() === "off") return null;
      if (/^[A-Za-z0-9]{1,15}$/.test(set)) return set;
      return snapshotList().filter((s) => /^LCB\d+$/.test(s.SnapshotName || "") && s.Status === "Active" && !snapshotRefused(s.SnapshotName))
        .sort((a, b) => String(b.CreatedDate).localeCompare(String(a.CreatedDate)))[0]?.SnapshotName || null;
    },
    /** The production baseline a snapshot holds: the b<id> its description carries (pipe snapshot refresh), or null. */
    snapshotBaseline(name) { return snapshotBaselineOf(name); },
    /**
     * Whether `pipe snapshot refresh` builds a snapshot (#430), from one listing and one hash of each input:
     * { rebuild, why, ids } (ids: what the new one's description names). Not when SCRATCH_SNAPSHOT pins one (nothing
     * would use a new one) or is off; with olderThan, not when the newest Active one is younger; with ifChanged, not
     * when the newest Active one, or a newer one Salesforce is still making (a second push queued behind the first),
     * already holds main's baseline, seed and shape inputs. Asked plainly (by hand): always.
     */
    snapshotPlan({ ifChanged = false, onPush = false, olderThan = null, now = Date.now() } = {}) {
      const pin = String(env.SCRATCH_SNAPSHOT || "").trim();
      if (pin) return { rebuild: false, why: pin.toLowerCase() === "off" ? "snapshots are off (SCRATCH_SNAPSHOT=off): not built" : `::notice::SCRATCH_SNAPSHOT pins ${pin}: new orgs use it, so a pipeline snapshot would go unused; not built (unset it to build one)`, ids: {} };
      const list = ours(snapshotList()).filter((s) => !snapshotRefused(s.SnapshotName));
      const current = list.find((s) => s.Status === "Active");
      const ids = { baseline: baseline(), seed: seedId(), shape: shapeId() };
      if (olderThan !== null && current && (now - at(current)) / 3600e3 < Number(olderThan)) return { rebuild: false, why: `${current.SnapshotName} is ${((now - at(current)) / 3600e3).toFixed(1)} h old: not rebuilt`, ids };
      if (!ifChanged) return { rebuild: true, why: "asked", ids };
      const lacks = (s) => Object.keys(IDS).find((k) => snapshotHolds(s.Description)[k] !== ids[k]);
      const coming = list.find((s) => s.Status !== "Active" && !/error|expired|deleted/i.test(s.Status || "") && (!current || at(s) > at(current)) && !lacks(s));
      if (coming) return { rebuild: false, why: `${coming.SnapshotName} (${coming.Status}) is being made with main's baseline, seed and shape inputs: not rebuilt`, ids };
      if (!current) return { rebuild: true, why: "no Active snapshot", ids };
      // Settings reach main only in a release (or hotfix) merge, whose push comes before the deploy and the shape refresh:
      // building now would record the new shape inputs on the old shape, and the release's run would then skip
      const shapeHeld = snapshotHolds(current.Description).shape;
      if (onPush && shapeHeld && shapeHeld !== ids.shape) return { rebuild: false, why: `main's shape inputs changed: the release rebuilds it after its shape job (${current.SnapshotName} holds ${shapeHeld}, main has ${ids.shape || "none"})`, ids };
      const k = lacks(current);
      return k ? { rebuild: true, why: `${current.SnapshotName} holds ${IDS[k]} ${snapshotHolds(current.Description)[k] || "(none named)"}, main has ${ids[k] || "none"}`, ids }
        : { rebuild: false, why: `${current.SnapshotName} already holds main's baseline, seed and shape inputs: not rebuilt`, ids };
    },
    /** The newest Active pipeline snapshot's age in hours, or null (for "rebuild at most once a day"). */
    snapshotAgeHours(now = Date.now()) {
      const newest = snapshotList().filter((s) => /^LCB\d+$/.test(s.SnapshotName || "") && s.Status === "Active")
        .map((s) => Date.parse(String(s.CreatedDate).replace(/\+0000$/, "Z"))).sort().pop();
      return newest ? (now - newest) / 3600e3 : null;
    },
    /**
     * Make a new snapshot of a ready source org (production's shape + packages + baseline + seed), wait until it is
     * Active, then keep only the newest `keep` pipeline snapshots. Returns { name, active }.
     */
    snapshot(alias, { name, description, waitMinutes = 60, keep = 2 }) {
      try { sf(["org", "create", "snapshot", "--name", name, "--source-org", alias, "-v", DEVHUB, "--description", String(description)]); } finally { snapshotsChanged(); }   // snapshotDescription keeps it within 255
      let status = "";
      for (let i = 0; i < Math.ceil(waitMinutes / 2); i++) {
        status = sf(["org", "get", "snapshot", "--snapshot", name, "-v", DEVHUB], { allowFail: true })?.Status || "";
        log(`snapshot ${name}: ${status || "?"}`);
        if (status === "Active" || status === "Error") break;
        sleep(120_000);
      }
      if (status === "Active") {
        snapshotsChanged();
        const ours = snapshotList().filter((s) => /^LCB\d+$/.test(s.SnapshotName || ""))
          .sort((a, b) => String(b.CreatedDate).localeCompare(String(a.CreatedDate)));
        for (const old of ours.slice(keep)) { sf(["org", "delete", "snapshot", "--snapshot", old.SnapshotName, "-v", DEVHUB, "--no-prompt"], { allowFail: true }); log(`deleted old snapshot ${old.SnapshotName}`); }
        snapshotsChanged();
      }
      return { name, active: status === "Active", status };
    },
  };
}
