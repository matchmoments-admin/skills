#!/usr/bin/env node
// The pipeline's one entry point. Workflows call `node pipeline/bin/pipe.mjs <command> ...`. This file only parses
// arguments, calls the module that owns the command, and writes step outputs; the work lives in pipeline/src/.
//   context   [--key K] [--branch B] [--labels a,b]     names for a story / the open sprint, as KEY=value lines
//   labels    sync                                       create or update every label the pipeline uses
//   org       ready <target> [--hotfix] [--manifest f] (the one way an org gets ready) · attach|remove <target> · temp · sweep · limits
//   lane      acquire|release <org target> [--minutes M]  one job at a time per org, a queue that drops nobody
//   gate      evaluate <pr> · nudge <pr> · checks [ref] · guard --base B --branch b · ui-needed --base B · followups <pr>
//             route-check --branch b --base B [--release R]   may this story branch still be built towards its base
//   status    set <context> <state> <sha> <description> [--pr N]
//   verdict   instructions <role> [--key K] · model <role> · review <pr> --since T · rounds --pr N
//   tracker   story <key> [--out file] [--pack [--base B]] · comment <key> <text> · open-sprint <sprint> · assign <key> --sprint S
//   story     card <key> | --branch B [--base B] [--tag T] [--now "what" [--failed] [--retry "how"]] [--starting]
//             plan-pending <key> [--failed] · plan-post <key> --file F [--started] · readiness <key>
//   tests     run <alias> --base B [--sha S] [--all] [--min 75] [--out dir]   relevant (or all) tests, live check run
//   prod      validate [--sha S] [--level L] [--deletions-from REF]   check-only deploy, live; prints the job id
//   access    check --base B [--out file] [--report-only]  least-privilege access of what changed (blockers fail)
//   ship      candidate --pr N --base B --sha S --dir D · plan --sha S [--validated-job J --validated-tree T]
//             renudge --base B --except N · watchdog      shipping keyed by commit (pipeline/src/shipping.mjs)
//   release   notes <sprint>
//   closeout  plan|run --tag T --sha S [--previous TAG]  from the shipped SHA and the release before it
//   triage    ui --log file [--story file] · review --base B --head H   (Jev, behind AI_TRIAGE; falls back safely)
//   event     agent --role R --file transcript [--key K] [--pr N] · rollback --tag T --sha S   (the event log; the
//             commands above record their own: stage, tests, validation, gate, org, verdict, lane, release)
//   metrics   [--days N] [--out file]                   DORA and pipeline telemetry as markdown
//   act       --number N [--is-pr] --by LOGIN [--by-type T] (--command "/x ..." | --before F --after F)   a person's
//             action from a comment command or a ticked card box (pipeline/src/actions.mjs)
//   pr        card <n> | --sha S [--now "what" [--failed]] [--tag T]   the release card, or the story card of a story PR
//   story     new <key>                                  the card of a story not started yet (boxes: plan, start) · blockers <key> (merged?)
//   spec      context <n> --out F · pending <n> --now W [--failed] · post <n> --file F   bigger work (then "Make it a story")
//   evidence  publish --key K --pr N --sha S --dir D [--org-url U] · squash   UI evidence screenshots (UI_EVIDENCE)
import { appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { io, PIPELINE_ROOT } from "../src/io.mjs";
import * as names from "../src/conventions.mjs";
import * as gate from "../src/gate.mjs";
import * as verdict from "../src/verdict.mjs";
import * as closeout from "../src/closeout.mjs";
import * as metrics from "../src/metrics.mjs";
import { typesafeJev, triageUiFailure, triageReview, storyReadiness } from "../src/jev.mjs";
import * as plans from "../src/plan.mjs";
import { storyCards } from "../src/card.mjs";
import * as tests from "../src/tests.mjs";
import * as production from "../src/production.mjs";
import { orgRegistry, personaOf as orgPersona } from "../src/org.mjs";
import { tracker as makeTracker, githubTracker } from "../src/tracker.mjs";
import * as access from "../src/access.mjs";
import * as pack from "../src/context-pack.mjs";
import * as shipping from "../src/shipping.mjs";
import { lane } from "../src/lane.mjs";
import * as events from "../src/events.mjs";
import { codeHost } from "../src/github.mjs";
import * as actions from "../src/actions.mjs";
import * as specs from "../src/spec.mjs";
import * as evidence from "../src/evidence.mjs";

const VALUE_FLAGS = new Set(["key", "branch", "labels", "manifest", "base", "tag", "out", "since", "sprint", "head", "days", "log", "story", "sha", "min", "level",
  "deletions-from", "now", "retry", "file", "pr", "dir", "validated-job", "validated-tree", "previous", "except", "minutes", "role", "model", "release", "number", "by", "by-type", "command", "before", "after", "comment", "for", "url", "login", "email", "alias", "org-url"]);
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
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Write step outputs when running in Actions (multi-line safe). */
function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [k, v] of Object.entries(values)) {
    const s = String(v ?? "");
    appendFileSync(process.env.GITHUB_OUTPUT, s.includes("\n") ? `${k}<<__PIPE__\n${s}\n__PIPE__\n` : `${k}=${s}\n`);
  }
}
const summary = (md) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); };

