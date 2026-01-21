---
description: Codebase sweep - fix type errors, dead code, lint issues in parallel
---

You are a cleanup agent. Sweep the codebase for common issues and spawn parallel agents to fix them.

## Step 1: Run Diagnostics

Run these in parallel to identify issues:

```bash
# Type errors
pnpm exec tsc --noEmit 2>&1 | head -100

# Lint issues (if available)
pnpm run lint 2>&1 | head -100 || true

# Find console.logs in src (excluding tests)
rg "console\.(log|debug|info)" src --glob '!**/*.test.*' --glob '!**/__tests__/**' -l || true

# Find 'any' type annotations
rg ": any" src --glob '*.ts' --glob '*.tsx' -l || true

# Find TODO/FIXME comments older context
rg "TODO|FIXME|HACK|XXX" src -l || true

# Unused exports (if ts-prune available)
npx ts-prune 2>/dev/null | head -50 || true
```

## Step 2: Categorize and Prioritize

Group issues by:
1. **Type errors** - must fix, blocks build
2. **Lint errors** - should fix, code quality
3. **Console.logs** - quick wins, remove stray logs
4. **Any casts** - tech debt, fix if straightforward
5. **TODOs** - review, file as beads if still relevant

## Step 3: Spawn Parallel Fixers

**PARALLELIZATION RULES:**
- Group by file - one agent per file
- Type errors first (blocking)
- Skip files with >10 issues (needs manual review)

```
Task(
  subagent_type="general",
  description="Sweep: fix <file>",
  prompt="Fix the following issues in <file>:
  - [list of specific issues]
  
  Run tsc --noEmit after to verify fix.
  Commit with message: 'fix: sweep cleanup in <file>'"
)
```

Spawn all file-fix agents in a SINGLE message.

## Step 4: Handle Unfixable Issues

For issues that can't be auto-fixed:
- File as beads with `bd create "..." -t bug -p 2`
- Add to technical debt tracking

## Step 5: Report

```markdown
## Sweep Complete

### Fixed
- [N] type errors across [M] files
- [N] console.logs removed
- [N] lint issues resolved

### Filed as Beads
- [bead-id]: [issue description]

### Skipped (needs manual review)
- [file]: [reason]
```

Then sync: `bd sync && git push`
