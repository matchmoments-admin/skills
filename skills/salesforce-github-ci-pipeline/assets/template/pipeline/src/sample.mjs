// The masked production sample for UAT (UAT_SAMPLE, uat-sample.yml): SFDMU copies a small subset of production into the
// UAT org with every personal field replaced (config/uat-sample/export.json). This is the guard that runs after it: no
// value may still carry one of production's own email domains (UAT_SAMPLE_DOMAINS). Free text (descriptions, comments)
// is never selected, so names, emails and phones are the fields to check. Pure.

/** The SOQL the guard runs in UAT: Contacts and Leads whose email ends in a production domain. */
export function guardQueries(domains) {
  const ds = parseDomains(domains);
  if (!ds.length) return [];
  const where = ds.map((d) => `Email LIKE '%@${d}'`).join(" OR ");
  return [`SELECT Id, Email FROM Contact WHERE ${where} LIMIT 5`, `SELECT Id, Email FROM Lead WHERE ${where} LIMIT 5`];
}

/** The domains, cleaned: "acme.com, @acme.co.uk" -> ["acme.com", "acme.co.uk"]; anything not a domain is dropped. */
export function parseDomains(text) {
  return String(text || "").split(/[,\s]+/).map((d) => d.trim().replace(/^@/, "").toLowerCase()).filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
}

/** The guard's verdict from the rows the queries returned: { ok, leaked: [email] }. */
export function sampleLeaks(rows = []) {
  const leaked = rows.map((r) => r.Email).filter(Boolean);
  return { ok: leaked.length === 0, leaked: leaked.map((e) => e.replace(/^[^@]+/, "***")) };
}
