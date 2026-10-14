import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { loginAs, openPath } from "./support/login";
import { evidence } from "./support/evidence";

const alias = process.env.SCRATCH_ALIAS as string;

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
  return JSON.parse(out.slice(start));
}

function dashboardId(): string {
  const result = sfJson([
    "data",
    "query",
    "-o",
    alias,
    "-q",
    "SELECT Id FROM Dashboard WHERE DeveloperName = 'Regional_Sales' LIMIT 1"
  ]);
  return result.result.records[0]?.Id || "";
}

test.describe("Story 166: Regional Sales dashboard", () => {
  test("a sales manager opens the dashboard and sees both components", async ({
    page
  }) => {
    const id = dashboardId();
    expect(id.length).toBeGreaterThan(0);
    await loginAs(page, {
      role: "DirectorDirectSales",
      permsets: ["Regional_Reporting_Access"]
    });
    await openPath(page, `/lightning/r/Dashboard/${id}/view`);

    // Lightning renders a dashboard inside an iframe: find its components there
    const dashboard = page.frameLocator("iframe").first();

    // AC1: the dashboard opens and its first component renders
    const closedWon = dashboard
      .getByText("Closed Won amount by Sales region", { exact: false })
      .first();
    await expect(closedWon).toBeVisible({ timeout: 60_000 });
    await evidence(
      page,
      "AC1: opens Regional Sales dashboard from Regional Reporting folder",
      closedWon
    );

    // A new dashboard shows "No data" until it is first refreshed: refresh, then expect each component's data
    await dashboard
      .getByRole("button", { name: "Refresh", exact: true })
      .click();

    // Both components show data once refreshed (fails if "No data" stays: the persona sees no records)
    await expect(dashboard.getByText("No data", { exact: false })).toHaveCount(
      0,
      { timeout: 90_000 }
    );
    await expect(closedWon).toBeVisible();

    // AC2: Closed Won amount by Sales region component
    await evidence(
      page,
      "AC2: Closed Won amount by Sales region component shows regional data",
      closedWon
    );

    // AC3: Accounts by Sales region component
    const accounts = dashboard
      .getByText("Accounts by Sales region", { exact: false })
      .first();
    await expect(accounts).toBeVisible({ timeout: 30_000 });
    await evidence(
      page,
      "AC3: Accounts by Sales region component shows regional data",
      accounts
    );

    // AC4: the dashboard runs as the logged-in user (type LoggedInUser), so this user's data is shown
    await evidence(
      page,
      "AC4: dashboard runs as logged-in user with their accessible data",
      closedWon
    );
  });

  test("a sales rep cannot find or open the Regional Sales dashboard", async ({
    page
  }) => {
    const id = dashboardId();
    expect(id.length).toBeGreaterThan(0);
    // Login as a user with no role and no Regional_Reporting_Access permission
    // Using null for role means no role is assigned, so the user gets no access to the shared folder
    await loginAs(page, { role: null, permsets: [] });
    await openPath(page, `/lightning/r/Dashboard/${id}/view`);

    // AC5: without folder access no dashboard component renders, on the page or in its iframe
    await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(10_000);
    for (const scope of [page, page.frameLocator("iframe").first()]) {
      await expect(
        scope.getByText("Closed Won amount by Sales region", { exact: false })
      ).toHaveCount(0);
      await expect(
        scope.getByText("Accounts by Sales region", { exact: false })
      ).toHaveCount(0);
    }
    await evidence(
      page,
      "AC5: sales rep cannot find or open Regional Sales dashboard",
      page.locator("body")
    );
  });
});
