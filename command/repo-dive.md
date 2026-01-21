---
description: Deep dive into a GitHub repo - clone locally and analyze with full toolchain
---

Clone a repo and crawl up its ass with the full local toolchain (rg, ast-grep, tokei, gitleaks, etc).

## Usage
```
/repo-dive <github-url-or-owner/repo> [focus area]
```

Target: $ARGUMENTS

## Step 1: Clone & Get Stats

First, clone the repo locally and get code stats:

```
repo-autopsy_clone("<repo>")
repo-autopsy_stats("<repo>")
```

This gives you:
- Local path for analysis
- Lines of code by language
- File counts

## Step 2: Structure & README

```
repo-autopsy_structure("<repo>", depth=3)
repo-autopsy_file("<repo>", path="README.md")
```

Extract:
- Directory layout
- What the project does
- Key concepts/abstractions

## Step 3: Dependencies & Tech Stack

```
repo-autopsy_deps("<repo>")
```

Understand what libraries/frameworks they're using.

## Step 4: Find the Core

Map the public API and find entry points:

```
repo-autopsy_exports_map("<repo>")
```

Then read the core files:

```
repo-autopsy_file("<repo>", path="src/index.ts")
repo-autopsy_file("<repo>", path="src/core.ts")
repo-autopsy_file("<repo>", path="src/types.ts")
```

## Step 5: AST Search for Patterns

Use ast-grep for structural code search:

```
repo-autopsy_ast("<repo>", pattern="export function $NAME($$$ARGS) { $$$BODY }")
repo-autopsy_ast("<repo>", pattern="class $NAME { $$$BODY }")
repo-autopsy_ast("<repo>", pattern="interface $NAME { $$$BODY }")
```

Or ripgrep for text patterns:

```
repo-autopsy_search("<repo>", pattern="TODO|FIXME|HACK", fileGlob="*.ts")
```

## Step 6: Hotspots & Churn

Find where the action is:

```
repo-autopsy_hotspots("<repo>")
```

This shows:
- Most changed files (git churn)
- Largest files
- Most TODOs/FIXMEs
- Recent commits

## Step 7: Security Scan

Check for leaked secrets:

```
repo-autopsy_secrets("<repo>")
```

## Step 8: Deep File Analysis

For specific files, use blame to understand history:

```
repo-autopsy_blame("<repo>", path="src/core.ts")
repo-autopsy_file("<repo>", path="src/core.ts", startLine=50, endLine=100)
```

## Step 9: Synthesize

Output a structured report:

```markdown
# Repo Autopsy: <owner/repo>

## TL;DR
[2-3 sentences on what this is and why it matters]

## Stats
- Total LOC: X
- Primary language: Y
- Files: Z

## Tech Stack
- Language: X
- Framework: Y
- Key deps: Z

## Architecture

### Core Abstractions
| Name | Location | Purpose |
|------|----------|---------|
| `Thing` | src/thing.ts | Does X |

### Data Flow
```
[Input] → [Processing] → [Output]
```

### Key Patterns
- Pattern 1: How they do X
- Pattern 2: How they handle Y

## Code Highlights

### Main Entry
```typescript
// key code snippet
```

### Interesting Pattern
```typescript
// notable implementation detail
```

## Hotspots
- Most churned: file.ts (47 changes)
- Largest: bigfile.ts (2000 lines)
- Most TODOs: messy.ts (15 TODOs)

## Security
- [x] No secrets detected (or list findings)

## Gotchas / Surprises
- ⚠️ Thing that's not obvious
- 🔥 Clever trick worth stealing

## Ideas to Steal
- [ ] Pattern we could use
- [ ] Abstraction worth copying
- [ ] Convention to adopt
```

## Focus Areas

If a focus area is specified (e.g., "auth", "routing", "state management"):

1. Find files: `repo-autopsy_find("<repo>", pattern="<focus>")`
2. Search code: `repo-autopsy_search("<repo>", pattern="<focus>")`
3. AST search: `repo-autopsy_ast("<repo>", pattern="<relevant-pattern>")`
4. Read the matching files
5. Trace the implementation

## Cleanup

When done, optionally remove from cache:

```
repo-autopsy_cleanup("<repo>")
```

Or clear all cached repos:

```
repo-autopsy_cleanup("all")
```

## Examples

```
/repo-dive openai/swarm
/repo-dive vercel/ai streaming
/repo-dive shadcn/ui component patterns
/repo-dive trpc/trpc type inference
/repo-dive tanstack/query caching
```
