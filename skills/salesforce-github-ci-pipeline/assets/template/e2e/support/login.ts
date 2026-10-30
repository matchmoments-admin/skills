import { Page, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

/**
 * Logs in to the scratch org through a front-door URL from `sf org open --url-only`.
 * Front-door URLs are short-lived and may be single-use, so when SCRATCH_ALIAS is set a fresh one is
 * fetched for every login (retries, re-runs and several specs each need their own). SF_FRONTDOOR_URL
 * is the fallback for a one-off local run. Never log or commit either value.
 */
function frontDoorUrl(): string {
  const alias = process.env.SCRATCH_ALIAS;
  if (alias) {
    const out = execFileSync(
      "sf",
      ["org", "open", "-o", alias, "--url-only", "--json"],
      {
        encoding: "utf8",
        // Playwright sets FORCE_COLOR for its workers, and the CLI then puts colour codes inside its JSON.
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          SF_AUTOUPDATE_DISABLE: "true",
          NODE_NO_WARNINGS: "1"
        }
      }
    );
    // Parse only the JSON object, in case a warning line precedes it.
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    if (start < 0 || end < start)
      throw new Error("sf org open returned no JSON");
    return JSON.parse(out.slice(start, end + 1)).result.url;
  }
  const url = process.env.SF_FRONTDOOR_URL;
  if (!url)
    throw new Error("Set SCRATCH_ALIAS (preferred) or SF_FRONTDOOR_URL");
  return url;
}

export async function login(page: Page): Promise<void> {
  // A front-door login occasionally lands on Salesforce's login page ("logged out due to
  // inactivity") in production-shaped orgs; one retry with a fresh URL clears it.
  for (let attempt = 1; ; attempt++) {
    const url = frontDoorUrl();
    startSession(page, url);
    await page.goto(url);
    try {
      await expect(page.getByRole("navigation").first()).toBeVisible({
        timeout: attempt === 1 ? 30_000 : 60_000
      });
      await settleSetupProbe(page);
      return;
    } catch (e) {
      if (attempt >= 2 || !process.env.SCRATCH_ALIAS) throw e;
    }
  }
}

/**
 * Salesforce's Setup domain (<my domain>.my.salesforce-setup.com). The front door lands on Setup Home, and a probe then
 * moves the page there (?SetupDomainProbePassed=true&SetupDomainReload=1). That host serves only Setup: a Lightning path
 * asked of it ends on Setup Home (release 2027-w03, run 41001925070: issue-1 and story-143, which built the URL from
 * page.url() once the probe had moved the page). So openPath resolves every path against the org's front-door host
 * (where the session cookie is; it sends Lightning paths on to Lightning itself), saved at login.
 */
const origins = new WeakMap<Page, string>();
/** Pages past the probe (it passed, or a navigation stayed off Setup): openPath needs no late watch for them. */
const settled = new WeakSet<Page>();
const PROBE_PARAMS = ["SetupDomainProbePassed", "SetupDomainReload"];
/** Upper bound on waiting out the probe; a URL unchanged for STABLE_MS (PRE_PROBE_MS before the probe was seen) is settled. */
const PROBE_MS = 10_000;
const STABLE_MS = 500;
const PRE_PROBE_MS = 3_000;
/** How long openPath watches a loaded page for a late move to Setup, once per session until one stays. */
const LATE_MS = 3_000;

const isSetupPath = (pathname: string) => pathname.startsWith("/lightning/setup/");
const probeQuery = (u: URL) => PROBE_PARAMS.some((p) => u.searchParams.has(p));

/** A new session on this page (login, "Log in as"): its origin, and nothing known yet about the probe. */
function startSession(page: Page, url: string): void {
  origins.set(page, new URL(url).origin);
  settled.delete(page);
}

/**
 * True when `path` (not a Setup page) was asked for and the page is where the probe sends it: Setup Home, or a URL with
 * the probe's query. A page Salesforce shows in Setup (a permission set record, Flow Builder) is not a bounce.
 */
export function bouncedToSetup(current: string, path: string): boolean {
  if (isSetupPath(new URL(path, current).pathname)) return false;
  const at = new URL(current);
  return at.pathname === "/lightning/setup/SetupOneHome/home" || probeQuery(at);
}

/**
 * Wait out the Setup-domain probe, so it cannot move the page under the spec's next step: on a Setup page, until the
 * URL stays the same for STABLE_MS (PRE_PROBE_MS while the probe may still come), at most PROBE_MS.
 */
async function settleSetupProbe(page: Page): Promise<void> {
  const end = Date.now() + PROBE_MS;
  for (;;) {
    const at = page.url();
    if (probeQuery(new URL(at))) settled.add(page); // the probe has run
    if (!isSetupPath(new URL(at).pathname)) return;
    const left = end - Date.now();
    if (left <= 0) return;
    const window = settled.has(page) ? STABLE_MS : PRE_PROBE_MS;
    const moved = await page
      .waitForURL((u) => u.toString() !== at, { timeout: Math.min(window, left) })
      .then(
        () => true,
        () => false
      );
    if (!moved) {
      await page.waitForLoadState("load").catch(() => {});
      return;
    }
  }
}

