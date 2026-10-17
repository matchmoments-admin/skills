// Slack actions (see GLOSSARY.md: Slack action): a Cloudflare Worker that receives the buttons on a Slack notice
// (pipeline/src/notify.mjs) and starts the same action a tick box on the card does. Slack gives it 3 seconds, so it
// answers at once and does the work after (ctx.waitUntil). It starts the pipeline with a repository_dispatch
// ("slack-act"); .github/workflows/slack.yml then runs `pipe act` as the person who clicked, so the pipeline's own
// rules apply unchanged (write access, the two-person rule). Approvals are never offered: a GitHub approval is the
// person's own review, so its button opens GitHub. No dependencies (Web Crypto, fetch): `wrangler deploy` from here.
//
// Settings (wrangler.toml [vars], and `wrangler secret put` for the secrets):
//   SLACK_SIGNING_SECRET  (secret) the Slack app's Basic Information › Signing Secret
//   SLACK_BOT_TOKEN       (secret) the app's Bot User OAuth Token: opens the "Answer in Slack" box (views.open)
//   GITHUB_TOKEN          (secret) a fine-grained token for this one repository, Contents: read and write (dispatches)
//   GITHUB_REPO           owner/name
//   SLACK_USERS           (secret) JSON {"<Slack user ID>": "<GitHub login>"}: who may act, and as whom

/** The actions a Slack button may start: the card's own boxes, for issues (specs and stories). Never an approval. */
export const ACTS = { spec: "/spec", story: "/story", "story-anyway": "/story", plan: "/plan", start: "/start", build: "/build" };
const MAX_AGE = 300;   // seconds: an older signed request is a replay

/** Is this request from Slack? Its v0 signature over the timestamp and the raw body, and not older than 5 minutes. */
export async function fromSlack({ body, timestamp, signature, secret, now = Math.floor(Date.now() / 1000) }) {
  if (!secret || !signature || !timestamp || Math.abs(now - Number(timestamp)) > MAX_AGE) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  const want = `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (want.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

const users = (env) => { try { return JSON.parse(env.SLACK_USERS || "{}"); } catch { return {}; } };
const value = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const number = (n) => (/^\d{1,7}$/.test(String(n)) ? Number(n) : null);

/**
 * What to do with one Slack interaction, decided without side effects. Returns
 * { ack } (the immediate HTTP answer), plus, when there is work: dispatch (the repository_dispatch payload),
 * reply (an ephemeral note to the clicker, through response_url) and/or modal (the "Answer in Slack" box to open).
 */
export function decide(payload, env) {
  const login = users(env)[payload.user?.id];
  const notLinked = { ack: "", reply: `Your Slack account is not linked to GitHub yet, so the pipeline cannot act as you. Ask a maintainer to add \`"${payload.user?.id}": "<your GitHub login>"\` to SLACK_USERS (docs/handbook.md, "Slack notices").` };
  if (payload.type === "block_actions") {
    const a = payload.actions?.[0] || {};
    if (a.url || !a.value) return { ack: "" };   // a link button: Slack opens it
    const v = value(a.value), n = number(v.n);
    if (!n) return { ack: "" };
    if (!login) return notLinked;
    if (v.act === "answer") return { ack: "", modal: { trigger_id: payload.trigger_id, view: answerView(n, v.title, v.cmd, v.q) } };
    if (!ACTS[v.act]) return { ack: "", reply: "That action cannot be started from Slack: open the card." };
    return { ack: "", dispatch: { number: n, command: ACTS[v.act], by: login, text: "" }, reply: `⏳ Done as @${login}: \`${ACTS[v.act]}\` on <https://github.com/${env.GITHUB_REPO}/issues/${n}|#${n}>. The card shows what happens next; this channel hears when it is your turn again.` };
  }
  if (payload.type === "view_submission" && payload.view?.callback_id === "answer") {
    const n = number(value(payload.view.private_metadata).n);
    const text = String(payload.view.state?.values?.answer?.text?.value || "").trim().slice(0, 4000);
    if (!n || !text) return { ack: JSON.stringify({ response_action: "errors", errors: { answer: "Write your answers first." } }) };
    if (!login) return { ack: JSON.stringify({ response_action: "errors", errors: { answer: notLinked.reply.slice(0, 150) } }) };
    // posted on the issue as the person's words, then the spec (or plan) is rewritten with them
    return { ack: JSON.stringify({ response_action: "clear" }), dispatch: { number: n, command: value(payload.view.private_metadata).cmd === "/plan" ? "/plan" : "/spec", by: login, text } };
  }
  return { ack: "" };
}

