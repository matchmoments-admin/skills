// Every name the pipeline uses, built and parsed in one place (see GLOSSARY.md).
// Pure: no I/O. Workflows get these through `pipe context`; other modules import them.

export const LABELS = {
  feature: { color: "0E8A16", description: "A story" },
  hotfix: { color: "B60205", description: "Urgent production fix: branches from main, ships after its gates" },
  start: { color: "1D76DB", description: "BUTTON: create the story branch and its scratch org" },
  "ai:plan": { color: "C2E0C6", description: "BUTTON (AI_PLAN): Claude proposes the build and asks its open questions (before /start)" },
  "ai:spec": { color: "C2E0C6", description: "BUTTON (AI_PLAN): Claude writes the spec of a bigger piece of work" },
  "ai:implement": { color: "5319E7", description: "BUTTON (AI_IMPLEMENT): AI builds the story in its scratch org and opens a PR" },
  "ai:review": { color: "C5DEF5", description: "BUTTON (AI_REVIEW): run the AI review again" },
  "ai:fix": { color: "FBCA04", description: "BUTTON (AI_FIX): AI fixes what the reviewers found" },
  "ai:test": { color: "D93F0B", description: "BUTTON (AI_UI_TEST): AI writes the Playwright UI test, then it runs" },
  test: { color: "BFD4F2", description: "BUTTON: run the PR's committed story spec (no AI)" },
  ready: { color: "0E8A16", description: "Sign-off on a PR you wrote yourself (GitHub will not let you approve your own)" },
  blocked: { color: "B60205", description: "A gate needs a person; see the latest comment" },
  release: { color: "0052CC", description: "The release PR of a sprint" },
  "in-sprint": { color: "0E8A16", description: "Merged into the sprint: ships with its release (the story closes when it is in production)" },
  "needs-triage": { color: "D4C5F9", description: "A person needs to look at this issue before it becomes a story" },
  "needs-info": { color: "D4C5F9", description: "Waiting on the person who raised it" },
  wontfix: { color: "FFFFFF", description: "Will not be done" },
  spec: { color: "5319E7", description: "A spec (to-spec): made into a story with one tick (Make it a story), never built directly" },
  "needs-human": { color: "FBCA04", description: "A story a person builds (not Claude)" },
  "review:pass": { color: "0E8A16", description: "Verdict: AI review passed" },
  "review:changes": { color: "B60205", description: "Verdict: AI review asks for changes" },
  "ui:pass": { color: "0E8A16", description: "Verdict: UI test passed" },
  "ui:fail": { color: "B60205", description: "Verdict: UI test failed" },
};

// Names of CI jobs whose results gates require. Must match the `name:` of the jobs (ci.yml, staging-deploy.yml)
// and the required checks in the branch rules.
export const CHECKS = {
  static: "static checks (no org)",
  apex: "deploy and Apex tests (scratch org)",
  staging: "staging regression",
};

export const COVERAGE_MIN = 75;

/** Pipeline code: story PRs may not change it (it runs with production credentials). */
// package.json and the lockfile too: install scripts run in jobs that hold credentials, so a story cannot change them.
// The rules the checks and agents enforce too (code-analyzer.yml, CLAUDE.md, REVIEW.md): a story cannot loosen its own review.
export const PIPELINE_PATHS = [".github/", "pipeline/", "scripts/", "config/", "devhub-setup/", "package.json", "package-lock.json",
  "code-analyzer.yml", "CLAUDE.md", "REVIEW.md"];

/** Is this login one of the pipeline's own identities (PIPELINE_BOTS: bare names, e.g. "github-actions,acme-pipeline")?
 *  Exact names only, in the three forms GitHub prints them (name, name[bot], app/name): a look-alike user is not trusted. */
export function isPipelineAuthor(login, bots = setting("PIPELINE_BOTS") || "github-actions") {
  const names = String(bots).split(",").map((b) => b.trim()).filter(Boolean);
  return names.some((n) => [n, `${n}[bot]`, `app/${n}`].includes(String(login || "")));
}
export const touchesPipeline = (files) => files.filter((f) => PIPELINE_PATHS.some((p) => f.startsWith(p)));

