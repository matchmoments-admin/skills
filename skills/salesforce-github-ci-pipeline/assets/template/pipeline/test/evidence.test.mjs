// Pipeline tests: evidence (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as names from "../src/conventions.mjs";
import * as gate from "../src/gate.mjs";
import * as verdict from "../src/verdict.mjs";
import * as roles from "../src/roles.mjs";
import * as journey from "../src/journey.mjs";
import * as capacity from "../src/capacity.mjs";
import * as settings from "../src/settings.mjs";
import { plan } from "../src/closeout.mjs";
import { jiraTracker, githubTracker, adfToText } from "../src/tracker.mjs";
import { orgRegistry, packageList, findOrphans, personaOf as orgPersonaOf, expandSeed, sameSourceVia } from "../src/org.mjs";
import { summarize, toMarkdown, aiCost } from "../src/metrics.mjs";
import { typesafeJev, triageUiFailure, triageReview, storyReadiness } from "../src/jev.mjs";
import * as plans from "../src/plan.mjs";
import { storyCard, CARD_MARK, startingCard, activityLine } from "../src/card.mjs";
import * as board from "../src/board.mjs";
import * as tests from "../src/tests.mjs";
import * as production from "../src/production.mjs";
import * as access from "../src/access.mjs";
import * as pack from "../src/context-pack.mjs";
import * as shipping from "../src/shipping.mjs";
import * as closeout from "../src/closeout.mjs";
import { lane, jobId, wakeAll, waiterJob } from "../src/lane.mjs";
import * as events from "../src/events.mjs";
import { codeHost } from "../src/github.mjs";
import { storyCards, releaseCard, newStoryCard } from "../src/card.mjs";
import * as actions from "../src/actions.mjs";
import * as specs from "../src/spec.mjs";
import * as evidence from "../src/evidence.mjs";
import * as baselineMod from "../src/baseline.mjs";
import * as orgMod from "../src/org.mjs";
import * as start from "../src/start.mjs";
import * as harness from "../src/harness.mjs";
import { fixture, open, ok, FULL_AI, withVerdicts, uiPassed, fakeSf, fakeJev, src, files, pick, repo, O, SHA, fakeRefs, fakeGitHub, scratchSkill, webp, meta, provisionSf, deliveryIo, BOT, wfSteps, pipeSources, st_, read, TREE } from "./helpers.mjs";

