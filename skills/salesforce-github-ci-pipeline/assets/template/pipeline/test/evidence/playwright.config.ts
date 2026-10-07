import { defineConfig } from "@playwright/test";
// The evidence() helper's own tests (pipeline/test/pipeline.test.mjs runs them): local pages, no org, no network.
// Named *.check.ts, not *.spec.ts: Jest (sfdx-lwc-jest) runs every *.spec.ts it finds.
export default defineConfig({ testDir: ".", testMatch: "*.check.ts", timeout: 30_000, retries: 1, workers: 1, reporter: [["line"]], use: { headless: true } });
