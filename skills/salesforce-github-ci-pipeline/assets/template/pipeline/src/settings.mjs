// Settings (see docs/handbook.md, "Settings"): every switch the pipeline reads, declared once, with its default.
// Settings are repository variables (Settings > Secrets and variables > Actions > Variables). Every workflow passes all
// of them in one line, `PIPELINE_VARS: ${{ toJSON(vars) }}`, so a new switch needs no workflow edits; an env var of the
// same name, if set, wins (a step that overrides one setting). A name not declared here is a bug: setting() throws, and
// a test checks every name the code and the workflows read is declared and documented in the handbook.

/** [name, default, what it does]. Defaults are what the pipeline does with the variable unset. */
export const SETTINGS = [
  // AI switches: each AI step is its own variable; unset = off, so the pipeline is fully manual by default
  ["AI_PLAN", "false", "Claude plans a story and writes specs (/plan, /spec)"],
  ["AI_IMPLEMENT", "false", "Claude builds a story (/build)"],
  ["AI_REVIEW", "false", "Claude reviews every story PR"],
  ["AI_FIX", "false", "Claude fixes review comments and failed checks"],
  ["AI_UI_TEST", "false", "Claude writes and runs the story's Playwright spec"],
  ["AI_AUTO_CHAIN", "false", "a review, fix and UI test start each other"],
  ["AI_TRIAGE", "false", "Jev triages review risk, UI failures and chained fixes"],
  ["AI_MODEL", "", "one model for every role (empty: per role)"],
  ["AI_MODEL_IMPLEMENT", "", "the implement role's model, to trial one role (empty: AI_MODEL, then the role's default)"],
  ["AI_MODEL_FIX", "", "the fix role's model, to trial one role (empty: AI_MODEL, then the role's default)"],
  ["AI_MODEL_PLAN", "", "the plan role's model, to trial one role (empty: AI_MODEL, then the role's default)"],
  ["AI_MODEL_SPEC", "", "the spec role's model, to trial one role (empty: AI_MODEL, then the role's default)"],
  ["AI_MODEL_REVIEW", "", "the review role's model, to trial one role (empty: AI_MODEL, then the role's default)"],
  ["AI_MODEL_UI_TEST", "", "the ui-test role's model, to trial one role (empty: AI_MODEL, then the role's default)"],
  ["AI_STORY_BUDGET_USD", "5", "what one story's AI agents may spend before they stop (each /budget-ok adds as much again; 0: no limit)"],
  // AI providers other than the subscription (config/ai-models.json providers); never secrets: keys stay in secrets
  ["AI_GATEWAY_URL", "", "the gateway provider's Anthropic-compatible URL (LiteLLM and the like)"],
  ["AWS_ROLE_ARN", "", "the bedrock provider: the AWS role GitHub's OIDC identity assumes"],
  ["AWS_REGION", "", "the bedrock provider: the AWS region"],
  ["GCP_WORKLOAD_IDENTITY_PROVIDER", "", "the vertex provider: the workload identity provider GitHub's OIDC identity uses"],
  ["GCP_SERVICE_ACCOUNT", "", "the vertex provider: the service account it impersonates"],
  ["ANTHROPIC_VERTEX_PROJECT_ID", "", "the vertex provider: the Google Cloud project"],
  ["CLOUD_ML_REGION", "", "the vertex provider: the Vertex AI region"],
  ["UI_EVIDENCE", "false", "a passing UI test posts one screenshot per criterion"],
  // people and identities
  ["APPROVERS", "", "who approves stories (empty: anyone with write access)"],
  ["APPROVAL_MODE", "team", "team: nobody approves a change they pushed; solo: the one approver may, once the AI review passed on it"],
  ["PIPELINE_BOTS", "github-actions", "the pipeline's own bot logins, trusted to start agents"],
  ["BOARD_PROJECT", "", "a GitHub Project number for the delivery board"],
  ["TRACKER", "github", "github or jira"],
  ["SLACK_ACTIONS", "false", "Slack notices carry action buttons (the Slack actions Worker is set up)"],
  // UAT
  ["UAT_ENABLED", "false", "releases go to UAT and need /uat-pass"],
  ["UAT_TESTERS", "{}", "{\"github-login\": \"email\"} for UAT logins"],
  ["UAT_TESTER_ROLE", "", "the role a UAT login gets when no story names a persona"],
  ["SF_UAT_LOGIN_URL", "", "the UAT sandbox's login URL (with secret SF_UAT_USERNAME)"],
  ["UAT_SAMPLE", "off", "on: a masked subset of production goes into UAT after each UAT deploy (uat-sample.yml, SFDMU)"],
  ["UAT_SAMPLE_DOMAINS", "", "production's email domains: the sample fails if any survives masking (acme.com,acme.co.uk)"],
  // orgs
  ["SCRATCH_SNAPSHOT", "", "a snapshot to force, or off (empty: the newest pipeline snapshot)"],
  ["BASELINE", "soft", "the production baseline in every scratch org: soft, strict or off"],
  ["BASELINE_NIGHTLY", "false", "prod-baseline also runs nightly (drift from Setup changes in production)"],
  ["SEED", "on", "synthetic test data in every scratch org: on or off"],
  ["VOLUME_RECORDS", "5000", "volume records in the staging org"],
  ["ORG_RESERVE", "0", "scratch-org slots a new story org leaves free"],
  ["ORG_POOL", "0", "warm scratch orgs kept ready from the snapshot for the next stories (each holds a slot)"],
  // tests
  ["UI_REGRESSION", "release", "the staging UI regression: once per release, or every merge"],
  ["CI_TEST_LEVEL", "RunRelevantTests", "a story's Apex tests: RunRelevantTests or selector"],
  ["PROD_TEST_LEVEL", "RunRelevantTests", "production validation's Apex tests"],
  ["COVERAGE_MIN", "85", "minimum coverage (percent) of each Apex class or trigger a change touches (docs/agents/apex-testing.md)"],
  ["FLOW_COVERAGE_MIN", "0", "minimum Flow coverage (percent) a story's tests must reach"],
];
const BY_NAME = new Map(SETTINGS.map(([n, d]) => [n, d]));

/** A setting's value: an env var of that name, else the repository variable (PIPELINE_VARS), else its default. */
export function setting(name, env = process.env) {
  if (!BY_NAME.has(name)) throw new Error(`setting ${name} is not declared in pipeline/src/settings.mjs`);
  if (env[name] !== undefined && env[name] !== "") return env[name];
  let v;
  try { v = JSON.parse(env.PIPELINE_VARS || "{}")[name]; } catch { v = undefined; }
  return v === undefined || v === null || v === "" ? BY_NAME.get(name) : String(v);
}

/** The settings org provisioning reads (orgRegistry's env): resolved here, so a repository variable reaches it. */
export const ORG_SETTINGS = ["SCRATCH_SNAPSHOT", "BASELINE", "SEED", "VOLUME_RECORDS", "ORG_RESERVE", "ORG_POOL"];
export const orgSettings = (env = process.env) => Object.fromEntries(ORG_SETTINGS.map((n) => [n, setting(n, env)]));

/** Every setting with its value now, for `pipe settings`. */
export const settingsTable = (env = process.env) => SETTINGS.map(([n, d, what]) => ({ name: n, value: setting(n, env), default: d, what }));
