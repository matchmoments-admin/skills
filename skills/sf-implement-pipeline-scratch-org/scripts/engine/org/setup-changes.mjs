// Setup changes made by hand in a feature's org, retrieved into the branch.
// DERIVED from sf-lifecycle-labs pipeline/src/org/setup-changes.mjs: the login suffix is USERNAME_SUFFIX (ENGINE.md).
// Part of Org provisioning (pipeline/src/org.mjs): orgRegistry composes these methods with the provisioning core.
import { excluded } from "../baseline.mjs";

/** The registry's setup-changes methods. ctx: orgRegistry's shared context (sf, log, env, ...). */
export function setupChangesMethods({ sf, sleep, log, keyFile, packages, env, baselineDir, seedDir, record, snapshotRefused, refuseSnapshot, baseline, seedId, active, deleteRecord }) {
  return {
    /**
     * What people changed in Setup in this source-tracked org: SourceMember rows changed by the logins the pipeline
     * gave people (Send me a login: <login>.admin@ / <login>.uat@ ... .pipeline; never the UI tests' persona.* users).
     * Not the org's admin user (every pipeline deploy), nor the system users and the snapshot's own rows (live
     * story #166: 327 rows, none by a person). Profiles never (permission sets carry access), nor what
     * config/baseline.json excludes, nor sub-parts whose bundle is listed too. Deletions are not included. [{ type, name }].
     */
    setupChanges(alias, { exclude = [] } = {}) {
      const suffix = String(env.USERNAME_SUFFIX || "pipeline").replace(/[^a-z0-9-]/gi, "");
      const id15 = (x) => String(x || "").slice(0, 15);   // ChangedBy holds 15-character ids
      const people = new Set((sf(["data", "query", "-o", alias, "-q", `SELECT Id FROM User WHERE Username LIKE '%.${suffix}' AND (NOT Username LIKE 'persona.%')`], { allowFail: true })?.records || []).map((u) => id15(u.Id)));
      if (!people.size) return [];
      const rows = (by) => sf(["data", "query", "-o", alias, "--use-tooling-api", "-q", `SELECT MemberType, MemberName, IsNameObsolete, ${by} FROM SourceMember`], { allowFail: true })?.records;
      let by = "ChangedBy", list = rows(by);   // ChangedBy is API 60+; LastModifiedById otherwise
      if (!list) { by = "LastModifiedById"; list = rows(by) || []; }
      const seen = new Set();
      return list.filter((r) => people.has(id15(r[by])) && !r.IsNameObsolete && !/^(LightningComponentResource|AuraDefinition)$/.test(r.MemberType)
        && !excluded(r.MemberType, r.MemberName, ["Profile", ...exclude]))
        .map((r) => ({ type: r.MemberType, name: r.MemberName })).filter((c) => !seen.has(`${c.type}:${c.name}`) && seen.add(`${c.type}:${c.name}`));
    },
    /** Retrieve those changes into the source (sfdx-project.json's default folder): the branch owns them from now on. */
    retrieveChanges(alias, changes) {
      if (changes.length) sf(["project", "retrieve", "start", "-o", alias, ...changes.flatMap((c) => ["-m", `${c.type}:${c.name}`]), "--ignore-conflicts"]);
      return changes;
    },
  };
}
