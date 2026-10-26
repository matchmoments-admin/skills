// The orgs and lanes commands of `pipe` (see the header of pipeline/bin/pipe.mjs): Org provisioning, the scratch-org
// janitor, testers, and the Lane (one job at a time in an org). pipe.mjs passes its shared context (io, host, flags,
// output); the decisions live in pipeline/src/org.mjs and lane.mjs.
import { readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import * as names from "../../src/conventions.mjs";
import * as capacity from "../../src/capacity.mjs";
import * as sample from "../../src/sample.mjs";
import { personaOf as orgPersona, storyRefusal, doneStoryOrgs, advanceCovered, foldSeeds } from "../../src/org.mjs";
import { lane, jobId, wakeAll } from "../../src/lane.mjs";
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
    catch (e) { if ((e.kind || sfFailure(e.message)) === "slots") output({ waiting: true }); throw e; }   // no slot: the story waits in line
    if (o.created || o.completed) record("org", { action: o.created ? "created" : "completed", org: o.description, story: o.key });
    output({ alias: o.alias, created: o.created }); return say(o.alias);
  },
  "org advance": () => say(orgs().advance(arg(0), flag("sha"), (held) => advanceCovered(io.git, { held, head: flag("sha"), base: flag("base") })) ? `${arg(0)} holds ${flag("sha").slice(0, 7)}` : `${arg(0)} left as it was`),   // CI tested this commit
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
    const live = io.sf(["data", "query", "-o", "devhub", "-q", "SELECT Description, CreatedDate FROM ScratchOrgInfo WHERE Status = 'Active'"]).records || [];
    const done = await doneStoryOrgs(live, { tracker, gh: io.gh, log });
    const gone = orgs().sweep({ isStoryDone: (d) => done.has(d), openSprint: names.sprintOf(host.openRelease() || ""), poolSize: Number(names.setting("ORG_POOL")) });
    for (const g of gone) record("org", { action: "deleted", org: g.description, why: g.why });
    await freed();   // every run, not only after a delete: a slot also frees by expiry or by hand
    return say(`deleted ${gone.length} orphan org(s)${gone.length ? `: ${gone.map((o) => `${o.description} (${o.why})`).join(", ")}` : ""}`);
  },
  "org pool": () => {   // the warm pool (ORG_POOL): make what is missing while a slot stays free beyond ORG_RESERVE
    const made = orgs().topUpPool(Number(names.setting("ORG_POOL")));
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
    const { org, l } = orgLane(arg(0), { card: !has("no-card") }), t0 = Date.now(), id = flag("park") && jobId({ api: host.api, repo: host.repo });   // --no-card: a read-only job
    const p = id ? l.park(org.lock, { kind: flag("park"), jobId: id }) : (l.acquire(org.lock, { timeoutMinutes: Number(flag("minutes", "45")) }), { held: true });
    if (!p.held) { output({ parked: true }); return say(`${p.dropped ? `a ${flag("park")} job already waits for` : "parked until lane-wake re-runs it:"} ${org.lock} (run ${p.waitingFor.run} holds it)`); }
    const waited = Math.round((Date.now() - t0) / 1000);
    if (waited > 30) record("lane", { lane: org.lock, waitedSeconds: waited, story: org.key });
    output({ lane: org.lock }); return say(org.lock);
  },
  "lane release": () => { const { org, l } = orgLane(arg(0)); if (l.release(org.lock) && l.waiters(org.lock).length) host.repoDispatch("lane-freed"); },
  "lane wake": () => say(`re-ran ${wakeAll({ api: host.api, repo: host.repo, l: lane({ api: host.api, repo: host.repo, holder: {}, sleep, log }), sleep, log }).length} parked job(s)`),
  };
}
