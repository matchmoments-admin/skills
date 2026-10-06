# Local edits to vendored upstream skills

`scripts/sync-upstream.sh` copies upstream over `skills/<name>/`, then re-applies each patch here. To change a vendored
skill locally: edit it, then regenerate its patch against the upstream commit in `skills/.upstream-ref`:

```bash
U=$(mktemp -d) && git clone -q https://github.com/mattpocock/skills.git $U/up && git -C $U/up checkout -q <sha>
mkdir -p $U/a/skills $U/b/skills && cp -R $U/up/skills/<category>/<name> $U/a/skills/ && cp -R skills/<name> $U/b/skills/
(cd $U && git diff --no-index a/skills/<name> b/skills/<name>) | sed 's#a/a/skills/#a/skills/#g; s#b/b/skills/#b/skills/#g' > patches/<name>.patch
```

- `ask-matt.patch`: reviews go to the built-in `/code-review` and `/local-ultrareview`.
- `pr.patch`: in Salesforce repos, read `docs/agents/salesforce.md` first; keep the pipeline's `Story #N`.
