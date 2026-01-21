---
description: Self-review before PR - lint, types, common mistakes, generate PR description
---

Pre-flight check before opening a PR. Catch the dumb shit before reviewers do.

## Step 1: Identify What's Changed

```bash
# What branch are we on?
git branch --show-current

# Diff against main
git diff main --stat
git diff main --name-only

# Commits since main
git log main..HEAD --oneline
```

## Step 2: Run the Gauntlet

Run all checks in parallel:

```bash
# Type check
pnpm exec tsc --noEmit

# Lint
pnpm run lint || true

# Tests (if fast)
pnpm test --run || true

# Build (catches runtime issues)
pnpm run build || true
```

## Step 3: Check for Common Mistakes

Scan changed files for:

```bash
# Console.logs (should be removed)
git diff main --unified=0 | rg "^\+" | rg "console\.(log|debug|info)" || echo "✓ No console.logs"

# 'any' type annotations
git diff main --unified=0 | rg "^\+" | rg ": any" || echo "✓ No 'any' casts"

# TODO/FIXME added
git diff main --unified=0 | rg "^\+" | rg "TODO|FIXME" || echo "✓ No new TODOs"

# Commented-out code
git diff main --unified=0 | rg "^\+.*//.*[a-zA-Z]+\(" | head -10 || echo "✓ No suspicious commented code"

# Large files added
git diff main --stat | rg "\d{4,} \+" || echo "✓ No large file additions"

# .env or secrets
git diff main --name-only | rg "\.env|secret|password|token|key" || echo "✓ No secrets files"
```

## Step 4: Review the Diff

Use the `reviewer` subagent to analyze the actual code changes:

```
Task(
  subagent_type="reviewer",
  description="Review diff for PR",
  prompt="Review the changes between main and HEAD. Look for:
  - Logic errors
  - Missing error handling
  - Security issues
  - Performance concerns
  - API contract changes
  
  Be harsh but fair. Output a list of concerns if any."
)
```

## Step 5: Generate PR Description

Based on the changes, generate a PR description:

```markdown
## Summary
[1-3 bullet points on what this PR does]

## Changes
- [Key change 1]
- [Key change 2]

## Testing
- [ ] Type check passes
- [ ] Lint passes
- [ ] Tests pass
- [ ] Manual testing done

## Screenshots (if UI)
[if applicable]
```

## Step 6: Suggest Reviewers

```bash
# Who has touched these files?
git diff main --name-only | xargs -I {} git log -1 --format="%an" -- {} | sort | uniq -c | sort -rn | head -5
```

## Step 7: Final Checklist

```markdown
## Pre-PR Checklist

- [ ] Branch is rebased on main
- [ ] No type errors
- [ ] No lint errors
- [ ] Tests pass
- [ ] No console.logs
- [ ] No 'any' casts (or justified)
- [ ] No secrets committed
- [ ] PR description written
- [ ] Related beads linked
```

If all green: `gh pr create --title "..." --body "..."`
