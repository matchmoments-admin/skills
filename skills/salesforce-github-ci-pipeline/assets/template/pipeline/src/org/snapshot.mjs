// Scratch org snapshots: the current one new orgs start from, its age, and making a new one.
// Part of Org provisioning (pipeline/src/org.mjs): orgRegistry composes these methods with the provisioning core.
import { DEVHUB } from "./fleet.mjs";

/** The registry's snapshot methods. ctx: orgRegistry's shared context (sf, log, env, ...). */
export function snapshotMethods({ sf, sleep, log, keyFile, packages, env, baselineDir, seedDir, record, snapshotRefused, refuseSnapshot, baseline, seedId, active, deleteRecord }) {
  return {
    /**
     * The snapshot new orgs start from: SCRATCH_SNAPSHOT if set ("off" turns snapshots off), else the newest Active
     * pipeline snapshot (LCB...) in the Dev Hub, so no variable has to be written when a new one is made.
     */
    currentSnapshot() {
      const set = String(env.SCRATCH_SNAPSHOT || "").trim();
      if (set.toLowerCase() === "off") return null;
      if (/^[A-Za-z0-9]{1,15}$/.test(set)) return set;
      const list = sf(["org", "list", "snapshot", "-v", DEVHUB], { allowFail: true }) || [];
      return (Array.isArray(list) ? list : []).filter((s) => /^LCB\d+$/.test(s.SnapshotName || "") && s.Status === "Active" && !snapshotRefused(s.SnapshotName))
        .sort((a, b) => String(b.CreatedDate).localeCompare(String(a.CreatedDate)))[0]?.SnapshotName || null;
    },
    /** The newest Active pipeline snapshot's age in hours, or null (for "rebuild at most once a day"). */
    snapshotAgeHours(now = Date.now()) {
      const list = sf(["org", "list", "snapshot", "-v", DEVHUB], { allowFail: true }) || [];
      const newest = (Array.isArray(list) ? list : []).filter((s) => /^LCB\d+$/.test(s.SnapshotName || "") && s.Status === "Active")
        .map((s) => Date.parse(String(s.CreatedDate).replace(/\+0000$/, "Z"))).sort().pop();
      return newest ? (now - newest) / 3600e3 : null;
    },
    /**
     * Make a new snapshot of a ready source org (production's shape + packages + baseline + seed), wait until it is
     * Active, then keep only the newest `keep` pipeline snapshots. Returns { name, active }.
     */
    snapshot(alias, { name, description, waitMinutes = 60, keep = 2 }) {
      sf(["org", "create", "snapshot", "--name", name, "--source-org", alias, "-v", DEVHUB, "--description", String(description).slice(0, 255)]);
      let status = "";
      for (let i = 0; i < Math.ceil(waitMinutes / 2); i++) {
        status = sf(["org", "get", "snapshot", "--snapshot", name, "-v", DEVHUB], { allowFail: true })?.Status || "";
        log(`snapshot ${name}: ${status || "?"}`);
        if (status === "Active" || status === "Error") break;
        sleep(120_000);
      }
      if (status === "Active") {
        const ours = (sf(["org", "list", "snapshot", "-v", DEVHUB], { allowFail: true }) || []).filter((s) => /^LCB\d+$/.test(s.SnapshotName || ""))
          .sort((a, b) => String(b.CreatedDate).localeCompare(String(a.CreatedDate)));
        for (const old of ours.slice(keep)) { sf(["org", "delete", "snapshot", "--snapshot", old.SnapshotName, "-v", DEVHUB, "--no-prompt"], { allowFail: true }); log(`deleted old snapshot ${old.SnapshotName}`); }
      }
      return { name, active: status === "Active", status };
    },
  };
}
