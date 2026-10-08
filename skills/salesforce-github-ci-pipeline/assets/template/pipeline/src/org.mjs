// The org registry: find, create, prepare and delete scratch orgs (see GLOSSARY.md: Issue org, Staging org,
// Org registry). The Dev Hub's ScratchOrgInfo records are the registry, matched on Description, so a deleted
// org can never look alive. Logins use the CI certificate (JWT) with the Dev Hub's connected app.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { orgFor } from "./conventions.mjs";
import { PIPELINE_ROOT } from "./io.mjs";
import { baselineId as idOf, composeProject, DIR as BASELINE_DIR } from "./baseline.mjs";

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
/** Written to the scratch org admin user's Title when ready() has finished every step, with the commit it holds. */
export const READY = "pipeline: ready";
export const readyMarker = (commit, baseline = null, seed = null) => (commit ? `${READY} ${String(commit).slice(0, 12)}${baseline ? ` b${baseline}` : ""}${seed ? ` s${seed}` : ""}` : READY);

/**
 * The roles an Org Shape scratch org arrives with cannot be given to a user ("invalid cross reference id"; a role made
 * in the org can). Rebuilding them (delete, leaves first; recreate as Role metadata from what was read) makes them
 * usable, so personas, testers and role-shared folders work. Pure: queried UserRoles -> { levels (ids to delete, the
 * deepest first), files ({ DeveloperName: role-meta xml }) }.
 */
export function roleRebuild(roles) {
  const byId = new Map(roles.map((r) => [r.Id, r]));
  const depth = (r, seen = 0) => (r.ParentRoleId && byId.has(r.ParentRoleId) && seen < 50 ? 1 + depth(byId.get(r.ParentRoleId), seen + 1) : 0);
  const levels = [];
  for (const r of roles) (levels[depth(r)] ||= []).push(r.Id);
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const access = (v, d) => (["Edit", "Read", "None"].includes(v) ? v : d);
  const files = Object.fromEntries(roles.map((r) => [r.DeveloperName, ['<?xml version="1.0" encoding="UTF-8"?>', '<Role xmlns="http://soap.sforce.com/2006/04/metadata">',
    `    <caseAccessLevel>${access(r.CaseAccessForAccountOwner, "Edit")}</caseAccessLevel>`, `    <contactAccessLevel>${access(r.ContactAccessForAccountOwner, "Edit")}</contactAccessLevel>`,
    ...(r.RollupDescription ? [`    <description>${esc(r.RollupDescription)}</description>`] : []), `    <mayForecastManagerShare>${Boolean(r.MayForecastManagerShare)}</mayForecastManagerShare>`,
    `    <name>${esc(r.Name)}</name>`, `    <opportunityAccessLevel>${access(r.OpportunityAccessForAccountOwner, "Edit")}</opportunityAccessLevel>`,
    ...(r.ParentRoleId && byId.has(r.ParentRoleId) ? [`    <parentRole>${byId.get(r.ParentRoleId).DeveloperName}</parentRole>`] : []), "</Role>", ""].join("\n")]));
  return { levels: levels.filter(Boolean).reverse(), files };
}

/** The seed's files with their date tokens filled in (data/seed/README.md). Pure: { name: text } -> { name: text }. */
export function expandSeed(files, { today = new Date(), marker }) {
  const y = today.getUTCFullYear();
  const tokens = { TODAY: today.toISOString().slice(0, 10), THIS_YEAR: String(y), LAST_YEAR: String(y - 1), NEXT_YEAR: String(y + 1), SEED_MARKER: marker };
  return Object.fromEntries(Object.entries(files).map(([n, t]) => [n, String(t).replace(/\$\{(TODAY|THIS_YEAR|LAST_YEAR|NEXT_YEAR|SEED_MARKER)\}/g, (_, k) => tokens[k])]));
}

/** Who a story is for, from its "Persona:" line (Access section): "Persona: DirectorDirectSales role, Regional_Reporting_Access".
 *  { role, permsets } or null. Pure. */
