// The build plan: an optional step before /start where Claude proposes the build and asks its open questions, people
// answer in comments, and the agreed plan joins the story as part of the spec. Pure: the tracker adapters fetch and
// post the comments; this module decides what they say and what the agents read.

import { isPipelineAuthor } from "./conventions.mjs";

export const PLAN_MARK = "<!-- pipeline:build-plan -->";
export const PLAN_TITLE = "Build plan";
export const READINESS_MARK = "<!-- pipeline:readiness -->";
export const READINESS_TITLE = "Story readiness";

// the pipeline's own comments: its exact identities (conventions.isPipelineAuthor), or anything carrying its marker
const isPipeline = (c) => isPipelineAuthor(c.author) || c.author === "app/pipeline" || /<!-- pipeline:/.test(c.body || "");
const isCommand = (c) => /^\s*\//.test(c.body || "");

/**
 * comments: [{ author, body, created }] oldest first (GitHub issue comments or Jira comments as text).
 * Returns { plan, answers[] }: the latest build plan, and what people wrote after it (no /commands, no pipeline posts).
 */
export function planContext(comments, { mark = PLAN_MARK, title = PLAN_TITLE } = {}) {
  const sorted = [...comments].sort((a, b) => String(a.created).localeCompare(String(b.created)));
  const at = sorted.map((c) => ((c.body || "").includes(mark) || (c.body || "").includes(`### ${title}`)) && !(c.body || "").includes(PENDING)).lastIndexOf(true);
  if (at < 0) return { plan: null, answers: [] };
  const plan = sorted[at].body.replace(mark, "").replace(/^(⏳ \*\*Now:\*\*|❌ \*\*Failed:\*\*).*\n*/m, "").replace(/<!-- story:\d+ -->\n?/, "")
    .replace(/\n\*\*(Do it from here|Story):\*\*[\s\S]*$/, "").trim();   // a status line or the story link is not the spec
  const answers = sorted.slice(at + 1).filter((c) => !isPipeline(c) && !isCommand(c) && (c.body || "").trim()).map((c) => ({ author: c.author, body: c.body.trim() }));
  return { plan, answers };
}

/** The story file every agent reads: the story, then (when there is one) the agreed plan and the answers to it. */
export function storyFile(story, { plan, answers }) {
  const parts = [`# Story ${story.key}: ${String(story.title).replace(/^Story:\s*/i, "")}`, "", `Tracker: ${story.url}`, "", story.body || "(no description)"];
  if (plan) {
    parts.push("", "---", "", "## Agreed plan (part of the spec: build what it says, unless an answer below changes it)", "", plan);
    if (answers.length) parts.push("", "## Answers to the plan's questions (these win over the plan where they differ)", "", ...answers.map((a) => `- **${a.author}:** ${a.body.replace(/\n+/g, " ")}`));
  }
  return parts.join("\n") + "\n";
}

/** The parent spec, for a story made from one (planContext() of the spec comment): everything the story builds. */
export function specSection(key, { plan, answers }) {
  if (!plan) return "";
  return ["", "---", "", `## The spec (#${key}): this story builds all of it; its decisions and out of scope bind`, "", plan,
    ...(answers.length ? ["", "## Answers since the spec (these win where they differ; an open question without an answer keeps the spec's assumption)", "", ...answers.map((a) => `- **${a.author}:** ${a.body.replace(/\n+/g, " ")}`)] : [])].join("\n") + "\n";
}

/** The acceptance criteria: the bullet lines under "### Acceptance criteria". */
export function criteria(body) {
  const m = String(body || "").match(/###\s*Acceptance criteria\s*\n([\s\S]*?)(\n###\s|\s*$)/i);
  if (!m) return [];
  return m[1].split("\n").map((l) => l.trim()).filter((l) => /^[-*]\s+\S/.test(l)).map((l) => l.replace(/^[-*]\s+/, ""));
}

/**
 * The posted plan: Claude's sections, then the next step, worked out from what it says.
 * size: S | M | L (from the plan's "PLAN-SIZE:" line); questions: how many open questions it numbered.
 */
export function planComment(text, { readiness = null, started = false } = {}) {
  const size = (String(text).match(/^PLAN-SIZE:\s*([SML])\b/m) || [])[1] || "M";
  const qs = String(text).match(/### Open questions\s*\n([\s\S]*?)(\n###\s|$)/i);
  const questions = qs ? qs[1].split("\n").filter((l) => /^\s*\d+[.)]\s+\S/.test(l)).length : 0;
  const body = String(text).replace(/^PLAN-SIZE:.*$/m, "").trim();
  const go = started ? "**/build** (or build it on the story branch yourself)" : "**/start**";
  const next = questions
    ? `**Next:** answer the ${questions === 1 ? "question" : `${questions} questions`} in a comment, then comment **/plan** to revise the plan, or ${go} to go ahead with it.`
    : size === "S" ? `**Next:** ready. Comment ${go}.` : `**Next:** check the plan; if it is right, comment ${go} (or reply with changes and **/plan** again).`;
  const ready = readiness ? readinessLines(readiness) : [];
  return [PLAN_MARK, `### ${PLAN_TITLE} (size ${size})`, "", body, "", ...(ready.length ? [...ready, ""] : []), next, "",
    "_The agreed plan and your answers become part of the spec: the build, the review and the UI test follow them._"].join("\n");
}

export const PENDING = "<!-- pipeline:plan-pending -->";

/** The Build plan comment while Claude is still writing it, or after it failed (replaced when a plan lands).
 *  It is never read as a plan (planContext skips it). */
export function planPending(activity) {
  const failed = activity.state === "failed";
  const link = activity.url ? ` · **[${failed ? "see what went wrong" : "watch it live"}](${activity.url})**` : "";
  return [PLAN_MARK, PENDING, `### ${PLAN_TITLE}`, "", `${failed ? "❌ **Failed:**" : "⏳ **Now:**"} ${activity.what}${link}`, "",
    failed ? "Comment **/plan** to try again, or **/start** to go ahead without a plan." : "The plan, its questions and the next step will appear here."].join("\n");
}

/** Readiness as lines (empty when there is nothing to say). */
export function readinessLines(r) {
  if (!r || (!r.weak.length && r.size !== "large")) return [];
  return [
    ...r.weak.map((w) => `- ⚠ Criterion ${w.n} may not be testable (${Math.round(w.p * 100)}%): "${w.text}". Say what a tester would see.`),
    ...(r.size === "large" ? ["- ⚠ This looks like a large story: consider splitting it, or **/plan** before building."] : []),
  ];
}

/** The readiness comment (only posted when something is worth saying). */
export function readinessComment(r) {
  const lines = readinessLines(r);
  return lines.length ? [READINESS_MARK, `### ${READINESS_TITLE} (checked by Jev)`, "", ...lines, "", "Comment **/plan** to have Claude propose the build and ask its questions first."].join("\n") : null;
}
