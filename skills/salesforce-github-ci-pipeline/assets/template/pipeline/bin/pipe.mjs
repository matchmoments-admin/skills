#!/usr/bin/env node
// The pipeline's one entry point. Workflows call `node pipeline/bin/pipe.mjs <command> ...`. This file only parses
// arguments, calls the module that owns the command, and writes step outputs; the work lives in pipeline/src/.
//   context   [--key K] [--branch B] [--labels a,b]     names for a story / the open sprint, as KEY=value lines
//   labels    sync                                       create or update every label the pipeline uses
//   org       ready <target> [--hotfix] [--manifest f] (the one way an org gets ready) · attach|remove <target> · temp · sweep · limits · capacity [--devs N] [--uat-sandbox] (load and cost)
//             advance <alias> --sha S   CI tested this commit in the org: it holds it now (no second deploy)
//   next      --after review|ci|staging|release-pr|org-freed [--pr N]   what the journey owes next, started (journey.mjs)
//   lane      acquire|release <org target> [--minutes M] [--no-card] [--park KIND] · wake   one job at a time per org; parked jobs re-run
//   gate      evaluate <pr> · nudge <pr> · checks [ref] · guard --base B --branch b · ui-needed --base B · followups <pr>
//             route-check --branch b --base B [--release R]   may this story branch still be built towards its base
//   status    set <context> <state> <sha> <description> [--pr N]
//   verdict   instructions <role> [--key K] · model <role> · review <pr> --since T · rounds --pr N
//   start     review|fix|ui-test --pr N [--mode ai|run] [--before S --after S]   run the job, or say why not (no runner)
//             followups --after "a b" --pr N --base B --sha S [--job J --tree T] [--story K]   what starts after a merge
//   ci        plan --ref R --base B (kind, sf, org, ui, target, all, carried) · results <sha> [--out f]   CI's results for agents
//   agent     budget <role>                             the role's model and turns (pipeline/src/roles.mjs)
//   harness   overlay implement|fix|ui-test|staging [--from DIR]   main's rules and harness over the checkout, hidden
//   tracker   story <key> [--out file] [--pack [--base B]] · comment <key> <text> · open-sprint <sprint> · assign <key> --sprint S
//   story     card <key> | --branch B [--base B] [--tag T] [--now "what" [--failed] [--retry "how"]] [--starting]
//             plan-pending <key> [--failed] · plan-post <key> --file F [--started] · readiness <key>
//   tests     run <alias> --base B [--sha S] [--all] [--min 75] [--out dir]   relevant (or all) tests, live check run
//             flow-gaps --base B                        every changed record-triggered Flow has a Flow test
//   prod      validate [--sha S] [--level L] [--deletions-from REF]   check-only deploy, live; prints the job id
//   access    check --base B [--out file] [--report-only]  least-privilege access of what changed (blockers fail)
//   ship      candidate --pr N --base B --sha S --dir D · plan --sha S [--validated-job J --validated-tree T]
//             renudge --base B --except N · watchdog      shipping keyed by commit (pipeline/src/shipping.mjs)
//   release   notes <sprint>
//   closeout  plan|run --tag T --sha S [--previous TAG]  from the shipped SHA and the release before it
//   triage    ui --log file [--story file] [--ci file] · review --base B --head H   (Jev, behind AI_TRIAGE; falls back safely)
//   event     agent --role R --file transcript [--key K] [--pr N] · rollback --tag T --sha S   (the event log; the
//             commands above record their own: stage, tests, validation, gate, org, verdict, lane, release)
//   metrics   [--days N] [--out file]                   DORA and pipeline telemetry · improve --run ID: a failed run's improvement ticket
//   act       --number N [--is-pr] --by LOGIN [--by-type T] (--command "/x ..." | --before F --after F)   a person's
//             action from a comment command or a ticked card box (pipeline/src/actions.mjs)
//   pr        card <n> | --sha S [--now "what" [--failed]] [--tag T]   the release card, or the story card of a story PR
//   story     new <key>                                  the card of a story not started yet (boxes: plan, start) · blockers <key> (merged?)
//   spec      context <n> --out F · pending <n> --now W [--failed] · post <n> --file F   bigger work (then "Make it a story")
//   baseline  capture [--out drift.md] · snapshot refresh [--minutes M]   production baseline and scratch-org snapshots
//   evidence  publish --key K --pr N --sha S --dir D [--org-url U] · squash   UI evidence screenshots (UI_EVIDENCE)
import { appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { io, PIPELINE_ROOT } from "../src/io.mjs";
import * as names from "../src/conventions.mjs";
import { orgSettings, settingsTable } from "../src/settings.mjs";
import * as gate from "../src/gate.mjs";
import * as verdict from "../src/verdict.mjs";
import * as closeout from "../src/closeout.mjs";
import * as metrics from "../src/metrics.mjs";
import { typesafeJev, triageUiFailure, triageReview, storyReadiness } from "../src/jev.mjs";
import * as plans from "../src/plan.mjs";
import { storyCards } from "../src/card.mjs";
import * as tests from "../src/tests.mjs";
import * as production from "../src/production.mjs";
import { orgRegistry, personaOf as orgPersona, packageList, sameSourceVia } from "../src/org.mjs";
import { orgCommands } from "./commands/org.mjs";
import { tracker as makeTracker, githubTracker } from "../src/tracker.mjs";
import * as access from "../src/access.mjs";
import * as pack from "../src/context-pack.mjs";
import * as shipping from "../src/shipping.mjs";
import * as events from "../src/events.mjs";
import { codeHost } from "../src/github.mjs";
import * as actions from "../src/actions.mjs";
import * as specs from "../src/spec.mjs";
import * as evidence from "../src/evidence.mjs";
import * as baseline from "../src/baseline.mjs";
import * as start from "../src/start.mjs";
import * as harness from "../src/harness.mjs";
import * as journey from "../src/journey.mjs";
import * as roles from "../src/roles.mjs";
import * as improve from "../src/improve.mjs";

const VALUE_FLAGS = new Set(["key", "branch", "labels", "manifest", "base", "tag", "out", "since", "sprint", "head", "days", "log", "story", "sha", "min", "level",
  "deletions-from", "now", "retry", "file", "pr", "dir", "validated-job", "validated-tree", "previous", "except", "minutes", "role", "model", "release", "number", "by", "by-type", "command", "before", "after", "comment", "for", "url", "login", "email", "alias", "org-url", "if-older-than", "mode", "ref", "from", "job", "tree", "ci", "run", "park", "devs", "stories", "sprint-days", "in-flight", "test-seconds", "in-use", "org"]);
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
  for (const [k, v] of Object.entries(values)) { const s = String(v ?? ""); appendFileSync(process.env.GITHUB_OUTPUT, s.includes("\n") ? `${k}<<__PIPE__\n${s}\n__PIPE__\n` : `${k}=${s}\n`); }
}
const summary = (md) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); };

