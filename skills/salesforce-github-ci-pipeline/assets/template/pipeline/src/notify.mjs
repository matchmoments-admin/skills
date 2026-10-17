// Slack notices (see GLOSSARY.md: Slack notice). Optional: with the SLACK_WEBHOOK_URL secret set, one channel hears when a
// card's turn changes: a person is needed (the card's Next line), something failed, or it shipped. Never while the
// pipeline is working (a ⏳ row), and never twice for the same turn: the card before the update is compared with the
// card after it, as notifyNeeds does for @mentions. Pure, except slackNotifier(), which posts through fetch.

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

/** The Slack message for a card update, or null when the turn has not changed. kinds: the turns this card announces
 *  (a story's "shipped" is left to its release's one message). Pure. */
export function notice({ before, after, key, title = "", url = "", kinds = ["you", "failed", "shipped"] }) {
  const now = turnOf(after), was = turnOf(before);
  if (!now || !kinds.includes(now.kind) || (was && was.kind === now.kind && was.next === now.next)) return null;
  const name = `#${String(key).replace(/^#/, "")}${title ? ` ${title}` : ""}`;
  return { text: [`${now.kind === "failed" ? "❌" : now.kind === "shipped" ? "🚀" : "👉"} *${name}*: ${HEAD[now.kind]}`, mrkdwn(now.next), url ? `<${url}|Open the card>` : ""].filter(Boolean).join("\n") };
}

/** post(message) to the webhook, or null when no webhook is set (Slack is optional). Never throws: a notice is information. */
export function slackNotifier({ url = process.env.SLACK_WEBHOOK_URL, log = () => {}, post = (u, body) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body }) } = {}) {
  if (!url) return null;
  return async (message) => {
    try { const r = await post(url, JSON.stringify(message)); if (r && r.ok === false) log(`::warning::Slack notice not sent (${r.status})`); }
    catch (e) { log(`::warning::Slack notice not sent: ${e.message}`); }
  };
}
