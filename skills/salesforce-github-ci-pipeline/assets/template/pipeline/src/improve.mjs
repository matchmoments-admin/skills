// Pipeline improvements (see GLOSSARY.md: Pipeline improvement): a failed pipeline job becomes a ticket by itself,
// so what goes wrong is fixed in the pipeline, not only worked around in one run. improve.yml calls report() for every
// failed run of a pipeline workflow. A failure that is the story's own (its tests, its access, its deploy errors) is
// the story's to fix and opens nothing; anything else is the pipeline's, including a step this table does not know:
// a wrong ticket costs one triage, a missed one repeats in every run. Repeats update one ticket (by signature).
import { createHash } from "node:crypto";

export const LABEL = "pipeline-improvement";
export const MARK = "<!-- improve:";

// Steps whose failure is the story's own. `storyIf` narrows it: only when the log says so (a deploy can also fail for
// the pipeline's reasons: a signup error, an expired login).
// (matched against the step's output only: its script, printed above it, names force-app on every run)
// Only the story's own gates are here. Staging, UAT and production validation test code that already passed them, so a
// failure there escaped the story's checks (a too-tight timeout, a time-zone-dependent test: E43, E44): always a ticket.
const STORY_COMPONENT = /Component Failures|component failures|tests? failed|Test failure|coverage|FIELD_CUSTOM_VALIDATION|No such column|Invalid type|Variable does not exist|DUPLICATE_|REQUIRED_FIELD_MISSING/i;
const STORY_STEPS = [
  { step: /^Story PRs may not change pipeline code/ },
  { step: /^Access check/ },
  { step: /record-triggered Flow has a Flow test/ },
  { step: /^Code analyzer/ },
  { step: /^Deploy what changed against the base/, storyIf: STORY_COMPONENT },
  { step: /^Tests for this change/, storyIf: STORY_COMPONENT },
  { step: /^Run the committed spec|^Does the spec check a criterion|^Verdict to a commit status/ },
  { step: /^The gate's verdict on this commit|^Decide/ },
];
/** Never the story's, whatever the step: the pipeline broke (a crash's stack trace too) or Salesforce/GitHub had a moment. */
const PIPELINE_ALWAYS = /fatal signup error|Unknown command|SyntaxError|TypeError|ReferenceError|Cannot find module|Resource not accessible|INVALID_SESSION_ID|ECONNRESET|ETIMEDOUT|socket hang up|HTTP (404|5\d\d)|^\s*at .+\.m?js:\d+/im;
/** Not a fault at all: the pipeline refusing or waiting on purpose (a full Dev Hub, a command used at the wrong time). */
const REFUSAL = /No free scratch org slot|scratch org slot\(s\) free|has created its \d+ scratch orgs for today|No open sprint|is still open\. Ship it first|not green yet|Start the story first|not a PR number|bad input|PR #\d+ is not open/i;
const TRANSIENT = /fatal signup error|ECONNRESET|ETIMEDOUT|socket hang up|HTTP 50[234]|Service Unavailable/i;

/** Whose failure is it: "story" (no ticket), "pipeline" (a ticket) or "ignore". */
export function classify({ conclusion = "failure", step = "", logTail = "" }) {
  if (conclusion === "startup_failure") return "pipeline";   // a workflow file GitHub could not run
  if (conclusion !== "failure") return "ignore";   // cancelled (a newer run replaced it), skipped
  // a warning is not why the step failed (a card that could not be updated, #220): judge the rest of the output
  const said = String(logTail).split("\n").filter((l) => !/##\[warning\]|::warning/.test(l)).join("\n");
  if (PIPELINE_ALWAYS.test(said)) return "pipeline";
  if (REFUSAL.test(said)) return "ignore";
  const rule = STORY_STEPS.find((r) => r.step.test(step));
  if (rule && (!rule.storyIf || rule.storyIf.test(said))) return "story";
  return "pipeline";
}

/** The first error a person would read (GitHub's ::error lines first, then the last line that says "error"). */
export function firstError(logTail) {
  const lines = String(logTail).split("\n").map((l) => l.replace(/^\S+Z\s/, "").trim()).filter(Boolean);
  // "Process completed" says nothing (every failed step prints it); runner markers (##[start-action …]) are not output
  const real = lines.filter((l) => !/Process completed with exit code/.test(l) && !/^##\[(?!error|warning)/.test(l));
  const e = real.find((l) => /^##\[error\]|^::error/.test(l)) || [...real].reverse().find((l) => /error|failed|exception/i.test(l)) || real.at(-1) || lines.at(-1) || "";
  return e.replace(/^##\[error\]|^::error[^:]*::/, "").replace(/^Error:\s*/, "").trim().slice(0, 300);
}

/** The same failure in another run gives the same signature: ids, shas, numbers, orgs and times removed. */
export function signature({ workflow, job, step, error }) {
  const norm = String(error).toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>").replace(/\S+@\S+/g, "<email>").replace(/(\/tmp|\/var\/folders|\/home\/runner)\/\S*/g, "<path>")
    .replace(/[\w-]*\d[\w-]*/g, "#")   // any word with a digit: ids, shas, uuids, org usernames, times
    .replace(/\s+/g, " ").trim();
  return createHash("sha256").update([workflow, job, step, norm].join("|")).digest("hex").slice(0, 12);
}

/** No login, session or frontdoor URL in a ticket (Actions masks secrets; these are not secrets to it). */
// Log text is anyone's (a fork's run too): no @-mention pings, every line capped (GitHub refuses bodies over 65,536).
export const scrub = (text) => String(text)
  .replace(/https?:\/\/\S*(frontdoor|secur\/|sid=|access_token|session)\S*/gi, "<redacted url>")
  .replace(/\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]+/g, "<redacted session>")
  .replace(/@(?=[\w-])/g, "@\u200b")
  .split("\n").map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l)).join("\n");
const span = (t) => `\`${String(t).replace(/`/g, "'")}\``;

