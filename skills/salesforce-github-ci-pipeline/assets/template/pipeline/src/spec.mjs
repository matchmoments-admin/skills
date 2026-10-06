// Specs and story breakdowns, on GitHub (see GLOSSARY.md: Spec, Story breakdown). The to-spec and to-tickets skills,
// adapted to run in the pipeline: Claude writes a Spec (one comment on the spec issue, edited in place) and then a
// breakdown into stories (JSON it writes to a file); a person approves the breakdown by ticking a box, and an
// agent-free step creates the Story issues in the pipeline's story format, linked to the spec, blockers first.
// Pure, except createStories(), which acts through the gh seam.
import { checklist } from "./actions.mjs";
import { planContext } from "./plan.mjs";

export const SPEC_MARK = "<!-- pipeline:spec -->";
export const SPEC_TITLE = "Spec";
export const BREAKDOWN_MARK = "<!-- pipeline:breakdown -->";
export const BREAKDOWN_TITLE = "Story breakdown";
const PAYLOAD = /<!-- stories:([A-Za-z0-9+/=]+) -->/;
const CREATED = /<!-- created:([0-9,]+) -->/;

/** The spec comment: Claude's spec, then what to do next (the box splits it into stories). */
export function specComment(text) {
  const questions = (String(text).match(/### Open questions\s*\n([\s\S]*?)(\n###\s|$)/i)?.[1] || "").split("\n").filter((l) => /^\s*\d+[.)]\s+\S/.test(l)).length;
  return [SPEC_MARK, `### ${SPEC_TITLE}`, "", String(text).trim(), "",
    questions ? `**Next:** answer the ${questions === 1 ? "question" : `${questions} questions`} in a comment, then comment **/spec** to revise it; or split it as it is.` : "**Next:** check it; if it is right, split it into stories (or reply with changes and comment **/spec**).",
    "", ...checklist(["tickets"])].join("\n");
}

/** Check the breakdown Claude wrote: [{ title, summary, criteria[], access, where, out, blockedBy[] (indexes) }]. */
export function parseTickets(json) {
  const list = typeof json === "string" ? JSON.parse(json) : json;
  if (!Array.isArray(list) || !list.length) throw new Error("the breakdown has no stories");
  if (list.length > 15) throw new Error(`${list.length} stories is too many for one spec: split the spec`);
  return list.map((t, i) => {
    for (const k of ["title", "summary", "where"]) if (!String(t[k] || "").trim()) throw new Error(`story ${i + 1} has no ${k}`);
    if (!Array.isArray(t.criteria) || !t.criteria.length) throw new Error(`story ${i + 1} has no acceptance criteria`);
    const blockedBy = (t.blockedBy || []).map(Number);
    if (blockedBy.some((b) => !(b >= 0 && b < i))) throw new Error(`story ${i + 1} is blocked by a story that does not come before it`);
    return { title: String(t.title).replace(/^Story:\s*/i, "").trim(), summary: String(t.summary).trim(), criteria: t.criteria.map((c) => String(c).replace(/^[-*]\s*/, "").trim()),
      access: String(t.access || "No change").trim(), where: String(t.where).trim(), out: String(t.out || "Anything not listed above.").trim(), blockedBy };
  });
}

/** The breakdown for a person to approve: a table, the stories as data (hidden), and the box that creates them. */
export function breakdownComment(tickets) {
  const payload = Buffer.from(JSON.stringify(tickets)).toString("base64");
  return [BREAKDOWN_MARK, `<!-- stories:${payload} -->`, `### ${BREAKDOWN_TITLE} (${tickets.length} ${tickets.length === 1 ? "story" : "stories"})`, "",
    "| # | Story | Acceptance criteria | Blocked by |", "|---|---|---|---|",
    ...tickets.map((t, i) => `| ${i + 1} | **${t.title}**: ${t.summary.replace(/\|/g, "\\|").replace(/\n/g, " ")} | ${t.criteria.map((c) => c.replace(/\|/g, "\\|")).join("<br>")} | ${t.blockedBy.map((b) => b + 1).join(", ") || "none"} |`),
    "", "Each story is a slice that deploys and passes the production validation on its own. Reply with changes and comment **/tickets** to redo it.",
    "", ...checklist(["create-stories"])].join("\n");
}

/** The stories inside a breakdown comment, and whether they were already created. */
export function readBreakdown(body) {
  const m = String(body || "").match(PAYLOAD);
  return { tickets: m ? JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) : null, created: (String(body || "").match(CREATED)?.[1] || "").split(",").filter(Boolean) };
}

/** A story's issue body, in the format the pipeline reads (docs/agents/issue-tracker.md). */
export function storyBody(t, { spec, blockers = [] }) {
  return ["### Summary", "", t.summary, "", "### Acceptance criteria", "", ...t.criteria.map((c) => `- ${c}`), "", "### Access", "", t.access, "",
    "### Where to see it in the UI", "", t.where, "", "### Out of scope", "", t.out, ...(blockers.length ? ["", `Blocked by ${blockers.map((n) => `#${n}`).join(", ")}.`] : []),
    "", `Part of spec #${spec}.`].join("\n");
}

/**
 * Create the stories of an approved breakdown, blockers first, once (a second tick creates nothing). gh: the gh seam
 * (as the App, so each story's card appears). Returns the new issue numbers and the comment, marked as created.
 */
export function createStories({ gh, repo, spec, body, log = () => {} }) {
  const { tickets, created } = readBreakdown(body);
  if (!tickets) throw new Error("no breakdown in this comment");
  if (created.length) return { numbers: created.map(Number), body, already: true };
  const numbers = [];
  for (const [i, t] of tickets.entries()) {
    const blockers = t.blockedBy.map((b) => numbers[b]);
    const url = gh(["issue", "create", "--title", `Story: ${t.title}`, "--label", "feature", "--body", storyBody(t, { spec, blockers })]);
    const n = Number(String(url).match(/\/issues\/(\d+)/)?.[1]);
    numbers.push(n);
    log(`created #${n} ${t.title}`);
    // GitHub's own links, best effort: a sub-issue of the spec, and "blocked by" its blockers
    const id = gh(["api", `repos/${repo}/issues/${n}`, "--jq", ".id"], { allowFail: true });
    if (id) gh(["api", "-X", "POST", `repos/${repo}/issues/${spec}/sub_issues`, "-F", `sub_issue_id=${id}`], { allowFail: true });
    for (const b of blockers) {
      const bid = gh(["api", `repos/${repo}/issues/${b}`, "--jq", ".id"], { allowFail: true });
      if (bid) gh(["api", "-X", "POST", `repos/${repo}/issues/${n}/dependencies/blocked_by`, "-F", `issue_id=${bid}`], { allowFail: true });
    }
  }
  const done = body.replace(/\n\*\*Do it from here:\*\*[\s\S]*$/, "") + `\n<!-- created:${numbers.join(",")} -->\n**Created:** ${numbers.map((n) => `#${n}`).join(", ")}. Each story's card offers Plan and Start.`;
  return { numbers, body: done, already: false };
}

/** What Claude is doing, in the spec or breakdown comment itself (replaced when its output lands). */
export function pendingComment(mark, title, { state, what, url }) {
  return [mark, `### ${title}`, "", `${state === "failed" ? "❌ **Failed:**" : "⏳ **Now:**"} ${what}${url ? ` · **[${state === "failed" ? "see what went wrong" : "watch it live"}](${url})**` : ""}`].join("\n");
}

/** The file Claude reads to write (or revise) a spec, or to split it: the issue, the latest spec and the answers since,
 *  and for a breakdown the latest breakdown and the comments on it. */
export async function specFile(tracker, key, { forTickets = false } = {}) {
  const issue = await tracker.story(key);
  const comments = await tracker.comments(key).catch(() => []);
  const spec = planContext(comments, { mark: SPEC_MARK, title: SPEC_TITLE });
  const people = comments.filter((c) => !/<!-- pipeline:/.test(c.body || "") && !/^\s*\//.test(c.body || "")).map((c) => `- **${c.author}:** ${String(c.body).replace(/\n+/g, " ")}`);
  const parts = [`# ${issue.title} (#${key})`, "", issue.body || "(no description)", ""];
  if (spec.plan) parts.push("---", "", "## The current spec", "", spec.plan, "");
  if (spec.answers.length) parts.push("## Comments since the spec (they win over it)", "", ...spec.answers.map((a) => `- **${a.author}:** ${a.body.replace(/\n+/g, " ")}`), "");
  else if (!spec.plan && people.length) parts.push("## Discussion", "", ...people, "");
  if (forTickets) {
    const b = planContext(comments, { mark: BREAKDOWN_MARK, title: BREAKDOWN_TITLE });
    if (b.plan) parts.push("## The previous breakdown (redo it with the comments below)", "", b.plan.replace(PAYLOAD, ""), "", ...b.answers.map((a) => `- **${a.author}:** ${a.body.replace(/\n+/g, " ")}`), "");
  }
  return parts.join("\n");
}
