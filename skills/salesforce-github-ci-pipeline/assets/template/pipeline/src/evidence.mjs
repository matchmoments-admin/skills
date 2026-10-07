// UI evidence (see GLOSSARY.md): when a story's UI test passes, the screenshots its spec took with evidence()
// (e2e/support/evidence.ts) go on the story as one comment, edited in place, so a reviewer or UAT tester sees the
// feature before logging in. Behind the switch UI_EVIDENCE (on only when "true"); off, nothing is taken or posted.
//
// The spec runs untrusted (no token); this module runs in the trusted report job, so it checks every file before
// publishing: WebP only, small, at most MAX_SHOTS, safe names, captions escaped, a Lightning path and never a URL.
// Storage: the `evidence` branch, one folder per story holding only its latest passing head (each publish replaces
// the folder in one commit); squash() rewrites the branch to one commit of open stories' folders, so it never grows.
import { setting } from "./conventions.mjs";

export const BRANCH = "evidence";
export const EVIDENCE_MARK = "<!-- pipeline:evidence -->";
export const MAX_SHOTS = 6;
export const MAX_BYTES = 120 * 1024;
const NAME = /^(\d\d)-([a-z0-9-]{1,60})\.(webp|json)$/;

/** Is UI evidence on? Unset = off, like every other switch. */
export const evidenceOn = (env = process.env) => String(setting("UI_EVIDENCE", env) || "").trim().toLowerCase() === "true";

const isWebp = (buf) => buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP";
const escapeMd = (s) => String(s).replace(/[\\`*_[\]<>|!#]/g, (c) => `\\${c}`).replace(/\s+/g, " ").trim();

/**
 * Check what the spec wrote. files: [{ name, data: Buffer }]. Returns { shots: [{ n, name, data, caption, path }], rejected: [why] }.
 * Pure.
 */
export function check(files) {
  const rejected = [];
  const byStem = new Map();
  for (const f of files) {
    const m = String(f.name).match(NAME);
    if (!m) { rejected.push(`${f.name}: not an evidence file name`); continue; }
    const stem = `${m[1]}-${m[2]}`;
    const e = byStem.get(stem) || { n: Number(m[1]), stem };
    if (m[3] === "webp") {
      if (f.data.length > MAX_BYTES) { rejected.push(`${f.name}: ${Math.round(f.data.length / 1024)} KB is over ${MAX_BYTES / 1024} KB`); continue; }
      if (!isWebp(f.data)) { rejected.push(`${f.name}: not a WebP image`); continue; }
      e.data = f.data;
    } else {
      if (f.data.length > 2048) { rejected.push(`${f.name}: over 2 KB`); continue; }
      try {
        const j = JSON.parse(f.data.toString("utf8"));
        e.caption = escapeMd(String(j.caption || "").slice(0, 140));
        e.path = /^\/lightning\/[A-Za-z0-9_\-/]{1,200}$/.test(String(j.path || "")) ? j.path : null;   // a path, never a URL or a query
      } catch { rejected.push(`${f.name}: not JSON`); continue; }
    }
    byStem.set(stem, e);
  }
  const shots = [...byStem.values()].filter((e) => e.data).sort((a, b) => a.n - b.n);
  for (const s of shots.slice(MAX_SHOTS)) rejected.push(`${s.stem}.webp: more than ${MAX_SHOTS} screenshots`);
  return { shots: shots.slice(0, MAX_SHOTS).map((s) => ({ n: s.n, name: `${s.stem}.webp`, data: s.data, caption: s.caption || s.stem.slice(3).replace(/-/g, " "), path: s.path || null })), rejected };
}

/** Where a story's screenshots live on the evidence branch. */
export const folder = (key) => {
  if (!/^[A-Za-z0-9-]{1,40}$/.test(String(key))) throw new Error(`not a story key: ${key}`);
  return `story-${key}`;
};
const keyOf = (path) => path.match(/^story-([A-Za-z0-9-]{1,40})\//)?.[1];
export const imagePath = (key, sha, name) => `${folder(key)}/${String(sha).slice(0, 7)}/${name}`;

/** The evidence comment. orgUrl: the story org's instance URL (not a secret), or null. Pure. */
export function evidenceComment({ key, pr, sha, shots, orgUrl = null, repoUrl, when = new Date() }) {
  const base = orgUrl && /^https:\/\/[a-z0-9.-]+\.(force|salesforce)\.com\/?$/i.test(orgUrl) ? orgUrl.replace(/\/$/, "") : null;
  const lines = [EVIDENCE_MARK, `### UI evidence (${shots.length} ${shots.length === 1 ? "screenshot" : "screenshots"})`, "",
    `The UI test passed on [\`${String(sha).slice(0, 7)}\`](${repoUrl}/commit/${sha}) of [#${pr}](${repoUrl}/pull/${pr}), ${when.toISOString().slice(0, 16).replace("T", " ")} UTC. Each screenshot is one acceptance criterion, as the test saw it in the story's scratch org.`];
  if (base && shots.some((s) => s.path)) lines.push("", `To look yourself: tick **Send me a login to this story's scratch org** on [#${pr}](${repoUrl}/pull/${pr}), set your password, then the links below open the records shown.`);
  for (const s of shots) {
    const img = `${repoUrl}/blob/${BRANCH}/${imagePath(key, sha, s.name)}?raw=true`;
    lines.push("", `**${s.caption}**${base && s.path ? ` · [open in the scratch org](${base}${s.path})` : ""}`, "", `![${s.caption}](${img})`);
  }
  lines.push("", "_Replaced each time the UI test passes on a newer commit. Removed when the story is closed._");
  return lines.join("\n");
}

