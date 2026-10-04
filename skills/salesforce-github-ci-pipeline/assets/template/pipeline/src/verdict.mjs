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

// The cheapest model that does each job well (repo variable AI_MODEL overrides every role).
export const MODELS = {
  implement: "claude-sonnet-5-5",
  fix: "claude-sonnet-5-5",
  review: "claude-haiku-4-5-20251001",
  "ui-test": "claude-haiku-4-5-20251001",
};
export function modelFor(role, override = process.env.AI_MODEL) {
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
      return `${common}\nCommit as \`${COMMIT.implement(key)}\` and push the branch.`;
    case "fix":
      return `${common}\nCommit as \`${COMMIT.fix}\` and push. Do not open a new PR.`;
    case "review":
      return `${common}\nDo not push commits. Do not approve or merge. Post ONE summary comment that ends with exactly one line: \`${REVIEW_LINE.pass}\` or \`${REVIEW_LINE.changes}\`.`;
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

/** How many AI fix rounds a branch has had, from the commit subjects since its base. */
export const fixRounds = (subjects) => subjects.filter((s) => String(s).startsWith(FIX_PREFIX)).length;

/** The comments that may carry this run's verdict: written by the pipeline's identity, at or after the run started. */
export const PIPELINE_COMMENTER = /^(github-actions|app\/.+|.+\[bot\]|.+-pipeline)$/;
export function reviewComments(comments, since) {
  return comments.filter((c) => PIPELINE_COMMENTER.test(c.author?.login || "") && (!since || String(c.createdAt) >= since)).map((c) => c.body);
}