/**
 * Opens a Salesforce path such as "/lightning/o/Account/new" in the org you logged in to.
 * There is no Playwright baseURL (the org's domain is only known after login), so a relative
 * page.goto() fails with "Cannot navigate to invalid URL". Call login(page) first.
 * It checks where the page landed: sent to Setup Home instead (the Setup-domain probe), it asks once more, then fails.
 */
export async function openPath(page: Page, path: string): Promise<void> {
  const url = new URL(path, origins.get(page) ?? page.url()).toString();
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url);
    } catch (e) {
      // Lightning can still be redirecting after login, which aborts the first navigation.
      if (!String(e).includes("ERR_ABORTED")) throw e;
      await page.waitForLoadState("load");
      await page.goto(url);
    }
    if (!settled.has(page)) {
      // the probe was not seen to pass: it may still move this page once it has loaded
      await page
        .waitForURL((u) => bouncedToSetup(u.toString(), path), {
          timeout: LATE_MS
        })
        .catch(() => {});
      if (!bouncedToSetup(page.url(), path)) settled.add(page); // it stayed: no watch again this session
    }
    if (!bouncedToSetup(page.url(), path)) return;
    if (attempt >= 2)
      throw new Error(
        `openPath: Salesforce sent the page to Setup (${new URL(page.url()).pathname}) instead of ${path}, twice`
      );
    await settleSetupProbe(page);
  }
}

/** The user a story is for (its "Persona:" line): a role developer name and permission set names. */
export interface Persona {
  role?: string;
  permsets?: string[];
}

function sfJson(args: string[]): any {
  const out = execFileSync("sf", [...args, "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      SF_AUTOUPDATE_DISABLE: "true",
      NODE_NO_WARNINGS: "1"
    }
  });
  const start = out.indexOf("{");
  return JSON.parse(out.slice(start)).result;
}

/**
 * Logs in as the persona instead of the admin, so a test sees what that user sees (role-shared folders, records the
 * permission sets open or hide). A user for the persona is made once per org (Standard User, the role, the permission
 * sets) as plain records (`sf org create user` refuses JWT-authorised orgs on Hyperforce); then the admin uses
 * Salesforce's own "Log in as" on the classic domain, so no password ever exists. Scratch orgs have very few user
 * licences: when they run out, the OTHER persona users are deactivated (never the admin or a person's tester login).
 * Needs SCRATCH_ALIAS. The org's roles must be assignable (org provisioning rebuilds an Org Shape org's roles).
 */