/** Metadata a user sees in the UI: a change touching any of these needs a UI test; others do not. */
const UI_FACING = [/\/lwc\//, /\/aura\//, /\/flexipages\//, /\/layouts\//, /\/objects\/[^/]+\/fields\//, /\/quickActions\//,
  /\/tabs\//, /\/applications\//, /\/flows\//, /\/validationRules\//, /\/listViews\//, /\/compactLayouts\//, /\/pages\//, /\/triggers\//,
  /\/reports\//, /\/reportTypes\//, /\/dashboards\//, /\/recordTypes\//, /\/webLinks\//];   // a reporting story is seen in the UI too (spec #125 got "not needed")
export const uiFacing = (files) => files.filter((f) => f.startsWith("force-app/") && UI_FACING.some((re) => re.test(f)));

// ---- settings and AI feature flags ---------------------------------------------------------------------------
// Settings are repository variables (Settings > Secrets and variables > Actions > Variables). Every workflow passes all
// of them in one line, `PIPELINE_VARS: ${{ toJSON(vars) }}`, so a new switch needs no workflow edits and no workflow can
// forget one. An env var of the same name, if set, wins (a step that overrides one setting).
export function setting(name, env = process.env) {
  if (env[name] !== undefined && env[name] !== "") return env[name];
  try { return JSON.parse(env.PIPELINE_VARS || "{}")[name] ?? ""; } catch { return ""; }
}
// Each AI step is its own variable; unset = off, so the pipeline is fully manual by default.
export const AI_FLAGS = { plan: "AI_PLAN", implement: "AI_IMPLEMENT", review: "AI_REVIEW", fix: "AI_FIX", uiTest: "AI_UI_TEST", autoChain: "AI_AUTO_CHAIN", triage: "AI_TRIAGE" };
export function aiFeatures(env = process.env) {
  const on = (name) => String(setting(name, env) || "").trim().toLowerCase() === "true";
  return Object.fromEntries(Object.entries(AI_FLAGS).map(([k, v]) => [k, on(v)]));
}
/** The story's own Playwright spec, which a person (or the AI tester) commits with the change. */
export const storySpec = (key) => `e2e/story-${key}.spec.ts`;

const ORG_LIFETIME_DAYS = { story: 7, sprint: 30 };   // a story often takes longer than 3 days; ensure() rebuilds an expired one
const DEFINITION = { story: "config/scratch-dev.json", hotfix: "config/scratch-hotfix.json", sprint: "config/scratch-qa.json" };

// ---- story keys and branches ---------------------------------------------------------------------------
// GitHub key "12" -> branch "issue-12". Jira key "LIFE-123" -> branch "LIFE-123".
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

export function storyBranch(key) {
  key = String(key).trim();
  if (/^\d+$/.test(key)) return `issue-${key}`;
  if (JIRA_KEY.test(key)) return key;
  throw new Error(`Not a story key: ${key}`);
}

/** Story key from a branch name, or null. Accepts the older issue-N-slug form too. */
export function storyOf(branch) {
  if (!branch) return null;
  const b = String(branch).replace(/^refs\/heads\//, "").replace(/^origin\//, "");
  let m = b.match(/^issue-(\d+)(?:-.*)?$/);
  if (m) return m[1];
  m = b.match(/^([A-Z][A-Z0-9]+-\d+)(?:-.*)?$/);
  return m ? m[1] : null;
}

// ---- sprints ---------------------------------------------------------------------------------------------
export const releaseBranch = (sprint) => `release/${sprint}`;
export const milestoneTitle = (sprint) => `Sprint ${sprint}`;
export function sprintOf(branch) {
  const m = String(branch || "").replace(/^origin\//, "").match(/^release\/(.+)$/);
  return m ? m[1] : null;
}

/** "Sprint 2026-w45" -> "2026-w45" (the tracker's milestone title), or null. */
export const sprintOfMilestoneTitle = (title) => (String(title || "").match(/^Sprint (.+)$/) || [])[1] || null;

/** The next sprint's name after these (YYYY-wNN; the week after the latest), or this ISO week when there is none. */
export function nextSprint(sprints = [], now = new Date()) {
  const weeks = sprints.map((s) => String(s).match(/^(\d{4})-w(\d{2})$/)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const pad = (n) => String(n).padStart(2, "0");
  if (weeks.length) { const [y, w] = weeks.at(-1); return w >= 52 ? `${y + 1}-w01` : `${y}-w${pad(w + 1)}`; }
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return `${d.getUTCFullYear()}-w${pad(Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7))}`;
}

/** The single open release branch, from a list of branch names. Errors if more than one is open. */
export function openRelease(branches) {
  const open = branches.map((b) => b.replace(/^origin\//, "")).filter((b) => b.startsWith("release/")).sort();
  if (open.length > 1) throw new Error(`More than one release branch is open: ${open.join(", ")}`);
  return open[0] || null;
}

// ---- orgs ------------------------------------------------------------------------------------------------
/**
 * Target → org identity. A target is "story:<key>", "sprint:<name>" or a branch name.
 * description is the registry key on the Dev Hub (ScratchOrgInfo.Description).
 */
export function orgFor(target, { hotfix = false } = {}) {
  let kind, id;
  const t = String(target);
  if (t.startsWith("story:")) [kind, id] = ["story", t.slice(6)];
  else if (t.startsWith("uat:")) [kind, id] = ["uat", t.slice(4)];
  else if (t.startsWith("sprint:")) [kind, id] = ["sprint", t.slice(7)];
  else if (sprintOf(t)) [kind, id] = ["sprint", sprintOf(t)];
  else if (storyOf(t)) [kind, id] = ["story", storyOf(t)];
  else return null;
  if (kind === "story") {
    const branch = storyBranch(id);
    return {
      kind, key: id, alias: branch, description: branch, lock: `org-${branch}`,
      definition: hotfix ? DEFINITION.hotfix : DEFINITION.story, days: ORG_LIFETIME_DAYS.story,
    };
  }
  if (kind === "uat") {   // the business sign-off org: a scratch org standing in when no UAT sandbox is configured
    return { kind, sprint: id, alias: "uat", description: `uat-${id}`, lock: "org-uat", definition: DEFINITION.sprint, days: ORG_LIFETIME_DAYS.sprint };
  }
  return {
    kind, sprint: id, alias: "staging", description: `staging-${id}`, lock: "org-staging",
    definition: DEFINITION.sprint, days: ORG_LIFETIME_DAYS.sprint,
  };
}

// ---- where a story's work starts and lands --------------------------------------------------------------
export function isHotfix(labels) {
  return (labels || []).map((l) => (typeof l === "string" ? l : l.name)).includes("hotfix");
}

/** Base branch of a story: main for a hotfix, otherwise the open release branch. */
export function baseFor({ labels, openReleaseBranch }) {
  if (isHotfix(labels)) return "main";
  if (!openReleaseBranch) throw new Error("No open release branch. Run sprint-start first.");
  return openReleaseBranch;
}

/** Everything a workflow needs to know about a story or the open sprint, as flat KEY=value pairs. */
export function context({ key, branch, labels = [], openReleaseBranch = null }) {
  const out = {};
  const story = key || storyOf(branch);
  const sprint = sprintOf(openReleaseBranch);
  if (openReleaseBranch) {
    Object.assign(out, {
      SPRINT: sprint, RELEASE_BRANCH: openReleaseBranch, MILESTONE: milestoneTitle(sprint),
      STAGING_ALIAS: "staging", STAGING_DESCRIPTION: `staging-${sprint}`,
    });
  }
  if (story) {
    const org = orgFor(`story:${story}`, { hotfix: isHotfix(labels) });
    Object.assign(out, {
      STORY: story, STORY_BRANCH: storyBranch(story), ORG_ALIAS: org.alias, ORG_LOCK: org.lock,
      ORG_DEFINITION: org.definition, HOTFIX: String(isHotfix(labels)),
    });
    try {
      out.BASE_BRANCH = baseFor({ labels, openReleaseBranch });
    } catch {
      /* no open sprint: callers that need a base will say so */
    }
  }
  return out;
}
