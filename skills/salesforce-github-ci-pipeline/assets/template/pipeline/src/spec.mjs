// Specs (see GLOSSARY.md: Spec, Make it a story). The to-spec skill, adapted to run in the pipeline: Claude writes a Spec
// (one comment on the spec issue, edited in place); a person answers its questions (/spec revises it), then ticks
// "Make it a story": an agent-free step makes ONE Story issue from the spec, in the pipeline's story format, linked to
// the spec. Every agent working on that story reads the spec too (pipe tracker story). Split a spec into several stories
// by hand only when one slice cannot pass the production validation alone (docs/agents/salesforce.md, "Stories").
// Pure, except makeStory(), which acts through the gh seam.
import { checklist } from "./actions.mjs";
import { planContext, PENDING } from "./plan.mjs";
import { approverList } from "./gate.mjs";
import { setting } from "./conventions.mjs";

export const SPEC_MARK = "<!-- pipeline:spec -->";
export const SPEC_TITLE = "Spec";
const MADE = /<!-- story:(\d+) -->/;

/** How many open questions the spec still has. Pure. */
// More user stories than this and one story gets hard to review and to UAT: the spec suggests slicing it.
export const STORY_SIZE_LIMIT = 6;
const userStories = (text) => (sections(String(text))["User stories"] || "").split("\n").filter((l) => /^\s*(?:\d+[.)]|[-*])\s+\S/.test(l)).length;
export const openQuestions = (text) => (String(text).match(/### Open questions\s*\n([\s\S]*?)(\n###\s|$)/i)?.[1] || "").split("\n").filter((l) => /^\s*\d+[.)]\s+\S/.test(l)).length;

/** The spec comment: Claude's spec, then what to do next. With open questions, making the story is an explicit choice.
 *  story: the story already made from this spec (a revision keeps the link and offers no second story). */
export function specComment(text, { story = null } = {}) {
  const questions = openQuestions(text), size = userStories(text);
  const big = size > STORY_SIZE_LIMIT ? [`**Big for one story:** ${size} user stories. One story is one review and one UAT; consider splitting by hand into slices that each deploy alone (open each as a story, and write \`Blocked by #N\` where one needs another). Making it one story still works.`, ""] : [];
  if (story) return [SPEC_MARK, `### ${SPEC_TITLE}`, "", String(text).trim(), "", `<!-- story:${story} -->`, `**Story:** #${story}. This is the revised spec: everyone working on the story reads this version.`].join("\n");
  return [SPEC_MARK, `### ${SPEC_TITLE}`, "", String(text).trim(), "",
    questions ? `**Next:** answer the ${questions === 1 ? "question" : `${questions} questions`} in a comment, then comment **/spec** to revise it. Or make the story now: the spec's assumed answers then stand.` : "**Next:** check it; if it is right, make it a story (or reply with changes and comment **/spec**).",
    "", ...big, ...checklist([questions ? "story-anyway" : "story"])].join("\n");
}

/** The spec's sections by heading ("### Problem" -> "Problem"). Pure. */
export function sections(text) {
  const out = {};
  const parts = String(text).split(/^###\s+(.+)$/m);
  for (let i = 1; i < parts.length; i += 2) out[parts[i].trim()] = parts[i + 1].trim();
  return out;
}

/**
 * The one story a spec becomes, in the story format (storyBody). spec: the spec issue number; text: the spec comment;
 * title: the spec issue's title. Criteria are the spec's user stories; the rest of the spec reaches every agent anyway
 * (pipe tracker story adds it), so nothing is lost by keeping the story short. Pure.
 */
export function storyFromSpec({ spec, text, title }) {
  const s = sections(String(text).replace(SPEC_MARK, "").replace(/\n\*\*Next:\*\*[\s\S]*$/, ""));
  const firstPara = (t) => String(t || "").split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, " ").trim();
  const bullets = (t) => String(t || "").split("\n").map((l) => l.match(/^\s*(?:\d+[.)]|[-*])\s+(.*\S)/)?.[1]).filter(Boolean);
  const criteria = bullets(s["User stories"]);
  if (!criteria.length) throw new Error(`spec #${spec} has no user stories to make acceptance criteria from: revise it with /spec`);
  const access = bullets(s.Decisions).filter((l) => /persona|permission set|sharing|share|org-wide|OWD|access|profile/i.test(l));
  return {
    title: String(title).replace(/^Spec:\s*/i, "").trim(),
    summary: firstPara(s.Problem) || `See spec #${spec}.`,
    criteria,
    access: access.length ? access.map((l) => `- ${l}`).join("\n") : `As decided in spec #${spec}.`,
    where: String(s.Solution || "").trim().slice(0, 1500) || `As described in spec #${spec}.`,   // the whole section: a paragraph ending in ":" lists the rest
    out: bullets(s["Out of scope"]).map((l) => `- ${l}`).join("\n") || "Anything not in the spec.",
  };
}

/**
 * Make the spec's story, once: a second tick (or /tickets) finds the marker and links the story already made.
 * gh: the gh seam (as the App, so the story's card appears). Returns { number, body (the spec comment, marked), already }.
 */
export function makeStory({ gh, repo, spec, title, body }) {
  const made = String(body || "").match(MADE)?.[1];
  if (made) return { number: Number(made), body, already: true };
  const t = storyFromSpec({ spec, text: body, title });
  const url = String(gh(["issue", "create", "--title", `Story: ${t.title}`, "--label", "feature", "--body", storyBody(t, { spec, approver: approverList(setting("APPROVERS"))[0] })]) || "");   // the team's default approver
  const n = Number(url.match(/\/issues\/(\d+)/)?.[1]);
  if (!n) throw new Error(`the story was not created (gh said: ${url.slice(0, 120)})`);
  const id = gh(["api", `repos/${repo}/issues/${n}`, "--jq", ".id"], { allowFail: true });   // a sub-issue of the spec, best effort
  if (id) gh(["api", "-X", "POST", `repos/${repo}/issues/${spec}/sub_issues`, "-F", `sub_issue_id=${id}`], { allowFail: true });
  const done = String(body).replace(/\n\*\*Do it from here:\*\*[\s\S]*$/, "") + `\n<!-- story:${n} -->\n**Story:** #${n}. Its card offers **Plan** and **Start**; everyone working on it reads this spec too.`;
  return { number: n, body: done, already: false };
}

/** A story's issue body, in the format the pipeline reads (docs/agents/issue-tracker.md). */
export function storyBody(t, { spec, blockers = [], approver = null }) {
  return ["### Summary", "", t.summary, "", "### Acceptance criteria", "", ...t.criteria.map((c) => `- ${c}`), "", "### Access", "", t.access, "",
    ...(approver ? ["### Approver", "", `@${approver}`, ""] : []),
    "### Where to see it in the UI", "", t.where, "", "### Out of scope", "", t.out, ...(blockers.length ? ["", `Blocked by ${blockers.map((n) => `#${n}`).join(", ")}.`] : []),
    "", `Part of spec #${spec}.`].join("\n");
}

/** What Claude is doing, in the spec comment itself. A first spec: a placeholder (never read as a spec). A revision:
 *  the status line on top of the current spec, which stays readable (and its story link kept) until the new one lands,
 *  and stays as it was if the run fails. existing: the spec comment's body now, or null. */
export function pendingComment(existing, { state, what, url }) {
  const line = `${state === "failed" ? "❌ **Failed:**" : "⏳ **Now:**"} ${what}${url ? ` · **[${state === "failed" ? "see what went wrong" : "watch it live"}](${url})**` : ""}`;
  const current = String(existing || "").includes(SPEC_MARK) && !String(existing).includes(PENDING)
    ? String(existing).replace(SPEC_MARK, "").replace(/^(⏳ \*\*Now:\*\*|❌ \*\*Failed:\*\*).*\n*/m, "").trim() : null;
  return current ? [SPEC_MARK, line, "", current].join("\n") : [SPEC_MARK, PENDING, `### ${SPEC_TITLE}`, "", line].join("\n");
}

/** What a story hears when its spec is revised after it was made (its criteria are a copy; the spec binds). Pure. */
export const revisedNote = (spec) => `📝 Spec #${spec} was revised. Its decisions bind this story (every agent reads the latest spec): where a criterion above disagrees with it, the spec wins. Builders: bring the pull request's title and description in line with what is built.`;

/** The spec comment's body now (the latest one with the marker), from the issue's comments. */
export const currentSpec = (comments) => [...comments].reverse().find((c) => String(c.body || "").includes(SPEC_MARK))?.body || null;
/** The story already made from this spec, if any. */
export const storyOfSpec = (body) => Number(String(body || "").match(MADE)?.[1]) || null;

/** The file Claude reads to write (or revise) a spec: the issue, the latest spec and the answers since. */
export async function specFile(tracker, key) {
  const issue = await tracker.story(key);
  const comments = await tracker.comments(key).catch(() => []);
  const spec = planContext(comments, { mark: SPEC_MARK, title: SPEC_TITLE });
  const people = comments.filter((c) => !/<!-- pipeline:/.test(c.body || "") && !/^\s*\//.test(c.body || "")).map((c) => `- **${c.author}:** ${String(c.body).replace(/\n+/g, " ")}`);
  const parts = [`# ${issue.title} (#${key})`, "", issue.body || "(no description)", ""];
  if (spec.plan) parts.push("---", "", "## The current spec", "", spec.plan, "");
  if (spec.answers.length) parts.push("## Comments since the spec (they win over it)", "", ...spec.answers.map((a) => `- **${a.author}:** ${a.body.replace(/\n+/g, " ")}`), "");
  else if (!spec.plan && people.length) parts.push("## Discussion", "", ...people, "");
  return parts.join("\n");
}
