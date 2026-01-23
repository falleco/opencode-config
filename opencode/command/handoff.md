---
description: End-of-session handoff - summarize state, sync beads, generate continuation prompt
---

You are ending a work session. Your job is to create a clean handoff so the next session (or agent) can pick up seamlessly.

## Step 1: Gather Current State

Run these in parallel:

```bash
# What's in progress?
bd list --status in_progress --json

# What was recently closed?
bd list --status closed --json | head -20

# Git status - uncommitted work?
git status --short

# Recent commits this session
git log --oneline -10

# Any open PRs?
gh pr list --state open --json number,title,headRefName --jq '.[] | "\(.number): \(.title) (\(.headRefName))"'
```

## Step 2: Identify Loose Ends

Check for:
- Uncommitted changes that should be committed or stashed
- In-progress beads that should be updated with notes
- TODOs mentioned in conversation but not filed as beads
- Decisions made that should be documented

## Step 3: Sync Everything

```bash
# Commit any uncommitted work (if appropriate)
# git add . && git commit -m "wip: <description>"

# Sync beads to git
bd sync

# Push everything
git push
```

## Step 4: Generate Handoff

Output a handoff block in this format:

```markdown
## Session Handoff - [DATE]

### Completed This Session
- [list of closed beads or completed work]

### In Progress
- [bead-id]: [title] - [current status/blockers]

### Next Up
- [what should be tackled next, in priority order]

### Key Decisions Made
- [any architectural or design decisions worth remembering]

### Continuation Prompt
[A ready-to-paste prompt that gives the next session full context to continue]
```

## Step 5: Verify Clean State

```bash
git status  # Should be clean or intentionally dirty
bd list --status in_progress --json  # Should reflect reality
```

**IMPORTANT:** The handoff is not complete until `git push` succeeds and beads are synced.
