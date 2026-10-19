// The org registry: find, create, prepare and delete scratch orgs (see GLOSSARY.md: Issue org, Staging org,
// Org registry). The Dev Hub's ScratchOrgInfo records are the registry, matched on Description, so a deleted
// org can never look alive. Logins use the CI certificate (JWT) with the Dev Hub's connected app.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { orgFor } from "./conventions.mjs";
import { CONFIG_ROOT, sfFailure, sourceDirs } from "./io.mjs";
import { baselineId as idOf, composeProject, DIR as BASELINE_DIR } from "./baseline.mjs";
import { DEVHUB, fleetMethods, shapeOutdated, capacityProblem } from "./org/fleet.mjs";
import { dataMethods } from "./org/data.mjs";
import { usersMethods } from "./org/users.mjs";
import { snapshotMethods } from "./org/snapshot.mjs";
import { setupChangesMethods } from "./org/setup-changes.mjs";
// the helpers that moved to org/, still importable from here
/** A Salesforce login or network failure: worth one more try, and no fault of a snapshot. */
export { findOrphans, capacityProblem, shapeOutdated, DEVHUB } from "./org/fleet.mjs";
export { expandSeed, seedReplaceApex, VOLUME_MARKER, volumeApex, foldSeeds } from "./org/data.mjs";
export { roleRebuild, personaOf, permissionSets } from "./org/users.mjs";

// Scratch definitions come from the trusted pipeline checkout, so a PR cannot change its own org's shape.
const definitionPath = (d) => join(CONFIG_ROOT, d);









/** The baseline files a failed deploy names (componentFailures' fileName under baseline/), removed from the composed
 *  project `dir` so a retry deploys the rest. force-app failures are the story's own: nothing is removed for them.
 *  Returns the removed paths (relative to dir). */
export function failedBaselineFiles(result, dir) {
  // sf's reply lists each file with its state and path (absolute, or relative to the project)
  const rel = (p) => { const s = String(p || ""); return s.startsWith(`${dir}/`) ? s.slice(dir.length + 1) : s; };
  const failed = [].concat(result?.files || []).filter((f) => f.state === "Failed").map((f) => rel(f.filePath));
  if (!failed.length || failed.some((p) => !p.startsWith(`${BASELINE_DIR}/`))) return [];   // the story's own failure: no retry
  const paths = [...new Set(failed.flatMap((p) => [p, p.replace(/-meta\.xml$/, ""), `${p}-meta.xml`]))].filter((p) => existsSync(join(dir, p)));
  for (const p of paths) rmSync(join(dir, p));
  return paths;
}

/** Managed packages production has, which Org Shape does not copy: config/packages.json,
 *  [{ "name": "DocuSign", "id": "04t...", "keyEnv": "DOCUSIGN_KEY" }] (keyEnv names an env var holding an install key). */
export function packageList(file = join(CONFIG_ROOT, "config/packages.json")) {
  if (!existsSync(file)) return [];
  const list = JSON.parse(readFileSync(file, "utf8"));
  for (const p of list) if (!/^04t[A-Za-z0-9]{12,15}$/.test(p.id || "")) throw new Error(`config/packages.json: ${p.name || "?"} needs a package version id (04t...)`);
  return list;
}

/** Written to the scratch org admin user's Title when ready() has finished every step, with the commit it holds. */
export const READY = "pipeline: ready";
/**
 * Did anything deployable change from `held` to `head`? A check for ready() (see sameSource there), from git: head
 * descends from held, and nothing under the source folders or config/ changed. Unknown (held not in a shallow clone,
 * any git error) counts as changed. git is the io seam.
 */
export const sameSourceGit = (git, dirs = sourceDirs()) => (held, head) => {
  if (git(["merge-base", "--is-ancestor", held, head], { allowFail: true }) === null) return false;
  const files = git(["diff", "--name-only", held, head, "--", ...dirs, "config"], { allowFail: true });
  return files !== null && files.trim() === "";
};

export const readyMarker =(commit, baseline = null, seed = null) => (commit ? `${READY} ${String(commit).slice(0, 12)}${baseline ? ` b${baseline}` : ""}${seed ? ` s${seed}` : ""}` : READY);






function resolve(target) {
  const org = typeof target === "object" ? target : orgFor(target);
  if (!org) throw new Error(`Not an org target: ${target}`);
  return org;
}


