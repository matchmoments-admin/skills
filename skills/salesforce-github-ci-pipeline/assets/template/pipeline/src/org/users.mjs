// Users in an org: roles that can be assigned, Login As, permission sets, a production user's rights, and testers.
// Part of Org provisioning (pipeline/src/org.mjs): orgRegistry composes these methods with the provisioning core.
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { sfFailure } from "../io.mjs";
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

/** Who a story is for, from its "Persona:" line (Access section): "Persona: DirectorDirectSales role, Regional_Reporting_Access".
 *  { role, permsets } or null. Pure. */
export function personaOf(body) {
  const line = String(body || "").match(/^\s*[-*]?\s*\**Persona:?\**:?\s*(.+)$/im)?.[1];
  if (!line) return null;
  const items = line.split(/\s\(|\.(\s|$)/)[0].split(/[,;+]|\band\b/).map((s) => s.replace(/[`*.]/g, "").trim()).filter(Boolean);   // stop at an explanation
  const role = items.find((i) => /\s+role$/i.test(i))?.replace(/\s+role$/i, "").trim() || null;
  const permsets = items.filter((i) => !/\s+role$/i.test(i) && /^[A-Za-z][A-Za-z0-9_]*$/.test(i));
  return role || permsets.length ? { role, permsets } : null;
}

/** Permission set names in a source folder (scratch orgs get all of them; production never does). */
export function permissionSets(dir = "force-app", suffix = ".permissionset-meta.xml") {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(suffix)) out.push(basename(f, suffix));
    }
  };
  try { walk(dir); } catch { /* no source folder */ }
  return out.sort();
}

/** Permission set group names in a source folder: a persona's access (one group per business role or process). */
export const permissionSetGroups = (dir = "force-app") => permissionSets(dir, ".permissionsetgroup-meta.xml");

/**
 * Give a user each named permission set or permission set group (a persona line may name either). A group is assigned
 * only once Salesforce has recalculated it (Status 'Updated'; a deploy that changes a group leaves it 'Outdated' or
 * 'Updating' for a while, and an assignment then fails), so wait up to `waitMs`. Returns the names assigned.
 */
export function assignAccess({ sf, sleep = () => {}, log = () => {} }, alias, { id: userId, username }, names, waitMs = 120_000) {
  const safe = names.filter((n) => /^[A-Za-z][A-Za-z0-9_]*$/.test(n));
  if (!safe.length) return [];
  const q = (soql) => sf(["data", "query", "-o", alias, "-q", soql], { allowFail: true })?.records || [];
  const list = safe.map((n) => `'${n}'`).join(",");
  const done = [];
  let groups = q(`SELECT Id, DeveloperName, Status FROM PermissionSetGroup WHERE DeveloperName IN (${list})`);
  for (let waited = 0; groups.some((g) => g.Status !== "Updated" && g.Status !== "Failed") && waited < waitMs; waited += 10_000) {
    sleep(10_000);
    groups = q(`SELECT Id, DeveloperName, Status FROM PermissionSetGroup WHERE DeveloperName IN (${list})`);
  }
  for (const g of groups) {
    if (g.Status !== "Updated") { log(`::warning::permission set group ${g.DeveloperName} is ${g.Status} in ${alias}: not assigned (Setup > Permission Set Groups > Recalculate)`); continue; }
    if (sf(["data", "create", "record", "-o", alias, "-s", "PermissionSetAssignment", "-v", `AssigneeId=${userId} PermissionSetGroupId=${g.Id}`], { allowFail: true })) done.push(g.DeveloperName);
  }
  const isGroup = new Set(groups.map((g) => g.DeveloperName));
  for (const p of safe.filter((n) => !isGroup.has(n))) {
    if (sf(["org", "assign", "permset", "--name", p, "-o", alias, "--on-behalf-of", username], { allowFail: true })) done.push(p);
  }
  return done;
}

/** The registry's users methods. ctx: orgRegistry's shared context (sf, log, env, ...). */
export function usersMethods({ sf, sleep, log, keyFile, packages, env, baselineDir, seedDir, record, snapshotRefused, refuseSnapshot, baseline, seedId, active, deleteRecord }) {
  return {
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
      const names = permissionSets(dir), groups = permissionSetGroups(dir);
      if (!names.length && !groups.length) return fn();
      const username = sf(["org", "display", "-o", alias]).username;
      const inList = (xs) => xs.length ? xs.map((n) => `'${n}'`).join(",") : "''";
      const rows = sf(["data", "query", "-o", alias, "-q", `SELECT Id FROM PermissionSetAssignment WHERE Assignee.Username = '${username}' AND (PermissionSet.Name IN (${inList(names)}) OR PermissionSetGroup.DeveloperName IN (${inList(groups)}))`], { allowFail: true })?.records || [];
      for (const r of rows) sf(["data", "delete", "record", "-o", alias, "-s", "PermissionSetAssignment", "-i", r.Id], { allowFail: true });
      log(`tests run as production's CI user would: ${rows.length} permission set(s) taken from ${username} for the run`);
      try { return fn(); } finally { this.prepare(alias, dir); }   // prepare gives them back (UI tests and people need them)
    },
    /**
     * A tester for a person (a story's org or the UAT stand-in): a Standard User made once per login, and a
     * password-reset email from Salesforce to their address. No password or session ever leaves the org. With a
     * persona ({ role, permsets }: the story's "Persona:" line, or UAT_TESTER_ROLE) they get that role and those
     * permission sets, so they see what that user sees; without one, every permission set in the source.
     * Returns { username, created, persona }.
     */
    tester(alias, { login, email, persona = null, admin = false }, dir = "force-app") {
      // admin: System Administrator (an admin looking at the story's org as themselves); else Standard User as the persona
      const sets = admin ? [] : persona?.permsets?.length ? persona.permsets : permissionSets(dir);
      const q = (soql) => sf(["data", "query", "-o", alias, "-q", soql], { allowFail: true })?.records || [];
      const orgId = sf(["org", "display", "-o", alias]).id;
      const username = `${String(login).toLowerCase().replace(/[^a-z0-9]/g, "")}.${admin ? "admin" : "uat"}@${String(orgId).slice(0, 15).toLowerCase()}.pipeline`;
      const found = q(`SELECT Id, IsActive FROM User WHERE Username = '${username}'`)[0];
      // a record, not `sf org create user` (it fails with a JWT login on Hyperforce); a full org frees the licence a
      // UI-test persona holds (they are recreated on their next run), as e2e/support/login.ts does
      const withLicence = (f) => {
        try { return f(); } catch (e) {
          if ((e.kind || sfFailure(e.message)) !== "licence") throw e;
          for (const u of q(`SELECT Id FROM User WHERE IsActive = true AND Username LIKE 'persona.%'`)) sf(["data", "update", "record", "-o", alias, "-s", "User", "-i", u.Id, "-v", "IsActive=false"], { allowFail: true });
          return f();
        }
      };
      let id = found?.Id;
      if (!id) {
        const profile = q(`SELECT Id FROM Profile WHERE Name = '${admin ? "System Administrator" : "Standard User"}'`)[0]?.Id;
        id = withLicence(() => sf(["data", "create", "record", "-o", alias, "-s", "User", "-v", [`Username='${username}'`, `Email='${email}'`, `LastName='${String(login).slice(0, 70)}'`,
          `Alias='t${Date.now() % 1e6}'`, `ProfileId=${profile}`, "TimeZoneSidKey='Australia/Sydney'", "LocaleSidKey='en_AU'", "EmailEncodingKey='UTF-8'", "LanguageLocaleKey='en_US'"].join(" ")]).id);
      } else if (!found.IsActive) withLicence(() => sf(["data", "update", "record", "-o", alias, "-s", "User", "-i", id, "-v", "IsActive=true"]));
      assignAccess({ sf, sleep, log }, alias, { id, username }, sets);   // a persona names permission set groups (or, before them, loose sets)
      const roleId = persona?.role && !admin ? q(`SELECT Id FROM UserRole WHERE DeveloperName = '${String(persona.role).replace(/[^A-Za-z0-9_]/g, "")}'`)[0]?.Id : null;
      if (persona?.role && !admin && !roleId) log(`::warning::role ${persona.role} not found in ${alias}: the tester has no role`);
      sf(["data", "update", "record", "-o", alias, "-s", "User", "-i", id, "-v", `Email=${email} CountryCode=AU UserPreferencesLightningExperiencePreferred=true${roleId ? ` UserRoleId=${roleId}` : ""}`], { allowFail: true });
      const apex = join(tmpdir(), `reset-${process.pid}.apex`);
      writeFileSync(apex, `System.resetPassword('${id}', true);\n`);
      sf(["apex", "run", "-o", alias, "--file", apex]);
      log(`tester ${username}${admin ? " (System Administrator)" : roleId ? ` (role ${persona.role})` : ""}: password email sent`);
      return { username, created: !found, admin, persona: { role: roleId ? persona.role : null, permsets: sets } };
    },
  };
}
