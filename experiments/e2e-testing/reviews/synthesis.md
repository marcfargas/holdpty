# E2E Testing — Review Synthesis

4 reviews: Gemini (testing + systems), Sonnet (testing + systems).

---

## Unanimous Verdicts (all 4 agree)

### 1. `HOLDPTY_LINGER_MS` is a prerequisite — not optional
Every reviewer flagged the 5-second hardcoded linger in `shutdown()` as the **#1 blocker**. Without making this configurable, every test involving `stop` or `--fg` with child exit pays a 5s+ penalty. ~3 lines of code.

### 2. Named pipe namespace collision on Windows is critical
All reviewers identified that `//./pipe/holdpty-<name>` is system-global. Two tests using session name `foo` collide, even with different `HOLDPTY_DIR`. Must incorporate `HOLDPTY_DIR` (or a prefix/hash) into the pipe name to achieve real isolation.

### 3. Marker-based assertions — never exact match on PTY output
All 4 reviews converge on: embed a unique random token in child output, assert with `includes()`. Never parse or exact-match ConPTY-wrapped output. Use `node -e "process.stdout.write(marker)"` for deterministic child commands, not shell builtins.

### 4. Poll-based synchronization for async PTY output
All agree: poll `logs` in a retry loop until the marker appears. No fixed `sleep()`. Use a `waitForOutput` / `waitForLogs` helper with timeout + backoff.

### 5. Isolated `HOLDPTY_DIR` per test + aggressive cleanup
Track all holder PIDs, kill in `afterEach`, nuke the test dir in `afterAll`. CI needs an orphan-kill step with `if: always()`.

### 6. Error case tests are missing and cheap — add them to P1
CLI arg validation (`no --fg/--bg`, `no --`, `stop nonexistent`) should be P1. They're trivial and catch regressions on the hand-rolled arg parser.

### 7. `--help` and `--version` are good canary tests — P1
Trivial, validate the binary runs at all.

---

## Key Divergences

### A. Attach testing approach
- **Gemini testing**: Use node-pty as test harness to wrap the CLI in a real PTY. Concrete, works in CI.
- **Sonnet testing**: Don't test attach at CLI level for MVP. Library-level tests are sufficient. Use node-pty post-MVP.
- **Both systems**: Agree it's complex, suggest making it skippable.

**Decision needed**: Invest in PTY-wrapped attach tests now, or defer?
→ **Recommendation**: Defer to post-MVP. Library tests already cover attach protocol. Add a single PTY-wrapped test later with `it.skipIf(!hasPTY)` escape hatch.

### B. Test file structure
- Gemini testing: `test/e2e/` with multiple files (lifecycle, view, attach, errors)
- Sonnet testing: Single `src/e2e/e2e.test.ts` with helpers alongside
- Gemini systems: Doesn't prescribe structure
- Sonnet systems: Suggests `test/e2e.test.ts` with separate vitest config

**Decision needed**: Multiple files or single file?
→ **Recommendation**: Single file for MVP (`src/e2e.test.ts` or `test/e2e.test.ts`). Split when it exceeds ~200 lines.

### C. One big lifecycle test vs. many small tests
- Sonnet testing: Argues for one mega-test (`launch → ls → logs → info → stop`) to avoid launch/teardown overhead.
- Gemini testing: Separate tests per concern.

**Decision needed**: Monolith or modular?
→ **Recommendation**: Monolith lifecycle test (Sonnet's argument about overhead is correct). Separate tests for error cases and view (they don't share state anyway).

---

## Code Fixes Required Before E2E (from both systems reviews)

| Fix | Severity | Effort | Details |
|-----|----------|--------|---------|
| **Add `HOLDPTY_LINGER_MS`** | Blocker | ~3 lines | `holder.ts` shutdown timeout |
| **Namespace named pipes** | Blocker | ~5 lines | `platform.ts` pipe name includes hash of `HOLDPTY_DIR` |
| **Reverse metadata/listen order** | Bug | Trivial | In `Holder.start()`: listen first, then writeMetadata |
| **Fix `waitForExit()` race** | Bug | Small | Replace poll with promise-based shutdown signal |
| **`stop` should kill holder PID** | Bug | Small | Kill `meta.pid`, not (or in addition to) `meta.childPid` |

---

## Agreed Test Helpers

All reviews converge on these helpers:

1. **`runCli(args, testDir, opts?)`** — spawn CLI binary, return `{ stdout, stderr, exitCode }` with timeout
2. **`launchBg(testDir, command, name?)`** — launch + verify + return session name
3. **`waitForOutput(testDir, session, marker, timeout?)`** — poll logs until marker found
4. **`waitUntil(predicate, timeout?)`** — generic polling helper
5. **`E2EContext` or `TestContext`** — per-test isolation (dir, env, PID tracking, cleanup)
6. **`randomMarker()`** — generate unique test tokens

---

## Agreed Test Inventory (~13 tests for MVP)

### P1 — Must have
| # | Test | Notes |
|---|------|-------|
| 1 | `--help` exits 0, prints usage | Canary |
| 2 | `--version` exits 0, prints version | Canary |
| 3 | Unknown command exits non-zero | Arg validation |
| 4 | `launch` missing `--fg/--bg` exits non-zero | Arg validation |
| 5 | Full lifecycle: `launch --bg → ls → logs → info → stop → ls empty` | Single monolith test |
| 6 | `launch --bg` stdout is exactly the session name | Agent contract |
| 7 | `launch --fg` exits with child's exit code | CI pipeline contract |
| 8 | `ls --json` returns valid JSON array | Machine-readable output |
| 9 | `stop` nonexistent session exits non-zero | Error handling |
| 10 | `logs` nonexistent session exits non-zero | Error handling |

### P2 — Should have
| # | Test | Notes |
|---|------|-------|
| 11 | `view` receives replay + live data | Time-bounded subprocess |
| 12 | Auto-generated session name | No `--name` flag |
| 13 | `info` nonexistent session exits non-zero | Error handling |

---

## CI Configuration (agreed)

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-latest, windows-latest]
    node: ['20', '22']

env:
  HOLDPTY_LINGER_MS: '200'

steps:
  - Unit tests (fast, no PTY)
  - E2E tests (separate, with timeout)
  - Kill orphan processes (if: always())
```

Vitest config: `pool: 'forks'`, `fileParallelism: false` on Windows, `testTimeout: 30000`.
