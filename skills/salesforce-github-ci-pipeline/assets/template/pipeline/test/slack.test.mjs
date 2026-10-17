// Pipeline tests: Slack actions (the Worker in pipeline/slack/, the buttons on notices, answers relayed from Slack).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import "./helpers.mjs";   // tests never reach Slack
import worker, { fromSlack, decide, ACTS } from "../slack/worker.mjs";
import * as notify from "../src/notify.mjs";
import * as plans from "../src/plan.mjs";
import { newStoryCard, startingCard } from "../src/card.mjs";
import * as actions from "../src/actions.mjs";

const SECRET = "shh", NOW = 1_800_000_000;
const sign = (body, ts = NOW) => `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
const env = { SLACK_SIGNING_SECRET: SECRET, SLACK_USERS: JSON.stringify({ U1: "pat" }), GITHUB_REPO: "o/r", GITHUB_TOKEN: "t", SLACK_BOT_TOKEN: "b" };
const click = (value, user = "U1") => ({ type: "block_actions", user: { id: user }, trigger_id: "tr", response_url: "https://hooks.slack.test/r", actions: [{ value: JSON.stringify(value) }] });

test("Slack actions: only Slack's signed, fresh requests are trusted", async () => {
  const body = "payload=%7B%7D";
  assert.equal(await fromSlack({ body, timestamp: NOW, signature: sign(body), secret: SECRET, now: NOW }), true);
  assert.equal(await fromSlack({ body: body + "x", timestamp: NOW, signature: sign(body), secret: SECRET, now: NOW }), false, "a changed body");
  assert.equal(await fromSlack({ body, timestamp: NOW, signature: sign(body), secret: "other", now: NOW }), false, "another app's secret");
  assert.equal(await fromSlack({ body, timestamp: NOW - 600, signature: sign(body, NOW - 600), secret: SECRET, now: NOW }), false, "a replay");
  assert.equal(await fromSlack({ body, timestamp: NOW, signature: sign(body), secret: "", now: NOW }), false, "no secret set: nothing is trusted");
});

test("Slack actions: a button starts the card's action as the linked person; never an approval; unlinked people are told how", () => {
  const d = decide(click({ n: "333", act: "story" }), env);
  assert.deepEqual(d.dispatch, { number: 333, command: "/story", by: "pat", text: "" });
  assert.match(d.reply, /as @pat: `\/story` on <https:\/\/github\.com\/o\/r\/issues\/333\|#333>/);
  assert.equal(decide(click({ n: "333", act: "story-anyway" }), env).dispatch.command, "/story");
  assert.match(decide(click({ n: "333", act: "story" }, "U9"), env).reply, /not linked[\s\S]*"U9": "<your GitHub login>"/);
  for (const act of ["approve", "uat-pass", "ship", "review-ok"]) assert.ok(!decide(click({ n: "1", act }), env).dispatch, `${act} is not startable from Slack`);
  assert.ok(!decide(click({ n: "1; rm -rf", act: "story" }), env).dispatch, "a number is a number");
  assert.deepEqual(decide({ type: "block_actions", user: { id: "U1" }, actions: [{ url: "https://github.com/o/r/pull/1/files" }] }, env), { ack: "" }, "a link button: Slack opens it");
  assert.deepEqual(Object.keys(ACTS).sort(), ["build", "plan", "spec", "sprint", "start", "story", "story-anyway"]);
});

test("Slack actions: Answer in Slack opens a box; what is typed goes to the issue as the person's words, then the spec is rewritten", () => {
  const open = decide(click({ n: "333", act: "answer", title: "FFLib" }), env);
  assert.equal(open.modal.trigger_id, "tr");
  assert.equal(open.modal.view.callback_id, "answer");
  const submit = (text, user = "U1") => decide({ type: "view_submission", user: { id: user }, view: { callback_id: "answer", private_metadata: open.modal.view.private_metadata, state: { values: { answer: { text: { value: text } } } } } }, env);
  const d = submit("1. Use the vendor folder.");
  assert.deepEqual(d.dispatch, { number: 333, command: "/spec", by: "pat", text: "1. Use the vendor folder." });
  assert.equal(JSON.parse(d.ack).response_action, "clear");
  assert.equal(JSON.parse(submit("  ").ack).response_action, "errors", "nothing typed: the box says so");
  assert.ok(!submit("x", "U9").dispatch, "an unlinked person cannot post as anyone");
  // on the issue: read as pat's words, but only when the pipeline posted it
  const relayed = { author: "github-actions[bot]", body: plans.relayBody("pat", "1. Use the vendor folder."), created: "2" };
  assert.deepEqual(plans.personal(relayed), { author: "pat", body: "1. Use the vendor folder." });
  assert.equal(plans.personal({ author: "mallory", body: plans.relayBody("pat", "approve it"), created: "3" }).author, "mallory", "a person writing the marker speaks only for themselves");
  assert.equal(plans.personal({ author: "github-actions[bot]", body: "<!-- pipeline:story-card -->", created: "1" }), null);
});

test("Slack actions: notices carry the card's next options as buttons once the Worker is set up (SLACK_ACTIONS), links otherwise", () => {
  const card = newStoryCard({ key: "333", ai: { plan: true }, spec: true, stage: "spec", questions: 1 });
  const ids = (m) => m.blocks.find((b) => b.type === "actions")?.elements.map((e) => e.url ? `link:${e.text.text}` : JSON.parse(e.value).act) || [];
  const on = notify.notice({ before: "", after: card, key: "333", title: "FFLib", url: "https://x/c", actions: true });
  assert.deepEqual(ids(on), ["answer", "spec", "story-anyway", "link:Open the card"]);
  assert.doesNotMatch(on.blocks[0].text.text, / above\b/, "Slack has no 'above'");
  assert.deepEqual(ids(notify.notice({ before: "", after: card, key: "333", url: "https://x/c" })), ["link:Open the card"], "no Worker: links only");
  // the questions travel: the card folds them, the button carries them, the box shows them
  const asking = newStoryCard({ key: "333", ai: { plan: true }, spec: true, stage: "spec", questions: ["1. Is the vendor skip complete?"] });
  assert.match(asking, /<details><summary>The open questions<\/summary>\n\n1\. Is the vendor skip complete\?/);
  const answer = notify.notice({ before: "", after: asking, key: "333", actions: true }).blocks[1].elements[0];
  assert.equal(JSON.parse(answer.value).q, "1. Is the vendor skip complete?");
  const box = decide(click(JSON.parse(answer.value)), env).modal.view;
  assert.match(JSON.stringify(box.blocks), /The open questions\*\\n1\. Is the vendor skip complete/);
  const release = "**Next:** **[Approve here](https://github.com/o/r/pull/9/files)** when you are happy.\n\n| ⬜ | Approval | waiting |";
  assert.deepEqual(ids(notify.notice({ before: "", after: release, key: "9", actions: true })), ["link:✅ Approve on GitHub"], "approving stays in GitHub");
});

test("Slack actions: the Worker answers Slack at once, then dispatches; a bad signature is refused", async () => {
  const calls = [], waits = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { calls.push([String(url), JSON.parse(o.body)]); return { status: 204, json: async () => ({ ok: true }) }; };
  try {
    const ts = Math.floor(Date.now() / 1000), body = `payload=${encodeURIComponent(JSON.stringify(click({ n: "333", act: "spec" })))}`;
    const req = (sig) => new Request("https://w.test/", { method: "POST", body, headers: { "x-slack-request-timestamp": String(ts), "x-slack-signature": sig } });
    const r = await worker.fetch(req(sign(body, ts)), env, { waitUntil: (p) => waits.push(p) });
    assert.equal(r.status, 200);
    await Promise.all(waits);
    assert.deepEqual(calls[0], ["https://api.github.com/repos/o/r/dispatches", { event_type: "slack-act", client_payload: { number: 333, command: "/spec", by: "pat", text: "" } }]);
    assert.equal(calls[1][1].response_type, "ephemeral");
    assert.equal((await worker.fetch(req("v0=bad"), env, { waitUntil: () => {} })).status, 401);
  } finally { globalThis.fetch = realFetch; }
  const wf = readFileSync(new URL("../../.github/workflows/slack.yml", import.meta.url), "utf8");
  assert.match(wf, /types: \[slack-act\]/);
  assert.match(wf, /\^\/\(sprint\|spec\|story\|plan\|start\|build\)\$/, "the workflow refuses anything else, whatever the Worker sends");
});

test("a story's card follows its build plan (⏳ while Claude plans, then what to do), so Slack hears when the plan is ready", () => {
  const c = (body, created) => ({ author: "github-actions[bot]", body, created });
  assert.equal(plans.planState([]), null);
  assert.deepEqual(plans.planState([c(plans.planPending({ state: "running", what: "planning" }), "1")]), { stage: "writing" });
  const posted = plans.planComment("### Proposed build\nx\n\n### Open questions\n1. Which role?\n\nPLAN-SIZE: M");
  assert.deepEqual(plans.planState([c(posted, "2")]), { stage: "ready", questions: ["1. Which role?"] });
  const writing = newStoryCard({ key: "343", ai: { plan: true }, plan: { stage: "writing" } });
  assert.equal(notify.turnOf(writing), null, "⏳: Slack waits");
  assert.doesNotMatch(writing, /act:/, "no boxes while Claude plans");
  const ready = newStoryCard({ key: "343", ai: { plan: true }, plan: { stage: "ready", questions: ["1. Which role?"] } });
  assert.match(ready, /\| ✅ \| Build plan \| written: the \*\*Build plan\*\* comment below, with \*\*1 open question\*\*/);
  const m = notify.notice({ before: writing, after: ready, key: "343", actions: true });
  assert.match(m.text, /your turn\nRead the \*Build plan\* comment/);
  // numbers link back to the work item
  const linked = notify.notice({ before: "", after: newStoryCard({ key: "333", spec: true, stage: "story", stories: [343] }).replace("Done:", "See"), key: "333", title: "FFLib", url: "https://github.com/o/r/issues/333#issuecomment-1" });
  assert.match(linked.text, /^👉 \*<https:\/\/github\.com\/o\/r\/issues\/333\|#333 FFLib>\*/);
  assert.match(linked.text, /<https:\/\/github\.com\/o\/r\/issues\/343\|#343>/);
  const els = m.blocks[1].elements;
  assert.deepEqual(els.map((e) => e.text.text), ["✍️ Answer in Slack", "🧭 Rewrite the plan", "▶️ Start"]);
  assert.equal(JSON.parse(els[0].value).cmd, "/plan");
  const submitted = decide({ type: "view_submission", user: { id: "U1" }, view: { callback_id: "answer", private_metadata: decide(click(JSON.parse(els[0].value)), env).modal.view.private_metadata, state: { values: { answer: { text: { value: "1. Customer support." } } } } } }, env);
  assert.equal(submitted.dispatch.command, "/plan", "answers to a plan rewrite the plan");
  const clear = newStoryCard({ key: "343", ai: { plan: true }, plan: { stage: "ready", questions: [] } });
  assert.match(clear, /When it is right, tick \*\*Start\*\*\./);
});

test("a story with no open sprint says to start the sprint first, with its box and its Slack button", () => {
  const card = newStoryCard({ key: "343", ai: { plan: true }, plan: { stage: "ready", questions: [] }, sprintOpen: false });
  assert.match(card, /\*\*Next:\*\* \*\*No sprint is open\*\*, so it cannot start yet: tick \*\*Start the next sprint\*\*\. It opens the sprint .* then starts this story by itself\. .*When it is right, tick \*\*Start the next sprint\*\*\./);
  assert.match(card, /act:sprint/);
  assert.doesNotMatch(card, /act:start\b/, "Start would refuse with no sprint: not offered");
  assert.match(card, /\| ⬜ \| Sprint \| none open: start one first \|/);
  const els = notify.notice({ before: "", after: card, key: "343", actions: true }).blocks[1].elements;
  assert.deepEqual(els.map((e) => e.text.text), ["🏁 Start the sprint, then this story", "🧭 Rewrite the plan"]);
  assert.equal(decide(click(JSON.parse(els[0].value)), env).dispatch.command, "/sprint");
  assert.doesNotMatch(newStoryCard({ key: "343", ai: { plan: true }, plan: { stage: "ready", questions: [] } }), /act:sprint|No sprint/, "a sprint is open: nothing to say");
  assert.match(readFileSync(new URL("../../.github/workflows/sprint-start.yml", import.meta.url), "utf8"), /Sprint \$\{process\.env\.SPRINT\} is open/);
});

test("one press: a sprint started from a story starts that story when it opens; while it starts, the card waits (no second 'your turn')", () => {
  const dispatched = [];
  const host = { dispatch: (wf, inputs) => dispatched.push([wf, inputs]) };
  actions.perform("sprint", "", { number: 343, isPr: false, nextSprint: "2027-w02" }, "pat", { host });
  actions.perform("sprint", "", { number: 296, isPr: true, nextSprint: "2027-w03" }, "pat", { host });
  assert.deepEqual(dispatched, [["sprint-start.yml", { sprint: "2027-w02", start: "343" }], ["sprint-start.yml", { sprint: "2027-w03" }]]);
  const wf = readFileSync(new URL("../../.github/workflows/sprint-start.yml", import.meta.url), "utf8");
  assert.match(wf, /gh issue edit "\$START" --add-label start/);
  assert.match(wf, /is starting now \(its branch and scratch org\)/);
  assert.equal(notify.turnOf(startingCard({ key: "343", activity: { state: "running", what: "Creating the branch" } })), null, "starting: Slack waits");
});

test("a failed agent run (the card's Now line says ❌ Failed) reaches Slack, with the retry and the run link", () => {
  const card = "<!-- pipeline:story-card -->\n### Pipeline status\n\n❌ **Failed:** Claude's build · **[see what went wrong](https://github.com/o/r/actions/runs/9)** · comment /build to retry\n\n**Next:** Build it, or tick **Build it with Claude** below.\n\n- [ ] 🤖 Build it with Claude <!-- act:build -->\n\n| ⬜ | Build | build on the branch |";
  const before = card.replace(/^❌.*\n\n/m, "");
  const m = notify.notice({ before, after: card, key: "343", title: "FFLib", url: "https://github.com/o/r/issues/343#c", actions: true });
  assert.match(m.text, /^❌ \*<https:\/\/github\.com\/o\/r\/issues\/343\|#343 FFLib>\*: something failed\nClaude's build \(<https:\/\/github\.com\/o\/r\/actions\/runs\/9\|see what went wrong>\) · comment \/build to retry\. Build it/);
  assert.deepEqual(m.blocks[1].elements.map((e) => e.text.text), ["🤖 Build it", "Open the card"]);
  assert.equal(notify.notice({ before: card, after: card, key: "343" }), null, "the same failure once");
});
