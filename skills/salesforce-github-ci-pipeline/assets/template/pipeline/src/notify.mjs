// Slack notices (see GLOSSARY.md: Slack notice). Optional: with the SLACK_WEBHOOK_URL secret set, one channel hears when a
// card's turn changes: a person is needed (the card's Next line), something failed, or it shipped. Never while the
// pipeline is working (a ⏳ row), and never twice for the same turn: the card before the update is compared with the
// card after it, as notifyNeeds does for @mentions. Its buttons start the card's actions through the Slack actions
// Worker (pipeline/slack/worker.mjs). Pure, except slackNotifier(), which posts through fetch.

/** Whose move a card shows: { kind: "you" | "failed" | "shipped", next } or null (nothing to do, or the pipeline is on it). */
export function turnOf(body) {
  const next = String(body || "").match(/^\*\*Next:\*\* (.+)$/m)?.[1]?.trim();
  if (!next) return null;
  if (/^\| ❌ \|/m.test(body)) return { kind: "failed", next };
  if (/^Done: shipped in /.test(next) || /^\| ✅ \| In production \|/m.test(body)) return { kind: "shipped", next };
  if (/^\| ⏳ \|/m.test(body) || /^Done:/.test(next)) return null;
  return { kind: "you", next };
}

/** Markdown (the card's) to Slack's mrkdwn: **bold**, [text](url), `code`. */
export const mrkdwn = (s) => String(s).replace(/\*\*([^*]+)\*\*/g, "*$1*").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

const HEAD = { you: "your turn", failed: "something failed", shipped: "shipped" };

// the card's boxes a Slack button may start (pipeline/slack/worker.mjs ACTS: never an approval), with short labels
const BUTTONS = { spec: "📝 Rewrite the spec", story: "📌 Make it a story", "story-anyway": "📌 Make it a story anyway", plan: "🧭 Plan it", start: "▶️ Start", build: "🤖 Build it" };

/** The buttons for a card: its tick boxes (unticked), "Answer in Slack" while a spec has open questions, an approval
 *  link (approving stays in GitHub), and the card itself. Slack runs the action buttons through the Worker. Pure. */
export function buttons({ body, key, title = "", url = "", actions = true }) {
  const n = String(key).replace(/^#/, "");
  // actions: the Worker is set up (SLACK_ACTIONS); without it, only the links
  const boxes = actions ? [...String(body).matchAll(/^- \[ \] .*<!-- act:([a-z-]+) -->/gm)].map((m) => m[1]).filter((id) => BUTTONS[id]) : [];
  const out = [];
  if (/open question/.test(body) && boxes.includes("spec")) out.push({ text: "✍️ Answer in Slack", value: { n, act: "answer", title: title.slice(0, 120) }, style: "primary" });
  for (const id of boxes) out.push({ text: BUTTONS[id], value: { n, act: id }, ...(out.length ? {} : { style: "primary" }) });
  const approve = String(body).match(/\[Approve here\]\(([^)]+)\)/)?.[1];
  if (approve) out.push({ text: "✅ Approve on GitHub", url: approve, style: "primary" });
  if (url) out.push({ text: "Open the card", url });
  return out.slice(0, 5).map((b, i) => ({ type: "button", action_id: `pipeline-${i}`, text: { type: "plain_text", text: b.text, emoji: true },
    ...(b.url ? { url: b.url } : { value: JSON.stringify(b.value) }), ...(b.style ? { style: b.style } : {}) }));
}

/** The Slack message for a card update, or null when the turn has not changed. kinds: the turns this card announces
 *  (a story's "shipped" is left to its release's one message). Pure. */
export function notice({ before, after, key, title = "", url = "", kinds = ["you", "failed", "shipped"], actions = false }) {
  const now = turnOf(after), was = turnOf(before);
  if (!now || !kinds.includes(now.kind) || (was && was.kind === now.kind && was.next === now.next)) return null;
  const name = `#${String(key).replace(/^#/, "")}${title ? ` ${title}` : ""}`;
  const text = [`${now.kind === "failed" ? "❌" : now.kind === "shipped" ? "🚀" : "👉"} *${name}*: ${HEAD[now.kind]}`, mrkdwn(now.next).replace(/ (above|below)\b/g, ""), url ? `<${url}|Open the card>` : ""].filter(Boolean).join("\n");
  const acts = buttons({ body: after, key, title, url, actions });
  // text is the notification's fallback; the blocks show the same words with the next options as buttons
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text: text.split("\n").slice(0, 2).join("\n") } }, ...(acts.length ? [{ type: "actions", elements: acts }] : [])] };
}

/** post(message) to the webhook, or null when no webhook is set (Slack is optional). Never throws: a notice is information. */
export function slackNotifier({ url = process.env.SLACK_WEBHOOK_URL, log = () => {}, post = (u, body) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body }) } = {}) {
  if (!url) return null;
  return async (message) => {
    try { const r = await post(url, JSON.stringify(message)); if (r && r.ok === false) log(`::warning::Slack notice not sent (${r.status})`); }
    catch (e) { log(`::warning::Slack notice not sent: ${e.message}`); }
  };
}
