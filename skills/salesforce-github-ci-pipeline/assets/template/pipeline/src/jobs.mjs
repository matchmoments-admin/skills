// The jobs the pipeline starts, by name. Policy names a job ("gate", "uat-deploy"), never a workflow file, label or
// Buildkite pipeline: the CI runner (pipeline/src/runners/) owns how a job starts on its platform. A job name is
// the contract between the two; a runner that cannot start one of these is incomplete (its contract test says so).
export const JOBS = Object.freeze({
  "issue-start": "a story's branch and scratch org (inputs: key, labels)",
  gate: "decide and, when the PR may land, merge it (inputs: pr)",
  ci: "deploy and test a branch in its org (inputs: ref)",
  staging: "the release branch in the staging org: Apex, Flow and the UI regression",
  "uat-deploy": "the release candidate in UAT (inputs: pr, again?, warm?)",
  "uat-login": "a UAT or story-org login for a person (inputs: pr, who, target?, admin?)",
  release: "validate and quick-deploy main to production (inputs: sha, validated_job?, validated_tree?)",
  "back-merge": "main back into the open sprint",
  "sprint-start": "open a sprint and its staging org (inputs: sprint, start?)",
  "release-cut": "the sprint's release PR",
  "story-retrieve": "Setup changes from a story org into its branch (inputs: story, who)",
  "story-data": "a Data request into a story org (inputs: story, who, request)",
  "scratch-janitor": "free idle scratch orgs",
  "lane-wake": "re-run jobs parked on an org lane",
  "ai-review": "Claude reviews a PR (inputs: pr)",
  "ai-fix": "Claude fixes a PR's findings (inputs: pr)",
  "ui-test": "the story's UI test, written by Claude or by a person (inputs: pr, mode)",
});

/** The job's name, checked: a typo would start nothing, silently. */
export function job(name) {
  if (!Object.hasOwn(JOBS, name)) throw new Error(`no such job: ${name} (pipeline/src/jobs.mjs)`);
  return name;
}