export function personaOf(body) {
  const line = String(body || "").match(/^\s*[-*]?\s*\**Persona:?\**:?\s*(.+)$/im)?.[1];
  if (!line) return null;
  const items = line.split(/[,;+]|\band\b/).map((s) => s.replace(/[`*.]/g, "").trim()).filter(Boolean);
  const role = items.find((i) => /\s+role$/i.test(i))?.replace(/\s+role$/i, "").trim() || null;
  const permsets = items.filter((i) => !/\s+role$/i.test(i) && /^[A-Za-z][A-Za-z0-9_]*$/.test(i));
  return role || permsets.length ? { role, permsets } : null;
}

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

export function orgRegistry({ sf, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), log = console.error, keyFile = process.env.SF_CI_KEY_FILE || `${process.env.RUNNER_TEMP || "/tmp"}/ci.key`, packages = packageList(), env = process.env,
  baselineDir = join(PIPELINE_ROOT, BASELINE_DIR), seedDir = join(PIPELINE_ROOT, "data/seed"), record = () => {} }) {
  // the production baseline (BASELINE: off | soft (default) | strict), from main's trusted checkout, never the branch's
  const baselineMode = String(env.BASELINE || "soft").toLowerCase();
  const baseline = () => (baselineMode !== "off" && existsSync(baselineDir) ? idOf(baselineDir) : null);
  // test data (data/seed: synthetic, for people and UI tests; Apex tests never see it), from main's trusted checkout
  const seedId = () => (String(env.SEED || "on").toLowerCase() !== "off" && existsSync(join(seedDir, "plan.json")) ? idOf(seedDir) : null);
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
      if (!org) throw new Error(`No live scratch org for ${typeof target === "string" ? target : target.description}: it was never started, or it expired (story orgs live 7 days). Comment /start on the story to rebuild it.`);
      const clientId = sf(["org", "display", "-o", DEVHUB]).clientId;
      for (let i = 1; i <= 3; i++) {
        const ok = sf(["org", "login", "jwt", "--client-id", clientId, "--jwt-key-file", keyFile, "--username", org.username, "--instance-url", org.loginUrl, "--alias", org.alias], { allowFail: true });
        if (ok) { log(`attached ${org.alias} (${org.username})`); return org; }
        if (i < 3) sleep(10_000);
      }
      throw new Error(`Could not log in to ${org.username}`);
    },

    /**
     * The one way an org becomes usable (Org provisioning): find or create the target's org, then make it hold
     * `commit` (packages, the source, prepared users and permission sets, seed data) and mark it so. An org already
     * marked for this commit is returned as it is; a half-made one (a run that died) is finished, never trusted.
     * Creation tries the current snapshot (SCRATCH_SNAPSHOT) first and falls back to production's shape.
     * opts: { commit, manifest (deploy only these), hotfix }. Returns the org with { created, completed, fresh }.
     */
    ready(target, { commit = null, manifest = null, ...opts } = {}) {
      const existing = self.find(target, opts);
      const org = existing ? self.attach(existing) : resolve(target, opts);
      const want = readyMarker(commit, baseline(), seedId());
      if (existing && self.isReady(org.alias, want)) { log(`${org.alias} already holds ${commit ? String(commit).slice(0, 7) : "its source"}`); return { ...org, created: false, fresh: true }; }
      if (existing) log(`${org.alias} exists: bringing it to ${commit ? String(commit).slice(0, 7) : "its source"}`);
      else {
        self.assertCapacity(org.kind === "story" ? Number(env.ORG_RESERVE || 0) : 0);
        const how = self.create(org);
        if (!how.fromSnapshot) { self.enableLoginAs(org.alias); self.rebuildRoles(org.alias); }   // roles before the deploy: shares attach to them
      }
      self.installPackages(org.alias);
      self.deploy(org.alias, { manifest });
      self.prepare(org.alias);
      self.seed(org.alias, { story: org.key || null });
      self.markReady(org.alias, want);
      return { ...org, created: !existing, completed: Boolean(existing) };
    },
    /** Kept for callers that do not know a commit: ready() for the source in the working directory. */
    ensure(target, opts = {}) { return self.ready(target, opts); },

    /**
     * Create the org: from the current snapshot (SCRATCH_SNAPSHOT: packages, the production baseline, seed data
     * already in it) when one is set, else from production's shape. A missing or expired snapshot falls back, loudly.
     * Throwaway CI orgs skip source tracking (it only slows a deploy nobody retrieves from).
     */
    create(org) {
      const base = ["org", "create", "scratch", "--alias", org.alias, "--description", org.description, "--duration-days", String(org.days), "--target-dev-hub", DEVHUB,
        ...(org.kind === "temp" ? ["--no-track-source"] : [])];
      const snapshot = org.kind === "snapshot" ? null : self.currentSnapshot();
      if (snapshot) {
        const def = join(tmpdir(), `snapshot-${process.pid}.json`);
        writeFileSync(def, JSON.stringify({ orgName: `Lifecycle ${org.description}`, snapshot }));
        log(`creating ${org.alias} (${org.description}) from snapshot ${snapshot}, ${org.days} days`);
        if (sf([...base, "--definition-file", def, "--wait", "45"], { allowFail: true })) return { fromSnapshot: true };
        log(`::warning::snapshot ${snapshot} could not be used (expired or not active yet?): creating ${org.alias} from production's shape instead`);
        self.removeTagged(org.description);   // a half-made attempt must not hold a slot
      }
      log(`creating ${org.alias} (${org.description}) from ${org.definition}, ${org.days} days`);
      sf([...base, "--definition-file", definitionPath(org.definition), "--wait", "25"]);
      return { fromSnapshot: false };
    },

    /**
     * The snapshot new orgs start from: SCRATCH_SNAPSHOT if set ("off" turns snapshots off), else the newest Active
     * pipeline snapshot (LCB...) in the Dev Hub, so no variable has to be written when a new one is made.
     */
    currentSnapshot() {
      const set = String(env.SCRATCH_SNAPSHOT || "").trim();
      if (set.toLowerCase() === "off") return null;
      if (/^[A-Za-z0-9]{1,15}$/.test(set)) return set;
      const list = sf(["org", "list", "snapshot", "-v", DEVHUB], { allowFail: true }) || [];
      return (Array.isArray(list) ? list : []).filter((s) => /^LCB\d+$/.test(s.SnapshotName || "") && s.Status === "Active")
        .sort((a, b) => String(b.CreatedDate).localeCompare(String(a.CreatedDate)))[0]?.SnapshotName || null;
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

    /**
     * Load the test data once per org: the core seed (data/seed, from main) unless its marker Account is already there
     * (a snapshot holds it), then the story's own (data/seed/stories/<key>/plan.json in the working directory) once.
     * sf data import tree only inserts, so the markers are what make it safe to repeat. Scratch orgs only.
     */
    seed(alias, { story = null } = {}) {
      const loads = [];
      const id = seedId();
      if (id) loads.push({ dir: seedDir, marker: `[seed ${id}]` });
      const own = story ? join(process.cwd(), "data/seed/stories", String(story)) : null;
      if (id && own && existsSync(join(own, "plan.json"))) loads.push({ dir: own, marker: `[seed story ${story} ${idOf(own)}]` });
      if (!loads.length) return [];
      // never production: the Dev Hub is production here (and a production org is never a target of org ready anyway)
      const [target, prod] = [sf(["org", "display", "-o", alias], { allowFail: true })?.id, sf(["org", "display", "-o", DEVHUB], { allowFail: true })?.id];
      if (!target || (prod && String(target).slice(0, 15) === String(prod).slice(0, 15))) throw new Error(`refusing to load test data into ${alias}: it is production (or unknown)`);
      const loaded = [];
      for (const { dir, marker } of loads) {
        const have = sf(["data", "query", "-o", alias, "-q", `SELECT Id FROM Account WHERE Name = '${marker}'`], { allowFail: true })?.records?.length;
        if (have) { log(`${alias} already has ${marker}`); continue; }
        const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
        if (!files["plan.json"].includes("SEED_MARKER") && !Object.values(files).some((t) => t.includes("${SEED_MARKER}"))) {
          // a story's plan without its own marker: add one, so it too loads once
          files["SeedMarker.json"] = JSON.stringify({ records: [{ attributes: { type: "Account", referenceId: "SeedMarker" }, Name: "${SEED_MARKER}" }] });
          files["plan.json"] = JSON.stringify([...JSON.parse(files["plan.json"]), { sobject: "Account", files: ["SeedMarker.json"] }]);
        }
        const out = join(tmpdir(), `seed-${process.pid}-${loaded.length}`);
        mkdirSync(out, { recursive: true });
        for (const [n, t] of Object.entries(expandSeed(files, { marker }))) writeFileSync(join(out, n), t);
        sf(["data", "import", "tree", "--plan", join(out, "plan.json"), "-o", alias]);
        log(`loaded test data ${marker} into ${alias}`);
        loaded.push(marker);
      }
      return loaded;
    },

    /** "Administrators Can Log in as Any User" (off in scratch orgs): UI tests log in AS a persona through it, so no
     *  password ever exists (e2e/support/login.ts loginAs). Scratch orgs only; best effort. */
    enableLoginAs(alias) {
      const dir = join(tmpdir(), `security-${process.pid}`);
      mkdirSync(join(dir, "force-app/main/default/settings"), { recursive: true });
      writeFileSync(join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], sourceApiVersion: "67.0" }));
      writeFileSync(join(dir, "force-app/main/default/settings/Security.settings-meta.xml"), '<?xml version="1.0" encoding="UTF-8"?>\n<SecuritySettings xmlns="http://soap.sforce.com/2006/04/metadata">\n    <enableAdminLoginAsAnyUser>true</enableAdminLoginAsAnyUser>\n</SecuritySettings>\n');
      const ok = sf(["project", "deploy", "start", "-o", alias, "-d", "force-app", "--wait", "20"], { cwd: dir, allowFail: true });
      if (!ok) log(`::warning::could not turn on "log in as" in ${alias}: UI tests cannot log in as a persona`);
      return Boolean(ok);
    },

    /** Make a shape org's roles assignable (see roleRebuild). Safe on an org with no roles. Returns how many. */
    rebuildRoles(alias) {
      const roles = sf(["data", "query", "-o", alias, "-q", "SELECT Id, Name, DeveloperName, ParentRoleId, RollupDescription, CaseAccessForAccountOwner, ContactAccessForAccountOwner, OpportunityAccessForAccountOwner, MayForecastManagerShare FROM UserRole WHERE PortalType = 'None'"], { allowFail: true })?.records || [];
      if (!roles.length) return 0;
      const { levels, files } = roleRebuild(roles);
      const apex = join(tmpdir(), `roles-${process.pid}.apex`);
      const all = roles.map((r) => `'${r.Id}'`).join(",");
      writeFileSync(apex, [   // users holding these roles keep their role DeveloperName in mind: they get it back below
        `Map<Id, String> held = new Map<Id, String>(); for (User u : [SELECT Id, UserRole.DeveloperName FROM User WHERE UserRoleId IN (${all})]) held.put(u.Id, u.UserRole.DeveloperName);`,
        "List<User> clear = new List<User>(); for (Id u : held.keySet()) clear.add(new User(Id = u, UserRoleId = null)); update clear;",
        ...levels.map((ids) => `delete [SELECT Id FROM UserRole WHERE Id IN ('${ids.join("','")}')];`),
        "System.debug('HELD ' + JSON.serialize(held));"].join("\n") + "\n");
      if (!sf(["apex", "run", "-o", alias, "--file", apex], { allowFail: true })) { log(`::warning::could not rebuild the roles in ${alias}: personas with a role may fail`); return 0; }
      const dir = join(tmpdir(), `roles-${process.pid}`);
      mkdirSync(join(dir, "force-app/main/default/roles"), { recursive: true });
      writeFileSync(join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], sourceApiVersion: "67.0" }));
      for (const [name, xml] of Object.entries(files)) writeFileSync(join(dir, "force-app/main/default/roles", `${name}.role-meta.xml`), xml);
      sf(["project", "deploy", "start", "-o", alias, "-d", "force-app", "--wait", "20"], { cwd: dir });   // the roles must come back: fail loudly
      log(`rebuilt ${roles.length} role(s) in ${alias} so they can be assigned (shape roles cannot)`);
      return roles.length;
    },

    /** The ready marker: the org's admin user's Title, set only when ready() finished every step for a commit. */
    isReady(alias, want = READY) {
      const username = sf(["org", "display", "-o", alias], { allowFail: true })?.username;
      const r = username && sf(["data", "query", "-o", alias, "-q", `SELECT Title FROM User WHERE Username = '${username}'`], { allowFail: true });
      return r?.records?.[0]?.Title === want;
    },
    markReady(alias, want = READY) {
      const username = sf(["org", "display", "-o", alias]).username;
      sf(["data", "update", "record", "-o", alias, "-s", "User", "-w", `Username='${username}'`, "-v", `Title='${want}'`]);
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
    /** reserve: slots a story org must leave free for staging, UAT and CI (repository variable ORG_RESERVE). */
    assertCapacity(reserve = 0) {
      const { active, daily } = self.limits();
      if (reserve && active.remaining <= reserve) throw new Error(`Only ${active.remaining} scratch org slot(s) free and ${reserve} kept for staging, UAT and CI (ORG_RESERVE): merge or close a story first.`);
      if (active.remaining === 0) throw new Error(`No free scratch org slot (${active.max} active is the Dev Hub's limit). Merge or delete a story first, or run scratch-janitor.`);
      if (daily.remaining === 0) throw new Error(`The Dev Hub has created its ${daily.max} scratch orgs for today; the count resets at 00:00 UTC.`);
    },

    /** A throwaway org for one CI run, deleted by the caller (from the snapshot when there is one, untracked). */
    temporary(name) {
      self.assertCapacity();
      const org = { kind: "temp", alias: name, description: name, definition: "config/scratch-dev.json", days: 1 };
      const how = self.create(org);
      self.installPackages(name);
      return { ...org, created: true, ...how };
    },

    /**
     * Deploy the source. With a production baseline (and no manifest), the baseline and force-app go in ONE deploy
     * (they reference each other both ways). In soft mode a failed combined deploy warns, records why, and deploys
     * force-app alone, so a story is never blocked by production's own metadata; strict fails.
     */
    deploy(alias, { manifest, dryRun = false } = {}) {
      const id = manifest ? null : baseline();
      if (id) {
        const admin = sf(["org", "display", "-o", alias])?.username;
        const dir = composeProject({ baselineDir, sourceDir: join(process.cwd(), "force-app"), forceignore: join(process.cwd(), ".forceignore") });
        const r = sf(["project", "deploy", "start", "-o", alias, "-d", BASELINE_DIR, "-d", "force-app", "--ignore-conflicts", "--wait", "45", ...(dryRun ? ["--dry-run"] : [])],
          { cwd: dir, env: { SCRATCH_ADMIN: admin }, allowFail: baselineMode !== "strict" });
        const ok = r && r.success !== false && !["Failed", "Canceled"].includes(r.status);
        if (!ok && r?.details?.componentFailures) for (const f of [].concat(r.details.componentFailures).slice(0, 15)) log(`  ${f.componentType} ${f.fullName}: ${f.problem}`);
        if (ok) { log(`deployed the production baseline (${id}) and force-app to ${alias}`); return { baseline: id }; }
        log(`::warning::the production baseline (${id}) did not deploy to ${alias}: deploying force-app alone (BASELINE=soft). See the deploy errors above.`);
        record("baseline", { action: "deploy-failed", org: alias, id });
      }
      const src = manifest ? ["--manifest", manifest] : ["-d", "force-app"];
      sf(["project", "deploy", "start", "-o", alias, ...src, "--ignore-conflicts", "--wait", "30", ...(dryRun ? ["--dry-run"] : [])]);
      return { baseline: null };
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

    /**
     * Run fn with the org's running user holding none of the source's permission sets, then give them back: Apex and
     * Flow tests run with production's access (the CI user deploys and tests as a System Administrator with no story
     * permission set), so a test that depends on the running user's field access fails here, not at the release.
     */
    asProductionUser(alias, fn, dir = "force-app") {
      const names = permissionSets(dir);
      if (!names.length) return fn();
      const username = sf(["org", "display", "-o", alias]).username;
      const rows = sf(["data", "query", "-o", alias, "-q", `SELECT Id FROM PermissionSetAssignment WHERE Assignee.Username = '${username}' AND PermissionSet.Name IN (${names.map((n) => `'${n}'`).join(",")})`], { allowFail: true })?.records || [];
      for (const r of rows) sf(["data", "delete", "record", "-o", alias, "-s", "PermissionSetAssignment", "-i", r.Id], { allowFail: true });
      log(`tests run as production's CI user would: ${rows.length} permission set(s) taken from ${username} for the run`);
      try { return fn(); } finally { self.prepare(alias, dir); }   // prepare gives them back (UI tests and people need them)
    },

    /**
     * A tester for a person (a story's org or the UAT stand-in): a Standard User made once per login, and a
     * password-reset email from Salesforce to their address. No password or session ever leaves the org. With a
     * persona ({ role, permsets }: the story's "Persona:" line, or UAT_TESTER_ROLE) they get that role and those
     * permission sets, so they see what that user sees; without one, every permission set in the source.
     * Returns { username, created, persona }.
     */
    tester(alias, { login, email, persona = null }, dir = "force-app") {
      const sets = persona?.permsets?.length ? persona.permsets : permissionSets(dir);
      const orgId = sf(["org", "display", "-o", alias]).id;
      const username = `${String(login).toLowerCase().replace(/[^a-z0-9]/g, "")}.uat@${String(orgId).slice(0, 15).toLowerCase()}.pipeline`;
      const found = sf(["data", "query", "-o", alias, "-q", `SELECT Id FROM User WHERE Username = '${username}'`], { allowFail: true })?.records?.[0];
      let id = found?.Id;
      if (!id) {
        const made = sf(["org", "create", "user", "-o", alias, `username=${username}`, `email=${email}`, `lastName=${login}`, "profileName=Standard User", `permsets=${sets.join(",")}`]);
        id = made?.fields?.id || sf(["data", "query", "-o", alias, "-q", `SELECT Id FROM User WHERE Username = '${username}'`]).records[0].Id;
      } else for (const p of sets) sf(["org", "assign", "permset", "--name", p, "-o", alias, "--on-behalf-of", username], { allowFail: true });
      const roleId = persona?.role ? sf(["data", "query", "-o", alias, "-q", `SELECT Id FROM UserRole WHERE DeveloperName = '${String(persona.role).replace(/[^A-Za-z0-9_]/g, "")}'`], { allowFail: true })?.records?.[0]?.Id : null;
      if (persona?.role && !roleId) log(`::warning::role ${persona.role} not found in ${alias}: the tester has no role`);
      sf(["data", "update", "record", "-o", alias, "-s", "User", "-i", id, "-v", `Email=${email} CountryCode=AU UserPreferencesLightningExperiencePreferred=true${roleId ? ` UserRoleId=${roleId}` : ""}`], { allowFail: true });
      const apex = join(tmpdir(), `reset-${process.pid}.apex`);
      writeFileSync(apex, `System.resetPassword('${id}', true);\n`);
      sf(["apex", "run", "-o", alias, "--file", apex]);
      log(`tester ${username}${roleId ? ` (role ${persona.role})` : ""}: password email sent`);
      return { username, created: !found, persona: { role: roleId ? persona.role : null, permsets: sets } };
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

    limits() {
      const raw = sf(["limits", "api", "display", "-o", DEVHUB], { allowFail: true });
      const l = Array.isArray(raw) ? raw : [];
      const pick = (n) => l.find((x) => x.name === n) || {};
      return { active: pick("ActiveScratchOrgs"), daily: pick("DailyScratchOrgs") };   // unknown limits read as undefined, not 0
    },
  };
  return self;
}
