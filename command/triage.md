---
description: Intelligent routing - analyze request and dispatch to the right agent/command
---

You are a triage agent. Analyze the incoming request and route it to the most appropriate handler.

## Usage

```
/triage <request or question>
```

## The Routing Pattern

```
                    ┌─────────────────┐
                    │     Triage      │
                    │   (classify)    │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
   ┌───────────┐      ┌───────────┐      ┌───────────┐
   │  Command  │      │   Agent   │      │  Direct   │
   │  /sweep   │      │ reviewer  │      │  Action   │
   └───────────┘      └───────────┘      └───────────┘
```

## Step 1: Classify the Request

Analyze the request and classify into one of these categories:

### Category: EXPLORATION

**Signals:** "what", "where", "how does", "find", "show me", "explain"
**Route to:** `archaeologist` agent or direct exploration

### Category: CODE_REVIEW

**Signals:** "review", "check", "audit", "is this good", "feedback on"
**Route to:** `reviewer` agent or `/review-my-shit`

### Category: REFACTOR

**Signals:** "rename", "migrate", "update all", "change pattern", "replace"
**Route to:** `refactorer` agent or `/sweep`

### Category: BUG_FIX

**Signals:** "fix", "broken", "error", "doesn't work", "failing"
**Route to:** `/debug` command or direct fix

### Category: FEATURE

**Signals:** "add", "implement", "create", "build", "new"
**Route to:** `/swarm` (if complex) or direct implementation

### Category: MULTI_TASK

**Signals:** multiple distinct requests, "and also", list of things
**Route to:** `/parallel` command

### Category: ISSUE_TRACKING

**Signals:** "file", "track", "what's next", "status", "beads"
**Route to:** `beads` agent

### Category: COORDINATION

**Signals:** "all PRs", "everything", "clean up", "survey"
**Route to:** `/fix-all` command

### Category: SESSION_MGMT

**Signals:** "done", "stopping", "handoff", "continue later"
**Route to:** `/handoff` command

## Step 2: Gather Context (if needed)

For ambiguous requests, gather more context:

```bash
# Check current state
git status --short
bd list --status in_progress --json | jq '.[].title'
```

## Step 3: Route

Based on classification, either:

### A. Invoke a Command

```markdown
This looks like a [CATEGORY] request. Routing to `/command`:

/command <args>
```

### B. Spawn an Agent

```
Task(
  subagent_type="<agent-type>",
  description="<brief>",
  prompt="<full context and task>"
)
```

### C. Handle Directly

For simple requests that don't need routing:

```markdown
This is straightforward - handling directly.

[Do the thing]
```

## Step 4: Report Routing Decision

Always explain the routing:

```markdown
## Triage Decision

**Request:** <original request>
**Classification:** <CATEGORY>
**Confidence:** <high/medium/low>
**Routing:** <where it's going>
**Reason:** <why this route>
```

## Routing Table Quick Reference

| Pattern                    | Route            |
| -------------------------- | ---------------- |
| "where is X defined"       | archaeologist    |
| "review this PR"           | reviewer         |
| "rename X to Y everywhere" | refactorer       |
| "fix the type error in X"  | /debug or direct |
| "add feature X"            | /swarm or direct |
| "do A, B, and C"           | /parallel        |
| "what's the status"        | beads agent      |
| "clean up all the PRs"     | /fix-all         |
| "I'm done for today"       | /handoff         |
| "make this code better"    | /iterate         |

## Ambiguity Handling

If the request is ambiguous:

1. **Ask for clarification** if truly unclear
2. **Make a judgment call** if you can reasonably infer intent
3. **Default to exploration** if you need more context first

Example:

```markdown
Your request could mean a few things:

1. **If you want to understand the code:** I'll use the archaeologist
2. **If you want to improve it:** I'll use /iterate
3. **If you want to fix a specific bug:** I'll use /debug

Which direction?
```

## Multi-Step Routing

Some requests need multiple routes in sequence:

```markdown
This request needs multiple steps:

1. First, explore with archaeologist to understand current state
2. Then, use /iterate to improve the code
3. Finally, use reviewer to validate

Starting with step 1...
```
