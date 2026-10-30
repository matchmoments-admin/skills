// Loaded before every pipeline test file (package.json: node --import ./pipeline/test/env.mjs --test ...). Tests never
// reach a real tracker or channel: CI's job may carry the Jira login or Slack's webhook, and PIPELINE_VARS carries the
// repository's own TRACKER and JIRA_BASE_URL. TRACKER=jira set by hand in the env stays: that is a deliberate run.
for (const n of ["JIRA_EMAIL", "JIRA_API_TOKEN", "SLACK_WEBHOOK_URL"]) delete process.env[n];
try {
  const vars = JSON.parse(process.env.PIPELINE_VARS || "{}");
  delete vars.TRACKER;
  delete vars.JIRA_BASE_URL;
  process.env.PIPELINE_VARS = JSON.stringify(vars);
} catch {
  delete process.env.PIPELINE_VARS;
}