// one of each per process: the code host remembers what it fetched, the trackers the comments they edit
const host = codeHost({ io, sleep, log });
const tracker = makeTracker(io);
const cards = storyCards({ host, tracker, prTracker: githubTracker({ gh: io.gh, ghPages: io.ghPages }), log });
// a snapshot Salesforce refused is marked with a tag (snapshot-refused-<name>) so no later run spends a daily org on it
const refused = (n) => `repos/${host.repo}/git/refs/tags/snapshot-refused-${n}`;
const refuseSnapshot = (n) => { const sha = host.api("GET", `repos/${host.repo}/git/ref/heads/main`)?.object?.sha; if (sha) host.api("POST", `repos/${host.repo}/git/refs`, { ref: `refs/tags/snapshot-refused-${n}`, sha }); };
const nextAfter = (after, pr = null) => journey.next(after, pr, { host, gh: io.gh, cards, ai: names.aiFeatures(), uat: names.setting("UAT_ENABLED") === "true", startJob: start.startJob, log });
const freed = async () => { try { log((await nextAfter("org-freed")).said); } catch (e) { log(`::warning::could not start what waited for a slot: ${e.message}`); } };   // UAT first, else the story waiting longest
const orgs = () => orgRegistry({ sf: io.sf, log, record: (...a) => record(...a), snapshotRefused: (n) => !host.api("GET", refused(n).replace("/refs/", "/ref/"))?.status, refuseSnapshot, sameSource: sameSourceVia((a, b) => host.api("GET", `repos/${host.repo}/compare/${a}...${b}`)), env: { ...process.env, ...orgSettings() } });   // every setting org provisioning reads, resolved (SEED=off once never arrived)
const { record } = host;
const jev = () => typesafeJev(process.env.TYPESAFE_API_KEY);


