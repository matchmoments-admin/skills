// Retired Flows: a Flow the source commits as Obsolete or Draft is switched off in the org after a deploy. A deploy
// alone does not do it: the file only adds an inactive version, and the active one keeps running (release
// v2026.11.08-30 left Case_Default_Web_Priority v16 Active beside a new v17 Draft in production, 9 Nov). The Tooling
// API's FlowDefinition with activeVersionNumber 0 deactivates the Flow, as Setup's Deactivate button does.
// Part of Org provisioning (pipeline/src/org.mjs) and the release (`pipe org retire-flows devhub`).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { restIn } from "./data-store.mjs";

const RETIRED = /^(Obsolete|Draft|InvalidDraft)$/;

/** The names of the Flows the source retires: Flow files whose status is Obsolete or Draft. Pure over `read`. */
export function retiredFlows(paths, read) {
  return paths.filter((p) => p.endsWith(".flow-meta.xml"))
    .filter((p) => RETIRED.test((String(read(p)).match(/<status>([^<]+)<\/status>/) || [])[1] || ""))
    .map((p) => p.split("/").pop().replace(/\.flow-meta\.xml$/, ""))
    .sort();
}

const flowFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((p) => p.endsWith(".flow-meta.xml")).map((p) => join(dir, p)) : []);

export function flowsMethods({ sf, log }) {
  return {
    /**
     * Switch off, in `alias`, each Flow the source retires that is still active there. Safe to repeat: a Flow already
     * off is not touched. Returns the names switched off; throws when one is still active afterwards (the release
     * must not report a Flow removed that still runs).
     */
    retireFlows(alias, dir = "force-app", { apiVersion = "67.0" } = {}) {
      const names = retiredFlows(flowFiles(dir), (p) => readFileSync(p, "utf8"));
      if (!names.length) return [];
      const stillActive = () => sf(["data", "query", "-o", alias, "--use-tooling-api", "-q",
        `SELECT Id, DeveloperName FROM FlowDefinition WHERE ActiveVersionId != null AND DeveloperName IN (${names.map((n) => `'${n}'`).join(",")})`])?.records
        ?.filter((f) => names.includes(f.DeveloperName)) || [];
      const active = stillActive();
      if (!active.length) return [];
      const rest = restIn({ sf, alias, apiVersion });
      for (const f of active) rest("PATCH", `/tooling/sobjects/FlowDefinition/${f.Id}`, { Metadata: { activeVersionNumber: 0 } });
      const left = stillActive();
      if (left.length) throw new Error(`${left.map((f) => f.DeveloperName).join(", ")} still active in ${alias} after deactivation: switch it off in Setup (Flows, Deactivate) and re-run`);
      const off = active.map((f) => f.DeveloperName);
      log(`switched off in ${alias} the Flow(s) the source retires (committed Obsolete or Draft): ${off.join(", ")}`);
      return off;
    },
  };
}
