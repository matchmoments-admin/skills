import { isPipelineAuthor, setting } from "./conventions.mjs";
// What the AI jobs are told to produce, and how the pipeline reads it back. One module owns both sides,
// so an instruction and its parser cannot drift apart. Pure.

export const COMMIT = {
  implement: (key) => `feat(scope): summary (#${key})`,
  fix: "fix(review): summary",
  uiTest: (key) => `test(e2e): story ${key}`,
};
const FIX_PREFIX = "fix(review)";
export const UI_COMMIT_PREFIX = "test(e2e):";
export const REVIEW_LINE = { pass: "AI-REVIEW: PASS", changes: "AI-REVIEW: CHANGES" };
export const MAX_FIX_ROUNDS = 2;

// The PR body the build writes (the `pr` skill, adapted: docs/agents/salesforce.md). The pipeline needs Closes and a test plan.
export const PR_BODY = (key) => [
  "Write the PR body to a file with the Write tool and pass it with `--body-file`. Use these sections, briefly:",
  `\`Story #${key}\` (or \`Story ${key}\` for a Jira key) on the first line (never "Closes": the pipeline closes the story when it reaches production);`,
  "`## Summary`: the smallest view of what changed, e.g. a tree per object (Account -> Sales_Region__c (picklist) -> Sales_Region_Access -> Account Layout) or the Flow's decision path;",
  "`## Evidence`: the Apex and Flow test results for this change (Class.method pass/fail, coverage of changed classes);",
  "`## Merge danger`: **Door:** one-way (deletes or retypes a field, changes an org-wide default, changes data, removes access) or two-way, and **Blast radius:** in Salesforce terms (one page, every Opportunity save...);",
  "`## Test plan`: how a person checks it in the scratch org.",
].join(" ");

// The cheapest model that does each job well (repo variable AI_MODEL overrides every role).
export const MODELS = {
  implement: "claude-sonnet-5-5",
  fix: "claude-sonnet-5-5",
  plan: "claude-sonnet-5-5",
  spec: "claude-sonnet-5-5",
  tickets: "claude-sonnet-5-5",
  review: "claude-haiku-4-5-20251001",
  "ui-test": "claude-haiku-4-5-20251001",
};
export function modelFor(role, override = setting("AI_MODEL")) {
  if (override && String(override).trim()) return String(override).trim();
  if (!MODELS[role]) throw new Error(`Unknown AI role: ${role}`);
  return MODELS[role];
}

// Claude Code blocks compound shell commands and variables it cannot check, and a backgrounded command
// is lost when the job ends. Learned the hard way; every AI job gets this.
export const SHELL_RULE =
  "Shell rule: run ONE simple command per Bash call (no pipes, &&, ;, $() or ${}); create and edit files with the " +
  "Write and Edit tools, never with heredocs or echo. Run every command in the foreground and wait for it; never use " +
  "run_in_background (the job ends when you stop). Type org aliases literally; shell variables are blocked.";

