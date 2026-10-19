// Org names, built and parsed in one place. Pure: no I/O.
// DERIVED from sf-lifecycle-labs pipeline/src/conventions.mjs (orgFor, storyOf): any branch gets an org, not only
// issue-N / Jira-key branches, and the definition, lifetime and prefix are settings (ENGINE.md).

const JIRA_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const MAX_DESCRIPTION = 80;   // also the alias; long enough to read, short enough for every CLI table

/** A branch's story key: its Jira key when it has one ("feature/LIFE-123-tidy" -> "LIFE-123"), else the branch as a
 *  slug ("Tidy up_accounts" -> "tidy-up-accounts"), so one ticket worked on two branches shares one org. Null for none. */
export function storyOf(branch) {
  const b = String(branch || "").replace(/^refs\/heads\//, "").replace(/^origin\//, "").trim();
  if (!b) return null;
  const jira = b.match(JIRA_KEY);
  if (jira) return jira[1];
  return b.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || null;
}

/** A short stable hash, so two long branches that truncate to the same text still get two orgs. Pure. */
const shortHash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36).slice(0, 6); };

/** The Dev Hub description (and alias) of a story key: ORG_PREFIX + key, truncated with a hash when too long. Pure. */
export function descriptionFor(key, prefix = "feat-") {
  const d = `${prefix}${key}`;
  return d.length <= MAX_DESCRIPTION ? d : `${d.slice(0, MAX_DESCRIPTION - 7)}-${shortHash(d)}`;
}

/**
 * Target -> org identity. A target is "story:<key>", "snapshot", or a branch name. description is the registry key on
 * the Dev Hub (ScratchOrgInfo.Description); the alias is the same. env: ORG_PREFIX (default "feat-"), SCRATCH_DEF (the
 * definition, relative to CONFIG_ROOT; default config/scratch-feature.json), ORG_DAYS (default 7, at most 30).
 */
export function orgFor(target, { env = process.env } = {}) {
  const prefix = env.ORG_PREFIX || "feat-";
  const definition = env.SCRATCH_DEF || "config/scratch-feature.json";
  const days = Math.min(30, Math.max(1, Number(env.ORG_DAYS || 7)));
  const t = String(target || "");
  if (t === "snapshot") return { kind: "snapshot", alias: "snapshot-src", description: "snapshot-src", definition, days: 1 };   // the snapshot's source org
  const key = t.startsWith("story:") ? t.slice(6) : storyOf(t);
  if (!key) return null;
  const description = descriptionFor(key, prefix);
  return { kind: "story", key, alias: description, description, definition, days };
}

/** Is a Description one of this pipeline's orgs (feature, CI temporary, snapshot source)? */
export const isPipelineOrg = (d, prefix = process.env.ORG_PREFIX || "feat-") =>
  String(d || "").startsWith(prefix) || /^(ci-|snapshot-)/.test(String(d || ""));
