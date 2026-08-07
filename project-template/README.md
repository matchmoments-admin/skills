# Agentic Coding Skills — Six Classic Books as Claude Code Skills

Six reusable Claude Code Agent Skills that turn classic software-engineering
books into actionable guidance an AI coding agent can follow while writing,
reviewing, and refactoring code. Examples use TypeScript/JavaScript oriented
toward web/mobile (React, Node.js, React Native).

## Skills
| Skill | Book | Scope |
|-------|------|-------|
| `clean-code` | Clean Code (R. C. Martin) | Names, functions, comments, error handling, unit tests |
| `refactoring` | Refactoring (M. Fowler) | Smells → named refactorings, safe test-protected change |
| `pragmatic-programmer` | The Pragmatic Programmer (Hunt & Thomas) | DRY, orthogonality, tracer bullets, broken windows, automation |
| `clean-architecture` | Clean Architecture (R. C. Martin) | SOLID, Dependency Rule, boundaries, use cases |
| `software-architecture` | Fundamentals of Software Architecture (Richards & Ford) | Characteristics, trade-offs, ADRs, fitness functions |
| `data-intensive-design` | Designing Data-Intensive Applications (Kleppmann) | Reliability, scalability, data models, replication, consistency |

## Install
Personal (all projects): copy each skill folder into `~/.claude/skills/`.
Project (committed to repo): copy into `.claude/skills/` and commit.

```bash
# personal
cp -r skills/* ~/.claude/skills/
# or project-scoped
mkdir -p .claude/skills && cp -r skills/* .claude/skills/
```

Skills are **model-invoked**: Claude reads each skill's name + description and
loads the body only when relevant. You can also prompt explicitly, e.g.
"apply the refactoring skill to this module."

## How they fit together
- **clean-code** = micro (lines/functions). **refactoring** = the *process* of change.
- **pragmatic-programmer** = mindset/meta-principles. **clean-architecture** = modules/boundaries.
- **software-architecture** = system-level trade-offs & governance. **data-intensive-design** = data & distributed systems.

Use them together: clean-code tells you *what* good code looks like; refactoring
tells you *how* to get there safely; clean-architecture/software-architecture/
data-intensive-design tell you *where the boundaries and trade-offs are*; and
pragmatic-programmer supplies the judgment tying it all together.

## Compatibility
Valid under the open Agent Skills standard (agentskills.io); works in Claude
Code and other compatible agents (Cursor, Codex CLI, Gemini CLI).