// one of each per process: the code host remembers what it fetched, the trackers the comments they edit
const host = codeHost({ io, sleep, log });
const tracker = makeTracker(io);
const cards = storyCards({ host, tracker, prTracker: githubTracker({ gh: io.gh, ghPages: io.ghPages }), log });
const orgs = () => orgRegistry({ sf: io.sf, log, env: { ...process.env, ORG_RESERVE: names.setting("ORG_RESERVE"), SCRATCH_SNAPSHOT: names.setting("SCRATCH_SNAPSHOT") } });
const { record } = host;
const jev = () => typesafeJev(process.env.TYPESAFE_API_KEY);

function orgLane(target) {
  const org = names.orgFor(target);
  if (!org) throw new Error(`Not an org target: ${target}`);
  const { GITHUB_RUN_ID: run, GITHUB_JOB: job, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: sha } = process.env;
  const onWait = (h) => org.key && cards.refresh(org.key, { light: true, activity: { state: "running", what: `waiting for the story's scratch org: ${String(h.job).replace(/#\d+$/, "")} is using it`, url: `${host.repoUrl}/actions/runs/${h.run}` } }).catch(() => {});   // the card says why, not "deploying"
  return { org, l: lane({ api: host.api, repo: host.repo, holder: { run, job: `${job}#${attempt || 1}`, sha }, sleep, log, onWait }) };
}

