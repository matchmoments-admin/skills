// The approval policy (see GLOSSARY.md: Approver, Solo approval): who may approve whose change. Pure: the gate reads the
// facts (the reviews, who pushed, the AI review's verdict) and asks here; approval.mjs never reads GitHub itself.
import { isHumanAuthor } from "./conventions.mjs";

/** The story's approver: an "Approver: @login" line (or the story form's Approver field), else null. Pure. */
export const approverOf = (body) => String(body || "").match(/^(?:#+\s*)?\**Approver\**:?\**\s*\n*\s*@([A-Za-z0-9-]+)/im)?.[1] || null;
/** The APPROVERS setting as logins (the first is the default approver of new stories). Pure. */
export const approverList = (v) => String(v || "").split(/[\s,]+/).map((x) => x.replace(/^@/, "")).filter(Boolean);
/**
 * Who pushed the PR's latest change: the newest of (a) a push to the branch by a person (GitHub's own record of who
 * pushed: the repository activity API) and (b) a commit with a human author (not Claude, not the pipeline: a person's
 * change the App pushed for them, such as Bring my Setup changes). (a) matters: a commit whose email is not linked to
 * a GitHub account has no login, and story #193's sign-off by the person who had just pushed was accepted. Pure.
 */
export function lastPusherOf(commits = [], pushes = []) {
  const byCommit = [...commits].map((c) => [String(c.committedDate || ""), (c.authors || []).find((a) => a.login && isHumanAuthor(a.login))?.login]);
  const byPush = pushes.filter((p) => !p.activity_type || ["push", "force_push"].includes(p.activity_type))
    .map((p) => [String(p.timestamp || ""), p.actor?.type === "Bot" ? null : p.actor?.login]);
  return [...byCommit, ...byPush].filter(([, login]) => login && isHumanAuthor(login)).sort(([a], [b]) => a.localeCompare(b)).map(([, l]) => l).pop() || null;
}

const is = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
/** Solo mode (APPROVAL_MODE=solo): the one approver may approve a change they pushed themselves, once the AI review
 *  passed on it (or they overruled it, with a reason on record); nobody else is there to. The approval record says so.
 *  A team (two or more approvers) never may. */
const soloAllowed = ({ approvers = [], approvalMode = "team" }, login) => approvalMode === "solo" && approvers.length === 1 && is(approvers[0], login);
/** Did this person's approval count only by solo mode? */
export const isSolo = (ctx, login) => is(login, ctx.lastPusher) && soloAllowed(ctx, login);
/** What a solo approval rests on, for its record: "the AI review passed" or "AI review overruled by @x". Pure. */
export const soloBasis = (aiReview) => (aiReview === "overruled" ? "the AI review was overruled, reason on record" : "the AI review passed");
/** The AI review kinds a solo approval accepts as the second pair of eyes (gate.reviewKindOf). */
const SOLO_REVIEWS = ["passed", "overruled"];

/**
 * Why this person's approval does not count, or null when it does (see GLOSSARY.md: Approver). With APPROVERS unset,
 * anyone with write access approves (a team without a policy yet). With it set: never the person who pushed the
 * latest change (nobody approves their own work), and only the story's approver; with none named (a release, a
 * hotfix without one), or when the approver pushed the latest change themselves, anyone in APPROVERS. Solo mode: the one
 * approver's own push counts once the AI review passed on it, or they overruled it (aiReview: gate.reviewKindOf of the
 * review's verdict on the head, null when none stands). Pure.
 */
export function approvalProblem({ approvers = [], storyApprover = null, lastPusher = null, approvalMode = "team", aiReview = null, aiReviewOn = true }, login) {
  if (!approvers.length || !login) return null;
  const inTeam = approvers.some((a) => is(a, login));
  if (is(login, lastPusher) && soloAllowed({ approvers, approvalMode }, login)) {
    if (!aiReviewOn) return `@${login} pushed the latest change: solo approval needs the AI review as the second pair of eyes (turn on AI_REVIEW)`;
    return SOLO_REVIEWS.includes(aiReview) ? null : `@${login} pushed the latest change: solo approval (APPROVAL_MODE=solo) needs a real AI review to pass on it first ("not needed" is not one: comment /review to run it)`;
  }
  if (is(login, lastPusher)) return `@${login} pushed the latest change, so ${storyApprover && !is(storyApprover, login) ? `@${storyApprover} (the approver)` : "another approver"} needs to approve`;
  if (storyApprover && !is(storyApprover, login) && !(is(storyApprover, lastPusher) && inTeam)) return `@${storyApprover} is this story's approver (change the story's Approver line to hand it over)`;
  if (!storyApprover && !inTeam) return `@${login} is not an approver (APPROVERS: ${approvers.map((a) => `@${a}`).join(", ")})`;
  return null;
}


/**
 * Why this person may not take an action that needs an approver's authority, or null when they may. action:
 *   approve   approve the change (approvalProblem)
 *   overrule  accept the change over the AI review (/review-ok): the approval rule without its AI review condition
 *             (an overrule replaces the review), so in solo mode the one approver may, even on their own push
 *   budget    give a story more AI budget (/budget-ok): spending, not code, so anyone in APPROVERS
 * With APPROVERS unset, anyone with write access. Pure.
 */
export function authorityProblem(action, ctx, login) {
  const { approvers = [] } = ctx || {};
  if (action === "approve") return approvalProblem(ctx, login);
  if (!approvers.length || !login) return null;
  if (action === "budget") return approvers.some((a) => is(a, login)) ? null : `only an approver (${approvers.map((a) => `@${a}`).join(", ")}) can`;
  if (action === "overrule") return soloAllowed(ctx, login) ? null : approvalProblem({ ...ctx, approvalMode: "team" }, login);
  throw new Error(`authorityProblem: unknown action "${action}" (approve, overrule, budget)`);
}
