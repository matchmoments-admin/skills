// Agent roles (see GLOSSARY.md: Agent role): each AI job's model and turn budget, and the inputs every role is handed,
// in one table. The workflows name a role; the claude-agent action reads its budget here (`pipe agent budget`), so a
// cost change is one line, testable, instead of a string in six workflow files. The output format each role writes
// stays in verdict.mjs, next to the parser that reads it. Pure.
import { setting } from "./conventions.mjs";

// The cheapest model that does each job well (repository variable AI_MODEL overrides every role), and a turn budget
// sized from the event log's turns per role. The UI writer's 40 ran out on story #193 without it looking at its own
// failure screenshot (E9): 30, and it is told to stop and report before the end (verdict.instructions).
export const ROLES = {
  implement: { model: "claude-sonnet-5-5", turns: 100 },
  fix: { model: "claude-sonnet-5-5", turns: 40 },
  plan: { model: "claude-sonnet-5-5", turns: 25 },
  spec: { model: "claude-sonnet-5-5", turns: 30 },
  review: { model: "claude-sonnet-5-5", turns: 15 },   // Haiku made confident false Salesforce blockers on PR #144, each costing a round
  // Sonnet, not Haiku: both of story #200's Haiku runs used every turn and a failed writer run costs ~15 Actions minutes
  // (a runner holding the org's lane), far more than the model's price difference
  "ui-test": { model: "claude-sonnet-5-5", turns: 30, turnLimitOk: true },
};

export function modelFor(role, override = setting("AI_MODEL")) {
  if (!ROLES[role]) throw new Error(`Unknown AI role: ${role}`);
  if (override && String(override).trim()) return String(override).trim();
  return ROLES[role].model;
}

/** A role's budget: { model, turns }. */
// turnLimitOk: a run that hit its turn cap is not a failed job when its work is judged after it (the UI test's spec
// runs in its own job, which posts the verdict); the cap still stops it.
export const budget = (role, override) => ({ model: modelFor(role, override), turns: ROLES[role].turns, turnLimitOk: Boolean(ROLES[role].turnLimitOk) });

/**
 * CI's results on a commit, as a list an agent or Jev reads: code CI deployed and whose tests passed compiles and
 * runs (no "syntax error" guesses in a review), and a feature whose Apex and Flow tests passed makes "the feature is
 * wrong" an unlikely reading of a UI failure (story #193: Jev guessed "feature" with every test green, E10).
 */
export function ciResults(checkRuns = []) {
  const latest = new Map();
  for (const c of [...checkRuns].sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))) latest.set(c.name, c);
  const lines = [...latest.values()].map((c) => `- ${c.name}: ${c.conclusion || c.status || "pending"}${c.output?.title ? ` (${c.output.title})` : ""}`);
  return lines.length ? lines.join("\n") : "- (no CI results on this commit)";
}
