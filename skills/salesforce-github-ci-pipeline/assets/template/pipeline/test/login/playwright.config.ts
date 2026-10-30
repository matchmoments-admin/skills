import { defineConfig } from "@playwright/test";
// login() and openPath()'s own tests (pipeline/test/workflows.test.mjs runs them): Salesforce's hosts are faked with
// page.route, so no org and no network. Named *.check.ts, not *.spec.ts: Jest (sfdx-lwc-jest) runs every *.spec.ts.
export default defineConfig({ testDir: ".", testMatch: "*.check.ts", timeout: 60_000, retries: 0, workers: 1, reporter: [["line"]], use: { headless: true } });