/** What to do on GitHub: a new ticket, or a "seen again" on the open one with the same signature. */
export function ticket(fault, existing = null) {
  const sig = signature(fault);
  const where = [`- **Stage:** ${fault.workflow} / ${fault.job} / ${fault.step}`, `- **Run:** ${fault.runUrl}`,
    fault.branch ? `- **Branch:** \`${fault.branch}\`${fault.pr ? ` (PR #${fault.pr})` : ""}${fault.story ? `, story #${fault.story}` : ""}` : null].filter(Boolean);
  if (existing) {
    const seen = Number((String(existing.body).match(/\*\*Seen:\*\* (\d+)/) || [])[1] || 1) + 1;
    return { action: "comment", number: existing.number, sig, seen,
      body: String(existing.body).replace(/\*\*Seen:\*\* \d+ times?[^\n]*/, `**Seen:** ${seen} times, last ${fault.runUrl}`),
      comment: [`Seen again (${seen} times).`, "", ...where].join("\n") };
  }
  const error = scrub(fault.error).slice(0, 300);
  const tail = scrub(fault.logTail).split("\n").slice(-30).join("\n").replace(/```/g, "'''");
  const labels = [LABEL, "needs-triage", ...(TRANSIENT.test(fault.logTail) ? ["transient"] : [])];
  const body = [`${MARK}${sig} -->`, "### What happened", "", `${span(fault.step)} failed: ${error ? span(error) : "(no error line)"}`, "",
    "```", tail, "```", "", "### Where", "", ...where, "", "### Seen", "", `**Seen:** 1 time, last ${fault.runUrl}`, "",
    "### Cause", "", "_Triage: why the pipeline failed (not the story)._", "", "### Fix", "",
    "_The change that stops it happening again; the maintenance PR says `Closes #<this issue>`._"].join("\n").slice(0, 60000);
  return { action: "create", sig, labels, body, title: `Pipeline: ${fault.workflow} / ${fault.step} failed: ${error.replace(/[\[\]()<>*_`]/g, "")}`.slice(0, 120) };
}

/** The failed step's own part of the job log, its output only (not the script GitHub prints above it). A job log is one
 *  `##[group]Run …` section per step that ran (and per step inside a composite action). The failed step is the last
 *  section with an error: a continue-on-error step's error comes before it, and the `if: failure()` steps after it
 *  (the card saying CI failed) do not error. */
export function stepOutput(log) {
  const lines = String(log).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n");
  const starts = lines.flatMap((l, i) => (/##\[group\]Run /.test(l) ? [i] : []));
  const sections = starts.map((st, n) => lines.slice(st, starts[n + 1] ?? lines.length));
  const section = [...sections].reverse().find((sec) => sec.some((l) => /##\[error\]/.test(l)));
  if (!section) return lines.slice(-40).join("\n");
  const body = section.slice(section.findIndex((l) => /##\[endgroup\]/.test(l)) + 1);
  const at = body.findIndex((l) => /##\[error\]/.test(l));
  return body.slice(Math.max(0, at - 30), at + 1).join("\n");   // what follows is post-job cleanup
}

/** A failed run → its first failed step's fault, classified. `logOf(jobId)` is the seam (the job's log text). */
export function faultOf(run, jobs, logOf) {
  const base = { workflow: run.name, runUrl: run.html_url, branch: run.head_branch || "", pr: run.pull_requests?.[0]?.number || null };
  base.story = (base.branch.match(/^issue-(\d+)$/) || [])[1] || null;
  const job = jobs.find((j) => j.conclusion === "failure");
  if (!job) return run.conclusion === "startup_failure"
    ? { ...base, job: "(none)", step: "(the workflow file)", logTail: "", error: "the workflow did not start: GitHub could not run its file", whose: "pipeline" } : null;
  const failed = (job.steps || []).find((s) => s.conclusion === "failure");
  const step = failed?.name || "(the job)";
  const logTail = failed ? stepOutput(logOf(job.id) || "") : String(logOf(job.id) || "").split("\n").slice(-40).join("\n");
  return { ...base, job: job.name, step, logTail, error: firstError(logTail), whose: classify({ conclusion: run.conclusion, step, logTail }) };
}

/** improve.yml: read the run, open or update its ticket. Returns a line for the log. */
export function report(io, host, runId) {
  const run = host.api("GET", `repos/${host.repo}/actions/runs/${runId}`);
  const jobs = host.api("GET", `repos/${host.repo}/actions/runs/${runId}/jobs?per_page=100`).jobs || [];
  let unread = null;
  const fault = faultOf(run, jobs, (id) => {
    // job logs carry colour codes, and newer gh refuses to print those without --allow-escape-sequences (older gh has
    // no such flag): try both. The codes are stripped before anything reads the text.
    const path = `repos/${host.repo}/actions/jobs/${id}/logs`;
    for (const extra of [["--allow-escape-sequences"], []]) {
      try { const out = io.run("gh", ["api", ...extra, path], { quiet: true }); unread = null; return out; } catch (e) { unread = e.message; }
    }
    return "";
  });
  if (unread && fault) { fault.logTail = `(the job's log could not be read: ${unread})`; console.log(`::warning::${fault.logTail}`); }
  if (!fault) return `run ${runId}: no failed job`;
  if (fault.whose !== "pipeline") return `run ${runId}: ${fault.step} failed, the ${fault.whose === "story" ? "story's own fault (no ticket)" : "run was not a failure"}`;
  const sig = signature(fault);
  const open = io.ghPages(`repos/${host.repo}/issues?state=open&labels=${LABEL}&per_page=100`) || [];
  const t = ticket(fault, open.find((i) => String(i.body || "").startsWith(`${MARK}${sig} -->`)) || null);   // the marker opens the body: log text cannot fake one
  if (t.action === "comment") {
    host.api("PATCH", `repos/${host.repo}/issues/${t.number}`, { body: t.body });
    host.api("POST", `repos/${host.repo}/issues/${t.number}/comments`, { body: t.comment });
    return `seen again: #${t.number} (${t.seen} times)`;
  }
  const made = host.api("POST", `repos/${host.repo}/issues`, { title: t.title, body: t.body, labels: t.labels });
  if (!made.number) throw new Error(`could not open the ticket: ${made.message || "no reply"}`);
  return `opened #${made.number}: ${t.title}`;
}

/** For the metrics: opened, fixed (closed), open, and the median days to fix. */
export function loop(all, { days = null, now = Date.now() } = {}) {
  const issues = all.filter((i) => String(i.body || "").startsWith(MARK) && (!days || now - Date.parse(i.created_at) <= days * 864e5));   // opened by a run, in the window
  const closed = issues.filter((i) => i.closed_at);
  const toFix = closed.map((i) => (Date.parse(i.closed_at) - Date.parse(i.created_at)) / 864e5).sort((a, b) => a - b);
  const median = toFix.length ? toFix[Math.floor(toFix.length / 2)] : null;
  return { opened: issues.length, fixed: closed.length, open: issues.length - closed.length, medianDays: median === null ? null : Math.round(median * 10) / 10 };
}
