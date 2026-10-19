# What a feature org can't match

A feature org is production's shape, packages and customisations, with synthetic data. Say what's different in
`docs/scratch-orgs.md` so nobody trusts it for something it can't show.

| Gap | Why | What to do |
| --- | --- | --- |
| Real records and users | This skill copies no production data. | The synthetic seed (`data.md`). Volume testing needs a separate, larger seed. |
| Secrets: connected apps, certificates, auth providers, named-credential passwords | Excluded or sanitized. | Integrations point at sandboxes or mocks. Put per-org endpoints in custom metadata. |
| Experience sites, territories, entitlements, translations, Email Services | They need features the shape doesn't switch on (`watch` in `baseline.json`). | Enable the feature in the scratch definition, then move the type from `watch` to `types`. |
| Picklist values added to standard fields | `StandardValueSet` can't be listed. | Keep the ones that matter in the source. |
| Profiles | Not copied. Permission sets carry access. | Grant through permission sets, which is better practice anyway. |
| Roles copied by the shape | They can't be assigned to users until rebuilt. | The engine rebuilds them as metadata on new orgs (`rebuildRoles`). |
| Components soft mode dropped | A scratch org can't hold them. | Read the warnings. Fix the shape, or `exclude` the component. |
| Org limits and sharing calculations | Scratch orgs are small. | Test performance in a full sandbox. |
| Changes made in production since the last capture | The baseline is as fresh as its last capture. | Capture nightly. A drift PR shows what changed. |
| A different Dev Hub than production | Then `sourceOrg` must still name production, and the Dev Hub needs Org Shape enabled for it. | Phase 1 checks this. |
