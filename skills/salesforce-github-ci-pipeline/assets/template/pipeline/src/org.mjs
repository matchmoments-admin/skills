// The org registry: find, create, prepare and delete scratch orgs (see CONTEXT.md: Issue org, Staging org,
// Org registry). The Dev Hub's ScratchOrgInfo records are the registry, matched on Description, so a deleted
// org can never look alive. Logins use the CI certificate (JWT) with the Dev Hub's connected app.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { orgFor } from "./conventions.mjs";
import { PIPELINE_ROOT } from "./io.mjs";

// Scratch definitions come from the trusted pipeline checkout, so a PR cannot change its own org's shape.
const definitionPath = (d) => join(PIPELINE_ROOT, d);

/**
 * Which live scratch orgs nothing needs any more (pure). Orgs whose description the pipeline did not make are left alone.
 *   ci-*                 a CI run's temporary org older than tempHours: its run failed before its cleanup, or died
 *   issue-N / KEY-N      the story is closed (isStoryClosed)
 *   staging-S, uat-S     sprint S is not the open sprint (shipped or abandoned)
 */
export function findOrphans(records, { now = new Date(), isStoryClosed = () => false, openSprint = null, tempHours = 2 } = {}) {
  const out = [];
  for (const r of records) {
    const d = r.Description || "";
    const age = (now - new Date(r.CreatedDate || now)) / 3600e3;
    let why = null;
    if (/^ci-/.test(d) && age > tempHours) why = `CI org ${Math.round(age)} h old (its run did not clean up)`;
    else if (/^issue-\d+$|^[A-Z][A-Z0-9]+-\d+$/.test(d) && isStoryClosed(d)) why = "story closed";
    else if (/^(staging|uat)-(.+)$/.test(d) && d.replace(/^(staging|uat)-/, "") !== openSprint) why = "sprint no longer open";
    if (why) out.push({ username: r.SignupUsername, description: d, why });
  }
  return out;
}

/** Managed packages production has, which Org Shape does not copy: config/packages.json,
 *  [{ "name": "DocuSign", "id": "04t...", "keyEnv": "DOCUSIGN_KEY" }] (keyEnv names an env var holding an install key). */
export function packageList(file = join(PIPELINE_ROOT, "config/packages.json")) {
  if (!existsSync(file)) return [];
  const list = JSON.parse(readFileSync(file, "utf8"));
  for (const p of list) if (!/^04t[A-Za-z0-9]{12,15}$/.test(p.id || "")) throw new Error(`config/packages.json: ${p.name || "?"} needs a package version id (04t...)`);
  return list;
}

const DEVHUB = "devhub";
/** Written to the scratch org admin user's Title when ensure() has finished every step. */
export const READY = "pipeline: ready";

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

export function orgRegistry({ sf, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), log = console.error, keyFile = process.env.SF_CI_KEY_FILE || `${process.env.RUNNER_TEMP || "/tmp"}/ci.key`, packages = packageList(), env = process.env }) {
  const active = () =>
    (sf(["data", "query", "-o", DEVHUB, "-q", "SELECT SignupUsername, LoginUrl, Description, ExpirationDate, CreatedDate FROM ScratchOrgInfo WHERE Status = 'Active' ORDER BY CreatedDate DESC"]).records || []);
  /** Delete through the Dev Hub's ActiveScratchOrg record: no login to the org itself, so it works on any org. */
  const deleteRecord = (username) => Boolean(sf(["data", "delete", "record", "-o", DEVHUB, "-s", "ActiveScratchOrg", "-w", `SignupUsername='${username}'`], { allowFail: true }));

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

    /** Attach the target's org, or create it; either way finish it (packages, source, prepare) unless it is marked
     *  ready, so a run that died half way (packages, deploy) is completed by the next one instead of trusted. */
    ensure(target, opts = {}) {
      const existing = self.find(target, opts);
      const org = existing ? self.attach(existing) : resolve(target, opts);
      if (existing && self.isReady(org.alias)) return { ...org, created: false };
      if (existing) log(`${org.alias} exists but was never finished: completing it`);
      else {
        self.assertCapacity();
        log(`creating ${org.alias} (${org.description}) from ${org.definition}, ${org.days} days`);
        sf(["org", "create", "scratch", "--definition-file", definitionPath(org.definition), "--alias", org.alias, "--description", org.description,
          "--duration-days", String(org.days), "--target-dev-hub", DEVHUB, "--wait", "25"]);
      }
      self.installPackages(org.alias);
      self.deploy(org.alias);
      self.prepare(org.alias);
      self.markReady(org.alias);
      return { ...org, created: !existing, completed: Boolean(existing) };
    },

    /** The ready marker: the org's admin user's Title, set only when ensure() finished every step. */
    isReady(alias) {
      const username = sf(["org", "display", "-o", alias], { allowFail: true })?.username;
      const r = username && sf(["data", "query", "-o", alias, "-q", `SELECT Title FROM User WHERE Username = '${username}'`], { allowFail: true });
      return r?.records?.[0]?.Title === READY;
    },
    markReady(alias) {
      const username = sf(["org", "display", "-o", alias]).username;
      sf(["data", "update", "record", "-o", alias, "-s", "User", "-w", `Username='${username}'`, "-v", `Title='${READY}'`]);
    },

    /** Install production's managed packages, in order, before the source that depends on them (skipping any the org
     *  already has, so finishing a half-made org does not reinstall). */
    installPackages(alias) {
      const have = packages.length ? new Set((sf(["package", "installed", "list", "-o", alias], { allowFail: true }) || []).map((p) => p.SubscriberPackageVersionId)) : new Set();
      for (const p of packages) {
        if (have.has(p.id)) { log(`${p.name || p.id} already installed in ${alias}`); continue; }
        log(`installing ${p.name || p.id} in ${alias}`);
        const key = p.keyEnv ? env[p.keyEnv] : null;
        sf(["package", "install", "--package", p.id, "--target-org", alias, "--wait", "30", "--publish-wait", "10", "--no-prompt", "--security-type", "AdminsOnly", ...(key ? ["--installation-key", key] : [])]);
      }
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
      self.installPackages(name);
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
      return self.removeTagged(org.description) > 0;
    },

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
