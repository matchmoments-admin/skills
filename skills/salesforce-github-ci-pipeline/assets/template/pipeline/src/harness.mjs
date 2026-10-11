// The harness overlay (see GLOSSARY.md): main's rules and test harness laid over a branch's checkout, hidden from git.
// An agent or a spec on a story or release branch must follow main's CLAUDE.md, REVIEW.md and docs/agents, and run
// main's e2e/support (login, personas, evidence), never the branch's older copy; and nothing it commits may carry
// main's copy back onto the branch. One way to do it, for every workflow (six hand-written copies drifted: #180, #181,
// #184, #186, and implement and fix read the branch's CLAUDE.md).
//
// Run it after the branch is checked out and brought up to date (pipeline-identity re-checks out; a merge would trip
// over the hidden changes), from the branch's checkout, with main's sparse copy at `from` (default .pipeline).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What each role takes from main. */
export const OVERLAYS = {
  implement: ["CLAUDE.md", "REVIEW.md", "docs/agents"],
  fix: ["CLAUDE.md", "REVIEW.md", "docs/agents"],
  "ui-test": ["CLAUDE.md", "docs/agents", "e2e/support"],
  staging: ["e2e/support"],
};

/**
 * Lay main's copy of the role's paths over the checkout at `root`: the tracked files are marked skip-worktree, the
 * paths (and .pipeline/) are added to .git/info/exclude, and each path is replaced by main's. Throws if main lacks a
 * path, or if git would still see any of them as changed. git: the io seam, run in `root`. Returns the paths.
 */
export function overlay(role, { git, root = process.cwd(), from = ".pipeline" }) {
  const paths = OVERLAYS[role];
  if (!paths) throw new Error(`harness overlay: unknown role "${role}" (one of ${Object.keys(OVERLAYS).join(", ")})`);
  const exclude = join(root, ".git/info/exclude");
  const have = new Set(existsSync(exclude) ? readFileSync(exclude, "utf8").split("\n") : []);
  // anchored: "/CLAUDE.md" hides the root file only, never a nested CLAUDE.md an agent creates
  const add = [".pipeline/", ...paths.map((p) => (isDir(join(root, from, p)) ? `/${p}/` : `/${p}`))].filter((l) => !have.has(l));
  if (add.length) { mkdirSync(dirname(exclude), { recursive: true }); writeFileSync(exclude, [...have].filter(Boolean).concat(add, "").join("\n")); }
  for (const p of paths) {
    const src = join(root, from, p);
    if (!existsSync(src)) throw new Error(`harness overlay: main has no ${p} (is it in the .pipeline sparse checkout?)`);
    const tracked = (git(["ls-files", "-z", "--", p], { cwd: root }) || "").split("\0").filter(Boolean);
    if (tracked.length) git(["update-index", "--skip-worktree", "--", ...tracked], { cwd: root });
    rmSync(join(root, p), { recursive: true, force: true });
    mkdirSync(dirname(join(root, p)), { recursive: true });
    cpSync(src, join(root, p), { recursive: true });
  }
  const seen = git(["status", "--porcelain", "--", ...paths], { cwd: root }) || "";
  if (seen.trim()) throw new Error(`harness overlay: git still sees main's copy:\n${seen}`);
  return paths;
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