/**
 * Put the screenshots on the evidence branch, replacing the story's folder, in one commit (Git Data API: one blob per
 * image, one tree, one commit, one ref update; a concurrent writer means a retry). api: the gh seam
 * (method, path, body) -> json | { status }. Throws when it cannot write: the caller keeps the plain verdict.
 */
export function store({ api, repo, key, sha, shots, sleep = () => {} }) {
  const blobs = shots.map((s) => {
    const b = api("POST", `repos/${repo}/git/blobs`, { content: s.data.toString("base64"), encoding: "base64" });
    if (b?.status || !b?.sha) throw new Error(`could not store ${s.name}: ${b?.message || b?.status}`);
    return { path: imagePath(key, sha, s.name), mode: "100644", type: "blob", sha: b.sha };
  });
  for (let i = 0; i < 5; i++) {
    const ref = api("GET", `repos/${repo}/git/ref/heads/${BRANCH}`);
    const parent = ref?.status ? null : ref.object.sha;
    let entries = blobs;
    let baseTree;
    if (parent) {
      baseTree = api("GET", `repos/${repo}/git/commits/${parent}`).tree.sha;
      const tree = api("GET", `repos/${repo}/git/trees/${baseTree}?recursive=1`);
      const stale = (tree.tree || []).filter((e) => e.type === "blob" && e.path.startsWith(`${folder(key)}/`) && !blobs.some((b) => b.path === e.path));
      entries = [...blobs, ...stale.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: null }))];   // sha null deletes
    }
    const tree = api("POST", `repos/${repo}/git/trees`, baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries });
    if (tree?.status) throw new Error(`could not build the tree: ${tree.message}`);
    const commit = api("POST", `repos/${repo}/git/commits`, { message: `evidence: story ${key} at ${String(sha).slice(0, 7)}`, tree: tree.sha, parents: parent ? [parent] : [] });
    if (commit?.status) throw new Error(`could not commit: ${commit.message}`);
    const r = parent ? api("PATCH", `repos/${repo}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false })
      : api("POST", `repos/${repo}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
    if (!r?.status) return commit.sha;
    sleep((500 + Math.random() * 1500) * (i + 1));   // 422: the branch moved under a concurrent publish
  }
  throw new Error(`the ${BRANCH} branch kept moving: not stored`);
}

/**
 * Rewrite the evidence branch as one parentless commit holding only the folders of stories still open, so deleted
 * screenshots stop costing storage. isOpen(key) -> boolean (unknown = keep). Returns { kept, removed } or null.
 */
export async function squash({ api, repo, isOpen }) {
  const ref = api("GET", `repos/${repo}/git/ref/heads/${BRANCH}`);
  if (ref?.status) return null;   // no evidence yet
  const head = api("GET", `repos/${repo}/git/commits/${ref.object.sha}`);
  const all = (api("GET", `repos/${repo}/git/trees/${head.tree.sha}?recursive=1`).tree || []).filter((e) => e.type === "blob");
  const keys = [...new Set(all.map((e) => keyOf(e.path)).filter(Boolean))];
  const open = new Set();
  for (const k of keys) if (await isOpen(k)) open.add(k);
  const kept = all.filter((e) => open.has(keyOf(e.path)));
  const removed = keys.filter((k) => !open.has(k));
  if (!removed.length && !head.parents.length) return { kept: open.size, removed: [] };   // already one commit of open stories
  const tree = api("POST", `repos/${repo}/git/trees`, { tree: kept.length ? kept.map((e) => ({ path: e.path, mode: e.mode, type: "blob", sha: e.sha }))
    : [{ path: "README.md", mode: "100644", type: "blob", content: "UI evidence: screenshots of open stories (pipeline/src/evidence.mjs).\n" }] });
  const commit = api("POST", `repos/${repo}/git/commits`, { message: `evidence: open stories only (${open.size})`, tree: tree.sha, parents: [] });
  if (api("GET", `repos/${repo}/git/ref/heads/${BRANCH}`)?.object?.sha !== ref.object.sha) return null;   // a publish just landed: next sweep
  const r = api("PATCH", `repos/${repo}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true });
  if (r?.status) throw new Error(`could not squash ${BRANCH}: ${r.message}`);
  return { kept: open.size, removed };
}
