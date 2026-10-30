// Shared fakes, fixtures and helpers for the pipeline tests (pipeline/test/*.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
// tests never reach Slack: CI carries SLACK_WEBHOOK_URL for the cards, and a card test would post to the real channel
delete process.env.SLACK_WEBHOOK_URL;
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

process.env.PIPELINE_BOTS = "github-actions,__owner__-pipeline";   // the pipeline's identities, as the repo variable sets them

export const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/pr-${n}.json`, import.meta.url)));

export const open = (f, pr = {}) => ({ ...f, pr: { ...f.pr, state: "OPEN", mergeable: "MERGEABLE", ...pr } });   // as it was before merging

export const ok = (sha, context, at = "2026-10-04T12:00:00Z") => ({ sha, context, state: "success", created_at: at, creator: { login: "github-actions[bot]" } });

export const FULL_AI = { review: true, uiTest: true };   // the flags these real PRs ran under

export const withVerdicts = (f, extra = {}) => ({
  ...open(f), ai: FULL_AI, statuses: [ok(f.pr.headRefOid, gate.STATUS.review), ok(f.pr.headRefOid, gate.STATUS.ui)], ...extra,
});

export const uiPassed = (f) => ({ ...f, statuses: [...(f.statuses || []), { sha: f.pr.headRefOid, context: gate.STATUS.uiRegression, state: "success", created_at: "2026-10-05T00:00:00Z", creator: { login: "github-actions[bot]" } }] });

export function fakeSf(records, { ready = true, installed = [] } = {}) {
  const calls = [];
  const sf = (args, opts) => {
    calls.push(args.slice(0, 3).join(" "));
    if (args[0] === "data" && args[1] === "query" && /FROM User/.test(args.at(-1))) return { records: [{ Title: ready ? "pipeline: ready" : null }] };
    if (args[0] === "package" && args[1] === "installed") return installed.map((id) => ({ SubscriberPackageVersionId: id }));
    if (args[0] === "data" && args[1] === "query") return { records };
    if (args[0] === "org" && args[1] === "display") return { clientId: "CID", username: "u@x" };
    return {};
  };
  return { sf, calls };
}

export const fakeJev = (answers, status = 200) => typesafeJev("apik-test", async (url, init) => {
  fakeJev.last = JSON.parse(init.body);
  return { ok: status === 200, status, json: async () => ({ model: "jev-1.13.0", answers, usage: { input_tokens: 10 } }) };
});

export const src = {
  "force-app/c/AccountSelector.cls": "public class AccountSelector {}",
  "force-app/c/AccountSelectorTest.cls": "@isTest class AccountSelectorTest { AccountSelector s; }",
  "force-app/c/CaseHandler.cls": "public class CaseHandler {}",
  "force-app/c/CaseHandlerTest.cls": "@IsTest class CaseHandlerTest { CaseHandler h; Case c; }",
  "force-app/c/Orphan.cls": "public class Orphan {}",
  "force-app/t/CaseTrigger.trigger": "trigger CaseTrigger on Case (before insert) {}",
  "force-app/f/flows/Web_Priority.flow-meta.xml": "<Flow><start><object>Case</object></start></Flow>",
  "force-app/f/flowtests/Web_Medium.flowtest-meta.xml": "<FlowTest><flowApiName>Web_Priority</flowApiName></FlowTest>",
  "force-app/o/Account/fields/Tier__c.field-meta.xml": "<CustomField/>",
};

export const files = Object.keys(src), read = (p) => src[p] || "";

export const pick = (changed, extra = {}) => tests.selectTests({ changed, files, read, ...extra });

export const repo = (map) => ({ files: Object.keys(map), read: (p) => map[p] ?? "" });

export const O = "force-app/main/default";

export const SHA = "a".repeat(40), TREE = "t".repeat(40);

export function fakeRefs({ runs = {} } = {}) {
  const refs = {}, commits = { base: { tree: { sha: "T" } } };
  let failClaims = 0;
  let n = 0;
  const api = (method, path, body) => {
    if (method === "GET" && path.endsWith("/commits/main")) return { sha: "base", commit: { tree: { sha: "T" } } };
    if (method === "GET" && path.includes("/git/matching-refs/")) { const pre = `refs/${path.split("/git/matching-refs/")[1]}`; return Object.keys(refs).filter((r) => r.startsWith(pre)).map((ref) => ({ ref, object: { sha: refs[ref] } })); }
    if (method === "POST" && path.endsWith("/git/commits") && failClaims > 0) { failClaims--; return { status: 422, message: "tree not found" }; }
    if (method === "POST" && path.endsWith("/git/commits")) { const sha = `c${++n}`; commits[sha] = { message: body.message, parents: body.parents, tree: { sha: body.tree } }; return { sha }; }
    if (method === "GET" && path.includes("/git/commits/")) return commits[path.split("/").pop()];
    if (method === "GET" && path.includes("/actions/runs/")) return { status: runs[/actions\/runs\/(\d+)/.exec(path)[1]] || "in_progress" };
    const name = path.split("/git/")[1];
    if (method === "POST" && path.endsWith("/git/refs")) { if (refs[body.ref]) return { status: 422 }; refs[body.ref] = body.sha; return { ref: body.ref }; }
    if (method === "GET") return refs[name] ? { object: { sha: refs[name] } } : { status: 404 };
    if (method === "PATCH") { if (!commits[body.sha].parents.includes(refs[name])) return { status: 422 }; refs[name] = body.sha; return {}; }
    if (method === "DELETE") { delete refs[name]; return {}; }
    throw new Error(`${method} ${path}`);
  };
  return { api, refs, commits, failClaims: (n) => { failClaims = n; } };
}

export function fakeGitHub() {
  const calls = [];
  const io = {
    run: (cmd, args, o) => {
      calls.push(`${args[2]} ${args[3]}`);
      if (args[3].endsWith("/check-runs") && args[2] === "POST") return JSON.stringify({ id: 7 });
      if (args[3].includes("/missing")) throw new Error("gh api failed: gh: Not Found (HTTP 404)");
      return "";
    },
    gh: (args) => { calls.push(args.slice(0, 3).join(" ")); if (args[0] === "pr" && args[1] === "list") return [{ number: 90, state: "OPEN", baseRefName: "release/w45", headRefOid: "h" }]; if (args[0] === "api" && /matching-refs/.test(args[1])) return [{ ref: "refs/heads/release/w45" }]; return null; },
    ghPages: () => [],
  };
  return { io, calls };
}

export const scratchSkill = new URL("../../.claude/skills/salesforce-scratch-org-tests/scripts/engine/tests.mjs", import.meta.url);

export const webp = (kb = 10) => { const b = Buffer.alloc(kb * 1024); b.write("RIFF", 0, "latin1"); b.write("WEBP", 8, "latin1"); return b; };

export const meta = (o) => Buffer.from(JSON.stringify(o));

export function provisionSf({ live = [], title = null, snapshotWorks = true } = {}) {
  const calls = [];
  const sf = (args, opts) => {
    const c = args.join(" ");
    calls.push(c);
    if (args[0] === "limits") return [{ name: "ActiveScratchOrgs", remaining: 2, max: 3 }, { name: "DailyScratchOrgs", remaining: 5, max: 6 }];
    if (args[0] === "data" && args[1] === "query" && /FROM User WHERE Username/.test(c)) return { records: [{ Title: title }] };
    if (args[0] === "data" && args[1] === "query" && /FROM UserRole/.test(c)) return { records: [{ Id: "00E1" }] };
    if (args[0] === "data" && args[1] === "query") return { records: live };
    if (args[0] === "org" && args[1] === "display") return { clientId: "CID", username: "u@x", id: "00Dxx0000000001" };
    if (args[0] === "org" && args[1] === "create" && args[2] === "scratch" && c.includes("snapshot-")) { if (!snapshotWorks) throw new Error("sf org failed: SN-0001 The snapshot has expired"); return {}; }
    if (args[0] === "org" && args[1] === "create" && args[2] === "user") return { fields: { id: "005u" } };
    return {};
  };
  return { sf, calls };
}

export function deliveryIo(data) {
  const gh = (a) => {
    if (a[0] === "api" && /\/actions\/runs\/\d+$/.test(a[a.length - 1])) return data[a[a.length - 1]] ?? { event: "workflow_dispatch", head_branch: "main" };
    if (a[0] === "api") return data[a[a.length - 1]] ?? null;
    if (a[0] === "pr" && a[1] === "view") return data["pr view"];
    if (a[0] === "issue" && a[1] === "view") return data[`issue view ${a[2]}`] ?? null;
    if (a[0] === "issue" && a[1] === "list") return [];
    if (a[0] === "pr" && a[1] === "list") return data[`pr list ${(a.find((x) => /^head:|^release\//.test(x)) || "").replace("head:", "")}`] || [];
    return null;
  };
  const ghPages = (path, key) => { const v = data[path]; return key ? v?.[key] || [] : (v || []).map((x) => (x.context && !x.target_url ? { ...x, target_url: "https://github.com/o/r/actions/runs/1" } : x)); };
  return { gh, ghPages };
}

export const BOT = { login: "github-actions[bot]" };

export const wfSteps = async (file, job) => {
  const { createRequire } = await import("node:module");
  const doc = createRequire(import.meta.url)("js-yaml").load(readFileSync(new URL(`../../.github/workflows/${file}.yml`, import.meta.url), "utf8"));
  return doc.jobs[job].steps.map((st) => `${st.uses || ""} ${st.run || ""} ${st.name || ""}`);
};

export const pipeSources = () => [new URL("../bin/pipe.mjs", import.meta.url), ...readdirSync(new URL("../bin/commands/", import.meta.url)).map((f) => new URL(`../bin/commands/${f}`, import.meta.url))].map((u) => readFileSync(u, "utf8")).join("\n");

export const st_ = (over = {}) => ({ route: "feature", review: { state: "missing" }, ui: { state: "missing" }, uat: { state: "missing" }, checks: { [names.CHECKS.apex]: { state: "passed" } }, ...over });

/**
 * Run a Playwright check suite (pipeline/test/<name>/playwright.config.ts: local pages, no org) in a real browser, or
 * skip the node test when no Playwright Chromium is installed (CI installs it in static checks when a helper changed).
 * The exit code decides; on a failure Playwright's own output is in the assertion. Returns its output, or null if skipped.
 */
export async function playwrightCheck(t, config, { env = {}, timeout = 180_000 } = {}) {
  const { chromium } = await import("@playwright/test");
  if (!existsSync(chromium.executablePath())) { t.skip("no Playwright Chromium here (CI installs it in static checks)"); return null; }
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("npx", ["playwright", "test", "-c", config], { encoding: "utf8", timeout, env: { ...process.env, ...env }, cwd: new URL("../../", import.meta.url).pathname });
  if (r.status !== 0) assert.fail(`playwright -c ${config} ${r.error ? `did not finish (${r.error.message})` : `exited ${r.status}`}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
