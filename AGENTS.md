# ECC — Everything Claude Code (OpenCode 2 global rules)

This file is the global instruction set installed by ECC into
`~/.config/opencode/`. It applies to every project; project `AGENTS.md` files
add their own rules on top.

Install layout:

```text
~/.config/opencode/
├── AGENTS.md              # this file
├── opencode.jsonc         # global config
├── agents/                # 26 ECC agents (markdown, mode: subagent)
├── commands/              # 35 ECC slash commands
├── skills/                # 327 ECC skills (auto-discovered)
├── plugins/ecc/           # ECC hooks plugin (OpenCode 2 API) + 8 custom tools
├── scripts/ hooks/        # ECC runtime payload used by commands and hooks
├── rules/                 # 122 rule files, wired via `instructions` in opencode.jsonc
```

Runtime controls for the hooks plugin:

```powershell
$env:ECC_HOOK_PROFILE = "minimal"    # minimal | standard (default) | strict
$env:ECC_DISABLED_HOOKS = "pre:bash:tmux-reminder,post:edit:typecheck"
```

`strict` additionally runs Prettier and `tsc` after edits. The `hooks` profile is
read at plugin load, so change it before starting OpenCode.

### Rules wiring

`opencode.jsonc` loads the language-agnostic `rules/common/` set through
`instructions`; a project `opencode.jsonc` adds its domain set (for example
`rules/web/` in `E:\First Try`). Edit those keys to change what is loaded — the
`rules/` directory alone has no loader.

These files stay unwired on purpose because they document Claude Code paths that
do not exist here (`~/.claude/` is absent on this machine):

| File | Why skipped |
|------|-------------|
| `rules/common/hooks.md` | tells you to edit `~/.claude/settings.json` |
| `rules/common/agents.md` | documents `~/.claude/agents/` |
| `rules/common/performance.md` | `/effort`, `CLAUDE_CODE_*`, Haiku/Sonnet/Opus |
| `rules/*/hooks.md` | Claude Code hook config, per language |

`rules/README.md` still documents the Claude Code install flow (`cp -r` into
`~/.claude/rules/ecc`) and points at `install.sh` scripts that are not shipped.
For OpenCode, wire files through `instructions` instead.

---

## Security Guidelines (CRITICAL)

### Mandatory Security Checks

Before ANY commit:

- [ ] No hardcoded secrets (API keys, passwords, tokens)
- [ ] All user inputs validated
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (sanitized HTML)
- [ ] CSRF protection enabled
- [ ] Authentication/authorization verified
- [ ] Rate limiting on all endpoints
- [ ] Error messages don't leak sensitive data

### Secret Management

```typescript
// NEVER: Hardcoded secrets
const apiKey = "sk-proj-xxxxx"

// ALWAYS: Environment variables
const apiKey = process.env.OPENAI_API_KEY

if (!apiKey) {
  throw new Error("OPENAI_API_KEY not configured")
}
```

### Security Response Protocol

If a security issue is found:

1. STOP immediately
2. Use the **security-reviewer** agent
3. Fix CRITICAL issues before continuing
4. Rotate any exposed secrets
5. Review the whole codebase for similar issues

---

## Coding Style

### Immutability (CRITICAL)

ALWAYS create new objects, NEVER mutate:

```javascript
// WRONG: Mutation
function updateUser(user, name) {
  user.name = name
  return user
}

// CORRECT: Immutability
function updateUser(user, name) {
  return { ...user, name }
}
```

### File Organization

MANY SMALL FILES > FEW LARGE FILES:

- High cohesion, low coupling
- 200–400 lines typical, 800 max
- Extract utilities from large components
- Organize by feature/domain, not by type

### Error Handling

ALWAYS handle errors comprehensively:

```typescript
try {
  const result = await riskyOperation()
  return result
} catch (error) {
  console.error("Operation failed:", error)
  throw new Error("Detailed user-friendly message")
}
```

### Input Validation