export function orgRegistry({ sf, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), log = console.error, keyFile = process.env.SF_CI_KEY_FILE || join(tmpdir(), "ci.key"), packages = packageList(), env = process.env,
  baselineDir = join(CONFIG_ROOT, BASELINE_DIR), seedDir = join(CONFIG_ROOT, "data/seed"), record = () => {}, dirs = sourceDirs(env),
  // a snapshot Salesforce refused once is never tried again (each attempt spends a daily scratch org): marked by the caller
  snapshotRefused = () => false, refuseSnapshot = () => {},
  // (held, head) => true when nothing deployable changed between them (sameSourceVia): ready() then only re-marks the org
  sameSource = () => false }) {
  // the production baseline (BASELINE: off | soft (default) | strict), from main's trusted checkout, never the branch's
  const baselineMode = String(env.BASELINE || "soft").toLowerCase();
  const baseline = () => (baselineMode !== "off" && existsSync(baselineDir) ? idOf(baselineDir) : null);
  // test data (data/seed: synthetic, for people and UI tests; Apex tests never see it), from main's trusted checkout
  const seedId = () => (String(env.SEED || "on").toLowerCase() !== "off" && existsSync(join(seedDir, "plan.json")) ? idOf(seedDir) : null);
  const active = () =>
    (sf(["data", "query", "-o", DEVHUB, "-q", "SELECT SignupUsername, LoginUrl, Description, ExpirationDate, CreatedDate FROM ScratchOrgInfo WHERE Status = 'Active' ORDER BY CreatedDate DESC"]).records || []);
  /** Delete through the Dev Hub's ActiveScratchOrg record: no login to the org itself, so it works on any org. */
  const deleteRecord = (username) => Boolean(sf(["data", "delete", "record", "-o", DEVHUB, "-s", "ActiveScratchOrg", "-w", `SignupUsername='${username}'`], { allowFail: true }));

  // the methods of each concern (pipeline/src/org/), then the provisioning core below, which composes them
  const ctx = { sf, sleep, log, keyFile, packages, env, baselineDir, seedDir, record, snapshotRefused, refuseSnapshot, baseline, seedId, active, deleteRecord, dirs };
  const self = {
    ...fleetMethods(ctx), ...dataMethods(ctx), ...usersMethods(ctx), ...snapshotMethods(ctx), ...setupChangesMethods(ctx),
    /** Every live scratch org on the Dev Hub: { SignupUsername, LoginUrl, Description, ExpirationDate, CreatedDate }. */
    activeOrgs() { return active(); },
    /** The live org for a target, or null. Description is long text, which SOQL cannot filter, so match here. */
    find(target, opts) {
      const org = resolve(target, opts);
      const rec = active().find((r) => r.Description === org.description);
      return rec ? { ...org, username: rec.SignupUsername, loginUrl: rec.LoginUrl, expires: rec.ExpirationDate } : null;
    },

    /** Log in to the target's live org under its alias. Throws if there is none. */
    attach(target, opts) {
      const org = self.find(target, opts);
      if (!org) throw new Error(`No live scratch org for ${typeof target === "string" ? target : target.description}: it was never created, or it expired (ORG_DAYS). Run the feature-org step again to rebuild it.`);
      // already logged in under this alias as this org's admin (the job that created it, or a laptop): no JWT needed
      if (sf(["org", "display", "-o", org.alias], { allowFail: true })?.username === org.username) { log(`attached ${org.alias} (${org.username}, already logged in)`); return org; }
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
    ready(target, { commit = null, manifest = null, refusal = () => null, ...opts } = {}) {
      const existing = self.find(target, opts);
      const org = existing ? self.attach(existing) : resolve(target, opts);
      const want = readyMarker(commit, baseline(), seedId());
      // the test data an org of this kind gets: its story's own seed, or every story's in the release (staging, UAT).
      // Loaded on every call, even when the org already holds the code: a seed a story adds later (Claude writes it
      // with the build) still arrives, and the markers make a repeat a few queries (review, 14 Oct)
      const seedFor = org.kind === "story" ? { story: org.key } : ["sprint", "uat"].includes(org.kind) ? { stories: "all" } : {};
      if (existing && self.isReady(org.alias, want)) { log(`${org.alias} already holds ${commit ? String(commit).slice(0, 7) : "its source"}`); self.seed(org.alias, seedFor); return { ...org, created: false, fresh: true }; }
      // the head moved on with nothing deployable (the UI test's own spec commit, a doc): the org already holds this
      // source, so it is re-marked, not redeployed (a full deploy was about 4 minutes of every AI UI test, #241)
      if (existing && commit && self.advance(org.alias, commit, (held) => sameSource(held, commit))) { self.seed(org.alias, seedFor); return { ...org, created: false, fresh: true }; }
      let how = null;
      if (existing) log(`${org.alias} exists: bringing it to ${commit ? String(commit).slice(0, 7) : "its source"}`);
      else {
        const no = refusal(org);
        if (no) throw new Error(no);
        self.assertCapacity(org.kind === "story" ? Number(env.ORG_RESERVE || 0) : 0);
        how = self.create(org);
        if (!how.fromSnapshot) { self.enableLoginAs(org.alias); self.rebuildRoles(org.alias); }   // roles before the deploy: shares attach to them
      }
      self.installPackages(org.alias);
      // an org made from a snapshot that holds this production baseline already has it: only force-app is deployed (the
      // baseline redeploy cost a minute or two per org, and retried components a fresh org could not take)
      self.deploy(org.alias, { manifest, skipBaseline: Boolean(how?.baseline && how.baseline === baseline()) });
      self.prepare(org.alias);
      self.seed(org.alias, seedFor);
      self.markReady(org.alias, want);
      return { ...org, created: !existing, completed: Boolean(existing) };
    },
    /** The production baseline's id as it would be deployed now (null: BASELINE=off or none). */
    baselineId() { return baseline(); },
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
        writeFileSync(def, JSON.stringify({ orgName: `Scratch ${org.description}`, snapshot }));
        log(`creating ${org.alias} (${org.description}) from snapshot ${snapshot}, ${org.days} days`);
        let why = "", kind = "real";
        // a login or network hiccup is not the snapshot's fault: once more from it, and never refused for it (sprint
        // 2027-w01's staging got a JWT error page, refused a good snapshot, and story #293 fell back to an old one)
        for (let attempt = 1; attempt <= 2; attempt++) {
          try { sf([...base, "--definition-file", def, "--wait", "45"]); return { fromSnapshot: true, snapshot, baseline: self.snapshotBaseline(snapshot) }; } catch (e) { why = String(e.message).split("\n").slice(-2).join(" ").slice(0, 300); kind = e.kind || sfFailure(e.message); }
          self.removeTagged(org.description);   // a half-made attempt must not hold a slot
          if (kind !== "transient") break;
          if (attempt === 1) { log(`::warning::snapshot ${snapshot}: ${why.slice(0, 120)}... (a login or network error): trying once more`); sleep(30_000); }
        }
        const transient = kind === "transient";
        log(`::warning::snapshot ${snapshot} could not be used (${why || "no reason given"}): creating ${org.alias} from production's shape instead`);
        record("snapshot", { action: "fallback", name: snapshot, org: org.description, why, transient });
        if (!transient) refuseSnapshot(snapshot, why);   // the next org goes straight to shape until a new snapshot is built
      }
      log(`creating ${org.alias} (${org.description}) from ${org.definition}, ${org.days} days`);
      try { sf([...base, "--definition-file", definitionPath(org.definition), "--wait", "25"]); } catch (e) {
        if ((e.kind || sfFailure(e.message)) !== "shape") throw e;
        log(`::warning::production's org shape is outdated: refreshing it, then creating ${org.alias} once more`);
        record("shape", { action: "refresh", org: org.description });
        self.removeTagged(org.description);   // a half-made attempt must not hold a slot
        self.refreshShape();
        sf([...base, "--definition-file", definitionPath(org.definition), "--wait", "25"]);
      }
      return { fromSnapshot: false };
    },

    /** Capture production's shape again and wait until it is usable (about 2 to 10 minutes). */
    refreshShape({ waitMinutes = 15 } = {}) {
      const before = new Date().toISOString();
      sf(["org", "create", "shape", "-o", DEVHUB]);
      for (let i = 0; i < waitMinutes * 2; i++) {
        const shapes = sf(["org", "list", "shape"], { allowFail: true });
        const list = Array.isArray(shapes) ? shapes : shapes?.orgShapes || [];
        if (list.some((x) => String(x.status || x.Status).toLowerCase() === "active" && String(x.createdDate || x.CreatedDate || "") >= before.slice(0, 10))) return;
        sleep(30_000);
      }
      throw new Error(`production's org shape did not become active within ${waitMinutes} minutes: run org-shape-refresh`);
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
      const l = self.limits();
      const no = capacityProblem(l, l.active.remaining === 0 || (reserve && l.active.remaining <= reserve) ? active().map((r) => r.Description || "") : [], reserve);
      if (no) throw new Error(no);
    },

    /** CI deployed (base..head delta) and tested `commit` in an org that was ready for an earlier commit with the same
     *  baseline and seed: it now holds that commit, so the UI test does not deploy everything again. Only when
     *  coversMove(held) says the delta brought the org from `held` to `commit` (advanceCovered). Returns whether it moved. */
    advance(alias, commit, coversMove = () => false) {
      const username = sf(["org", "display", "-o", alias], { allowFail: true })?.username;
      const title = username && sf(["data", "query", "-o", alias, "-q", `SELECT Title FROM User WHERE Username = '${username}'`], { allowFail: true })?.records?.[0]?.Title;
      const m = String(title || "").match(/^pipeline: ready ([0-9a-f]{7,40})((?: b\S+)?(?: s\S+)?)$/);
      const want = readyMarker(commit, baseline(), seedId());
      if (!m || `${readyMarker(commit)}${m[2]}` !== want) { log(`${alias}: not marked (it was not ready with this baseline and seed)`); return false; }
      if (!coversMove(m[1])) { log(`${alias}: not marked (the deploy did not bring it from ${m[1].slice(0, 7)} to ${String(commit).slice(0, 7)})`); return false; }
      self.markReady(alias, want);
      log(`${alias} now holds ${String(commit).slice(0, 7)}`);
      return true;
    },

    /** A throwaway org for one CI run, deleted by the caller (from the snapshot when there is one, untracked). */
    temporary(name) {
      self.assertCapacity();
      const org = { kind: "temp", alias: name, description: name, definition: orgFor("snapshot", { env }).definition, days: 1 };
      const how = self.create(org);
      self.installPackages(name);
      return { ...org, created: true, ...how };
    },

    /**
     * Deploy the source. With a production baseline (and no manifest), the baseline and force-app go in ONE deploy
     * (they reference each other both ways). In soft mode a failed combined deploy warns, records why, and deploys
     * force-app alone, so a story is never blocked by production's own metadata; strict fails.
     */
    deploy(alias, { manifest, dryRun = false, skipBaseline = false } = {}) {
      if (skipBaseline) log(`${alias} came from a snapshot that holds the production baseline (${baseline()}): deploying ${dirs.join(", ")} only`);
      const id = manifest || skipBaseline ? null : baseline();
      if (id) {
        const admin = sf(["org", "display", "-o", alias])?.username;
        const dir = composeProject({ baselineDir, sourceDirs: dirs, forceignore: join(process.cwd(), ".forceignore") });
        const r = sf(["project", "deploy", "start", "-o", alias, "-d", BASELINE_DIR, ...dirs.flatMap((d) => ["-d", d]), "--ignore-conflicts", "--wait", "45", ...(dryRun ? ["--dry-run"] : [])],
          { cwd: dir, env: { SCRATCH_ADMIN: admin }, allowFail: baselineMode !== "strict" ? "json" : false });   // soft: the failure's details
        const ok = r && r.success !== false && !["Failed", "Canceled"].includes(r.status);
        if (!ok && r?.details?.componentFailures) for (const f of [].concat(r.details.componentFailures).slice(0, 15)) log(`  ${f.componentType} ${f.fullName}: ${f.problem}`);
        if (ok) { log(`deployed the production baseline (${id}) and ${dirs.join(", ")} to ${alias}`); return { baseline: id }; }
        // soft: leave out only the baseline components that failed and try once more, so one component a scratch org
        // cannot hold (a feature its shape lacks) does not take the rest of production's customisations with it
        const dropped = failedBaselineFiles(r, dir);
        if (dropped.length && baselineMode !== "strict") {
          log(`::warning::${dropped.length} production baseline component(s) cannot be deployed to ${alias}; trying again without them: ${dropped.map((f) => basename(f)).join(", ")}`);
          const again = sf(["project", "deploy", "start", "-o", alias, "-d", BASELINE_DIR, ...dirs.flatMap((d) => ["-d", d]), "--ignore-conflicts", "--wait", "45", ...(dryRun ? ["--dry-run"] : [])],
            { cwd: dir, env: { SCRATCH_ADMIN: admin }, allowFail: true });
          if (again && again.success !== false && !["Failed", "Canceled"].includes(again.status)) {
            record("baseline", { action: "deploy-partial", org: alias, id, dropped: dropped.map((f) => basename(f)) });
            log(`deployed the production baseline (${id}, without ${dropped.length}) and ${dirs.join(", ")} to ${alias}`);
            return { baseline: id, dropped };
          }
        }
        log(`::warning::the production baseline (${id}) did not deploy to ${alias}: deploying ${dirs.join(", ")} alone (BASELINE=soft). See the deploy errors above.`);
        record("baseline", { action: "deploy-failed", org: alias, id });
      }
      const src = manifest ? ["--manifest", manifest] : dirs.flatMap((d) => ["-d", d]);
      sf(["project", "deploy", "start", "-o", alias, ...src, "--ignore-conflicts", "--wait", "30", ...(dryRun ? ["--dry-run"] : [])]);
      return { baseline: null };
    },






    /** Delete the target's org if it is alive. Returns true if one was deleted. */
    remove(target, opts) {
      const org = self.find(target, opts);
      if (!org) { log(`no live org for ${resolve(target, opts).description}`); return false; }
      return self.removeTagged(org.description) > 0;
    },



  };
  return self;
}
