# Domain docs

How the engineering skills read this repo's domain documentation. There are two contexts (see `GLOSSARY-MAP.md`):

- **The Salesforce org** (`docs/org/GLOSSARY.md`): the business words (Account tier, Customer Since, Sales region...) and
  which object or field each one is. Specs and stories use these words.
- **The delivery pipeline** (`GLOSSARY.md` at the root): Story, Gate, Lane, Card... Only for pipeline work.

Also read `docs/agents/salesforce.md` before writing a spec, tickets, tests or a PR body: it translates the skills'
code-shaped advice (seams, tests, slices, merge danger) into Apex, Flows, permission sets and metadata.

ADRs live in `docs/adr/` (none yet). If a doc is missing, proceed silently; `/domain-modeling` creates them lazily.