const commands = {
  "context ": () => {
    const labels = (flag("labels") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const ctx = names.context({ key: flag("key"), branch: flag("branch"), labels, openReleaseBranch: host.openRelease() });
    output(ctx);
    return say(Object.entries(ctx).map(([k, v]) => `${k}=${v}`).join("\n"));
  },
  "settings ": () => say(settingsTable().map((x) => `${x.name.padEnd(18)} ${String(x.value).padEnd(18)} ${x.value === x.default ? "(default)" : `(default ${x.default || "empty"})`}  ${x.what}`).join("\n")),   // every setting, its value and default
  "labels sync": () => {
    for (const [name, l] of Object.entries(names.LABELS)) { io.gh(["label", "create", name, "--color", l.color, "--description", l.description, "--force"]); log(`label ${name}`); }
  },

  // ---- orgs and lanes (commands/org.mjs)
  ...orgCommands({ io, host, cards, tracker, flag, has, arg, output, say, log, sleep, orgs, record: (...a) => record(...a), freed }),

  // ---- the gate
  "gate evaluate": async () => {
    const pr = arg(0);
    const facts = host.prFacts(pr);
    const d = gate.evaluate(facts);
    record("gate", { pr: Number(pr), story: d.story, route: d.route, mergeable: d.mergeable, reasons: d.reasons, sha: facts.pr.headRefOid, approvedBy: d.standing?.approval?.who || [] });
    const gs = gate.gateStatus(d);
    output({
      gate_state: gs.state, gate_description: gs.description, route: d.route || "", mergeable: d.mergeable, story: d.story || "",
      reasons: d.reasons.map((r) => `- ${r}`).join("\n"), head: facts.pr.headRefOid, open: facts.pr.state === "OPEN", merge: d.rules?.merge || "",
      validate: d.validate || false, after: (d.after || []).join(" "), approval: d.standing ? gate.approvalRecord(d.standing.approval) : "", lock: ["release", "hotfix", "maintenance"].includes(d.route) ? "main" : `pr-${pr}`,
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
  "gate ui-needed": () => {   // fails closed, as the gate does: a diff that cannot be read is UI-facing
    const out = io.git(["diff", "--name-only", `${flag("base", "origin/main")}...${flag("head", "HEAD")}`], { allowFail: true });
    const ui = out === null ? ["(the diff failed: assumed)"] : names.uiFacing(out.split("\n").filter(Boolean));
    output({ needed: ui.length > 0 });
    return say(ui.length ? `UI-facing changes: ${ui.join(", ")}` : "no UI-facing changes");
  },
  "gate checks": () => {
    // Are the required CI checks green on a commit? (A release branch can only be cut from one that is.)
    const sha = io.git(["rev-parse", arg(0) || "HEAD"]);
    const runs = io.ghPages(`repos/${host.repo}/commits/${sha}/check-runs?per_page=100`, "check_runs");
    const state = [names.CHECKS.static, names.CHECKS.apex].map((n) => [n, gate.latestCheck(runs, n)]);
    output({ green: state.every(([, c]) => gate.checkPassed(c)) });
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
  "verdict model": () => say(roles.modelFor(arg(0))),
  "verdict instructions": () => say(verdict.instructions(arg(0), { key: flag("key", "N") })),
  "verdict review": () => {
    const v = verdict.reviewVerdict(verdict.reviewComments(io.gh(["pr", "view", String(arg(0)), "--json", "comments"]).comments, flag("since"))) || "none";
    output({ verdict: v });
    return say(v);
  },
  "verdict rounds": () => {   // earlier ai-fix runs of the PR in which Claude ran, since a person last pushed
    const n = verdict.fixRoundsUsed(flag("pr"), { host, gh: io.gh });
    output({ rounds: n, limit: verdict.MAX_FIX_ROUNDS, over: n >= verdict.MAX_FIX_ROUNDS });
    return say(String(n));
  },
  // ---- start decisions: does a job need a runner? (pipeline/src/start.mjs)
  "start review": () => startCmd("review"),
  "start fix": () => startCmd("fix"),
  "start ui-test": () => startCmd("ui-test"),
  "start followups": async () => {   // after a merge: what the gate (or an emergency merge) starts, one way
    const steps = await start.startFollowUps(flag("after"), { pr: flag("pr"), base: flag("base"), sha: flag("sha"), job: flag("job", ""), tree: flag("tree", ""), story: flag("story", "") },
      { host, gh: io.gh, cards, removeOrg: (t) => { const o = names.orgFor(t); if (orgs().remove(t)) record("org", { action: "deleted", org: o?.description, story: o?.key }); return true; }, log,
        orgFreed: freed,   // UAT may have been waiting for that slot
        regate: () => shipping.regate(io, host, log) });
    return say(`follow-ups: ${steps.join(" ") || "none"}`);
  },
  "ci staging-plan": () => { const p = start.stagingPlanFor({ git: io.git, host, gh: io.gh, branch: flag("branch"), policy: names.setting("UI_REGRESSION") || "release" }); output(p); return say(p.why); },   // what this staging run does (#273)
  "ci plan": () => {   // which CI jobs need a runner, from what changed (a failed diff assumes everything)
    const base = flag("base", "main");
    const out = io.git(["diff", "--name-only", `origin/${base}...HEAD`], { allowFail: true });
    const ref = flag("ref");
    const carried = out === null || !process.env.GH_TOKEN ? null : start.ciCarry({ ref, base, git: io.git, host });   // needs the step's read-only token
    const p = start.ciPlan({ ref, base, files: out === null ? null : out.split("\n").filter(Boolean), carried });
    output({ ...p, base });
    return say(JSON.stringify(p));
  },
  "next ": async () => { const r = await nextAfter(flag("after"), flag("pr")); output({ next: r.steps.map((x) => x.start || x.dispatch).join(" ") }); return say(r.said); },
  "ci results": () => { const t = roles.ciResults(io.ghPages(`repos/${host.repo}/commits/${arg(0)}/check-runs?per_page=100`, "check_runs")); if (flag("out")) writeFileSync(flag("out"), t); return say(t); },   // for an agent or Jev
  "agent budget": () => { const b = roles.budget(arg(0)); output(b); return say(`${arg(0)}: ${b.model}, ${b.turns} turns`); },
  "harness overlay": () => say(`main's ${harness.overlay(arg(0), { git: io.git, from: flag("from", ".pipeline") }).join(", ")} over the checkout, hidden from git`),
  "triage ui": async () => {
    const read = (f) => (f && existsSync(f) ? readFileSync(f, "utf8") : "");
    const t = await triageUiFailure(jev(), { log: read(flag("log")), story: read(flag("story")), ci: read(flag("ci")) });
    output({ kind: t.kind, confidence: t.confidence, why: t.why });
    return say(`${t.kind} (${t.why})`);
  },
  // ---- UI evidence (pipeline/src/evidence.mjs): checked, stored on the evidence branch, one comment on the story
  "evidence publish": async () => {   // pipeline/src/evidence.mjs publish(): check, store, comment, event
    const r = await evidence.publish({ dir: flag("dir"), key: flag("key"), sha: flag("sha"), pr: flag("pr"), orgUrl: flag("org-url"), host, tracker, record, sleep, log });
    output({ url: r.url || "", shots: r.shots }); return say(r.said);
  },
  "ui spec-check": () => { const p = evidence.specProblems(readFileSync(flag("file"), "utf8"), { persona: Boolean(flag("story") && orgPersona(existsSync(flag("story")) ? readFileSync(flag("story"), "utf8") : "")) }); output({ problems: p.join("; ") }); return say(p.length ? `weak spec: ${p.join("; ")}` : "spec checks values"); },
  "evidence squash": async () => say(await evidence.sweep({ host, tracker, log })),   // whatever UI_EVIDENCE says: off still clears what was stored
  "baseline capture": () => {   // production's customisations into baseline/ (pipeline/src/baseline.mjs); the workflow opens the drift PR
    const r = baseline.capture({ sf: io.sf, config: JSON.parse(readFileSync("config/baseline.json", "utf8")), log, packages: packageList() });
    const changes = (io.git(["status", "--porcelain", "--untracked-files=all", "--", baseline.DIR], { allowFail: true }) || "").split("\n").filter(Boolean);
    const inventory = baseline.inventoryMarkdown(r.notCopied); summary(inventory);
    writeFileSync(flag("out", "drift.md"), [baseline.driftSummary(changes, r.listings), inventory].filter(Boolean).join("\n\n")); output({ changed: changes.length, id: baseline.baselineId(baseline.DIR) || "" });
    record("baseline", { action: changes.length ? "drift" : "refreshed", changed: changes.length }); return say(`${changes.length} file(s) differ from git`);
  },
  "snapshot refresh": () => {   // a source org (shape + packages + baseline + source + seed), snapshotted; the newest Active one is used
    const age = orgs().snapshotAgeHours();   // --if-older-than: scheduled rebuilds at most daily (each costs a daily org)
    if (flag("if-older-than") && age !== null && age < Number(flag("if-older-than"))) return say(`snapshot is ${age.toFixed(1)} h old: not rebuilt`);
    const o = orgs().ready("snapshot", { commit: io.git(["rev-parse", "HEAD"])?.trim() });
    const name = `LCB${new Date().toISOString().replace(/\D/g, "").slice(2, 12)}`;
    const r = orgs().snapshot(o.alias, { name, description: `main@${(io.git(["rev-parse", "--short", "HEAD"]) || "").trim()}${orgs().baselineId() ? ` b${orgs().baselineId()}` : ""}`, waitMinutes: Number(flag("minutes", "60")) });
    if (r.active) orgs().remove("snapshot"); record("snapshot", { action: r.active ? "active" : "pending", name, status: r.status }); output({ name, active: r.active });
    return say(r.active ? `snapshot ${name} is active: new orgs start from it` : `snapshot ${name} is ${r.status || "not active yet"}: new orgs keep using the previous one until it is`);
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
    // the card says it once, when testing starts; progress lives on the live check run (cards change on start and end only)
    if (story) await cards.refresh(story, { activity: { state: "running", what: "CI is testing the change in its scratch org (progress: the Salesforce tests check)", url: host.runUrl } }).catch(() => {});
    const r = orgs().asProductionUser(alias, () => tests.runForCheckout(io, {
      host, alias, base: flag("base", "origin/main"), sha: flag("sha"), all: has("all"), level: names.setting("CI_TEST_LEVEL") || "RunRelevantTests", min: Number(flag("min", "75")), outDir: flag("out", "test-results"), sleep, log,
    }));
    if (!r.result) return say("no Salesforce changes");
    const src = io.sourceFiles({ base: flag("base", "origin/main") });
    const changedFlows = tests.recordTriggeredFlows(src.changed, src.read);   // active record-triggered: what coverage is about
    const cov = tests.flowCoverage(io, alias, changedFlows), min = Number(names.setting("FLOW_COVERAGE_MIN") || 0);
    if (changedFlows.length) summary(`**Flow coverage (from the Apex tests):** ${changedFlows.map((f) => `${f} ${cov[f] ?? "n/a"}${cov[f] === undefined ? "" : "%"}`).join(", ")}${min ? ` (minimum ${min}%)` : " (report only; FLOW_COVERAGE_MIN sets a minimum)"}`);
    const low = min ? changedFlows.filter((f) => (cov[f] ?? 0) < min) : [];
    if (low.length) r.result = { ...r.result, ok: false, reasons: [...(r.result.reasons || []), `Flow coverage below ${min}% (FLOW_COVERAGE_MIN): ${low.map((f) => `${f} ${cov[f] ?? 0}%`).join(", ")}`] };
    record("tests", { story, sha: flag("sha"), org: alias, mode: r.plan.mode, ok: r.result.ok, seconds: r.seconds, reasons: r.result.ok ? undefined : r.result.reasons,
      apex: { ran: r.state.apex.ran, passed: r.state.apex.passed }, flows: { ran: r.state.flows.ran, passed: r.state.flows.passed } });
    summary(tests.summaryMarkdown(r.state, { plan: r.plan, result: r.result }));
    if (!r.result.ok) throw new Error(`tests failed: ${r.result.reasons.join("; ")}`);
    return say(`tests passed: apex ${r.state.apex.passed}/${r.state.apex.ran}, flow ${r.state.flows.passed}/${r.state.flows.ran}`);
  },
  "tests flow-gaps": () => {   // every changed record-triggered Flow has a Flow test (parity with Apex); main's exceptions
    const src = io.sourceFiles({ base: flag("base") });
    const exFile = join(PIPELINE_ROOT, "config/test-exceptions.json");
    const gaps = tests.flowTestGaps(src, existsSync(exFile) ? JSON.parse(readFileSync(exFile, "utf8")).flowsWithoutTests || [] : []);
    for (const g of gaps) log(`::error title=Flow without a Flow test::${g} is a record-triggered Flow with no Flow test (force-app/main/default/flowtests/, <flowApiName>${g}</flowApiName>). Add one; if a Flow test cannot set up its records (it reads the Account), an Apex test that names its object and says \`// Flow test: ${g}: <why>\`.`);
    if (gaps.length) throw new Error(`${gaps.length} record-triggered Flow(s) without a Flow test: ${gaps.join(", ")}`);
    return say("every changed record-triggered Flow has a Flow test");
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
  "improve ": () => say(improve.report(io, host, flag("run"))),
  "metrics ": () => { const md = metrics.report(io, { days: Number(flag("days", "28")), events }); if (flag("out")) writeFileSync(flag("out"), md + "\n"); return say(md); },
};

async function startCmd(kind) {
  const d = await start.startJob(kind, flag("pr"), { host, gh: io.gh, cards, ai: names.aiFeatures(), mode: flag("mode", "run"), before: flag("before"), after: flag("after"), explicit: has("explicit"), log });
  output({ run: d.run, why: d.why || "" });
  return say(d.run ? `started ${kind} for PR #${flag("pr")}` : `not started: ${d.why}`);
}

async function closeoutCmd(run) {
  const p = closeout.plan(await closeout.gather(io, tracker, { sha: flag("sha", "HEAD"), previous: flag("previous") || null }));
  log(JSON.stringify(p));
  if (!run) return;
  await closeout.apply(p, { tag: flag("tag"), tracker, orgs: orgs(), git: io.git, gh: io.gh, ghPages: io.ghPages, cards, log });
  await freed();   // the sprint's orgs are gone: a story waiting for a slot starts
  record("release", { tag: flag("tag"), sha: flag("sha"), previous: flag("previous"), sprint: p.sprint, shipped: p.ship, hotfixes: p.hotfix.map((h) => h.key), carried: p.carry });
  for (const key of [...p.ship, ...p.hotfix.map((h) => h.key)]) await cards.refresh(key, { tag: flag("tag") });
  if (flag("sha")) await cards.refreshCommit(flag("sha"), { tag: flag("tag") });   // the release card: Done, with the tag
}

const run = commands[`${cmd} ${["metrics", "act"].includes(cmd) ? "" : sub ?? ""}`];
if (!run) { log(`::error::Unknown command: ${cmd} ${sub ?? ""}. See the header of pipeline/bin/pipe.mjs.`); process.exit(1); }
Promise.resolve().then(run).catch((e) => { log(`::error::${e.message}`); process.exit(1); });
