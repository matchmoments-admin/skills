// Pipeline tests: the UI tests' login helpers (e2e/support/login.ts), in a real browser against a fake org.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { playwrightCheck } from "./helpers.mjs";

test("login() and openPath() survive Salesforce's Setup-domain redirect (release 2027-w03: issue-1 and story-143 ended on Setup Home, #425)", async (t) => {
  // CI's static checks install Chromium when login.ts or these checks change, so a change to either runs them
  assert.match(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"), /e2e\/support\/\(evidence\|login\)\\\.ts\|.*pipeline\/test\/\(evidence\|login\)\//);
  // pipeline/test/login/login.check.ts: the probe before and after Setup Home shows, a probe query that stays, the Setup
  // domain's bounce, a late bounce, a page shown in Setup, a Setup path, the front-door origin
  await playwrightCheck(t, "pipeline/test/login/playwright.config.ts");
});
