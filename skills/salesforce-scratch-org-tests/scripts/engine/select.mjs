#!/usr/bin/env node
// Usage: node select.mjs <base-ref>        (run from the Salesforce DX project root; select-tests.sh calls it)
// Prints the tests relevant to the change between <base-ref> and HEAD, one per line:
//   none                 no Salesforce source changed: no org needed
//   all                  run every local Apex test (TEST_MODE=all forces this), then each Flow test as "flow ..."
//   apex <ClassName>     an Apex test class
//   flow <Flow>.<Test>   a Flow Builder test
// The rules are tests.mjs's selectTests(): a verbatim copy of the GitHub pipeline's pipeline/src/tests.mjs (the
// salesforce-github-ci-pipeline skill), kept identical by that repo's skills-sync, so both skills select alike and
// share its tests. Why the selection was made goes to stderr. Needs only git and Node (which the sf CLI needs anyway).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { selectTests } from "./tests.mjs";

const base = process.argv[2];
if (!base) { console.error("usage: select.mjs <base-ref>, e.g. origin/main"); process.exit(2); }
const packageDirs = () => { try { return JSON.parse(readFileSync("sfdx-project.json", "utf8")).packageDirectories.map((d) => d.path).join(" "); } catch { return "force-app"; } };
const dirs = (process.env.SOURCE_DIRS || packageDirs()).split(/\s+/).filter(Boolean);   // SOURCE_DIRS overrides
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

const plan = selectTests({
  changed: git("diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`, "--", ...dirs),
  deleted: git("diff", "--name-only", "--diff-filter=D", `${base}...HEAD`, "--", ...dirs),
  files: git("ls-files", ...dirs), read,
  mode: process.env.TEST_MODE === "all" ? "all" : "relevant",
});
console.error(`# ${plan.mode}: ${plan.why}`);
const lines = plan.mode === "none" ? ["none"] : plan.mode === "all" ? ["all", ...plan.flows.map((f) => `flow ${f}`)] : [...plan.apex.map((t) => `apex ${t}`), ...plan.flows.map((f) => `flow ${f}`)];
process.stdout.write([...new Set(lines)].join("\n") + "\n");