ALWAYS validate user input at the boundary (Zod, JSON Schema, or the
framework's validator) and reject rather than coerce.

### Code Quality Checklist

Before marking work complete:

- [ ] Code is readable and well-named
- [ ] Functions are small (<50 lines)
- [ ] Files are focused (<800 lines)
- [ ] No deep nesting (>4 levels)
- [ ] Proper error handling
- [ ] No `console.log` statements left behind
- [ ] No hardcoded values
- [ ] No mutation (immutable patterns used)

---

## Testing Requirements

### Minimum Test Coverage: 80%

Test types (ALL required where they apply):

1. **Unit tests** — individual functions, utilities, components
2. **Integration tests** — API endpoints, database operations
3. **E2E tests** — critical user flows (Playwright)

### Test-Driven Development

MANDATORY workflow:

1. Write the test first (RED)
2. Run it — it must FAIL
3. Write the minimal implementation (GREEN)
4. Run it — it must PASS
5. Refactor (IMPROVE)
6. Verify coverage (80%+)

### Troubleshooting Test Failures

1. Use the **tdd-guide** agent
2. Check test isolation
3. Verify the mocks
4. Fix the implementation, not the tests (unless the tests are wrong)

---

## Git Workflow

### Commit Message Format

```
<type>: <description>

<optional body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`

### Pull Request Workflow

When creating PRs:

1. Analyze the full commit history (not just the latest commit)
2. Use `git diff [base-branch]...HEAD` to see every change
3. Draft a comprehensive PR summary
4. Include a test plan with TODOs
5. Push with `-u` on a new branch

### Feature Implementation Workflow

1. **Plan first** — use the **planner** agent, identify dependencies and risks, split into phases
2. **TDD** — use the **tdd-guide** agent, RED → GREEN → refactor, verify 80%+ coverage
3. **Code review** — use the **code-reviewer** agent right after writing code; fix CRITICAL and HIGH findings
4. **Commit & push** — detailed conventional commit messages

---

## Agent Orchestration

### Available agents

ECC installs these subagents under `~/.config/opencode/agents/`. OpenCode also
has the built-in `build`, `plan`, `general` and `explore` agents.

| Agent | Purpose | When to use |
|-------|---------|-------------|
| planner | Implementation planning | Complex features, refactoring |
| architect | System design | Architectural decisions |
| tdd-guide | Test-driven development | New features, bug fixes |
| code-reviewer | Code review | After writing code |
| security-reviewer | Security analysis | Before commits |
| build-error-resolver | Fix build errors | When the build fails |
| e2e-runner | E2E testing | Critical user flows |
| refactor-cleaner | Dead code cleanup | Code maintenance |
| doc-updater | Documentation | Updating docs |
| database-reviewer | Database optimization | SQL, schema design |
| docs-lookup | Current library docs (Context7) | API questions |
| harness-optimizer | Harness/config tuning | Prompt and agent tuning |
| loop-operator | Autonomous loop control | Long-running loops |
| go-reviewer / go-build-resolver | Go | Go projects |
| rust-reviewer / rust-build-resolver | Rust | Rust projects |
| python-reviewer | Python | Python projects |
| java-reviewer / java-build-resolver | Java, Spring | JVM projects |
| kotlin-reviewer / kotlin-build-resolver | Kotlin, Android | KMP projects |
| cpp-reviewer / cpp-build-resolver | C++ | C++ projects |
| php-reviewer | PHP | PHP projects |
| ruby-reviewer | Ruby, Rails | Rails projects |

### Immediate agent usage

No user prompt needed to reach for:

1. Complex feature requests → **planner**
2. Code just written or modified → **code-reviewer**
3. Bug fix or new feature → **tdd-guide**
4. Architectural decision → **architect**

### Slash commands

`/plan`, `/tdd`, `/code-review`, `/security`, `/build-fix`, `/e2e`,
`/refactor-clean`, `/orchestrate`, `/verify`, `/checkpoint`, `/eval`,
`/test-coverage`, `/update-docs`, `/update-codemaps`, `/learn`, `/setup-pm`,
`/skill-create`, `/harness-audit`, `/quality-gate`, `/model-route`, plus
language-specific ones (`/go-review`, `/go-test`, `/go-build`, `/rust-review`,
`/rust-test`, `/rust-build`, `/security-scan`) and the instinct family
(`/instinct-status`, `/instinct-import`, `/instinct-export`, `/evolve`,
`/promote`, `/projects`, `/loop-start`, `/loop-status`).

Commands that shell out to a runtime need `node` on `PATH`:

- `node` directly: `setup-pm`, `harness-audit`, `instinct-status`, `evolve`,
  `promote`, `projects` (the last four also accept `python3`)
- `npx`: `build-fix`, `verify`, `e2e`, `refactor-clean`, `security-scan`

Without a runtime these fail before doing any work; everything else keeps
running. `/instinct-import` and `/instinct-export` are prompt-only and work
regardless. Node is **not** installed on this machine, so treat that list as
unavailable until it is.

The `skills/ck` skill also needs `node`; it will not run here.

---

## Custom tools

The ECC plugin registers eight tools on top of OpenCode's built-ins:

| Tool | Purpose |
|------|---------|
| `run-tests` | Detect the package manager/framework and run the suite |
| `check-coverage` | Analyse coverage output against a threshold |
| `security-audit` | Scan dependencies, secrets and code patterns |
| `format-code` | Detect the formatter and return the command |
| `lint-check` | Detect the linter and return the command |
| `git-summary` | Branch, status, log and diff stat in one call |
| `changed-files` | Tree of files changed in this session |
| `dependency-analyzer` | Outdated, vulnerable and unused packages |

Hooks also run on their own: Prettier (`strict`), TypeScript check (`strict`),
`console.log` audit, git-push and long-command reminders, documentation-file
warnings, session context, todo progress, desktop notification on idle, shell
environment injection, compaction context and read-only permission auto-approval.

The hooks plugin is TypeScript and runs inside the OpenCode runtime, so hooks and
all eight tools work without a system `node`. `scripts/` is different: it holds
~375 `.js` helpers that only run under a real `node`, so anything importing them
(the runtime-dependent slash commands above) stays inert on this machine.

---

## Performance and context

- Prefer a small model for lightweight subtasks, a strong model for design and
  review work.
- Avoid starting large refactors with the last 20% of the context window
  remaining; use `/checkpoint` and let OpenCode compact deliberately.
- The ECC compaction hook preserves the active task, key decisions, edited
  files and remaining work.

---

## OpenCode-specific notes

- Formatting and type checking are `strict`-profile hooks; with the default
  `standard` profile run `prettier --write <file>` and `npx tsc --noEmit`
  manually after editing JS/TS.
- Before committing: run the security checks, verify no secrets are staged, and
  run the full test suite.
- OpenCode 2 rediscovers config, agents, commands, skills and plugins on save;
  no restart is needed after editing them.

---

## Success metrics

You are successful when:

- All tests pass (80%+ coverage)
- No security vulnerabilities
- Code is readable and maintainable
- Performance is acceptable
- The user's requirements are met