/** The "Answer in Slack" box: one text field; the answers land on the issue and the spec is rewritten with them. */
export function answerView(n, title = "", cmd = "/spec", questions = "") {
  return { type: "modal", callback_id: "answer", private_metadata: JSON.stringify({ n, cmd: cmd === "/plan" ? "/plan" : "/spec" }),
    title: { type: "plain_text", text: `Answer #${n}`.slice(0, 24) }, submit: { type: "plain_text", text: "Send and rewrite" }, close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${title ? `*${title}*\n` : ""}Answer the open questions (numbered, as the spec asks them) or say what to change. Your words go on the issue as yours, then Claude rewrites the ${cmd === "/plan" ? "plan" : "spec"} with them.` } },
      ...(questions ? [{ type: "section", text: { type: "mrkdwn", text: `*The open questions*\n${String(questions).replace(/\*\*([^*]+)\*\*/g, "*$1*").slice(0, 2900)}` } }] : []),
      { type: "input", block_id: "answer", label: { type: "plain_text", text: "Your answers" }, element: { type: "plain_text_input", action_id: "text", multiline: true } },
    ] };
}

// one JSON line per event in the Worker's logs (wrangler tail, or the dashboard's Logs): never a secret or what was typed
const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));
const tell = async (payload, text) => {
  if (!payload.response_url) return;
  try {
    const r = await fetch(payload.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }) });
    if (!r.ok) log("reply-failed", { status: r.status });
  } catch (e) { log("reply-error", { error: String(e.message || e) }); }
};

async function work(d, env, payload) {
  if (d.modal) {
    try {
      const r = await fetch("https://slack.com/api/views.open", { method: "POST", headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${env.SLACK_BOT_TOKEN}` }, body: JSON.stringify(d.modal) });
      const j = await r.json().catch(() => ({}));
      log("views.open", { ok: Boolean(j.ok), status: r.status, error: j.error, messages: j.response_metadata?.messages });
      if (!j.ok) d.reply = `The answer box did not open (${j.error || r.status}${j.response_metadata?.messages ? `: ${j.response_metadata.messages.join("; ")}` : ""}). Answer in a comment on the issue instead.`;
    } catch (e) { log("views.open-error", { error: String(e.message || e) }); d.reply = "The answer box did not open. Answer in a comment on the issue instead."; }
  }
  if (d.dispatch) {
    try {
      const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, { method: "POST",
        headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "sf-pipeline-slack", "content-type": "application/json" },
        body: JSON.stringify({ event_type: "slack-act", client_payload: d.dispatch }) });
      log("dispatch", { status: r.status, number: d.dispatch.number, command: d.dispatch.command, by: d.dispatch.by, typed: d.dispatch.text.length });
      if (r.status !== 204) d.reply = `The pipeline was not started (GitHub said ${r.status}${r.status === 401 || r.status === 403 || r.status === 404 ? ": the Worker's GITHUB_TOKEN cannot send dispatches to this repository" : ""}). Use the card instead.`;
    } catch (e) { log("dispatch-error", { error: String(e.message || e) }); d.reply = "The pipeline was not started (GitHub did not answer). Use the card instead."; }
  }
  if (d.reply) await tell(payload, d.reply);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("SF Pipeline: Slack actions. POST only.", { status: 405 });
    try {
      const body = await request.text();
      const ok = await fromSlack({ body, timestamp: request.headers.get("x-slack-request-timestamp"), signature: request.headers.get("x-slack-signature"), secret: env.SLACK_SIGNING_SECRET });
      if (!ok) { log("bad-signature", { secretSet: Boolean(env.SLACK_SIGNING_SECRET), age: Math.floor(Date.now() / 1000) - Number(request.headers.get("x-slack-request-timestamp")) }); return new Response("bad signature", { status: 401 }); }
      const payload = value(new URLSearchParams(body).get("payload"));
      const d = decide(payload, env);
      log("interaction", { type: payload.type, callback: payload.view?.callback_id, action: (() => { try { return JSON.parse(payload.actions?.[0]?.value || "{}").act; } catch { return null; } })() ?? (payload.actions?.[0]?.url ? "link" : undefined),
        user: payload.user?.id, linked: Boolean(users(env)[payload.user?.id]), ack: d.ack ? JSON.parse(d.ack).response_action : "", dispatch: Boolean(d.dispatch), modal: Boolean(d.modal) });
      if (d.dispatch || d.reply || d.modal) ctx.waitUntil(work(d, env, payload).catch((e) => log("work-error", { error: String(e.message || e) })));
      return new Response(d.ack, { status: 200, headers: d.ack ? { "content-type": "application/json" } : {} });
    } catch (e) {
      // never a Slack error screen: answer 200 and say so in the logs
      log("error", { error: String(e.message || e), stack: String(e.stack || "").split("\n").slice(0, 3).join(" | ") });
      return new Response("", { status: 200 });
    }
  },
};
