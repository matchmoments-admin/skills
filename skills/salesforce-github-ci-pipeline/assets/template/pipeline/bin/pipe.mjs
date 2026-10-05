#!/usr/bin/env node
// The pipeline's one entry point. Workflows call `node pipeline/bin/pipe.mjs <command> ...`.
//   context   [--key K] [--branch B] [--labels a,b]     names for a story / the open sprint, as KEY=value lines
//   labels    sync                                       create or update every label the pipeline uses
//   org       ensure|attach|remove <target> [--hotfix] · prepare <alias> · deploy <alias> [--manifest f]
//             temp <name> · sweep · limits               (target: story:<key> | sprint:<name> | <branch>)
//   gate      evaluate <pr> · nudge <pr> · checks [ref] · guard --base B --branch b · ui-needed --base B
//   status    set <context> <state> <sha> <description>
//   verdict   instructions <role> [--key K] · review <pr> · rounds --base <ref>
//   tracker   story <key> [--out file] · comment <key> <text> · open-sprint <sprint> · assign <key> --sprint S
//   verdict   review <pr> --since <iso time>  (only the pipeline's own comments from this run)
//   release   notes <sprint>
//   closeout  plan|run --tag <tag>
//   triage    ui --log file [--story file] · review --base B --head H   (Jev, behind AI_TRIAGE; falls back safely)
//   verdict   model <role>                              the model for an AI role (AI_MODEL overrides)
//   prod      validate [--sha S] [--level L] [--deletions-from REF]   check-only deploy, live; prints the job id
//   tests     run <alias> --base B [--sha S] [--all] [--min 75] [--out dir]   relevant (or all) tests, live check run
//   story     card <key> [--base B] [--tag T]                refresh the story card on the issue / ticket
//   metrics   [--days N] [--out file]                   DORA and pipeline telemetry as markdown
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { io } from "../src/io.mjs";
import * as names from "../src/conventions.mjs";
import * as gate from "../src/gate.mjs";
import * as verdict from "../src/verdict.mjs";
import * as closeout from "../src/closeout.mjs";
import * as metrics from "../src/metrics.mjs";
import { typesafeJev, triageUiFailure, triageReview } from "../src/jev.mjs";
import { storyCard, CARD_MARK, CARD_TITLE } from "../src/card.mjs";
import * as board from "../src/board.mjs";
import * as tests from "../src/tests.mjs";
import * as production from "../src/production.mjs";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orgRegistry } from "../src/org.mjs";
import { tracker as makeTracker } from "../src/tracker.mjs";

const VALUE_FLAGS = new Set(["key", "branch", "labels", "manifest", "base", "tag", "out", "since", "sprint", "head", "days", "log", "story", "tag", "sha", "min", "level", "deletions-from"]);
const [cmd, ...argv] = process.argv.slice(2);
const flags = {}, positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) { const n = a.slice(2); flags[n] = VALUE_FLAGS.has(n) ? argv[++i] : true; }
  else positional.push(a);
}
const sub = cmd === "context" ? "" : positional.shift();
const flag = (n, d = null) => (typeof flags[n] === "string" ? flags[n] : d);
const has = (n) => flags[n] === true;
const arg = (i) => positional[i];
const say = (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
const log = (s) => process.stderr.write(s + "\n");

/** Write step outputs when running in Actions (multi-line safe). */
function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [k, v] of Object.entries(values)) {
    const s = String(v ?? "");
    appendFileSync(process.env.GITHUB_OUTPUT, s.includes("\n") ? `${k}<<__PIPE__\n${s}\n__PIPE__\n` : `${k}=${s}\n`);
  }
}

/** The open sprint's release branch, from the GitHub API (works in any checkout, with or without git credentials). */
function openRelease() {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  const refs = io.gh(["api", `repos/${repo}/git/matching-refs/heads/release/`], { allowFail: true }) || [];
  return names.openRelease(refs.map((r) => r.ref.replace("refs/heads/", "origin/")));
}

const orgs = () => orgRegistry({ sf: io.sf, log });

