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
