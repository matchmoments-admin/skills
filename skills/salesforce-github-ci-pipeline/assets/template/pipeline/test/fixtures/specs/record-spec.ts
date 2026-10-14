import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { login, openPath } from "./support/login";

const alias = process.env.SCRATCH_ALIAS as string;

interface Record {
  id: string;
}

function execSf(args: string[]): Record {
  const out = execFileSync(
    "sf",
    args,
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        SF_AUTOUPDATE_DISABLE: "true",
        NODE_NO_WARNINGS: "1"
      }
    }
  );
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  return JSON.parse(out.slice(start, end + 1)).result;
}

function createAccount(customerSince?: string): string {
  const values = `Name='E2E Account ${Date.now()}'${customerSince ? ` Customer_Since__c='${customerSince}'` : ""}`;
  const result = execSf(["data", "create", "record", "-o", alias, "-s", "Account", "-v", values, "--json"]);
  return result.id;
}

function createOpportunity(accountId: string, closeDate: string): string {
  const values = `Name='E2E Opp ${Date.now()}' AccountId='${accountId}' StageName='Prospecting' CloseDate='${closeDate}'`;
  const result = execSf(["data", "create", "record", "-o", alias, "-s", "Opportunity", "-v", values, "--json"]);
  return result.id;
}

function updateOpportunityStage(oppId: string, stage: string): void {
  execSf(["data", "update", "record", "-o", alias, "-s", "Opportunity", "-i", oppId, "-v", `StageName='${stage}'`, "--json"]);
}

// Salesforce may adjust CloseDate when an opportunity is closed, so read back the stored value.
function getCloseDate(oppId: string): string {
  const out = execFileSync(
    "sf",
    ["data", "query", "-o", alias, "-q", `SELECT CloseDate FROM Opportunity WHERE Id='${oppId}'`, "--json"],
    { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", NODE_NO_WARNINGS: "1" } }
  );
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  return JSON.parse(out.slice(start, end + 1)).result.records[0].CloseDate;
}

function customerSinceItem(page) {
  return page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: "Edit Customer Since" }) })
    .last();
}

function formatDateForDisplay(dateStr: string): string {
  // Convert YYYY-MM-DD to M/D/YYYY format
  const [year, month, day] = dateStr.split("-");
  return `${parseInt(month)}/${parseInt(day)}/${year}`;
}

test.describe("Story 84: Fill Customer Since when opportunity is won", () => {
  test("First opportunity won sets Customer Since to close date", async ({ page }) => {
    const accountId = createAccount();
    const closeDate = "2026-10-15";
    const oppId = createOpportunity(accountId, closeDate);

    // Update the opportunity stage to Closed Won (via CLI, not UI)
    updateOpportunityStage(oppId, "Closed Won");

    await login(page);

    // Navigate to Account to verify Customer Since was set by the Flow
    await expect(async () => {
      await openPath(page, `/lightning/r/Account/${accountId}/view`);
    }).toPass({ timeout: 60_000 });

    // Check that Customer Since field now shows the close date (formatted as M/D/YYYY)
    const displayDate = formatDateForDisplay(getCloseDate(oppId));
    await expect(customerSinceItem(page)).toContainText(displayDate);
  });

  test("Account with existing Customer Since keeps it when another opportunity wins", async ({ page }) => {
    const existingDate = "2025-01-01";
    const accountId = createAccount(existingDate);
    const newCloseDate = "2026-10-20";
    const oppId = createOpportunity(accountId, newCloseDate);

    // Update the opportunity stage to Closed Won (via CLI, not UI)
    updateOpportunityStage(oppId, "Closed Won");

    await login(page);

    // Open Account to verify Customer Since is still the original date (not changed by second opp)
    await expect(async () => {
      await openPath(page, `/lightning/r/Account/${accountId}/view`);
    }).toPass({ timeout: 60_000 });

    const displayExistingDate = formatDateForDisplay(existingDate);
    // Verify Customer Since was not changed by the second opportunity's Closed Won
    await expect(customerSinceItem(page)).toContainText(displayExistingDate);
  });
});