/** Rebuild the story card from the same facts the gate uses, and put it on the story. Never fails the caller. */
async function refreshCard(key, { base = null, tag = null } = {}) {
  try {
    const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
    const repoUrl = `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repo}`;
    const branch = names.storyBranch(key);
    const pr = (io.gh(["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,state,title,baseRefName,headRefOid"]) || [])[0] || null;
    const ai = names.aiFeatures();
    const openRel = openRelease();
    const facts = pr ? gate.gather(pr.number, io, { openReleaseBranch: openRel, ai }) : null;
    const body = storyCard({
      key, repoUrl, branch, ai, pr, facts, decision: facts ? gate.evaluate(facts) : null,
      base: pr?.baseRefName || base || names.context({ key, openReleaseBranch: openRel }).BASE_BRANCH || "main",
      shipped: tag ? { tag, url: `${repoUrl}/releases/tag/${tag}` } : null,
    });
    await makeTracker(io).card(key, body, CARD_MARK, CARD_TITLE);
    await syncBoard(key, { repo, pr, facts, shipped: Boolean(tag) });
  } catch (e) { log(`::warning::story card for ${key} not updated: ${e.message}`); }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A GitHub check run on a commit, created once and updated as tests progress (the live view on the PR). */
function checkRun(sha, name) {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  if (!sha || !repo) return { update: () => {} };
  const call = (method, path, body) => io.run("gh", ["api", "-X", method, path, "--input", "-"], { input: JSON.stringify(body), quiet: true, allowFail: true });
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const made = call("POST", `repos/${repo}/check-runs`, { name, head_sha: sha, status: "in_progress", details_url: runUrl, output: { title: "Starting", summary: "Creating the test run" } });
  const id = made ? JSON.parse(made).id : null;
  return {
    update(output, conclusion) {
      if (!id) return;
      call("PATCH", `repos/${repo}/check-runs/${id}`, conclusion ? { status: "completed", conclusion, output } : { output });
    },
  };
}

/** Run the tests a change needs (or all), live: a "Salesforce tests" check on the commit and the story card. */
async function testsRun(alias) {
  const dirs = (process.env.SOURCE_DIRS || "force-app").split(/\s+/).filter(Boolean);
  const baseRef = flag("base", "origin/main");
  const list = (args) => (io.git(args) || "").split("\n").filter(Boolean);
  const changed = list(["diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...HEAD`, "--", ...dirs]);
  const deleted = list(["diff", "--name-only", "--diff-filter=D", `${baseRef}...HEAD`, "--", ...dirs]);
  const files = list(["ls-files", ...dirs]);
  const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const plan = tests.selectTests({ changed, deleted, files, read, mode: has("all") ? "all" : "relevant" });
  log(`tests: ${plan.mode} (${plan.why})${plan.mode === "relevant" ? `: ${[...plan.apex, ...plan.flows].join(", ")}` : ""}`);
  const check = checkRun(flag("sha"), "Salesforce tests");
  if (plan.mode === "none") { check.update({ title: "No Salesforce changes", summary: plan.why }, "success"); return say("no Salesforce changes"); }
  const classPath = (cls) => files.find((p) => p.endsWith(`/${cls}.cls`)) || null;
  const story = names.storyOf(process.env.REF || process.env.GITHUB_HEAD_REF || "");
  let polls = 0;
  const state = tests.runTests(io, {
    alias, plan, sleep: sleepSync, outDir: flag("out", "test-results"),
    onProgress: (st) => {
      check.update(tests.checkOutput(st, { plan, classPath }));
      log(`  apex ${st.apex.passed}/${st.apex.ran} passed (${st.apex.classesDone}/${st.apex.classes} classes)${st.phase === "flows" ? " · flow tests running" : ""}`);
      if (story && polls++ % 4 === 0) refreshCard(story).catch(() => {});
    },
  });
  const result = tests.verdict(state, { plan, changedCode: tests.changedCode(changed, files, read), min: Number(flag("min", "75")) });
  check.update(tests.checkOutput(state, { plan, result, classPath }), result.ok ? "success" : "failure");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, tests.summaryMarkdown(state, { plan, result }) + "\n");
  for (const f of [...state.apex.failures, ...state.flows.failures]) log(`  FAIL ${f.test}: ${f.message}`);
  if (!result.ok) throw new Error(`tests failed: ${result.reasons.join("; ")}`);
  return say(`tests passed: apex ${state.apex.passed}/${state.apex.ran}, flow ${state.flows.passed}/${state.flows.ran}`);
}

/** Check-only deploy of the current checkout to production, watched live; stdout is only the validation id. */
async function prodValidate() {
  const dirs = (process.env.SOURCE_DIRS || "force-app").split(/\s+/).filter(Boolean);
  const files = (io.git(["ls-files", ...dirs]) || "").split("\n").filter(Boolean);
  const allTests = files.filter((p) => p.endsWith(".cls")).filter((p) => /@istest/i.test(readFileSync(p, "utf8"))).map((p) => p.split("/").pop().replace(/\.cls$/, ""));
  // components removed since the last release go as post-destructive changes, so the quick deploy removes them too
  let source = dirs.flatMap((d) => ["-d", d]);
  const from = flag("deletions-from") || io.git(["describe", "--tags", "--abbrev=0", "HEAD"], { allowFail: true });
  if (from) {
    const out = mkdtempSync(join(tmpdir(), "delta-"));
    io.run("sf", ["sgd", "source", "delta", "--from", from, "--to", "HEAD", "--output-dir", out, ...dirs.flatMap((d) => ["--source-dir", d])], { quiet: true, allowFail: true });
    const destructive = join(out, "destructiveChanges", "destructiveChanges.xml");
    if (existsSync(destructive) && readFileSync(destructive, "utf8").includes("<members>")) {
      log(`deleting since ${from}: ${[...readFileSync(destructive, "utf8").matchAll(/<members>([^<]+)/g)].map((m) => m[1]).join(", ")}`);
      io.run("sf", ["project", "generate", "manifest", ...dirs.flatMap((d) => ["--source-dir", d]), "--output-dir", out, "--name", "full"], { quiet: true });
      source = ["--manifest", join(out, "full.xml"), "--post-destructive-changes", destructive];
    }
  }
  const level = flag("level", process.env.PROD_TEST_LEVEL || "RunRelevantTests");
  const instance = io.sf(["org", "display", "-o", "devhub"], { allowFail: true })?.instanceUrl;
  const deployStatusUrl = instance ? `${instance.replace(".my.salesforce.com", ".lightning.force.com")}/lightning/setup/DeployStatus/home` : undefined;
  const check = checkRun(flag("sha"), "Production validation");
  log(`production validation with ${level} (fallback: every test class)`);
  const p = production.validate(io, {
    source, level, allTests, sleep: sleepSync,
    onProgress: (st) => { check.update(production.progressOutput(st, { deployStatusUrl })); log(`  ${st.status}: components ${st.components.done}/${st.components.total}, tests ${st.tests.done}/${st.tests.total}`); },
  });
  const out = production.progressOutput(p, { deployStatusUrl, done: true });
  check.update(out, p.ok ? "success" : "failure");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Production validation: ${out.title}\n\n${out.summary}\n\n${out.text}\n`);
  if (!p.ok) {
    process.stderr.write(`Production validation failed (${p.status}):\n${out.text || "see Deployment Status"}\n`);
    process.exit(1);
  }
  return say(p.id);
}

/** Move the story on the delivery board, when BOARD_PROJECT is set and the App credentials are in this step. */
async function syncBoard(key, { repo, pr, facts, shipped }) {
  const { BOARD_PROJECT, PIPELINE_APP_ID, PIPELINE_APP_PRIVATE_KEY } = process.env;
  if (!BOARD_PROJECT || !PIPELINE_APP_ID || !PIPELINE_APP_PRIVATE_KEY || !/^\d+$/.test(String(key))) return;
  try {
    const token = await board.appToken({ appId: PIPELINE_APP_ID, privateKey: PIPELINE_APP_PRIVATE_KEY, repo });
    const graphql = async (query, variables) => {
      const r = await (await fetch("https://api.github.com/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }) })).json();
      if (r.errors) throw new Error(r.errors.map((e) => e.message).join("; "));
      return r.data;
    };
    const issueNodeId = io.gh(["api", `repos/${repo}/issues/${key}`, "--jq", ".node_id"]);
    const approved = Boolean(facts && gate.humanApproval({ ...facts, head: pr?.headRefOid }));
    const stage = board.stageOf({ pr, approved, shipped });
    await board.moveCard({ graphql, org: repo.split("/")[0], project: BOARD_PROJECT, issueNodeId, stage });
    log(`board: story ${key} -> ${stage}`);
  } catch (e) { log(`::warning::board not updated for ${key}: ${e.message}`); }
}

async function main() {
  if (cmd === "metrics") {
    const md = metrics.toMarkdown(metrics.summarize(metrics.gather(io, { days: Number(flag("days", "28")) })));
    if (flag("out")) writeFileSync(flag("out"), md + "\n");
    return say(md);
  }
  switch (`${cmd} ${sub}`) {
    case "context ": {
      const labels = (flag("labels") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const ctx = names.context({ key: flag("key"), branch: flag("branch"), labels, openReleaseBranch: openRelease() });
      output(ctx);
      return say(Object.entries(ctx).map(([k, v]) => `${k}=${v}`).join("\n"));
    }

    case "labels sync": {
      for (const [name, l] of Object.entries(names.LABELS)) {
        io.gh(["label", "create", name, "--color", l.color, "--description", l.description, "--force"]);
        log(`label ${name}`);
      }
      return;
    }

    case "org ensure": {
      const o = orgs().ensure(arg(0), { hotfix: has("hotfix") });
      output({ alias: o.alias, created: o.created });
      return say(o.alias);
    }
    case "org attach": { const o = orgs().attach(arg(0)); output({ alias: o.alias }); return say(o.alias); }
    case "org remove": { orgs().remove(arg(0)); return; }
    case "org remove-tagged": { orgs().removeTagged(arg(0)); return; }
    case "org prepare": { orgs().prepare(arg(0)); return; }
    case "org deploy": { orgs().deploy(arg(0), { manifest: flag("manifest") }); return; }
    case "org temp": { const o = orgs().temporary(arg(0)); output({ alias: o.alias, temp: true }); return say(o.alias); }
    case "org limits": { const l = orgs().limits(); return say(`active scratch orgs ${l.active.remaining}/${l.active.max} free, created today ${l.daily.max - l.daily.remaining}/${l.daily.max}`); }
    case "org sweep": {
      // every orphan: CI orgs whose run died, closed stories' orgs, staging and UAT orgs of sprints no longer open
      const t = makeTracker(io);
      const closed = new Set();
      for (const d of (io.sf(["data", "query", "-o", "devhub", "-q", "SELECT Description FROM ScratchOrgInfo WHERE Status = 'Active'"]).records || []).map((r) => r.Description || "")) {
        const key = names.storyOf(d);
        try { if (key && (await t.story(key)).state === "CLOSED") closed.add(d); } catch (e) { log(`skipped ${d}: ${e.message}`); }
      }
      const gone = orgs().sweep({ isStoryClosed: (d) => closed.has(d), openSprint: names.sprintOf(openRelease() || "") });
      return say(`deleted ${gone.length} orphan org(s)${gone.length ? `: ${gone.map((o) => `${o.description} (${o.why})`).join(", ")}` : ""}`);
    }

    case "gate evaluate": {
      const pr = arg(0);
      const facts = gate.gather(pr, io, { openReleaseBranch: openRelease(), ai: names.aiFeatures(), uat: process.env.UAT_ENABLED === "true" });
      const d = gate.evaluate(facts);
      const reasons = d.reasons.map((r) => `- ${r}`).join("\n");
      const gs = gate.gateStatus(d);
      output({
        gate_state: gs.state, gate_description: gs.description,
        route: d.route || "", mergeable: d.mergeable, story: d.story || "", reasons, head: facts.pr.headRefOid,
        open: facts.pr.state === "OPEN", merge: d.rules?.merge || "", validate: d.validate || false, after: (d.after || []).join(" "),
        lock: ["release", "hotfix", "maintenance"].includes(d.route) ? "main" : `pr-${pr}`,
      });
      return say(JSON.stringify({ route: d.route, mergeable: d.mergeable, reasons: d.reasons, story: d.story, validate: d.validate, after: d.after }, null, 2));
    }
    case "gate guard": {
      // A story PR may not change pipeline code: that code runs with production credentials.
      const base = flag("base", "origin/main"), branch = flag("branch", "");
      const files = (io.git(["diff", "--name-only", `${base}...HEAD`]) || "").split("\n").filter(Boolean);
      const bad = names.storyOf(branch) ? names.touchesPipeline(files) : [];
      if (bad.length) throw new Error(`Story PRs cannot change pipeline code (${bad.join(", ")}). Open a separate maintenance PR from a non-story branch.`);
      return say(`guard ok (${files.length} files changed)`);
    }
    case "gate ui-needed": {
      const base = flag("base", "origin/main");
      const files = (io.git(["diff", "--name-only", `${base}...${flag("head", "HEAD")}`]) || "").split("\n").filter(Boolean);
      const ui = names.uiFacing(files);
      output({ needed: ui.length > 0 });
      return say(ui.length ? `UI-facing changes: ${ui.join(", ")}` : "no UI-facing changes");
    }
    case "status set": {
      // Post a verdict on an exact commit. Run only in agent-free steps, with the Actions token (see gate.mjs).
      const [context, state, sha, ...desc] = positional;
      const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
      const url = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : "";
      io.gh(["api", `repos/${repo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${context}`, "-f", `description=${desc.join(" ").slice(0, 139)}`, ...(url ? ["-f", `target_url=${url}`] : [])]);
      return say(`${context}=${state} on ${sha.slice(0, 7)}`);
    }
    case "gate checks": {
      // Are the required CI checks green on a commit? (A release branch can only be cut from one that is.)
      const sha = io.git(["rev-parse", arg(0) || "HEAD"]);
      const runs = io.ghPages(`repos/${process.env.GH_REPO || process.env.GITHUB_REPOSITORY}/commits/${sha}/check-runs?per_page=100`, "check_runs");
      const state = [names.CHECKS.static, names.CHECKS.apex].map((n) => [n, gate.latestCheck(runs, n)]);
      output({ green: state.every(([, c]) => c === "success") });
      return say(state.map(([n, c]) => `${n}: ${c}`).join("\n"));
    }
    case "gate followups": {
      const pr = io.gh(["pr", "view", String(arg(0)), "--json", "headRefName,baseRefName,files"]);
      const after = gate.followUps(pr, (pr.files || []).map((f) => f.path));
      output({ after: after.join(" "), route: gate.route(pr) || "", story: names.storyOf(pr.headRefName) || "" });
      return say(after.join(" ") || "none");
    }
    case "gate nudge": {
      // Runs after every check or verdict lands: re-run the gate if a person signed off, and refresh the story card.
      const pr = arg(0);
      const n = gate.nudge(pr, io);
      let said;
      if (n.action === "dispatch") { io.gh(["workflow", "run", "gate.yml", "-f", `pr=${pr}`]); said = `re-ran the gate for approved PR #${pr}`; }
      else if (n.action === "tell-reset") {
        io.gh(["pr", "comment", String(pr), "--body", `Your approval was reset because new commits arrived after it (an approval covers only the code you saw). **Approve again here:** ${n.url}`]);
        said = "told the approver their approval was reset";
      } else said = `nothing to do: ${n.why}`;
      const key = names.storyOf(io.gh(["pr", "view", String(pr), "--json", "headRefName"], { allowFail: true })?.headRefName || "");
      if (key) await refreshCard(key);
      return say(said);
    }

    case "verdict model": return say(verdict.modelFor(arg(0)));
    case "tests run": return testsRun(arg(0));
    case "prod validate": return prodValidate();
    case "story card": { await refreshCard(arg(0), { base: flag("base"), tag: flag("tag") }); return say(`card updated for ${arg(0)}`); }
    case "triage ui": {
      const read = (f) => (f ? readFileSync(f, "utf8") : "");
      const t = await triageUiFailure(typesafeJev(process.env.TYPESAFE_API_KEY), { log: read(flag("log")), story: read(flag("story")) });
      output({ kind: t.kind, confidence: t.confidence, why: t.why });
      return say(`${t.kind} (${t.why})`);
    }
    case "triage review": {
      const range = `${flag("base", "origin/main")}...${flag("head", "HEAD")}`;
      const files = (io.git(["diff", "--name-only", range]) || "").split("\n").filter(Boolean);
      const diff = io.git(["diff", range]) || "";
      const t = await triageReview(typesafeJev(process.env.TYPESAFE_API_KEY), { files, diff });
      output({ review: t.review, why: t.why });
      return say(`${t.review ? "review" : "skip"} (${t.why})`);
    }
    case "verdict instructions": return say(verdict.instructions(arg(0), { key: flag("key", "N") }));
    case "verdict review": {
      const pr = io.gh(["pr", "view", String(arg(0)), "--json", "comments"]);
      const v = verdict.reviewVerdict(verdict.reviewComments(pr.comments, flag("since"))) || "none";
      output({ verdict: v });
      return say(v);
    }
    case "verdict rounds": {
      const base = flag("base");
      const subjects = (io.git(["log", "--format=%s", `${base}..HEAD`]) || "").split("\n").filter(Boolean);
      const n = verdict.fixRounds(subjects);
      output({ rounds: n, limit: verdict.MAX_FIX_ROUNDS, over: n >= verdict.MAX_FIX_ROUNDS });
      return say(String(n));
    }

    case "tracker story": {
      const s = await makeTracker(io).story(arg(0));
      const md = `# Story ${s.key}: ${s.title}\n\nTracker: ${s.url}\n\n${s.body || "(no description)"}\n`;
      if (flag("out")) writeFileSync(flag("out"), md);
      output({ title: s.title, state: s.state, url: s.url });
      return say(flag("out") ? `wrote ${flag("out")}` : md);
    }
    case "tracker comment": { await makeTracker(io).comment(arg(0), positional.slice(1).join(" ")); return; }
    case "tracker open-sprint": { await makeTracker(io).openSprint(arg(0)); return; }
    case "tracker assign": { await makeTracker(io).assignSprint(arg(0), flag("sprint")); return; }

    case "release notes": {
      const sprint = arg(0);
      const merged = io.gh(["pr", "list", "--base", names.releaseBranch(sprint), "--state", "merged", "--limit", "200", "--json", "number,title,author"]) || [];
      const stories = await makeTracker(io).sprintStories(sprint);
      const body = [
        `## Release ${sprint}`, "", "### Merged changes",
        ...(merged.length ? merged.map((p) => `- #${p.number} ${p.title} (@${p.author.login})`) : ["none"]), "",
        "### Sprint stories", ...(stories.length ? stories.map((s) => `- ${s.key} ${s.title} [${s.state}]`) : ["none"]), "",
        "### How this ships",
        "- CI and the staging regression must be green on the release branch.",
        "- Approve this PR (Files changed > Review changes > Approve). The gate validates it against production, merges it, and the release job quick-deploys exactly what was validated.",
      ].join("\n");
      return say(body);
    }

    case "closeout plan":
    case "closeout run": {
      const t = makeTracker(io);
      const facts = await closeout.gather(io, t);
      const p = closeout.plan(facts);
      log(JSON.stringify(p));
      if (sub === "run") {
        await closeout.apply(p, { tag: flag("tag"), tracker: t, orgs: orgs(), git: io.git, gh: io.gh, log });
        for (const key of [...p.ship, ...p.hotfix.map((h) => h.key)]) await refreshCard(key, { tag: flag("tag") });
      }
      return;
    }
  }
  throw new Error(`Unknown command: ${cmd} ${sub ?? ""}. See the header of pipeline/bin/pipe.mjs.`);
}

main().catch((e) => { log(`::error::${e.message}`); process.exit(1); });