const commands = {
  "context ": () => {
    const labels = (flag("labels") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const ctx = names.context({ key: flag("key"), branch: flag("branch"), labels, openReleaseBranch: host.openRelease() });
    output(ctx);
    return say(Object.entries(ctx).map(([k, v]) => `${k}=${v}`).join("\n"));
  },
  "labels sync": () => {
    for (const [name, l] of Object.entries(names.LABELS)) { io.gh(["label", "create", name, "--color", l.color, "--description", l.description, "--force"]); log(`label ${name}`); }
  },

  // ---- orgs and lanes
  "org ready": () => {   // Org provisioning: the target's org, holding the code in the working directory (org.mjs ready)
    const o = orgs().ready(arg(0), { hotfix: has("hotfix"), commit: io.git(["rev-parse", "HEAD"], { allowFail: true })?.trim(), manifest: flag("manifest") });
    if (o.created || o.completed) record("org", { action: o.created ? "created" : "completed", org: o.description, story: o.key });
    output({ alias: o.alias, created: o.created }); return say(o.alias);
  },
  "org ensure": () => commands["org ready"](),   // the older name
  "org attach": () => { const o = orgs().attach(arg(0)); output({ alias: o.alias }); return say(o.alias); },
  "org remove": () => { const o = names.orgFor(arg(0)); if (orgs().remove(arg(0))) record("org", { action: "deleted", org: o?.description, story: o?.key }); },
  "org remove-tagged": () => { if (orgs().removeTagged(arg(0))) record("org", { action: "deleted", org: arg(0) }); },
  "org prepare": () => { orgs().prepare(arg(0)); },
  "org deploy": () => { orgs().deploy(arg(0), { manifest: flag("manifest") }); },
  "org temp": () => { const o = orgs().temporary(arg(0)); record("org", { action: "created", org: o.description }); output({ alias: o.alias, temp: true }); return say(o.alias); },
  "org limits": () => { const l = orgs().limits(); return say(`active scratch orgs ${l.active.remaining}/${l.active.max} free, created today ${l.daily.max - l.daily.remaining}/${l.daily.max}`); },
  "org sweep": async () => {
    // every orphan: CI orgs whose run died, closed stories' orgs, staging and UAT orgs of sprints no longer open
    const closed = new Set();
    for (const d of (io.sf(["data", "query", "-o", "devhub", "-q", "SELECT Description FROM ScratchOrgInfo WHERE Status = 'Active'"]).records || []).map((r) => r.Description || "")) {
      const key = names.storyOf(d);
      try { if (key && (await tracker.story(key)).state === "CLOSED") closed.add(d); } catch (e) { log(`skipped ${d}: ${e.message}`); }
    }
    const gone = orgs().sweep({ isStoryClosed: (d) => closed.has(d), openSprint: names.sprintOf(host.openRelease() || "") });
    for (const g of gone) record("org", { action: "deleted", org: g.description, why: g.why });
    return say(`deleted ${gone.length} orphan org(s)${gone.length ? `: ${gone.map((o) => `${o.description} (${o.why})`).join(", ")}` : ""}`);
  },
  "uat tester": async () => {   // a person's login, emailed by Salesforce, as the story's persona (or UAT_TESTER_ROLE); never a secret
    const story = names.storyOf(flag("alias", "")); const body = story ? (await tracker.story(story).catch(() => ({}))).body : "";
    const persona = orgPersona(body) || (names.setting("UAT_TESTER_ROLE") ? { role: names.setting("UAT_TESTER_ROLE"), permsets: [] } : null);
    const r = orgs().tester(flag("alias", "uat"), { login: flag("login"), email: flag("email"), persona });
    const masked = flag("email").replace(/^(.).*?(@.*)$/, "$1***$2");
    io.gh(["pr", "comment", flag("pr"), "--body", `🔑 @${flag("login")}: Salesforce has emailed **${masked}** a link to set a password for **${flag("alias", "uat") === "uat" ? "UAT" : `the story's scratch org (${flag("alias")})`}**. Username: \`${r.username}\`. ${r.persona.role ? `Role **${r.persona.role}**, permission sets ${r.persona.permsets.join(", ")}: you see what that user sees.` : `Every permission set in the code, no role (Standard User). If the feature is shared by role, set the story's \`Persona:\` line or UAT_TESTER_ROLE.`}`]);
    return say(r.username);
  },
  "lane acquire": () => {
    const { org, l } = orgLane(arg(0));
    const t0 = Date.now();
    l.acquire(org.lock, { timeoutMinutes: Number(flag("minutes", "45")) });
    const waited = Math.round((Date.now() - t0) / 1000);
    if (waited > 30) record("lane", { lane: org.lock, waitedSeconds: waited, story: org.key });
    output({ lane: org.lock });
    return say(org.lock);
  },
  "lane release": () => { const { org, l } = orgLane(arg(0)); l.release(org.lock); },

  // ---- the gate
  "gate evaluate": async () => {
    const pr = arg(0);
    const facts = host.prFacts(pr, { openReleaseBranch: host.openRelease(), ai: names.aiFeatures(), uat: names.setting("UAT_ENABLED") === "true" });
    const d = gate.evaluate(facts);
    record("gate", { pr: Number(pr), story: d.story, route: d.route, mergeable: d.mergeable, reasons: d.reasons, sha: facts.pr.headRefOid });
    const gs = gate.gateStatus(d);
    output({
      gate_state: gs.state, gate_description: gs.description, route: d.route || "", mergeable: d.mergeable, story: d.story || "",
      reasons: d.reasons.map((r) => `- ${r}`).join("\n"), head: facts.pr.headRefOid, open: facts.pr.state === "OPEN", merge: d.rules?.merge || "",
      validate: d.validate || false, after: (d.after || []).join(" "), lock: ["release", "hotfix", "maintenance"].includes(d.route) ? "main" : `pr-${pr}`,
    });
    if (has("card")) await cards.refreshPr(pr);   // the same facts: one gather for the decision and the card
    return say(JSON.stringify({ route: d.route, mergeable: d.mergeable, reasons: d.reasons, story: d.story, validate: d.validate, after: d.after }, null, 2));
  },
  "gate guard": () => {
    // A story PR may not change pipeline code: that code runs with production credentials.
    const files = (io.git(["diff", "--name-only", `${flag("base", "origin/main")}...HEAD`]) || "").split("\n").filter(Boolean);
    const bad = names.storyOf(flag("branch", "")) ? names.touchesPipeline(files) : [];
    if (bad.length) throw new Error(`Story PRs cannot change pipeline code (${bad.join(", ")}). Open a separate maintenance PR from a non-story branch.`);
    return say(`guard ok (${files.length} files changed)`);
  },
  "gate route-check": () => {
    const r = gate.branchRoute(io.git, { branch: flag("branch"), base: flag("base"), release: flag("release") });
    if (!r.ok) throw new Error(r.why);
    return say(`${flag("branch")} can be built towards ${flag("base")}`);
  },
  "gate ui-needed": () => {
    const files = (io.git(["diff", "--name-only", `${flag("base", "origin/main")}...${flag("head", "HEAD")}`]) || "").split("\n").filter(Boolean);
    const ui = names.uiFacing(files);
    output({ needed: ui.length > 0 });
    return say(ui.length ? `UI-facing changes: ${ui.join(", ")}` : "no UI-facing changes");
  },
  "gate checks": () => {
    // Are the required CI checks green on a commit? (A release branch can only be cut from one that is.)
    const sha = io.git(["rev-parse", arg(0) || "HEAD"]);
    const runs = io.ghPages(`repos/${host.repo}/commits/${sha}/check-runs?per_page=100`, "check_runs");
    const state = [names.CHECKS.static, names.CHECKS.apex].map((n) => [n, gate.latestCheck(runs, n)]);
    output({ green: state.every(([, c]) => c === "success") });
    return say(state.map(([n, c]) => `${n}: ${c}`).join("\n"));
  },
  "gate followups": () => {
    const pr = io.gh(["pr", "view", String(arg(0)), "--json", "headRefName,baseRefName,files"]);
    const after = gate.followUps(pr, (pr.files || []).map((f) => f.path));
    output({ after: after.join(" "), route: gate.route(pr) || "", story: names.storyOf(pr.headRefName) || "" });
    return say(after.join(" ") || "none");
  },
  "gate nudge": async () => {
    // after every check or verdict: re-run the gate if a person signed off, and refresh the story card
    const pr = arg(0);
    const n = gate.nudge(pr, io);
    if (n.action === "dispatch") host.dispatch("gate.yml", { pr });
    await cards.refreshPr(pr);
    return say(n.action === "dispatch" ? `re-ran the gate for approved PR #${pr}` : `nothing to do: ${n.why}`);
  },
  "status set": () => {
    // a verdict on an exact commit; agent-free steps only, with the Actions token (see gate.mjs)
    const [context, state, sha, ...desc] = positional;
    host.status(sha, context, state, desc.join(" "), flag("url") || host.runUrl);
    if (context.startsWith("pipeline/") && context !== gate.GATE_STATUS) record("verdict", { context, state, sha, pr: flag("pr") ? Number(flag("pr")) : undefined, why: desc.join(" ").slice(0, 139) });
    return say(`${context}=${state} on ${sha.slice(0, 7)}`);
  },

  // ---- verdicts and AI roles
  "verdict model": () => say(verdict.modelFor(arg(0))),
  "verdict instructions": () => say(verdict.instructions(arg(0), { key: flag("key", "N") })),
  "verdict review": () => {
    const v = verdict.reviewVerdict(verdict.reviewComments(io.gh(["pr", "view", String(arg(0)), "--json", "comments"]).comments, flag("since"))) || "none";
    output({ verdict: v });
    return say(v);
  },
  "verdict rounds": () => {   // earlier ai-fix runs of the PR in which Claude ran, since a person last pushed
    const n = verdict.fixRunsFor(host.workflowRuns("ai-fix.yml", "event=workflow_dispatch"), flag("pr"), process.env.GITHUB_RUN_ID, (id) => verdict.ranAgent(host.api("GET", `repos/${host.repo}/actions/runs/${id}/jobs`)?.jobs),
      verdict.lastHumanPush(io.gh(["pr", "view", flag("pr"), "--json", "commits"])?.commits, names.isPipelineAuthor));   // a person's push resets the count
    output({ rounds: n, limit: verdict.MAX_FIX_ROUNDS, over: n >= verdict.MAX_FIX_ROUNDS });
    return say(String(n));
  },
  "triage ui": async () => {
    const read = (f) => (f ? readFileSync(f, "utf8") : "");
    const t = await triageUiFailure(jev(), { log: read(flag("log")), story: read(flag("story")) });
    output({ kind: t.kind, confidence: t.confidence, why: t.why });
    return say(`${t.kind} (${t.why})`);
  },
  // ---- UI evidence (pipeline/src/evidence.mjs): checked, stored on the evidence branch, one comment on the story
  "evidence publish": async () => {
    if (!evidence.evidenceOn()) return say("UI evidence is off (UI_EVIDENCE is not true): nothing posted");
    const dir = flag("dir");
    const files = dir && existsSync(dir) ? readdirSync(dir).map((name) => ({ name, data: readFileSync(join(dir, name)) })) : [];
    const { shots, rejected } = evidence.check(files);
    for (const r of rejected) log(`::warning::UI evidence not published: ${r}`);
    const [key, sha, pr] = [flag("key"), flag("sha"), flag("pr")];
    const kb = Math.round(shots.reduce((a, s) => a + s.data.length, 0) / 1024);
    record("evidence", { story: key, pr: pr ? Number(pr) : undefined, shots: shots.length, rejected: rejected.length, kb });
    if (!shots.length) return say("no UI evidence: the spec took no screenshots");
    evidence.store({ api: host.api, repo: host.repo, key, sha, shots, sleep });
    const url = await tracker.card(key, evidence.evidenceComment({ key, pr, sha, shots, orgUrl: flag("org-url"), repoUrl: host.repoUrl }), evidence.EVIDENCE_MARK, evidence.EVIDENCE_TITLE);
    output({ url: url || "", shots: shots.length });
    return say(url || `posted ${shots.length} screenshot(s) on ${key}`);
  },
  "ui spec-check": () => { const p = evidence.specProblems(readFileSync(flag("file"), "utf8")); output({ problems: p.join("; ") }); return say(p.length ? `weak spec: ${p.join("; ")}` : "spec checks values"); },
  "evidence squash": async () => {   // runs whatever the switch says, so turning UI_EVIDENCE off still clears what was stored
    // a closed story's comment is rewritten FIRST; only then are its screenshots deleted (a failed rewrite keeps them)
    const keep = new Set();
    for (const k of evidence.storiesOnBranch({ api: host.api, repo: host.repo })) {
      const open = await tracker.story(k).then((s) => s.state !== "CLOSED", () => true);
      const has = !open && (await tracker.comments(k).catch(() => null))?.some((c) => String(c.body).includes(evidence.EVIDENCE_TITLE));
      if (open || (has && !(await tracker.card(k, evidence.removedComment(), evidence.EVIDENCE_MARK, evidence.EVIDENCE_TITLE).then(() => true, (e) => (log(`::warning::${k}: ${e.message}`), false))))) keep.add(k);
    }
    const r = await evidence.squash({ api: host.api, repo: host.repo, isOpen: async (k) => keep.has(k) });
    return say(r ? `evidence branch: ${r.kept} open stories kept${r.removed.length ? `, removed ${r.removed.join(", ")}` : ""}` : "no evidence branch");
  },
  "triage review": async () => {
    const range = `${flag("base", "origin/main")}...${flag("head", "HEAD")}`;
    const t = await triageReview(jev(), { files: (io.git(["diff", "--name-only", range]) || "").split("\n").filter(Boolean), diff: io.git(["diff", range]) || "" });
    output({ review: t.review, why: t.why });
    return say(`${t.review ? "review" : "skip"} (${t.why})`);
  },

  // ---- the story: tracker, card, plan
  "tracker story": async () => {
    // the story plus the agreed build plan and its answers (the spec every agent reads); --pack adds the context pack
    const s = await tracker.story(arg(0));
    const ctx = plans.planContext(await tracker.comments(arg(0)).catch(() => []));
    let md = plans.storyFile(s, ctx);
    const spec = String(s.body || "").match(/Part of spec #(\d+)/)?.[1];   // made from a spec: all of it reaches every agent
    if (spec) md += plans.specSection(spec, plans.planContext(await tracker.comments(spec).catch(() => []), { mark: specs.SPEC_MARK, title: specs.SPEC_TITLE }));
    if (has("pack")) md += "\n" + pack.packForCheckout(io, { text: `${s.title}\n${s.body}\n${ctx.plan || ""}`, base: flag("base"), log });
    if (flag("out")) writeFileSync(flag("out"), md);
    output({ planned: Boolean(ctx.plan), title: s.title, state: s.state, url: s.url });
    return say(flag("out") ? `wrote ${flag("out")}` : md);
  },
  "tracker comment": () => tracker.comment(arg(0), positional.slice(1).join(" ")),
  "tracker open-sprint": () => tracker.openSprint(arg(0)),
  "tracker assign": () => tracker.assignSprint(arg(0), flag("sprint")),
  "story card": async () => {
    const key = arg(0) || names.storyOf(flag("branch") || "");
    if (!key) return say(`not a story branch (${flag("branch") || "none"}): no card`);
    const activity = flag("now") ? { state: has("failed") ? "failed" : "running", what: flag("now"), url: host.runUrl, retry: flag("retry") } : null;
    if (activity) record("stage", { story: key, what: activity.what, state: activity.state });
    if (has("starting")) { await cards.starting(key, activity); return say(`starting card for ${key}`); }
    await cards.refresh(key, { base: flag("base"), tag: flag("tag"), activity });
    return say(`card updated for ${key}`);
  },
  "story base": async () => say(names.baseFor({ labels: (await tracker.story(arg(0))).labels, openReleaseBranch: host.openRelease() })),   // as /start: hotfix -> main, else the sprint
  // ---- specs (bigger work): Claude writes the spec; a person makes it a story (pipeline/src/spec.mjs)
  "spec context": async () => { writeFileSync(flag("out"), await specs.specFile(tracker, arg(0)) + "\n" + pack.packForCheckout(io, { text: (await tracker.story(arg(0))).body, log })); return say(`wrote ${flag("out")}`); },
  "spec pending": async () => { await tracker.card(arg(0), specs.pendingComment(specs.currentSpec(await tracker.comments(arg(0)).catch(() => [])), { state: has("failed") ? "failed" : "running", what: flag("now"), url: host.runUrl }), specs.SPEC_MARK); return say("pending"); },
  "spec post": async () => {   // a revision of a spec already made into a story keeps its link and offers no second story
    const story = specs.storyOfSpec(specs.currentSpec(await tracker.comments(arg(0)).catch(() => []))); io.gh(["issue", "edit", arg(0), "--add-label", "spec"], { allowFail: true }); if (story) await tracker.comment(story, specs.revisedNote(arg(0)));
    await tracker.card(arg(0), specs.specComment(readFileSync(flag("file"), "utf8"), { story }), specs.SPEC_MARK); await cards.newStory(arg(0), { spec: true, stage: story ? "story" : "spec", stories: [story].filter(Boolean) }); return say(`spec on #${arg(0)}`); },
  "story blockers": async () => {   // before a branch and org exist: blockers merged? A failed check lets it start (the gate checks at merge)
    let waiting = []; try { waiting = gate.blockersOf((await tracker.story(arg(0))).body).filter((n) => !gate.landedOf(n, io.gh)); } catch (e) { log(`::warning::blockers not checked (${e.message}): starting; the gate still checks them at merge`); }
    output({ ok: !waiting.length, waiting: waiting.join(" ") }); if (!waiting.length) return say("no unmerged blockers");
    io.gh(["issue", "edit", arg(0), "--remove-label", "start"], { allowFail: true }); io.gh(["issue", "comment", arg(0), "--body", gate.blockedMessage(waiting)]);
    await cards.newStory(arg(0)); return say(`blocked by ${waiting.join(", ")}`);   // the card offers Start again
  },
  "story new": async () => { await cards.newStory(arg(0), { spec: has("spec") }); return say(`card for new ${has("spec") ? "spec" : "story"} ${arg(0)}`); },
  "pr card": async () => {
    // the card of a pull request (release card or its story's); --sha: of the PR a commit was merged by
    const activity = flag("now") ? { state: has("failed") ? "failed" : "running", what: flag("now"), url: host.runUrl, retry: flag("retry") } : null;
    const r = arg(0) ? await cards.refreshPr(arg(0), { activity, tag: flag("tag") }) : await cards.refreshCommit(flag("sha"), { activity, tag: flag("tag") });
    return say(`card: ${r || "no story or release PR"}`);
  },
  "act ": async () => {
    // a person's action from a comment command (--command) or a ticked card box (--before/--after the edit)
    const said = await actions.act({ number: flag("number"), isPr: has("is-pr"), who: flag("by"), whoType: flag("by-type"),
      command: flag("command"), before: flag("before") && readFileSync(flag("before"), "utf8"), after: flag("after") && readFileSync(flag("after"), "utf8"), commentId: flag("comment") },
      { io, host, cards, log, appToken: process.env.APP_TOKEN, makeStory: specs.makeStory, specMark: specs.SPEC_MARK });
    return say(said);
  },
  "story plan-pending": async () => {
    // the Build plan comment appears at once, saying Claude is planning (or that it failed), with a link
    const what = has("failed") ? { state: "failed", what: "Claude could not produce a plan", url: host.runUrl } : { state: "running", what: "Claude is planning the build (2 to 5 minutes)", url: host.runUrl };
    await tracker.card(arg(0), plans.planPending(what), plans.PLAN_MARK, plans.PLAN_TITLE);
    return say(`plan pending on ${arg(0)}`);
  },
  "story plan-post": async () => {
    const s = await tracker.story(arg(0));
    const readiness = await storyReadiness(jev(), { criteria: plans.criteria(s.body), title: s.title, body: s.body });
    await tracker.card(arg(0), plans.planComment(readFileSync(flag("file"), "utf8"), { readiness, started: has("started") }), plans.PLAN_MARK, plans.PLAN_TITLE);
    return say(`build plan posted on ${arg(0)}`);
  },
  "story readiness": async () => {
    const s = await tracker.story(arg(0));
    const r = await storyReadiness(jev(), { criteria: plans.criteria(s.body), title: s.title, body: s.body });
    const body = plans.readinessComment(r);
    if (body) await tracker.card(arg(0), body, plans.READINESS_MARK, plans.READINESS_TITLE);
    output({ weak: r?.weak.length ?? 0, size: r?.size || "unknown" });
    return say(r ? `readiness: ${r.weak.length} weak criteria, size ${r.size}${body ? " (posted)" : ""}` : "readiness: no answer from Jev (skipped)");
  },

  // ---- tests, access, production
  "tests run": async () => {
    const alias = arg(0);
    const story = names.storyOf(process.env.REF || process.env.GITHUB_HEAD_REF || "");
    let polls = 0;
    const r = orgs().asProductionUser(alias, () => tests.runForCheckout(io, {
      host, alias, base: flag("base", "origin/main"), sha: flag("sha"), all: has("all"), min: Number(flag("min", "75")), outDir: flag("out", "test-results"), sleep, log,
      // the card's Now line, every ~2 minutes, reusing this process's facts (two comment edits, no re-gathering)
      onProgress: (st, title) => { if (story && polls++ % 8 === 0) cards.refresh(story, { light: true, activity: { state: "running", what: `CI is testing the change in its scratch org (${title})`, url: host.runUrl } }).catch(() => {}); },
    }));
    if (!r.result) return say("no Salesforce changes");
    record("tests", { story, sha: flag("sha"), org: alias, mode: r.plan.mode, ok: r.result.ok, seconds: r.seconds, reasons: r.result.ok ? undefined : r.result.reasons,
      apex: { ran: r.state.apex.ran, passed: r.state.apex.passed }, flows: { ran: r.state.flows.ran, passed: r.state.flows.passed } });
    summary(tests.summaryMarkdown(r.state, { plan: r.plan, result: r.result }));
    if (!r.result.ok) throw new Error(`tests failed: ${r.result.reasons.join("; ")}`);
    return say(`tests passed: apex ${r.state.apex.passed}/${r.state.apex.ran}, flow ${r.state.flows.passed}/${r.state.flows.ran}`);
  },
  "access check": () => {
    const { files, read, changed, added } = io.sourceFiles({ base: flag("base"), head: flag("head", "HEAD") });
    const exFile = join(PIPELINE_ROOT, "config/access-exceptions.json");
    const found = access.findings({ changed, added, files, read, exceptions: existsSync(exFile) ? JSON.parse(readFileSync(exFile, "utf8")) : [] });
    for (const f of found) log(`::${f.level === "blocker" ? "error" : "warning"} file=${f.file},line=${f.line},title=access: ${f.rule}::${f.message}`);
    const md = access.toMarkdown(found);
    if (flag("out")) writeFileSync(flag("out"), md + "\n");
    summary(md);
    const blockers = found.filter((f) => f.level === "blocker").length;
    say(`access check: ${changed.length} changed file(s), ${blockers} blocker(s), ${found.length - blockers} warning(s)`);
    if (blockers && !has("report-only")) process.exit(1);
  },
  "prod validate": () => {
    // check-only deploy of this checkout, live; stdout is only the validation id (the quick deploy reads it)
    const p = production.validateCheckout(io, { host, sha: flag("sha"), level: flag("level", names.setting("PROD_TEST_LEVEL") || "RunRelevantTests"),
      deletionsFrom: flag("deletions-from") || shipping.lastRelease(io.git, "HEAD"), sleep, log });
    summary(`### Production validation: ${p.out.title}\n\n${p.out.summary}\n\n${p.out.text}`);
    record("validation", { sha: flag("sha"), level: p.level, ok: p.ok, status: p.status, seconds: p.seconds, components: p.components.total, tests: p.tests.total });
    if (!p.ok) { process.stderr.write(`Production validation failed (${p.status}):\n${p.out.text || "see Deployment Status"}\n`); process.exit(1); }
    return say(p.id);
  },

  // ---- shipping and close-out
  "ship candidate": () => {
    const c = shipping.buildCandidate(io.git, { pr: flag("pr"), base: flag("base"), head: flag("sha"), dir: flag("dir") });
    output({ base: c.base, tree: c.tree, since: c.since || "" });
    return say(`candidate: ${flag("base")}@${c.base.slice(0, 7)} + PR #${flag("pr")} @${c.head.slice(0, 7)} = tree ${c.tree.slice(0, 7)}; deletions since ${c.since || "the beginning"}`);
  },
  "ship plan": () => {
    const facts = shipping.gatherRelease(io.git, { sha: flag("sha"), validated: { job: flag("validated-job"), tree: flag("validated-tree") } });
    const p = shipping.releasePlan(facts);
    output({ sha: facts.sha, action: p.action, job: p.job || "", tag: p.tag || "", previous: p.previous || "", skip: p.action === "skip" });
    return say(`${p.action}: ${p.why}`);
  },
  "ship renudge": () => {
    const again = shipping.renudge(io, host, { base: flag("base", "main"), except: flag("except") }, (n) => gate.nudge(n, io));
    return say(again.length ? `re-ran the gate for ${again.map((n) => `#${n}`).join(", ")}` : `nothing else waiting on ${flag("base", "main")}`);
  },
  "ship watchdog": () => {
    const f = shipping.watchdogFacts(io, host);
    const w = shipping.watchdog(f);
    if (w.action === "release") host.dispatch("release.yml", { sha: f.mainSha });
    if (w.action === "report") log(`::warning::${w.why}`);
    return say(`watchdog: ${w.action} (${w.why})`);
  },
  "release notes": async () => say(await closeout.releaseNotes(io, tracker, arg(0))),
  "closeout plan": () => closeoutCmd(false),
  "closeout run": () => closeoutCmd(true),

  // ---- the event log and metrics
  "event agent": () => {
    // an agent's cost and turns from its transcript (claude-agent action, after the agent)
    let r = null;
    try { r = [...JSON.parse(readFileSync(flag("file"), "utf8"))].reverse().find((m) => m.type === "result"); } catch { /* no transcript */ }
    if (!r) return say("no agent result to record");
    record("agent", { role: flag("role"), story: flag("key") && flag("key") !== "N" ? flag("key") : undefined, pr: flag("pr") ? Number(flag("pr")) : undefined,
      usd: Math.round((Number(r.total_cost_usd) || 0) * 1e4) / 1e4, turns: r.num_turns, minutes: Math.round((Number(r.duration_ms) || 0) / 6e3) / 10, ok: !r.is_error, model: flag("model") });
    return say(`recorded ${flag("role")}: $${(Number(r.total_cost_usd) || 0).toFixed(2)}, ${r.num_turns} turns`);
  },
  "event rollback": () => { record("rollback", { tag: flag("tag"), sha: flag("sha") }); return say(`recorded rollback to ${flag("tag")}`); },
  "metrics ": () => {
    // the event log first; workflow health from GitHub's run history (transcripts only for windows before the log)
    const days = Number(flag("days", "28"));
    const log_ = events.readLog(io, { days });
    const covered = log_.some((e) => e.kind === "release");   // the log has seen a release: its DORA is the one to trust
    const gh = metrics.summarize(metrics.gather(io, { days, transcripts: !log_.some((e) => e.kind === "agent"), prDetails: !covered }));
    const older = metrics.toMarkdown(gh, { dora: !covered }).replace(/^## Delivery metrics, last \d+ days/, covered ? "## Workflow health (GitHub's run history)" : "## From GitHub's history (PRs, releases, workflow runs)");
    const md = [events.toMarkdown(events.summarize(log_, { days })), "", older].join("\n");
    if (flag("out")) writeFileSync(flag("out"), md + "\n");
    return say(md);
  },
};

async function closeoutCmd(run) {
  const p = closeout.plan(await closeout.gather(io, tracker, { sha: flag("sha", "HEAD"), previous: flag("previous") || null }));
  log(JSON.stringify(p));
  if (!run) return;
  await closeout.apply(p, { tag: flag("tag"), tracker, orgs: orgs(), git: io.git, gh: io.gh, cards, log });
  record("release", { tag: flag("tag"), sha: flag("sha"), previous: flag("previous"), sprint: p.sprint, shipped: p.ship, hotfixes: p.hotfix.map((h) => h.key), carried: p.carry });
  for (const key of [...p.ship, ...p.hotfix.map((h) => h.key)]) await cards.refresh(key, { tag: flag("tag") });
  if (flag("sha")) await cards.refreshCommit(flag("sha"), { tag: flag("tag") });   // the release card: Done, with the tag
}

const run = commands[`${cmd} ${["metrics", "act"].includes(cmd) ? "" : sub ?? ""}`];
if (!run) { log(`::error::Unknown command: ${cmd} ${sub ?? ""}. See the header of pipeline/bin/pipe.mjs.`); process.exit(1); }
Promise.resolve().then(run).catch((e) => { log(`::error::${e.message}`); process.exit(1); });
