// Agent roles (see GLOSSARY.md: Agent role, Model policy): each AI job's provider, model and turn budget, from
// config/ai-models.json. The workflows name a role; the claude-agent action reads its budget here (`pipe agent budget`),
// so a model change is one line of config, testable, instead of a string in six workflow files. The output format each role writes
// stays in verdict.mjs, next to the parser that reads it. Pure apart from reading the policy file and the settings.
import { readFileSync } from "node:fs";
import { setting } from "./conventions.mjs";

// The model policy (config/ai-models.json): a default, the providers and their model ids per alias, each role's model
// and turn budget, and experiments. One file a team edits to change which model does which job, through which provider.
const POLICY = JSON.parse(readFileSync(new URL("../../config/ai-models.json", import.meta.url), "utf8"));
const ROLE_ALIAS = { "ui-test": "UI_TEST" };
export const ROLES = POLICY.roles;
/** The roles where a model that is not Claude may run (Anthropic does not support Claude Code on other vendors' models;
 *  a read-only role's mistake costs a review round, a writer's costs a broken branch). */
export const NON_CLAUDE_OK = ["review", "plan"];

/** "provider:model", "alias" or a model id -> { provider, model id }. Throws on an unknown provider or a missing id. */
export function resolve(spec, policy = POLICY) {
  const s = String(spec).trim();
  const [provider, name] = s.includes(":") && policy.providers[s.split(":")[0]] ? [s.slice(0, s.indexOf(":")), s.slice(s.indexOf(":") + 1)] : [policy.default.provider, s];
  const p = policy.providers[provider];
  if (!p) throw new Error(`Unknown AI provider: ${provider} (config/ai-models.json providers)`);
  const id = (p.models && Object.hasOwn(p.models, name) ? p.models[name] : null) || (/\d/.test(name) && /[-.:]/.test(name) ? name : null);   // an alias, or a full (versioned) model id
  if (!id) throw new Error(`Provider ${provider} has no model id for "${name}": add it to config/ai-models.json`);
  return { provider, model: id };
}

/** Every role and experiment resolves, writers run Claude, and no role's experiments take more than 100% of stories.
 *  Checked when the policy loads, so a bad edit fails every agent loudly at once, not one story's bucket later. */
export function validatePolicy(policy) {
  const share = {};
  for (const [role, r] of Object.entries(policy.roles)) {
    for (const m of [r.model || policy.default.model, r.declarative].filter(Boolean)) checkModel(role, resolve(m, policy).model);
  }
  for (const e of policy.experiments || []) {
    if (!policy.roles[e.role]) throw new Error(`experiment ${e.arm}: unknown role ${e.role}`);
    checkModel(e.role, resolve(e.model, policy).model);
    share[e.role] = (share[e.role] || 0) + Number(e.percent || 0);
    if (share[e.role] > 100) throw new Error(`experiments on ${e.role} take ${share[e.role]}% of stories`);
  }
  return true;
}
function checkModel(role, id) {
  if (!/claude/i.test(id) && !NON_CLAUDE_OK.includes(role)) throw new Error(`${id} is not a Claude model: only ${NON_CLAUDE_OK.join(" and ")} may run one (config/ai-models.json)`);
}

/** A stable 0-99 bucket for a story, so its every run lands in the same experiment arm. Pure. */
export const bucket = (key) => [...String(key)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 100;

/**
 * Which model a role runs, and why: AI_MODEL_<ROLE> (a trial of one role), then AI_MODEL (every role), then an
 * experiment the story's bucket falls in, then a declarative-only review's cheaper model, then the role's own. Pure
 * apart from the settings. ctx: { story, declarative }. Returns { provider, model, arm }.
 */
export function choose(role, override, { story = "", declarative = false } = {}, policy = POLICY) {
  const r = policy.roles[role];
  if (!r) throw new Error(`Unknown AI role: ${role}`);
  if (override === undefined) override = setting(`AI_MODEL_${ROLE_ALIAS[role] || role.toUpperCase()}`) || setting("AI_MODEL");
  let pick, arm = "";
  if (override && String(override).trim()) { pick = resolve(override, policy); arm = "override"; }
  else {
    let from = 0;
    const x = story && (policy.experiments || []).find((e) => {
      if (e.role !== role) return false;
      const hit = bucket(story) >= from && bucket(story) < from + Number(e.percent || 0);
      from += Number(e.percent || 0);
      return hit;
    });
    if (x) { pick = resolve(x.model, policy); arm = x.arm; }
    else if (declarative && r.declarative) { pick = resolve(r.declarative, policy); arm = "declarative"; }
    else pick = resolve(r.model || policy.default.model, policy);
  }
  checkModel(role, pick.model);
  return { ...pick, arm };
}

/**
 * What a provider needs besides its model: { env } for the agent step and { with } for the cloud login step (non-secret
 * settings only; keys stay in secrets). Throws when a setting it needs is empty, naming it.
 */
export function providerSetup(provider, policy = POLICY) {
  const auth = policy.providers[provider]?.auth;
  const need = (names) => {
    const v = Object.fromEntries(names.map((n) => [n, setting(n)]));
    const missing = names.filter((n) => !v[n]);
    if (missing.length) throw new Error(`provider ${provider} needs ${missing.join(", ")} (repository variables)`);
    return v;
  };
  if (auth === "gateway") { const v = need(["AI_GATEWAY_URL"]); return { auth, env: { ANTHROPIC_BASE_URL: v.AI_GATEWAY_URL }, with: {} }; }
  if (auth === "aws-oidc") { const v = need(["AWS_ROLE_ARN", "AWS_REGION"]); return { auth, env: { AWS_REGION: v.AWS_REGION }, with: { aws_role: v.AWS_ROLE_ARN, aws_region: v.AWS_REGION } }; }
  if (auth === "gcp-wif") {
    const v = need(["GCP_WORKLOAD_IDENTITY_PROVIDER", "GCP_SERVICE_ACCOUNT", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION"]);
    return { auth, env: { ANTHROPIC_VERTEX_PROJECT_ID: v.ANTHROPIC_VERTEX_PROJECT_ID, CLOUD_ML_REGION: v.CLOUD_ML_REGION }, with: { gcp_provider: v.GCP_WORKLOAD_IDENTITY_PROVIDER, gcp_account: v.GCP_SERVICE_ACCOUNT } };
  }
  return { auth: auth || "oauth", env: {}, with: {} };
}

// kept for callers that want only the id
export const modelFor = (role, override, ctx) => choose(role, override, ctx).model;

/** A role's budget: { provider, model, turns, turnLimitOk, arm }. */
// turnLimitOk: a run that hit its turn cap is not a failed job when its work is judged after it (the UI test's spec
// runs in its own job, which posts the verdict); the cap still stops it.
export function budget(role, override, ctx) {
  const c = choose(role, override, ctx);
  return { model: c.model, turns: ROLES[role].turns, turnLimitOk: Boolean(ROLES[role].turnLimitOk), provider: c.provider, arm: c.arm };
}

validatePolicy(POLICY);

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
