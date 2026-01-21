---
description: Create PR with beads-linked description and smart summary
---

Create a pull request with context from commits, beads, and code changes.

## Step 1: Pre-flight Check

```bash
# Current branch
BRANCH=$(git branch --show-current)
echo "Branch: $BRANCH"

# Make sure we're not on main
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "❌ Cannot create PR from main/master"
  exit 1
fi

# Commits since main
git log main..$BRANCH --oneline

# Uncommitted changes?
git status --short
```

If uncommitted changes exist, ask: commit first or stash?

## Step 2: Push Branch

```bash
# Push with upstream tracking
git push -u origin $BRANCH
```

## Step 3: Gather PR Context

```bash
# Full diff for analysis
git diff main..HEAD --stat

# Commit messages for summary
git log main..HEAD --format="%s%n%b" 

# Related beads (check branch name and commit messages)
bd list --json 2>/dev/null | jq -r '.[] | select(.id | test("'$BRANCH'|bd-")) | "\(.id): \(.title)"' | head -10
```

## Step 4: Analyze Changes

Read key changed files to understand the PR:
```bash
git diff main..HEAD --name-only
```

Determine:
- What's the main feature/fix?
- What areas of code are affected?
- Any breaking changes?
- Any new dependencies?

## Step 5: Generate PR Description

```markdown
## Summary
[1-3 bullet points - the WHY, not the WHAT]

## Changes
- [Key change 1]
- [Key change 2]
- [Key change 3]

## Testing
- [ ] Type check passes (`pnpm exec tsc --noEmit`)
- [ ] Lint passes (`pnpm run lint`)
- [ ] Tests pass (`pnpm test`)
- [ ] Manual testing done

## Related
- Closes: [bead-id or issue link if applicable]
- Refs: [related beads/issues]

## Screenshots
[If UI changes - ask user to add]
```

## Step 6: Suggest Reviewers

```bash
# Who touched these files recently?
git diff main..HEAD --name-only | xargs -I {} git log -3 --format="%an" -- {} 2>/dev/null | sort | uniq -c | sort -rn | head -3
```

## Step 7: Create PR

```bash
gh pr create \
  --title "<type>(<scope>): <description>" \
  --body "$(cat <<'EOF'
## Summary
- <bullet 1>
- <bullet 2>

## Changes
- <change 1>
- <change 2>

## Testing
- [ ] Type check passes
- [ ] Lint passes
- [ ] Tests pass

## Related
- Refs: <bead-id>
EOF
)"
```

## Step 8: Post-create

```bash
# Get PR URL
gh pr view --web

# Update bead with PR link (if applicable)
# bd update <bead-id> -d "PR: <url>"
```

Output:
```markdown
## PR Created

**URL:** <pr-url>
**Branch:** $BRANCH → main
**Commits:** N

### Next Steps
- [ ] Add reviewers if not auto-assigned
- [ ] Add screenshots if UI changes
- [ ] Monitor CI checks
```
