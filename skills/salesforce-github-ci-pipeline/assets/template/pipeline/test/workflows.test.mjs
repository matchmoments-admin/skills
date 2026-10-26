// Pipeline tests: workflows (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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

test("metrics: DORA from releases and PR routes, AI first-pass rate from fix commits", () => {
  const pr = (number, headRefName, baseRefName, createdAt, mergedAt, labels = []) => ({ number, headRefName, baseRefName, createdAt, mergedAt, labels: labels.map((name) => ({ name })) });
  const s = summarize({
    days: 14,
    prs: [
      pr(1, "issue-1", "release/2026-w43", "2026-10-01T00:00:00Z", "2026-10-01T04:00:00Z", ["review:pass"]),
      pr(2, "issue-2", "release/2026-w43", "2026-10-01T00:00:00Z", "2026-10-01T10:00:00Z", ["review:pass"]),
      pr(3, "issue-3", "main", "2026-10-02T00:00:00Z", "2026-10-02T02:00:00Z"),          // hotfix
      pr(4, "release/2026-w43", "main", "2026-10-03T00:00:00Z", "2026-10-03T01:00:00Z"),  // release: not a story
      pr(5, "issue-5", "release/2026-w43", "2026-10-03T00:00:00Z", null),                 // still open
    ],
    releases: [{ tagName: "v1" }, { tagName: "v2" }],
    runs: [
      { name: "ci", conclusion: "success", run_started_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:10:00Z" },
      { name: "ci", conclusion: "failure", run_started_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:20:00Z" },
      { name: "ci", conclusion: "skipped", run_started_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:01Z" },
      // one row per workflow file, whatever the run is called
      { name: "ai-fix PR #176", path: ".github/workflows/ai-fix.yml", conclusion: "success", run_started_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:02:00Z" },
      { name: "ai-fix (label on PR #185)", path: ".github/workflows/ai-fix.yml", conclusion: "success", run_started_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:04:00Z" },
    ],
    fixCommits: { 2: 1 },
  });
  assert.deepEqual(s.counts, { features: 2, hotfixes: 1, releases: 2 });
  assert.equal(s.dora.deploymentsPerWeek, 1);
  assert.equal(s.dora.leadTimeHours, 7);
  assert.equal(s.dora.changeFailureRate, 50);
  assert.equal(s.dora.timeToRestoreHours, 2);
  assert.equal(s.ai.passedFirstReview, 50);
  assert.deepEqual(s.pipeline.ci, { runs: 2, successRate: 50, medianMinutes: 15, p90Minutes: 20 });
  assert.match(toMarkdown(s), /\| ci \| 2 \| 50% \| 15 \|/);
  assert.equal(s.pipeline["ai-fix"].runs, 2);
});

test("every workflow that runs the Claude agent allows the pipeline's own bots (commands and auto-chain act as the App)", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../../.github/workflows/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
    const y = readFileSync(new URL(f, dir), "utf8");
    const agents = y.split("uses: ./.pipeline/.github/actions/claude-agent").length - 1;
    const allowed = (y.match(/allowed-bots: \$\{\{ vars\.PIPELINE_BOTS \}\}/g) || []).length;
    assert.equal(allowed, agents, `${f}: ${agents} agent step(s), ${allowed} with allowed-bots`);
  }
});

test("every agent reads the story with its context pack; CI runs the access check", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  for (const n of ["ai-plan", "ai-implement", "ai-review", "ai-fix", "ui-test"]) assert.match(wf(n), /tracker story "?\$[A-Z_]*KEY"? --pack/, n);
  assert.match(wf("ci"), /access check --base/);
  assert.match(wf("ai-implement"), /merge -q --no-edit "origin\/\$BASE"/);
});

test("shipping wiring: the gate passes the SHA and the validated tree; nothing queued is lost; UAT signs only what it runs", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  assert.match(wf("gate"), /start followups --after "\$AFTER" --pr "\$PR" --base "\$BASE" --sha "\$SHA" --job "\$JOB" --tree "\$TREE"/);
  assert.match(wf("gate"), /ship candidate --pr/);
  assert.doesNotMatch(wf("gate"), /refs\/pull\/\$\{\{ env.PR \}\}\/merge/);
  assert.match(wf("gate"), /ship renudge --base/);
  assert.match(wf("release"), /run-name: release \$\{\{ inputs.sha/);
  assert.match(wf("release"), /closeout run --tag "\$TAG" --sha "\$SHA"/);
  assert.match(wf("merged"), /--sha "\$MERGED_SHA"/);
  assert.match(wf("reconcile"), /ship watchdog/);
  assert.match(wf("reconcile"), /pipe\.mjs reconcile/);
  assert.doesNotMatch(wf("reconcile"), /SF_CI_|sf-auth/, "reconcile is GitHub only: no Salesforce key");
  assert.doesNotMatch(wf("scratch-janitor"), /ship watchdog|pipe\.mjs reconcile/, "the janitor keeps only what needs the Dev Hub");
  assert.match(readFileSync(new URL("../src/actions.mjs", import.meta.url), "utf8"), /standing\(host\.prFacts\(pr\.number\)\)\.uat/, "in UAT: Standing's reading, the card's too");
  assert.match(wf("uat-deploy"), /pipe\.mjs gate standing --pr "\$PR" --result uat/, "is UAT already on this commit: Standing, not the statuses");
  assert.match(wf("commands"), /pipe.mjs act /);
});

test("parking jobs skip their work when parked, and lane-wake re-runs them with the least permissions", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  for (const [n, kinds] of [["ai-fix", ["fix"]], ["ui-test", ["write", "run"]]]) {
    const y = wf(n);
    for (const k of kinds) assert.match(y, new RegExp(`--park ${k}\\b`), `${n} parks its ${k} job`);
    assert.match(y, /uses: \.\/\.pipeline\/\.github\/actions\/claude-agent\n\s+if: steps\.lane\.outputs\.parked != 'true'/, `${n}: no agent while parked`);
  }
  assert.match(wf("ui-test"), /needs\.write\.outputs\.parked != 'true'/, "the spec run waits for the writer's re-run");
  const w = wf("lane-wake");
  assert.match(w, /types: \[lane-freed\]/);
  assert.match(w, /permissions:\n  actions: write .*\n  contents: write .*\n(?!  \w)/, "only actions and contents");
  assert.match(w, /pipe.mjs lane wake\n/, "no target from the event: every lane is scanned");
  for (const n of ["ci", "staging-deploy"]) assert.doesNotMatch(wf(n), /--park/, `${n} is a required check: it waits, never parks`);
});

test("every job that uses a story or staging org holds its lane, and releases it whatever happens", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  for (const n of ["issue-start", "ai-implement", "ai-fix", "ui-test", "ci", "staging-deploy"]) {
    const y = wf(n);
    const steps = y.split(/\n\s+- (?=name:|uses:|run:|id:|if:)/);
    const takes = steps.filter((x) => /lane acquire/.test(x)).length, gives = steps.filter((x) => /lane release/.test(x));
    assert.ok(takes > 0, `${n} takes a lane`);
    assert.equal(gives.length, takes, `${n} releases every lane it takes`);
    for (const g of gives) assert.match(g, /if: always\(\)/, `${n} releases whatever happens`);
    assert.doesNotMatch(y, /group: (ai-pr-|org-staging|org-\$\{\{)/, `${n} has no GitHub concurrency group on an org`);
  }
});

test("every workflow passes every repository variable in one line, and lists no switch by hand", () => {
  for (const f of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((n) => n.endsWith(".yml"))) {
    const y = readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8");
    assert.match(y, /^  PIPELINE_VARS: \$\{\{ toJSON\(vars\) \}\}/m, f);
    assert.doesNotMatch(y, /^\s+(AI_[A-Z_]+|PIPELINE_BOTS|UAT_ENABLED|BOARD_PROJECT|PROD_TEST_LEVEL): \$\{\{ vars\./m, f);
  }
});

test("fix rounds are this PR's earlier completed ai-fix runs, whatever the commits were called", () => {
  const runs = [{ id: 1, display_title: "ai-fix PR #90", status: "completed", conclusion: "success" }, { id: 2, display_title: "ai-fix PR #90", status: "completed", conclusion: "cancelled" },
    { id: 3, display_title: "ai-fix PR #91", status: "completed", conclusion: "success" }, { id: 4, display_title: "ai-fix PR #90", status: "in_progress" }, { id: 5, display_title: "ai-fix PR #90", status: "completed", conclusion: "failure" }];
  assert.equal(verdict.fixRunsFor(runs, 90, 5), 1);
  assert.equal(verdict.fixRunsFor(runs, 90, 4), 2);
  const wf = readFileSync(new URL("../../.github/workflows/ai-fix.yml", import.meta.url), "utf8");
  assert.match(wf, /pipe\.mjs start fix --pr/, "the route job counts the rounds before the fix job starts");
  assert.match(readFileSync(new URL("../../.github/actions/claude-agent/action.yml", import.meta.url), "utf8"), /event agent --role/);
});

test("tick boxes: the card-actions workflow acts only on a person's edit of a card, through the same pipe act as commands", () => {
  const y = readFileSync(new URL("../../.github/workflows/card-actions.yml", import.meta.url), "utf8");
  assert.match(y, /github.event.sender.type != 'Bot'/);
  assert.match(y, /contains\(github.event.comment.body, '<!-- pipeline:'\)/);
  assert.match(y, /pipe.mjs act --number .* --before .* --after/);
  assert.match(readFileSync(new URL("../../.github/workflows/commands.yml", import.meta.url), "utf8"), /pipe.mjs act --number .* --command "\$BODY"/);
});

test("agent jobs cannot post verdicts or start workflows; follow-ups run on a fresh runner; no endless fix loop", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  const job = (y, name) => y.split(/\n  (?=[a-z-]+:\n)/).find((b) => b.startsWith(`${name}:`)) || "";
  // every job that runs an agent, in every workflow (ai-review's inherited the workflow's write scopes until 14 Oct)
  const ls = readdirSync, yaml = createRequire(import.meta.url)("js-yaml");
  const agentJobs = [];
  for (const f of ls(new URL("../../.github/workflows/", import.meta.url)).filter((x) => x.endsWith(".yml"))) {
    const doc = yaml.load(wf(f.replace(/\.yml$/, "")));
    for (const [name, j] of Object.entries(doc.jobs || {})) if ((j.steps || []).some((st) => /claude-agent/.test(st.uses || ""))) agentJobs.push([f, name, j]);
  }
  assert.ok(agentJobs.length >= 6, `found ${agentJobs.map(([f, n]) => `${f}/${n}`).join(", ")}`);
  for (const [f, name, j] of agentJobs) {
    assert.ok(j.permissions && typeof j.permissions === "object", `${f}/${name} sets its own permissions`);
    assert.ok(j.permissions.statuses !== "write" && j.permissions.actions !== "write", `${f}/${name} cannot post verdicts or start workflows`);
    assert.doesNotMatch(JSON.stringify(j.steps), /gh workflow run/, `${f}/${name} dispatches nothing`);
  }
  assert.match(job(wf("ai-fix"), "follow-up"), /the fix pushed nothing: no new review/);
  assert.match(job(wf("ai-fix"), "route"), /pipe\.mjs start fix --pr/, "the round limit is decided before the fix job starts");
});

test("every workflow that refreshes a card can read checks (the card is built from the gate's facts)", () => {
  for (const f of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((n) => n.endsWith(".yml"))) {
    const y = readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8");
    if (!/pipe\.mjs (pr card|story card|act |gate nudge|gate evaluate)/.test(y)) continue;
    assert.match(y, /checks: (read|write)/, `${f} refreshes a card without checks permission`);   // workflow or job level
  }
});

test("labels follow conventions.mjs on main; specs read the open sprint like /plan", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  assert.match(wf("labels"), /paths: \["pipeline\/src\/conventions.mjs"\]/);
  assert.match(wf("ai-spec"), /git checkout -q "origin\/\$REL"/);
});

test("pipe act parses the workflows' own arguments: who acted and that it is a PR (a value flag must not swallow them)", async () => {
  const { execFileSync } = await import("node:child_process");
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  for (const n of ["commands", "card-actions"]) assert.match(wf(n), /'--is-pr'/, n);
  // the argument parser is the one in pipe.mjs: run a dry parse through a tiny shim of the same VALUE_FLAGS rule
  const src = pipeSources();
  const valueFlags = new Set(JSON.parse(`[${src.match(/const VALUE_FLAGS = new Set\(\[([\s\S]*?)\]\)/)[1].replace(/\s+/g, " ")}]`));
  const switches = [...new Set([...src.matchAll(/has\("([a-z-]+)"\)/g)].map((m) => m[1]))];
  assert.deepEqual(switches.filter((s) => valueFlags.has(s)), [], "a switch that is also a value flag swallows the next argument");
  const argv = ["--number", "110", "--is-pr", "--by", "alex-admin", "--by-type", "User", "--command", "/uat-pass"];
  const flags = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) { const n = argv[i].slice(2); flags[n] = valueFlags.has(n) ? argv[++i] : true; }
  assert.deepEqual([flags.number, flags["is-pr"], flags.by, flags["by-type"], flags.command], ["110", true, "alex-admin", "User", "/uat-pass"]);
});

test("an agent run that finished successfully past its turn cap counts as success (story #143: 69 of 60, PR opened)", () => {
  const a = readFileSync(new URL("../../.github/actions/claude-agent/action.yml", import.meta.url), "utf8");
  assert.match(a, /id: claude\n\s+uses: anthropics\/claude-code-action@v1\n\s+continue-on-error: true/);
  assert.match(a, /if \[ "\$R" = "success false" \]; then echo "::warning::/);
  assert.match(a, /\\\(\.is_error \| tostring\)/, "false must print as false, not vanish under //");
  assert.equal(roles.budget("implement", "").turns, 100);
  // the provider decides the login: one secret or cloud identity per provider, never two (config/ai-models.json)
  assert.match(a, /claude_code_oauth_token: \$\{\{ steps\.rules\.outputs\.auth == 'oauth' && inputs\.oauth-token \|\| '' \}\}/);
  assert.match(a, /use_bedrock: \$\{\{ steps\.rules\.outputs\.auth == 'aws-oidc' \}\}/);
  assert.match(a, /if: steps\.rules\.outputs\.auth == 'aws-oidc'\n\s+uses: aws-actions\/configure-aws-credentials@v4/);
  assert.match(a, /if: steps\.rules\.outputs\.auth == 'gcp-wif'\n\s+uses: google-github-actions\/auth@v2/);
  assert.match(a, /--provider "\$PROVIDER"/, "the event log records the provider");
  for (const f of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((x) => x.endsWith(".yml"))) {
    const y = readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8");
    if (!y.includes("actions/claude-agent")) continue;
    assert.doesNotMatch(y, /model: \$\{\{ vars\.AI_MODEL \}\}/, `${f}: AI_MODEL arrives with PIPELINE_VARS`);
    assert.match(y, /api-key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/, `${f}: the api-key and gateway providers' key`);
  }
  assert.match(readFileSync(new URL("../../.github/workflows/ai-review.yml", import.meta.url), "utf8"), /changed-files: \$\{\{ runner\.temp \}\}\/changed\.txt/, "a declarative-only review may use the cheaper model");
  assert.match(a, /--max-turns \$\{\{ steps.rules.outputs.turns \}\}/, "the role's budget from roles.mjs");
  for (const f of readdirSync(new URL("../../.github/workflows/", import.meta.url))) assert.doesNotMatch(readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8"), /max-turns:/, `${f}: turn caps live in roles.mjs`);
  const plan = plans.storyFile({ key: "143", title: "Story: Regional reporting", url: "u", body: "b" }, { plan: null, answers: [] });
  assert.match(plan, /^# Story 143: Regional reporting\n/, "no doubled 'Story:'");
});

test("ai-fix's job can read Actions runs (the round limit and the UI log need actions: read; job permissions replace the workflow's)", () => {
  const wf = readFileSync(new URL("../../.github/workflows/ai-fix.yml", import.meta.url), "utf8");
  const fixJob = wf.slice(wf.indexOf("\n  fix:"), wf.indexOf("\n  follow-up:"));
  assert.match(fixJob, /permissions:[\s\S]*?actions: read/);
  assert.doesNotMatch(fixJob, /actions: write/, "the agent's job never gets to start workflows");
});

test("reports, report types and dashboards are UI-facing; a review the agent only wrote is still posted (PR #144)", () => {
  assert.deepEqual(names.uiFacing(["force-app/main/default/reports/Regional_Reporting/Accounts_by_Sales_Region.report-meta.xml",
    "force-app/main/default/dashboards/Regional_Reporting/Regional_Sales.dashboard-meta.xml", "force-app/main/default/reportTypes/Opps.reportType-meta.xml",
    "force-app/main/default/classes/X.cls"]).length, 3);
  const wf = readFileSync(new URL("../../.github/workflows/ai-review.yml", import.meta.url), "utf8");
  assert.match(wf, /verdict review "\$PR" --since "\$SINCE"\)" = none \] \|\| exit 0/);
  assert.match(wf, /GH_TOKEN: \$\{\{ steps\.id\.outputs\.token \}\}   # the pipeline's identity/);
  assert.match(wf, /gh pr comment "\$PR" --body-file "\$F"/);
  // the reviewer writes its summary to a file and never posts through the shell (10 quoting failures on PR #144)
  assert.match(wf, /allowed-tools: "Read,Glob,Grep,Write,mcp__github_inline_comment__create_inline_comment,/);
  assert.doesNotMatch(wf, /Bash\(gh pr comment/);
  assert.match(verdict.instructions("review"), /Do not post the summary yourself: write it with the Write tool/);
});

test("review round 3: a spec revision keeps the spec and its story link; screenshots are found wherever the artifact put them; lanes can see runs", () => {
  const spec = specs.specComment("### Problem\nslow\n### User stories\n1. As a manager, I want x\n");
  const pending = specs.pendingComment(spec, { state: "running", what: "Claude is revising the spec" });
  assert.match(pending, /^<!-- pipeline:spec -->\n⏳ \*\*Now:\*\* Claude is revising the spec\n\n### Spec/);
  assert.match(pending, /### Problem\nslow/, "the current spec stays readable while Claude revises it");
  const failed = specs.pendingComment(pending, { state: "failed", what: "Claude could not write the spec" });
  assert.equal((failed.match(/\*\*(Now|Failed):\*\*/g) || []).length, 1, "one status line, the spec intact");
  const ctx = plans.planContext([{ author: "app/pipeline", body: failed, created: "1" }], { mark: specs.SPEC_MARK, title: specs.SPEC_TITLE });
  assert.match(ctx.plan, /^### Spec\n\n### Problem\nslow/, "agents read the spec, not the status line");
  assert.match(specs.pendingComment(null, { state: "running", what: "x" }), /plan-pending/, "a first spec's placeholder is never read as a spec");

  const made = specs.specComment("### User stories\n1. y\n", { story: 143 });
  assert.equal(specs.storyOfSpec(made), 143);
  assert.doesNotMatch(made, /act:story/, "a revision never offers a second story");
  assert.equal(specs.storyOfSpec(specs.pendingComment(made, { state: "running", what: "x" })), 143, "the link survives the pending status");
  assert.doesNotMatch(plans.planContext([{ author: "app/pipeline", body: made, created: "1" }], { mark: specs.SPEC_MARK, title: specs.SPEC_TITLE }).plan, /Story:|story:143/);

  assert.equal(verdict.ranAgent(undefined), true, "an API error counts as a round: the limit holds");
  assert.equal(names.uiFacing(["force-app/main/default/objects/Account/recordTypes/Customer.recordType-meta.xml", "force-app/main/default/objects/Account/webLinks/Map.webLink-meta.xml"]).length, 2);

  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  assert.match(wf("ui-test"), /D=\$\(find art -type d -name evidence/);
  assert.match(wf("commands"), /group: card-\$\{\{ github\.event\.issue\.number \}\}/);
  assert.match(wf("ai-review"), /case "\$V" in pass\|changes\|not-needed\) ;; \*\) echo "::warning::no verdict"/, "no verdict: finish posts it as an error");
  // every job that waits in an org lane can see whether the holder's run ended (or a dead holder blocks until the TTL)
  for (const f of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((x) => x.endsWith(".yml"))) {
    const y = wf(f.replace(/\.yml$/, ""));
    const workflowLevel = (y.match(/\npermissions:\n((?:  .*\n)+)/) || [])[1] || "";
    for (const job of y.split(/\n  (?=[a-z-]+:\n)/).slice(1)) {
      if (!/lane acquire/.test(job)) continue;
      const own = /\n    permissions:/.test(job) ? job : workflowLevel;   // job-level permissions replace the workflow's
      assert.match(own, /actions: (read|write)/, `${f}: a job that runs lane acquire needs actions: read`);
    }
  }
});

test("the reviewer's rules come from main (a PR cannot soften its own review)", () => {
  const wf = readFileSync(new URL("../../.github/workflows/ai-review.yml", import.meta.url), "utf8");
  for (const f of ["REVIEW\\.md", "CLAUDE\\.md", "docs\\/agents"]) assert.match(wf, new RegExp(`path: \\.pipeline, sparse-checkout: "[^"]*${f}`));
  assert.match(wf, /following \.pipeline\/REVIEW\.md, \.pipeline\/CLAUDE\.md and \.pipeline\/docs\/agents\/salesforce\.md/);
});

test("the UI tester's screenshots must show the criterion met: data first, the element that shows it (story #143 showed an empty report)", () => {
  const wf = readFileSync(new URL("../../.github/workflows/ui-test.yml", import.meta.url), "utf8");
  assert.match(wf, /A screenshot is evidence only if it shows the criterion met: create the records the criterion needs first/);
  assert.match(wf, /never the app name or an empty page/);
});

test("UI tests log in as a persona after the Dev Hub is logged out (story #166: `sf org display` failed there)", () => {
  const wf = readFileSync(new URL("../../.github/workflows/ui-test.yml", import.meta.url), "utf8");
  assert.equal((wf.match(/SCRATCH_ORG_ID=.*SCRATCH_INSTANCE_URL=/g) || []).length, 2, "both jobs export the org's id and URL");
  assert.ok(wf.indexOf("SCRATCH_INSTANCE_URL") < wf.indexOf("sf org logout -o devhub"), "before production access is dropped");
  assert.match(readFileSync(new URL("../../e2e/support/login.ts", import.meta.url), "utf8"), /process\.env\.SCRATCH_ORG_ID && process\.env\.SCRATCH_INSTANCE_URL/);
  // story #166: a "Log in as" that did not take left the admin's view, and the rep's no-access test saw the dashboard
  assert.match(readFileSync(new URL("../../e2e/support/login.ts", import.meta.url), "utf8"), /still the admin after "Log in as"/);
});

test("harness overlay: every agent and spec job runs main's rules and harness, after the branch checkout, hidden from git (#180 #181 #184 #186)", async () => {
  for (const [file, job, role] of [["ai-implement", "implement", "implement"], ["ai-fix", "fix", "fix"], ["ui-test", "write", "ui-test"], ["ui-test", "run", "ui-test"], ["staging-deploy", "staging", "staging"]]) {
    const st = await wfSteps(file, job);
    const at = st.findIndex((x) => x.includes(`harness overlay ${role}`));
    assert.ok(at > 0, `${file}/${job} lays main's copy over the checkout`);
    const identity = st.findIndex((x) => x.includes("pipeline-identity"));
    if (identity >= 0) assert.ok(identity < at, `${file}/${job}: after the branch checkout (a re-checkout or merge would undo it)`);
    const agent = st.findIndex((x) => x.includes("claude-agent")), spec = st.findIndex((x) => /playwright test|actions\/playwright/.test(x));
    if (agent >= 0) assert.ok(at < agent, `${file}/${job}: before the agent`);
    if (spec >= 0) assert.ok(at < spec, `${file}/${job}: before the specs run`);
    assert.ok(!st.some((x) => /cp -R (\.\.\/)?\.pipeline\/(e2e|docs)/.test(x)), `${file}/${job}: no hand-written copy left`);
  }
  assert.deepEqual(harness.OVERLAYS.implement, ["CLAUDE.md", "REVIEW.md", "docs/agents"], "implement and fix follow main's CLAUDE.md too");
  assert.match(readFileSync(new URL("../../docs/agents/salesforce.md", import.meta.url), "utf8"), /frameLocator\("iframe"\)/);
  const sw = readFileSync(new URL("../../.github/workflows/staging-deploy.yml", import.meta.url), "utf8");
  assert.ok(sw.indexOf("SCRATCH_INSTANCE_URL") < sw.indexOf("sf org logout -o devhub"), "loginAs's org id and URL are read before the Dev Hub logout");
});

test("every workflow file parses as YAML (an unquoted ': ' in a step name broke three workflows on main)", async () => {
  const { createRequire } = await import("node:module");
  const yaml = createRequire(import.meta.url)("js-yaml");
  for (const f of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((n) => n.endsWith(".yml"))) {
    const doc = yaml.load(readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8"));
    assert.ok(doc && doc.jobs, `${f} parses and has jobs`);
  }
});

test("agent roles: one table for model and turns; the UI writer reads its failure screenshot and stops to report; triage sees CI (E9, E10)", async () => {
  assert.deepEqual(roles.budget("ui-test", ""), { model: "claude-sonnet-5-5", turns: 30, turnLimitOk: true, provider: "anthropic", arm: "" }, "the spec run judges the writer's work");
  assert.equal(roles.budget("implement", "").turnLimitOk, false);
  assert.equal(roles.budget("review", "claude-opus-5-5").model, "claude-opus-5-5");
  assert.throws(() => roles.modelFor("poet", "x"), /Unknown AI role/, "an unknown role fails even with an override");
  assert.equal(roles.ciResults([{ name: "Salesforce tests", conclusion: "failure", started_at: "1" }, { name: "Salesforce tests", conclusion: "success", started_at: "2", output: { title: "18 passed" } }]), "- Salesforce tests: success (18 passed)");
  assert.equal(roles.ciResults([]), "- (no CI results on this commit)");
  const ui = verdict.instructions("ui-test", { key: "9" });
  assert.match(ui, /test-failed-1\.png/);
  assert.match(ui, /Details tab/);
  assert.match(ui, /about 20 turns, or 3 failed runs, stop/);
  let sent = null;
  await triageUiFailure(async (input, q) => { sent = { input, q }; return { ok: true, answers: { kind: { choice: "test", confidence: 0.9 } } }; }, { log: "x", story: "s", ci: "- Salesforce tests: success" });
  assert.equal(sent.input.ci_results_on_this_commit, "- Salesforce tests: success");
  assert.match(sent.q.kind.instructions, /prefer test or flake/);
  assert.match(readFileSync(new URL("../../.github/workflows/ui-test.yml", import.meta.url), "utf8"), /triage ui --log .* --ci ci\.md/);
});

test("#227: CI's rule checks run main's pipeline code, so a rule fixed on main reaches every open story at its next push", () => {
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  for (const cmd of ["access check", "tests flow-gaps"]) assert.match(ci, new RegExp(`node \\.pipeline/pipeline/bin/pipe\\.mjs ${cmd}`), cmd);
  const statik = ci.split(/\n  apex:\n/)[0];
  assert.ok(statik.indexOf("Trusted pipeline code (main)") < statik.indexOf(".pipeline/pipeline/bin/pipe.mjs access check"), "main's code is checked out first");
});

test("Standing is the only reader of results: no other module or workflow reads the pipeline's statuses", () => {
  // a fifth reader with its own rule is how the UAT deadlock happened (actions.inUat, uat-deploy's jq, close-out and
  // nudge each read pipeline/* statuses their own way; the 15 Oct review). Writers (host.status, `pipe status set`) stay.
  const dir = new URL("../src/", import.meta.url);
  const srcs = [...readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => `src/${f}`), ...readdirSync(new URL("org/", dir)).map((f) => `src/org/${f}`), "bin/pipe.mjs", ...readdirSync(new URL("../bin/commands/", import.meta.url)).map((f) => `bin/commands/${f}`)];
  for (const f of srcs.filter((x) => x !== "src/gate.mjs" && x !== "src/github.mjs")) {
    const s = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(s, /\/statuses(\?|`)/, `${f} reads commit statuses: ask gate.standing (or gate.statusOn for one exact commit)`);
  }
  for (const f of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((x) => x.endsWith(".yml"))) {
    const runs = readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8").split("\n").filter((l) => !/^\s*#/.test(l));
    assert.ok(!runs.some((l) => /\/statuses/.test(l)), `${f} reads commit statuses: use pipe gate standing`);
  }
});

test("CI's deploy with deletions tolerates what is already gone (a re-run in the same org: #353)", () => {
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /DESTRUCTIVE="--post-destructive-changes delta\/destructiveChanges\/destructiveChanges\.xml --ignore-warnings"/);
});