test("UI evidence is behind UI_EVIDENCE: off unless exactly true, and the workflows obey it", () => {
  assert.equal(evidence.evidenceOn({}), false);
  assert.equal(evidence.evidenceOn({ PIPELINE_VARS: JSON.stringify({ UI_EVIDENCE: "false" }) }), false);
  assert.equal(evidence.evidenceOn({ PIPELINE_VARS: JSON.stringify({ UI_EVIDENCE: "true" }) }), true);
  assert.equal(evidence.evidenceOn({ UI_EVIDENCE: "TRUE" }), true);
  const wf = readFileSync(new URL("../../.github/workflows/ui-test.yml", import.meta.url), "utf8");
  // off: the spec gets no EVIDENCE_DIR (evidence() does nothing) and nothing is published; the spec step has no token
  assert.match(wf, /GH_TOKEN: ""\n\s+EVIDENCE_DIR: \$\{\{ vars\.UI_EVIDENCE == 'true' && 'ui-out\/evidence' \|\| '' \}\}/);
  assert.match(wf, /id: evidence\n\s+if: env\.OUTCOME == 'success' && vars\.UI_EVIDENCE == 'true'/);
  assert.match(wf, /continue-on-error: true   # no screenshots never fails the verdict/);
  assert.match(readFileSync(new URL("../../e2e/support/evidence.ts", import.meta.url), "utf8"), /const dir = process\.env\.EVIDENCE_DIR;\n\s+if \(!dir\) return;/);
  assert.match(readFileSync(new URL("../../.github/workflows/reconcile.yml", import.meta.url), "utf8"), /pipe\.mjs evidence squash/);
});

test("UI evidence: only small WebP shots with safe names are published, at most 6, never a URL", () => {
  const files = [
    { name: "01-ac1-customer-since.webp", data: webp() }, { name: "01-ac1-customer-since.json", data: meta({ caption: "AC1: *Customer* [Since] @org/everyone see https://evil.example/x #12", path: "/lightning/r/Account/001xx/view" }) },
    { name: "02-png.webp", data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]) },
    { name: "03-big.webp", data: webp(130) },
    { name: "../x.webp", data: webp() },
    { name: "04-url.webp", data: webp() }, { name: "04-url.json", data: meta({ caption: "x", path: "https://evil.example/secur/frontdoor.jsp?sid=1" }) },
    ...[5, 6, 7, 8, 9].map((n) => ({ name: `0${n}-more.webp`, data: webp() })),
  ];
  const { shots, rejected } = evidence.check(files);
  assert.deepEqual(shots.map((s) => s.name), ["01-ac1-customer-since.webp", "04-url.webp", "05-more.webp", "06-more.webp", "07-more.webp", "08-more.webp"]);
  assert.equal(shots[0].path, "/lightning/r/Account/001xx/view");
  assert.equal(shots[1].path, null, "a URL with a query is never kept");
  assert.ok(rejected.some((r) => /02-png\.webp: not a WebP/.test(r)));
  assert.ok(rejected.some((r) => /03-big\.webp: 130 KB is over 120 KB/.test(r)));
  assert.ok(rejected.some((r) => /\.\.\/x\.webp: not an evidence file name/.test(r)));
  assert.ok(rejected.some((r) => /09-more\.webp: more than 6/.test(r)));

  const body = evidence.evidenceComment({ key: "84", pr: 90, sha: "abcdef1234", shots, orgUrl: "https://x-dev-ed.scratch.my.salesforce.com", repoUrl: "https://github.com/o/r" });
  assert.ok(body.startsWith(evidence.EVIDENCE_MARK));
  // the caption is plain words: no markdown, no @mention, no #reference, no live link (the spec that wrote it is untrusted)
  assert.equal(shots[0].caption, "AC1: Customer Since org/everyone see https:\u200b//evil.example/x 12");
  assert.equal(evidence.safeCaption("go to www.evil.example"), "go to www\u200b.evil.example");
  assert.match(body, /\*\*AC1: Customer Since org\/everyone see https:\u200b\/\/evil\.example\/x 12\*\* · \[open in the scratch org\]\(https:\/\/x-dev-ed\.scratch\.my\.salesforce\.com\/lightning\/r\/Account\/001xx\/view\)/);
  assert.match(body, /!\[.*\]\(https:\/\/github\.com\/o\/r\/blob\/evidence\/story-84\/abcdef1\/01-ac1-customer-since\.webp\?raw=true\)/);
  assert.match(body, /Send me a login to this story's scratch org/);
  assert.doesNotMatch(body, /sid=|frontdoor|@org|https:\/\/evil|#12/);
  assert.ok(body.includes(`### ${evidence.EVIDENCE_TITLE}: 6 screenshots`), "Jira finds the comment by this distinctive title, never by plain \"UI evidence\"");
  assert.ok(evidence.removedComment().includes(evidence.EVIDENCE_TITLE) && /screenshots were deleted/.test(evidence.removedComment()));
  assert.doesNotMatch(evidence.evidenceComment({ key: "84", pr: 90, sha: "abc", shots, orgUrl: "https://evil.example", repoUrl: "https://github.com/o/r" }), /open in the scratch org|\]\(https:\/\/evil/);
  assert.throws(() => evidence.folder("../84"), /not a story key/);
});

test("UI evidence storage: one commit replaces the story's folder (retrying a moved branch); squash keeps open stories only, atomically", async () => {
  const calls = [];
  let patches = 0;
  let graphql = {};
  let moved = false;
  const api = (m, path, body) => {
    calls.push([m, path, body]);
    if (m === "POST" && path.endsWith("/git/blobs")) return { sha: `blob${calls.length}` };
    if (m === "GET" && path.endsWith("/git/ref/heads/evidence")) return { object: { sha: moved ? "head2" : "head1" } };
    if (m === "GET" && path.includes("/git/commits/")) return { tree: { sha: "tree1" }, parents: [{ sha: "p" }] };
    if (m === "GET" && path.includes("/git/trees/")) return { tree: [{ type: "blob", path: "story-84/old0000/01-a.webp", sha: "o1", mode: "100644" }, { type: "blob", path: "story-7/aaa/01-b.webp", sha: "o2", mode: "100644" }] };
    if (m === "POST" && path.endsWith("/git/trees")) return { sha: "newtree" };
    if (m === "POST" && path.endsWith("/git/commits")) return { sha: "newcommit" };
    if (m === "PATCH") return ++patches === 1 && !body.force ? { status: 422, message: "not a fast forward" } : {};
    if (m === "GET" && path === "repos/o/r") return { node_id: "R_1" };
    if (m === "POST" && path === "graphql") return graphql;
    return {};
  };
  const shots = [{ name: "01-a.webp", data: webp(1) }];
  assert.equal(evidence.store({ api, repo: "o/r", key: "84", sha: "abcdef1234", shots }), "newcommit");
  const tree = calls.filter(([m, p]) => m === "POST" && p.endsWith("/git/trees")).pop()[2];
  assert.deepEqual(tree.tree.map((e) => [e.path, e.sha]), [["story-84/abcdef1/01-a.webp", "blob1"], ["story-84/old0000/01-a.webp", null]], "the old head's shot is deleted, other stories untouched");
  assert.equal(calls.filter(([m]) => m === "PATCH").length, 2, "a moved branch is retried");

  calls.length = 0;
  const r = await evidence.squash({ api, repo: "o/r", isOpen: async (k) => k === "84" });
  assert.deepEqual(r, { kept: 1, removed: ["7"] });
  const squashTree = calls.find(([m, p]) => m === "POST" && p.endsWith("/git/trees"))[2];
  assert.deepEqual(squashTree.tree.map((e) => e.path), ["story-84/old0000/01-a.webp"]);
  assert.deepEqual(calls.find(([m, p]) => m === "POST" && p.endsWith("/git/commits"))[2].parents, [], "one parentless commit: the branch never grows");
  assert.equal(calls.some(([m]) => m === "PATCH"), false, "never a blind forced PATCH");
  const swap = calls.find(([m, p]) => m === "POST" && p === "graphql")[2];
  assert.match(swap.query, /updateRefs/);
  assert.deepEqual(swap.variables, { id: "R_1", u: [{ name: "refs/heads/evidence", beforeOid: "head1", afterOid: "newcommit", force: true }] }, "moves only if the branch is still where it was read");
  // GitHub answers a stale beforeOid with a generic error (seen live), and gh exits non-zero: the api seam's { status }
  graphql = { status: 500, message: "Something went wrong while executing your query" };
  const realApi = api;
  let reads = 0;
  const racing = (m, path, body) => { if (m === "GET" && path.endsWith("/git/ref/heads/evidence") && ++reads > 1) moved = true; return realApi(m, path, body); };
  assert.equal(await evidence.squash({ api: racing, repo: "o/r", isOpen: async (k) => k === "84" }), null, "a publish landed meanwhile: nothing lost, the next sweep squashes");
  moved = false;
  await assert.rejects(evidence.squash({ api, repo: "o/r", isOpen: async (k) => k === "84" }), /could not squash evidence/, "an error with the branch unmoved is reported");
});

test("evidence() in a real browser: boxed small WebP the trusted check accepts; no-match skips fast; retries and shared captions", async (t) => {
  const { chromium } = await import("@playwright/test");
  if (!existsSync(chromium.executablePath())) return t.skip("no Playwright Chromium here (CI installs it in static checks)");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  try {
    execFileSync("npx", ["playwright", "test", "-c", "pipeline/test/evidence/playwright.config.ts"], { env: { ...process.env, EVIDENCE_DIR: dir }, stdio: "pipe", cwd: new URL("../../", import.meta.url).pathname });
    const files = readdirSync(dir).map((name) => ({ name, data: readFileSync(join(dir, name)) }));
    const { shots, rejected } = evidence.check(files);
    assert.deepEqual(rejected, [], "everything the helper writes passes the trusted check");
    const captions = shots.map((s) => s.caption).sort();
    assert.deepEqual(captions, ["AC1: Customer Since is set", "AC3: many values", "AC4: same caption", "AC4: same caption", "AC5: the passing retry"]);
    for (const s of shots) assert.ok(s.data.length <= 100 * 1024, `${s.name} is ${s.data.length} bytes`);
    assert.ok(!files.some((f) => /only-in-the-failed-attempt/.test(f.name)), "a failed attempt's shot is not evidence");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("round 1: a weak UI spec fails; evidence never boxes the page header; closed stories' comments are rewritten before their screenshots go", async () => {
  assert.deepEqual(evidence.specProblems("await expect(page.getByRole('heading').first()).toBeVisible();").length, 2);
  assert.deepEqual(evidence.specProblems(readFileSync(new URL("fixtures/specs/record-spec.ts", import.meta.url), "utf8")), []);
  // story #166: Claude's rewrite polled for "No data" to go, carried on regardless, and asserted isVisible() with toBe(true)
  const weak = "let n = await d.getByText('No data').count();\nwhile (n > 0 && i < 30) { await page.waitForTimeout(3000); n = await d.getByText('No data').count(); }\nconst v = await c.isVisible();\nexpect(v).toBe(true);";
  assert.equal(evidence.specProblems(weak).length, 2);
  // not weak: isVisible() for control flow, a fixed retry followed by an assertion, a poll asserted afterwards
  assert.deepEqual(evidence.specProblems("await expect(x).toHaveText('A');\nif (await dialog.isVisible()) await dialog.click();"), []);
  assert.deepEqual(evidence.specProblems("for (let i = 0; i < 3; i++) { await r.click(); await page.waitForTimeout(2000); }\nawait expect(d.getByText('No data')).toHaveCount(0);"), []);
  assert.deepEqual(evidence.specProblems("let n = 1;\nwhile (n > 0 && i < 30) { await page.waitForTimeout(3000); n = await d.count(); }\nexpect(n).toBe(0);"), []);
  assert.deepEqual(evidence.specProblems(readFileSync(new URL("fixtures/specs/dashboard-spec.ts", import.meta.url), "utf8")), []);
  assert.match(readFileSync(new URL("../../e2e/support/evidence.ts", import.meta.url), "utf8"), /its locator points into the page header/);
  const ui = readFileSync(new URL("../../.github/workflows/ui-test.yml", import.meta.url), "utf8");
  assert.match(ui, /pipe\.mjs ui spec-check --file/);
  assert.match(ui, /finish ui-test [^\n]*--weak "\$WEAK"/, "a weak spec reaches the verdict");
  assert.match((await import("../src/finish.mjs")).verdictOf("ui-test", { outcome: "success", weak: "no assertion" }).description, /the spec passed but checks too little: no assertion/);
  const api = (m, path) => path.endsWith("/git/ref/heads/evidence") ? { object: { sha: "h" } } : path.includes("/git/commits/") ? { tree: { sha: "t" } }
    : { tree: [{ type: "blob", path: "story-143/abc/01-a.webp" }, { type: "blob", path: "story-150/def/01-b.webp" }, { type: "blob", path: "README.md" }] };
  assert.deepEqual(evidence.storiesOnBranch({ api, repo: "o/r" }), ["143", "150"]);
  assert.match(readFileSync(new URL("../../.github/workflows/reconcile.yml", import.meta.url), "utf8"), /issues: write/);
  assert.doesNotMatch(evidence.removedComment(), /open in the scratch org|!\[/);
});
