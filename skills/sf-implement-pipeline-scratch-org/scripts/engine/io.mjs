// The only place that runs sf and git. Modules receive these functions, so tests replace them with fakes.
// DERIVED from sf-lifecycle-labs pipeline/src/io.mjs: no gh; CONFIG_ROOT replaces PIPELINE_ROOT; SOURCE_DIRS defaults
// to sfdx-project.json's package directories (ENGINE.md).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The trusted checkout that holds config/, baseline/ and data/seed/: the default branch's copy, never the feature
 *  branch's, so a branch cannot change its own org's shape or data (CONFIG_ROOT; default: the working directory). */
export const CONFIG_ROOT = resolve(process.env.CONFIG_ROOT || process.cwd());

/** The branch's Salesforce source folders: SOURCE_DIRS (space separated), else sfdx-project.json's packageDirectories
 *  (except baseline/, which is never a package directory), else force-app. Read from the working directory: the branch. */
export function sourceDirs(env = process.env, cwd = process.cwd()) {
  if (env.SOURCE_DIRS) return env.SOURCE_DIRS.split(/\s+/).filter(Boolean);
  try {
    const dirs = JSON.parse(readFileSync(join(cwd, "sfdx-project.json"), "utf8")).packageDirectories.map((d) => String(d.path).replace(/\/+$/, ""));
    const ours = dirs.filter((d) => d !== "baseline" && existsSync(join(cwd, d)));
    if (ours.length) return ours;
  } catch { /* no project file: the default */ }
  return ["force-app"];
}

export function run(cmd, args, { input, quiet = false, allowFail = false, env, encoding = "utf8", cwd } = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: encoding === "buffer" ? undefined : encoding, input, maxBuffer: 64 * 1024 * 1024,   // no encoding = a Buffer
      stdio: ["pipe", "pipe", quiet ? "pipe" : "inherit"],
      env: { ...process.env, SF_AUTOUPDATE_DISABLE: "true", SF_SKIP_NEW_VERSION_CHECK: "true", FORCE_COLOR: "0", NO_COLOR: "1", NODE_NO_WARNINGS: "1", ...env },
    });
  } catch (e) {
    if (allowFail === "json") return e.stdout ? String(e.stdout) : null;   // a failed --json command's reply (sf deploy's failures)
    if (allowFail) return null;
    const detail = failureDetail(e.stdout, e.stderr);
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

/** Why a command failed: a --json reply's own name and message first (stderr often holds only a CLI "update
 *  available" warning, which hid the real reason on story #166), then the last lines of stderr, which keep what
 *  callers parse (gh's "(HTTP 404)": codeHost.api reads the status from it); else stdout. Pure. */
export function failureDetail(stdout, stderr) {
  const out = String(stdout || ""), i = out.indexOf("{");
  let json = "";
  if (i >= 0) {
    try { const j = JSON.parse(out.slice(i)); if (j && (j.message || j.name)) json = [j.name, j.message].filter(Boolean).join(": ").replace(/\s+/g, " ").slice(0, 500); } catch { /* not JSON */ }
  }
  const lines = (s) => String(s || "").trim().split("\n").filter((l) => !/update available|›\s+Warning/i.test(l)).slice(-5).join("\n");
  return [json, lines(stderr)].filter(Boolean).join(" | ") || lines(stdout);
}

/** Parse the JSON object out of CLI output (warning lines can precede it). */
export function parseJson(text) {
  const s = text.indexOf("{"), a = text.indexOf("[");
  const start = s < 0 ? a : a < 0 ? s : Math.min(s, a);
  if (start < 0) throw new Error("no JSON in command output");
  return JSON.parse(text.slice(start));
}

/**
 * What kind of failure a Salesforce (or network) error is, from its message: one table for every caller, which branch
 * on the kind instead of keeping a regex each (the snapshot retry knew a JWT login error was a hiccup; the improvement
 * tickets did not). transient: try once more, never blame what was being made; licence, slots, limit: Salesforce's
 * allocation (free one, or wait); shape: production's org shape aged out; real: anything else. Pure.
 */
export const SF_FAILURES = [
  ["transient", /JwtAuthError|Error authenticating|invalid_grant|ECONNRESET|ETIMEDOUT|socket hang up|HTTP 50[234]|Service Unavailable|UNABLE_TO_LOCK_ROW|fatal signup error/i],
  ["licence", /LICENSE_LIMIT_EXCEEDED|License Limit Exceeded/i],
  ["slots", /scratch org slot|ORG_RESERVE|has created its \d+ scratch orgs for today/i],
  ["limit", /REQUEST_LIMIT_EXCEEDED/i],
  ["shape", /shape.{0,40}(outdated|out of date|expired)|outdated.{0,40}shape/i],
];
export const sfFailure = (message) => SF_FAILURES.find(([, re]) => re.test(String(message || "")))?.[0] || "real";

export const sf = (args, opts) => {
  let out;
  try { out = run("sf", [...args, "--json"], { quiet: true, ...opts }); } catch (e) { e.kind = sfFailure(e.message); throw e; }
  if (out === null) return null;
  let j;
  try { j = parseJson(out); } catch (e) { if (opts?.allowFail) return null; throw e; }
  if (j.status && j.status !== 0 && !opts?.allowFail) throw Object.assign(new Error(j.message || `sf ${args[0]} failed`), { kind: sfFailure(j.message) });
  return opts?.allowFail === "json" && j.status ? { ...(j.result || j.data || {}), success: false, failed: true } : j.result;
};

/** git output trimmed; null when the command fails and allowFail is set (so "not an ancestor" is not "") */
export const git = (args, opts) => {
  const out = run("git", args, { quiet: true, ...opts });
  return out === null ? null : out.trim();
};

export const io = { sf, git, run };