export async function loginAs(
  page: Page,
  persona: Persona
): Promise<{ username: string }> {
  const alias = process.env.SCRATCH_ALIAS;
  if (!alias) throw new Error("loginAs needs SCRATCH_ALIAS");
  // CI passes the org's id and URL: the Dev Hub is logged out before spec code runs, and `sf org display` needs it
  const org =
    process.env.SCRATCH_ORG_ID && process.env.SCRATCH_INSTANCE_URL
      ? {
          id: process.env.SCRATCH_ORG_ID,
          instanceUrl: process.env.SCRATCH_INSTANCE_URL
        }
      : sfJson(["org", "display", "-o", alias]);
  const orgId = String(org.id).slice(0, 15).toLowerCase();
  const sets = (persona.permsets || [])
    .filter((p) => /^[A-Za-z][A-Za-z0-9_]*$/.test(p))
    .sort();
  const tag =
    `${persona.role || "norole"}${sets.length ? `.${sets.join(".")}` : ""}`
      .toLowerCase()
      .replace(/[^a-z0-9.]/g, "")
      .slice(0, 40);
  const username = `persona.${tag}@${orgId}.pipeline`;
  const q = (soql: string) =>
    sfJson(["data", "query", "-o", alias, "-q", soql]).records;
  const freeLicences = () => {
    for (const u of q(
      `SELECT Id FROM User WHERE IsActive = true AND Username LIKE 'persona.%' AND Username != '${username}'`
    ))
      sfJson([
        "data",
        "update",
        "record",
        "-o",
        alias,
        "-s",
        "User",
        "-i",
        u.Id,
        "-v",
        "IsActive=false"
      ]);
  };
  const withLicence = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (
        !/LICENSE_LIMIT_EXCEEDED|License Limit Exceeded/i.test(
          String((e as { stdout?: string }).stdout || e)
        )
      )
        throw e;
      freeLicences();
      return fn();
    }
  };
  const found = q(
    `SELECT Id, IsActive FROM User WHERE Username = '${username}'`
  )[0];
  let id: string | undefined = found?.Id;
  if (found && !found.IsActive)
    withLicence(() =>
      sfJson([
        "data",
        "update",
        "record",
        "-o",
        alias,
        "-s",
        "User",
        "-i",
        found.Id,
        "-v",
        "IsActive=true"
      ])
    );
  if (!id) {
    const profile = q("SELECT Id FROM Profile WHERE Name = 'Standard User'")[0]
      .Id;
    const role = persona.role
      ? q(
          `SELECT Id FROM UserRole WHERE DeveloperName = '${persona.role.replace(/[^A-Za-z0-9_]/g, "")}'`
        )[0]
      : null;
    if (persona.role && !role)
      throw new Error(`role ${persona.role} does not exist in ${alias}`);
    const values = [
      `Username='${username}'`,
      "Email='persona@example.invalid'",
      `LastName='${`Persona ${tag}`.slice(0, 70)}'`,
      `Alias='p${Date.now() % 1e6}'`,
      `ProfileId=${profile}`,
      "TimeZoneSidKey='Australia/Sydney'",
      "LocaleSidKey='en_AU'",
      "EmailEncodingKey='UTF-8'",
      "LanguageLocaleKey='en_US'",
      "CountryCode='AU'",
      "UserPreferencesLightningExperiencePreferred=true",
      ...(role ? [`UserRoleId=${role.Id}`] : [])
    ];
    id = withLicence(
      () =>
        sfJson([
          "data",
          "create",
          "record",
          "-o",
          alias,
          "-s",
          "User",
          "-v",
          values.join(" ")
        ]).id
    ) as string;
  }
  // assigned on every call, not only when the user is made: a run that stopped part-way (a timeout while a group
  // recalculates) must not leave the persona with no access, or its "cannot see" tests pass for the wrong reason
  // a persona names permission set groups (one per business role or process) or, before them, loose sets
  const list = sets.map((n) => `'${n}'`).join(",");
  const groupsNow = (): {
    Id: string;
    DeveloperName: string;
    Status: string;
  }[] =>
    sets.length
      ? q(
          `SELECT Id, DeveloperName, Status FROM PermissionSetGroup WHERE DeveloperName IN (${list})`
        )
      : [];
  let groups = groupsNow();
  // a deploy that changes a group leaves it Outdated or Updating, and an assignment then fails: wait for Updated
  for (
    let i = 0;
    i < 12 && groups.some((g) => !["Updated", "Failed"].includes(g.Status));
    i++
  ) {
    await new Promise((r) => setTimeout(r, 10_000));
    groups = groupsNow();
  }
  const stuck = groups.filter((g) => g.Status !== "Updated");
  if (stuck.length)
    throw new Error(
      `permission set group ${stuck.map((g) => `${g.DeveloperName} (${g.Status})`).join(", ")} cannot be assigned in ${alias}`
    );
  const loose = sets.filter((n) => !groups.some((g) => g.DeveloperName === n));
  const permsets: { Id: string; Name: string }[] = loose.length
    ? q(
        `SELECT Id, Name FROM PermissionSet WHERE Name IN (${loose.map((n) => `'${n}'`).join(",")})`
      )
    : [];
  const unknown = loose.filter((n) => !permsets.some((ps) => ps.Name === n));
  if (unknown.length)
    throw new Error(
      `${unknown.join(", ")}: no permission set group or permission set of that name in ${alias}`
    );
  const held = new Set<string>(
    q(
      `SELECT PermissionSetId, PermissionSetGroupId FROM PermissionSetAssignment WHERE AssigneeId = '${id}'`
    ).flatMap(
      (a: { PermissionSetId: string; PermissionSetGroupId: string | null }) => [
        a.PermissionSetId,
        a.PermissionSetGroupId || ""
      ]
    )
  );
  for (const [field, recordId] of [
    ...groups.map((g) => ["PermissionSetGroupId", g.Id]),
    ...permsets.map((ps) => ["PermissionSetId", ps.Id])
  ])
    if (!held.has(recordId))
      sfJson([
        "data",
        "create",
        "record",
        "-o",
        alias,
        "-s",
        "PermissionSetAssignment",
        "-v",
        `AssigneeId=${id} ${field}=${recordId}`
      ]);
  await login(page);
  // "Log in as" lives on the classic domain (the org's instance URL), not the Lightning one; it redirects a few times
  const su = `${String(org.instanceUrl).replace(/\/$/, "")}/servlet/servlet.su?oid=${org.id}&suorgadminid=${id}&retURL=%2F&targetURL=%2Flightning%2Fpage%2Fhome`;
  // Salesforce's banner names the persona once "Log in as" took. Without it the page is still the admin's, and a
  // test of what the persona may NOT see would pass on the admin's view (story #166): check, retry once, else fail.
  const banner = page.getByText(username, { exact: false }).first();
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(su);
    } catch (e) {
      if (!String(e).includes("ERR_ABORTED")) throw e;
      await page.waitForLoadState("load");
    }
    await expect(page.getByRole("navigation").first()).toBeVisible({
      timeout: 60_000
    });
    const isPersona = await banner
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(
        () => true,
        () => false
      );
    if (isPersona) {
      startSession(page, su); // the persona's session, on the classic host "Log in as" used
      break;
    }
    if (attempt === 2)
      throw new Error(
        `loginAs: still the admin after "Log in as" ${username} (no "Logged in as" banner)`
      );
    await page.waitForTimeout(5_000); // a user just reactivated may not be ready to log in as
  }
  return { username };
}