/** The output-format part of each role's prompt. */
export function instructions(role, { key = "N" } = {}) {
  const common = SHELL_RULE + "\nDo not edit .github/ or pipeline/.";
  switch (role) {
    case "implement":
      return `${common}\nTests per acceptance criterion at a seam (docs/agents/salesforce.md): write a criterion's tests, deploy, run them alone (--tests Class.method), then the code; then everything the change needs.\nCommit as \`${COMMIT.implement(key)}\` and push the branch. ${PR_BODY(key)}`;
    case "fix":
      return `${common}\nFor each failure, the diagnosing loop (docs/agents/salesforce.md "Debugging"): reproduce it with the one failing test method alone (\`sf apex run test --tests Class.method --synchronous\`, or \`sf flow run test --tests Flow.Test\`), read the message and stack, list the likely causes (the running user's access, Flow entry criteria, another automation on the object, bulk limits), check the most likely first, fix, run that test again, then the change's tests. For a review finding without a failing test, write the test that shows it first.\nCommit as \`${COMMIT.fix}\` and push. Do not open a new PR.`;
    case "review":
      return `${common}\nDo not push commits. Do not approve or merge. Post ONE summary comment with two parts: \`### Acceptance criteria\` (each criterion from the story file on its own line: met, missing or partly met, and where; then anything built that no criterion asked for) and \`### Standards\` (REVIEW.md findings by severity). A missing or partly met criterion is a [major]. End with exactly one line: \`${REVIEW_LINE.pass}\` or \`${REVIEW_LINE.changes}\`.`;
    case "plan":
      return `${common}\nDo not change any file except the plan file named in the prompt. Do not commit, push or comment. Write the plan in markdown with these sections, in order: \`### Proposed build\` (objects and fields, Flows, Apex, permission sets, layouts and pages; say what you would reuse), \`### Access\` (who must see and change what: the permission set to add or extend, each touched object's org-wide default from the story file and whether the change relies on it, and whether each Flow or class runs as the user or the system, and why), \`### Tests\` (Apex, Flow and UI tests, by acceptance criterion, including the permission test: a user without the access is refused), \`### Risks\`, \`### Open questions\` (numbered; only what you cannot decide from the story and the repo; none if there are none). End with one line: \`PLAN-SIZE: S\`, \`PLAN-SIZE: M\` or \`PLAN-SIZE: L\`.`;
    case "spec":
      return `${common}\nDo not change any file except the spec file named in the prompt. Do not commit, push or comment. Read docs/agents/salesforce.md ("Specs") and docs/org/CONTEXT.md first and use the org's words. Write markdown with these sections, in order: \`### Problem\` (the user's side), \`### Solution\` (the user's side), \`### User stories\` (numbered: "As a <Salesforce persona>, I want ..., so that ..."; cover every case), \`### Decisions\` (per object touched: new fields, the automation (record-triggered Flow before/after save, or a trigger handler), the permission set, the page or layout, and the Access decision; no file paths), \`### Testing\` (the seams from docs/agents/salesforce.md and the prior art in the repo), \`### One-way doors\` (field deletes or retypes, org-wide default changes, production data changes; "none" if none), \`### Out of scope\`, \`### Open questions\` (numbered; only what the issue and the repo cannot answer).`;
    case "tickets":
      return `${common}\nDo not change any file except the JSON file named in the prompt. Do not commit, push or comment. Read docs/agents/salesforce.md ("Stories") first. Split the spec into vertical slices: each story deploys on its own with its field, permission set entry, automation, page or layout and tests, and passes the production validation alone; prefactoring first; expand-contract for a rename. Write a JSON array, blockers first: [{"title": "...", "summary": "who wants what and why", "criteria": ["one testable outcome per line"], "access": "who may see or change it", "where": "where a person sees it work", "out": "out of scope", "blockedBy": [indexes of earlier stories]}]. At most 15 stories.`;
    case "ui-test":
      return `${common}\nCommit the spec as \`${COMMIT.uiTest(key)}\` and push. Never print or commit login URLs.`;
    default:
      throw new Error(`Unknown AI role: ${role}`);
  }
}

/** The review verdict from PR comment bodies (latest verdict line wins): "pass", "changes" or null.
 *  Pass only the pipeline's own comments from this review run (see reviewComments). */
export function reviewVerdict(commentBodies) {
  let v = null;
  for (const body of commentBodies) {
    for (const line of String(body).split("\n")) {
      const t = line.replace(/[`*]/g, "").trim();
      if (t === REVIEW_LINE.pass) v = "pass";
      else if (t === REVIEW_LINE.changes) v = "changes";
    }
  }
  return v;
}

/** How many AI fix rounds a PR has had: its earlier completed ai-fix runs (run-name "ai-fix PR #N"). Robust to what
 *  the agent called its commits; a run that stopped at the limit counts too, which only keeps it over the limit. */
export const fixRunsFor = (runs, pr, currentRunId) =>
  runs.filter((r) => r.display_title === `ai-fix PR #${pr}` && r.status === "completed" && ["success", "failure"].includes(r.conclusion) && String(r.id) !== String(currentRunId)).length;

/** How many AI fix rounds a branch has had, from the commit subjects since its base (the older count). */
export const fixRounds = (subjects) => subjects.filter((s) => String(s).startsWith(FIX_PREFIX)).length;

/** The comments that may carry this run's verdict: written by the pipeline's identity, at or after the run started. */
// The pipeline's own comments: exact identities from PIPELINE_BOTS (conventions.isPipelineAuthor), never a pattern.
export function reviewComments(comments, since) {
  return comments.filter((c) => isPipelineAuthor(c.author?.login) && (!since || String(c.createdAt) >= since)).map((c) => c.body);
}
