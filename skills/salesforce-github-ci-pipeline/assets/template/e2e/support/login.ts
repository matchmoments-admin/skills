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
    await page.goto(frontDoorUrl());
    try {
      await expect(page.getByRole("navigation").first()).toBeVisible({
        timeout: attempt === 1 ? 30_000 : 60_000
      });
      return;
    } catch (e) {
      if (attempt >= 2 || !process.env.SCRATCH_ALIAS) throw e;
    }
  }
}

/**
 * Opens a Salesforce path such as "/lightning/o/Account/new" in the org you logged in to.
 * There is no Playwright baseURL (the org's domain is only known after login), so a relative
 * page.goto() fails with "Cannot navigate to invalid URL". Call login(page) first.
 */
export async function openPath(page: Page, path: string): Promise<void> {
  const url = new URL(path, page.url()).toString();
  try {
    await page.goto(url);
  } catch (e) {
    // Lightning can still be redirecting after login, which aborts the first navigation.
    if (!String(e).includes("ERR_ABORTED")) throw e;
    await page.waitForLoadState("load");
    await page.goto(url);
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
      ? { id: process.env.SCRATCH_ORG_ID, instanceUrl: process.env.SCRATCH_INSTANCE_URL }
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
    for (const ps of sets.length
      ? q(
          `SELECT Id FROM PermissionSet WHERE Name IN (${sets.map((n) => `'${n}'`).join(",")})`
        )
      : [])
      sfJson([
        "data",
        "create",
        "record",
        "-o",
        alias,
        "-s",
        "PermissionSetAssignment",
        "-v",
        `AssigneeId=${id} PermissionSetId=${ps.Id}`
      ]);
  }
  await login(page);
  // "Log in as" lives on the classic domain (the org's instance URL), not the Lightning one; it redirects a few times
  const su = `${String(org.instanceUrl).replace(/\/$/, "")}/servlet/servlet.su?oid=${org.id}&suorgadminid=${id}&retURL=%2F&targetURL=%2Flightning%2Fpage%2Fhome`;
  try {
    await page.goto(su);
  } catch (e) {
    if (!String(e).includes("ERR_ABORTED")) throw e;
    await page.waitForLoadState("load");
  }
  await expect(page.getByRole("navigation").first()).toBeVisible({
    timeout: 60_000
  });
  return { username };
}
