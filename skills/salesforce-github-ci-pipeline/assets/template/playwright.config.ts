import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // per test, not per step: a persona spec (log in as the user, create, check the list, the record, then the task as the
  // owner) took 78s on staging in the morning and over 90s under the afternoon's load (#249). Steps keep their own timeouts.
  timeout: 180_000,
  retries: 1,
  // one browser: a Lightning page is CPU-heavy, and 3 at once on a 2-core runner timed out across many specs (#268)
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    headless: true,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure"
  }
});
