import { defineConfig } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// Specs that log in as a persona (loginAs) share the org's few user licences: when they run out, loginAs deactivates the
// other persona users, which would end a parallel test's session. Those specs run one at a time; the rest in parallel.
const persona = existsSync("e2e")
  ? readdirSync("e2e").filter(
      (f) =>
        f.endsWith(".spec.ts") &&
        readFileSync(`e2e/${f}`, "utf8").includes("loginAs(")
    )
  : [];
const personaFiles = persona.map((f) => `**/${f}`);

export default defineConfig({
  testDir: "./e2e",
  // per test, not per step: a persona spec (log in as the user, create, check the list, the record, then the task as the
  // owner) took 78s on staging in the morning and over 90s under the afternoon's load (#249). Steps keep their own timeouts.
  timeout: 180_000,
  retries: 1,
  // One browser per 2 cores: a Lightning page is CPU-heavy, and 3 at once on a 2-core runner timed out across many specs
  // (#268). UI_WORKERS raises it on a larger runner (UI_RUNNER); faster on standard runners means UI_SHARDS (more runners).
  workers: process.env.CI ? Number(process.env.UI_WORKERS) || 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    headless: true,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  // the persona chain first: it is the longest (11 tests, about 13 minutes), so it starts at once beside the parallel
  // tests instead of after them (listed second, it ran last: the regression took 19 minutes on 3 workers)
  projects: [
    ...(persona.length
      ? [{ name: "persona", testMatch: personaFiles, workers: 1 }]
      : []),
    { name: "parallel", testIgnore: personaFiles }
  ]
});
