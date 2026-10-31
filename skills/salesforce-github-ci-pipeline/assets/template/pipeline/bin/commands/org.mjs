// The orgs and lanes commands of `pipe` (see the header of pipeline/bin/pipe.mjs): Org provisioning, the scratch-org
// janitor, testers, and the Lane (one job at a time in an org). pipe.mjs passes its shared context (io, host, flags,
// output); the decisions live in pipeline/src/org.mjs and lane.mjs.
import { readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import * as names from "../../src/conventions.mjs";
import * as capacity from "../../src/capacity.mjs";
import * as sample from "../../src/sample.mjs";
import { personaOf as orgPersona, storyRefusal, doneStoryOrgs, advanceCovered, foldSeeds } from "../../src/org.mjs";
import { lane, jobId, wakeAll, stillOwed, wakeDue } from "../../src/lane.mjs";
import { standing } from "../../src/gate.mjs";
import { freeIdleOrgs } from "../../src/journey.mjs";
import { sfFailure } from "../../src/io.mjs";
import { readLog, summarize } from "../../src/events.mjs";

export function orgCommands({ io, host, cards, tracker, flag, has, arg, output, say, log, sleep, orgs, record, freed }) {
  function orgLane(target, { card = true } = {}) {
    const org = names.orgFor(target);
    if (!org) throw new Error(`Not an org target: ${target}`);
    const { GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: sha, GITHUB_JOB: job } = process.env;
    const onWait = (h) => card && org.key && cards.refresh(org.key, { light: true, activity: { state: "running", what: `waiting for the story's scratch org: ${String(h.job).replace(/#\d+$/, "")} is using it`, url: `${host.repoUrl}/actions/runs/${h.run}` } }).catch(() => {});   // the card says why, not "deploying"
    return { org, l: lane({ api: host.api, repo: host.repo, holder: { run, job: `${job}#${attempt || 1}`, sha }, sleep, log, onWait }) };
  }

  return {
  "org ready": () => {   // Org provisioning: the target's org, holding the code in the working directory (org.mjs ready)
    let o;
    try { o = orgs().ready(arg(0), { hotfix: has("hotfix"), commit: io.git(["rev-parse", "HEAD"], { allowFail: true })?.trim(), manifest: flag("manifest"), refusal: storyRefusal(io.gh, flag("pr")) }); }
    catch (e) {
      if ((e.kind || sfFailure(e.message)) !== "slots") throw e;
      output({ waiting: true });   // no slot: the story waits in line
      if (!has("queue")) throw e;
      log(`::notice::${e.message.split("\n")[0]} The story is in line (waiting:org) and starts by itself when a slot frees up.`); return;   // --queue (issue-start): waiting is not a failure
    }
    if (o.created || o.completed) record("org", { action: o.created ? "created" : "completed", org: o.description, story: o.key });
    if (o.created && flag("pr")) io.gh(["issue", "edit", flag("pr"), "--remove-label", "org:released"], { allowFail: true });   // a released story org is back
    output({ alias: o.alias, created: o.created }); return say(o.alias);
  },
  "org advance": () => say(orgs().advance(arg(0), flag("sha"), (held) => advanceCovered(io.git, { held, head: flag("sha"), base: flag("base") })) ? `${arg(0)} holds ${flag("sha").slice(0, 7)}` : `${arg(0)} left as it was`),   // CI tested this commit
  "org ci": () => {   // CI's org for <target> (org.mjs ci): attached, completed, rebuilt once, or a temporary one (--alias) only when it must be
    const name = flag("alias");
    // no open PR (a hand-run CI on a merged story): the story org is not rebuilt, a temporary org runs it, as before
    const refusal = flag("pr") ? storyRefusal(io.gh, flag("pr")) : () => "no open PR for this run";
    let o;
    try { o = orgs().ci(arg(0), { name, commit: io.git(["rev-parse", "HEAD"], { allowFail: true })?.trim(), refusal, onTemp: () => output({ alias: name, temp: true }) }); }
    catch (e) { if (e.phase === "deploy") output({ "deploy-failed": true }); throw e; }   // the change's deploy: ci.yml's code-failed
    if (o.temp) record("org", { action: "created", org: o.description });
    else if (o.created || o.completed) record("org", { action: o.created ? "created" : "completed", org: o.description, story: o.key });
    if (o.created && !o.temp && flag("pr")) io.gh(["issue", "edit", flag("pr"), "--remove-label", "org:released"], { allowFail: true });   // a released story org is back
    output({ alias: o.alias, temp: o.temp, full: o.full }); return say(o.alias);
  },
  "org held": () => say(orgs().held(arg(0)) || ""),   // the commit the org holds (CI deploys what changed since it)
  "org attach": () => { const o = orgs().attach(arg(0)); output({ alias: o.alias }); return say(o.alias); },
  "org remove": () => { const o = names.orgFor(arg(0)); if (orgs().remove(arg(0))) record("org", { action: "deleted", org: o?.description, story: o?.key }); },
  "org remove-tagged": () => { if (orgs().removeTagged(arg(0))) record("org", { action: "deleted", org: arg(0) }); },
  "org prepare": () => { orgs().prepare(arg(0)); },
  "org deploy": () => { orgs().deploy(arg(0), { manifest: flag("manifest") }); },
  "org temp": () => { const o = orgs().temporary(arg(0)); record("org", { action: "created", org: o.description }); output({ alias: o.alias, temp: true }); return say(o.alias); },
  "org changes": () => { const o = orgs(), c = o.retrieveChanges(arg(0), o.setupChanges(arg(0), { exclude: JSON.parse(readFileSync("config/baseline.json", "utf8")).exclude })); output({ count: c.length }); return say(c.map((x) => `${x.type}:${x.name}`).join("\n") || "no Setup changes"); },
  "org capacity": () => {   // how much load this carries, and the settings for more; AI cost per story measured when the log has it
    const measured = summarize(readLog(io, { days: 90 })).ai.medianStoryUsd;
    const m = measured ? { ...capacity.MEASURED, aiUsdPerStory: measured } : capacity.MEASURED;
    return say(capacity.report(capacity.plan({ ...capacity.gather({ limits: () => orgs().limits(), flag, has }), uiPolicy: names.setting("UI_REGRESSION") || "release", m })));
  },
  // shipped stories' seeds (data/seed/stories/<key>) into the core seed, in the working directory (seed-fold.yml)
  "seed fold": () => {
    const dir = "data/seed", root = `${dir}/stories`;
    const keys = existsSync(root) ? readdirSync(root).filter((k) => existsSync(`${root}/${k}/plan.json`)).sort() : [];
    if (!keys.length) { output({ folded: 0 }); return say("no story seeds to fold"); }
    const read = (d) => Object.fromEntries(readdirSync(d).filter((f) => f.endsWith(".json") && f !== "plan.json").map((f) => [f, readFileSync(`${d}/${f}`, "utf8")]));
    const r = foldSeeds({ plan: JSON.parse(readFileSync(`${dir}/plan.json`, "utf8")), files: read(dir) }, keys.map((k) => ({ key: k, plan: JSON.parse(readFileSync(`${root}/${k}/plan.json`, "utf8")), files: read(`${root}/${k}`) })));
    for (const [f, t] of Object.entries(r.files)) writeFileSync(`${dir}/${f}`, t);
    writeFileSync(`${dir}/plan.json`, JSON.stringify(r.plan, null, 2) + "\n");
    for (const k of keys) rmSync(`${root}/${k}`, { recursive: true });
    output({ folded: keys.length, stories: keys.join(",") }); return say(`folded the seeds of ${keys.map((k) => `#${k}`).join(", ")} into data/seed`);
  },
  // after the masked production sample went into UAT: fail if any production email domain survived (uat-sample.yml)
  "sample guard": () => {
    const qs = sample.guardQueries(names.setting("UAT_SAMPLE_DOMAINS"));
    if (!qs.length) throw new Error("UAT_SAMPLE_DOMAINS is empty: the sample cannot be checked, so it is not trusted (set production's email domains)");
    const v = sample.sampleLeaks(qs.flatMap((q) => io.sf(["data", "query", "-o", flag("org", "uat"), "-q", q]).records || []));
    if (!v.ok) throw new Error(`the UAT sample still holds production emails (${v.leaked.join(", ")}): delete the UAT org's sample and fix config/uat-sample/export.json`);
    return say("no production email domain in the UAT sample");
  },
  "org limits": () => { const l = orgs().limits(); return say(`active scratch orgs ${l.active.remaining}/${l.active.max} free, created today ${l.daily.max - l.daily.remaining}/${l.daily.max}`); },
  "org sweep": async () => {
    // every orphan: CI orgs whose run died, merged or closed stories' orgs, staging and UAT orgs of sprints no longer open
    const live = orgs().live();   // the registry's own read, which sweep() then reuses
    const done = await doneStoryOrgs(live, { tracker, gh: io.gh, log });
    const gone = orgs().sweep({ isStoryDone: (d) => done.has(d), openSprint: names.sprintOf(host.openRelease() || ""), poolSize: Number(names.setting("ORG_POOL")) || 0 });
    for (const g of gone) record("org", { action: "deleted", org: g.description, why: g.why });
    await freed();   // every run, not only after a delete: a slot also frees by expiry or by hand
    return say(`deleted ${gone.length} orphan org(s)${gone.length ? `: ${gone.map((o) => `${o.description} (${o.why})`).join(", ")}` : ""}`);
  },
  "org make-room": async () => {   // FREE_IDLE_ORGS: a story waiting for a slot gets the org of a story PR that waits only for its approval
    if (names.setting("FREE_IDLE_ORGS") === "off") return say("FREE_IDLE_ORGS is off: waiting stories wait for a merge");
    const live = new Set(orgs().live().map((r) => r.Description));
    const removeOrg = (t) => { const o = names.orgFor(t); const gone = orgs().remove(t); if (gone) record("org", { action: "deleted", org: o?.description, story: o?.key, why: "idle: waits only for approval" }); return gone; };
    const f = freeIdleOrgs({ host, gh: io.gh, live, removeOrg, log });
    if (f.length) { for (const x of f) await cards.refreshPr(x.pr).catch(() => {}); await freed(); }
    return say(f.length ? `freed ${f.map((x) => `story ${x.key}'s org (PR #${x.pr})`).join(", ")}` : "no idle story org to free (or no story waits)");
  },
  "org pool": () => {   // the warm pool (ORG_POOL): make what is missing while a slot stays free beyond ORG_RESERVE
    const made = orgs().topUpPool(Number(names.setting("ORG_POOL")) || 0);
    return say(made.length ? `made ${made.join(", ")}` : "the warm pool is full (or off, or no slot to spare)");
  },
  "uat tester": async () => {   // a person's login, emailed by Salesforce, as the story's persona (or UAT_TESTER_ROLE); never a secret
    const story = names.storyOf(flag("alias", "")); const body = story ? (await tracker.story(story).catch(() => ({}))).body : "";
    const persona = orgPersona(body) || (names.setting("UAT_TESTER_ROLE") ? { role: names.setting("UAT_TESTER_ROLE"), permsets: [] } : null);
    const r = orgs().tester(flag("alias", "uat"), { login: flag("login"), email: flag("email"), persona, admin: has("admin") });
    const masked = flag("email").replace(/^(.).*?(@.*)$/, "$1***$2");
    io.gh(["issue", "comment", flag("pr"), "--body", `🔑 @${flag("login")}: Salesforce has emailed **${masked}** a link to set a password for **${flag("alias", "uat") === "uat" ? "UAT" : `the story's scratch org (${flag("alias")})`}**. Username: \`${r.username}\`. ${r.admin ? "System Administrator: build what the story needs in Setup, then tick **Bring my Setup changes into the story** (or comment /retrieve)." : r.persona.role ? `Role **${r.persona.role}**, permission sets ${r.persona.permsets.join(", ")}: you see what that user sees.` : `Every permission set in the code, no role (Standard User). If the feature is shared by role, set the story's \`Persona:\` line or UAT_TESTER_ROLE.`}`]);
    return say(r.username);
  },
  "lane acquire": () => {   // --park <kind>: if busy, park (the runner is given back; lane-wake re-runs the job) and output parked=true
    // --optional: a target with no org (a maintenance branch: CI's temporary org) prints nothing; any other failure (a
    // timeout, an API error) fails the step, so a job never uses an org another job holds
    if (has("optional") && !names.orgFor(arg(0))) return log(`no lane: ${arg(0)} has no org of its own`);
    const { org, l } = orgLane(arg(0), { card: !has("no-card") }), t0 = Date.now(), id = flag("park") && jobId({ api: host.api, repo: host.repo });   // --no-card: a read-only job
    const head = id ? io.git(["rev-parse", "HEAD"], { allowFail: true })?.trim() || null : null;   // the PR head this job works on (stillOwed on wake)
    const p = id ? l.park(org.lock, { kind: flag("park"), jobId: id, head }) : (l.acquire(org.lock, { timeoutMinutes: Number(flag("minutes", "45")) }), { held: true });
    if (!p.held) { output({ parked: true }); return say(`${p.dropped ? `a ${flag("park")} job already waits for` : "parked until lane-wake re-runs it:"} ${org.lock} (run ${p.waitingFor.run} holds it)`); }
    const waited = Math.round((Date.now() - t0) / 1000);
    if (waited > 30) record("lane", { lane: org.lock, waitedSeconds: waited, story: org.key });
    output({ lane: org.lock }); return say(org.lock);
  },
  "lane release": () => { const { org, l } = orgLane(arg(0)); if (l.release(org.lock) && l.waiters(org.lock).length) host.repoDispatch("lane-freed"); },
  "lane wake": async () => {   // --wait M: minutes to wait for a parked run to end (reconcile passes 1)
    const l = lane({ api: host.api, repo: host.repo, holder: {}, sleep, log }), dropped = [];
    const prOf = (w) => /PR #(\d+)/.exec(host.api("GET", `repos/${host.repo}/actions/runs/${w.run}`)?.display_title || "")?.[1] || null;   // ai-fix and ui-test run-names
    const owed = (w) => { const n = prOf(w); if (!n) return { owed: true, why: "no PR in the run's name" }; w.pr = n; const f = host.prFacts(n); return stillOwed({ kind: w.kind, parkedHead: w.head, pr: f.pr, st: standing(f) }); };
    const woken = wakeAll({ api: host.api, repo: host.repo, l, sleep, log, owed, onDropped: (w) => dropped.push(w.pr), waitMinutes: Number(flag("wait", "5")) });
    for (const n of new Set(dropped.filter(Boolean))) { host.forget(n); await cards.refreshPr(n); }   // the card stops saying it waits for the org
    return say(`re-ran ${woken.length} parked job(s)${dropped.length ? `; ${dropped.length} no longer owed` : ""}`);
  },
  "lane due": () => {   // reconcile: start lane-wake when a parked job waits for a free lane (its holder died without letting go)
    if (!wakeDue({ api: host.api, repo: host.repo, l: lane({ api: host.api, repo: host.repo, holder: {}, sleep, log }) })) return say("no parked job waits for a free lane");
    host.dispatch("lane-wake.yml"); return say("a parked job waits for a free lane: started lane-wake");
  },
  };
}
