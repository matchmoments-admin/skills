// The only place that runs gh, sf and git. Modules receive these functions, so tests replace them with fakes.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The checkout this pipeline code came from (".pipeline/" in CI: main's copy, never the PR's). */
export const PIPELINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function run(cmd, args, { input, quiet = false, allowFail = false, env } = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", quiet ? "pipe" : "inherit"],
      env: { ...process.env, SF_AUTOUPDATE_DISABLE: "true", FORCE_COLOR: "0", NO_COLOR: "1", NODE_NO_WARNINGS: "1", ...env },
    });
  } catch (e) {
    if (allowFail) return null;
    const detail = (e.stderr || e.stdout || "").toString().trim().split("\n").slice(-5).join("\n");
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

/** Parse the JSON object out of CLI output (warning lines can precede it). */
export function parseJson(text) {
  const s = text.indexOf("{"), a = text.indexOf("[");
  const start = s < 0 ? a : a < 0 ? s : Math.min(s, a);
  if (start < 0) throw new Error("no JSON in command output");
  return JSON.parse(text.slice(start));
}

/** gh output: parsed JSON when the command prints JSON, otherwise the text (e.g. the URL `gh issue comment` prints). */
export const gh = (args, opts) => {
  const out = run("gh", args, { quiet: true, ...opts });
  if (out === null) return null;
  const t = out.trim();
  if (!t) return null;
  return t.startsWith("{") || t.startsWith("[") ? parseJson(t) : t;
};

/** All pages of a REST list endpoint, flattened. `key` picks the array inside an object page (e.g. "check_runs"). */
export function ghPages(path, key) {
  const pages = gh(["api", "--paginate", "--slurp", path]) || [];
  return pages.flatMap((p) => (key ? p[key] || [] : p));
}

export const sf = (args, opts) => {
  const out = run("sf", [...args, "--json"], { quiet: true, ...opts });
  if (out === null) return null;
  const j = parseJson(out);
  if (j.status && j.status !== 0 && !opts?.allowFail) throw new Error(j.message || `sf ${args[0]} failed`);
  return j.result;
};

/** git output trimmed; null when the command fails and allowFail is set (so "not an ancestor" is not "") */
export const git = (args, opts) => {
  const out = run("git", args, { quiet: true, ...opts });
  return out === null ? null : out.trim();
};

export const io = { gh, ghPages, sf, git, run };
