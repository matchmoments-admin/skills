// The org registry: find, create, prepare and delete scratch orgs (see CONTEXT.md: Issue org, Staging org,
// Org registry). The Dev Hub's ScratchOrgInfo records are the registry, matched on Description, so a deleted
// org can never look alive. Logins use the CI certificate (JWT) with the Dev Hub's connected app.
import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { orgFor } from "./conventions.mjs";
import { PIPELINE_ROOT } from "./io.mjs";

// Scratch definitions come from the trusted pipeline checkout, so a PR cannot change its own org's shape.
const definitionPath = (d) => join(PIPELINE_ROOT, d);

const DEVHUB = "devhub";

function resolve(target, opts) {
  const org = typeof target === "object" ? target : orgFor(target, opts);
  if (!org) throw new Error(`Not an org target: ${target}`);
  return org;
}

/** Permission set names in a source folder (scratch orgs get all of them; production never does). */
export function permissionSets(dir = "force-app") {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".permissionset-meta.xml")) out.push(basename(f, ".permissionset-meta.xml"));
    }
  };
  try { walk(dir); } catch { /* no source folder */ }
  return out.sort();
}

export function orgRegistry({ sf, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), log = console.error, keyFile = process.env.SF_CI_KEY_FILE || `${process.env.RUNNER_TEMP || "/tmp"}/ci.key` }) {
  const active = () =>
    (sf(["data", "query", "-o", DEVHUB, "-q", "SELECT SignupUsername, LoginUrl, Description, ExpirationDate FROM ScratchOrgInfo WHERE Status = 'Active' ORDER BY CreatedDate DESC"]).records || []);

  const self = {
    /** The live org for a target, or null. Description is long text, which SOQL cannot filter, so match here. */
    find(target, opts) {
      const org = resolve(target, opts);
      const rec = active().find((r) => r.Description === org.description);
      return rec ? { ...org, username: rec.SignupUsername, loginUrl: rec.LoginUrl, expires: rec.ExpirationDate } : null;
    },

    /** Log in to the target's live org under its alias. Throws if there is none. */
    attach(target, opts) {
      const org = self.find(target, opts);
      if (!org) throw new Error(`No live scratch org for ${typeof target === "string" ? target : target.description}. Was it started (label start / sprint-start)?`);
      const clientId = sf(["org", "display", "-o", DEVHUB]).clientId;
      for (let i = 1; i <= 3; i++) {
        const ok = sf(["org", "login", "jwt", "--client-id", clientId, "--jwt-key-file", keyFile, "--username", org.username, "--instance-url", org.loginUrl, "--alias", org.alias], { allowFail: true });
        if (ok) { log(`attached ${org.alias} (${org.username})`); return org; }
        if (i < 3) sleep(10_000);
      }
      throw new Error(`Could not log in to ${org.username}`);
    },

    /** Attach the target's org, or create it from its definition, deploy the source and prepare it. */
    ensure(target, opts = {}) {
      const existing = self.find(target, opts);
      if (existing) return { ...self.attach(existing), created: false };
      const org = resolve(target, opts);
      self.assertCapacity();
      log(`creating ${org.alias} (${org.description}) from ${org.definition}, ${org.days} days`);
      sf(["org", "create", "scratch", "--definition-file", definitionPath(org.definition), "--alias", org.alias, "--description", org.description,
        "--duration-days", String(org.days), "--target-dev-hub", DEVHUB, "--wait", "25"]);
      self.deploy(org.alias);
      self.prepare(org.alias);
      return { ...org, created: true };
    },

    /** Fail with a clear message instead of a half-made org when the Dev Hub has no room. */
    assertCapacity() {
      const { active, daily } = self.limits();
      if (active.remaining === 0) throw new Error(`No free scratch org slot (${active.max} active is the Dev Hub's limit). Merge or delete a story first, or run scratch-janitor.`);
      if (daily.remaining === 0) throw new Error(`The Dev Hub has created its ${daily.max} scratch orgs for today; the count resets at 00:00 UTC.`);
    },

    /** A throwaway org for one CI run, deleted by the caller. */
    temporary(name) {
      self.assertCapacity();
      const org = { kind: "temp", alias: name, description: name, definition: "config/scratch-dev.json", days: 1 };
      sf(["org", "create", "scratch", "--definition-file", definitionPath(org.definition), "--alias", name, "--description", name, "--duration-days", "1", "--target-dev-hub", DEVHUB, "--wait", "25"]);
      return { ...org, created: true };
    },

    deploy(alias, { manifest } = {}) {
      const src = manifest ? ["--manifest", manifest] : ["-d", "force-app"];
      sf(["project", "deploy", "start", "-o", alias, ...src, "--ignore-conflicts", "--wait", "30"]);
    },

    /** Make the org usable for tests: Lightning on, a valid country (production's shape has State and
     *  Country picklists), and every permission set in the source assigned. Safe to repeat. Scratch orgs only. */
    prepare(alias, dir = "force-app") {
      const username = sf(["org", "display", "-o", alias]).username;
      sf(["data", "update", "record", "-o", alias, "-s", "User", "-w", `Username='${username}'`, "-v", "CountryCode=AU UserPreferencesLightningExperiencePreferred=true"], { allowFail: true });
      const assigned = [];
      for (const p of permissionSets(dir)) if (sf(["org", "assign", "permset", "--name", p, "-o", alias], { allowFail: true })) assigned.push(p);
      log(`prepared ${alias}: Lightning on, country AU, permission sets ${permissionSets(dir).join(", ") || "none"}`);
      return assigned;
    },

    /** Delete the target's org if it is alive. Returns true if one was deleted. */
    remove(target, opts) {
      const org = self.find(target, opts);
      if (!org) { log(`no live org for ${resolve(target, opts).description}`); return false; }
      self.attach(org);
      const done = sf(["org", "delete", "scratch", "-o", org.alias, "--no-prompt"], { allowFail: true });
      log(done ? `deleted ${org.alias} (${org.description})` : `could not delete ${org.alias} (${org.description}); the janitor will retry`);
      return Boolean(done);
    },

    /** Story orgs whose story the tracker says is closed. */
    closedStoryOrgs(isClosed) {
      return active().filter((r) => /^issue-\d+$|^[A-Z][A-Z0-9]+-\d+$/.test(r.Description || "")).filter((r) => isClosed(r.Description));
    },

    limits() {
      const raw = sf(["limits", "api", "display", "-o", DEVHUB], { allowFail: true });
      const l = Array.isArray(raw) ? raw : [];
      const pick = (n) => l.find((x) => x.name === n) || {};
      return { active: pick("ActiveScratchOrgs"), daily: pick("DailyScratchOrgs") };   // unknown limits read as undefined, not 0
    },
  };
  return self;
}
