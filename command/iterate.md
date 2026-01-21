---
description: Evaluator-optimizer loop - generate, critique, improve until quality threshold met
---

Iterative refinement using the evaluator-optimizer pattern. Generate something, critique it, improve it, repeat until good enough.

## Usage

```
/iterate <what to create or improve>
/iterate --max-rounds 5 "refactor the auth module"
/iterate --criteria "type-safe, tested, documented" "implement user service"
/iterate --learn "fix the hydration error in UserCard"
```

## The Pattern

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Generator  │────▶│  Evaluator  │────▶│  Optimizer  │
│  (create)   │     │  (critique) │     │  (improve)  │
└─────────────┘     └─────────────┘     └──────┬──────┘
       ▲                                       │
       └───────────────────────────────────────┘
                    (loop until good)
```

## Step 1: Parse Arguments

Extract from $ARGUMENTS:

- `--max-rounds N` (default: 3)
- `--criteria "..."` (quality criteria, or use defaults)
- `--learn` (save novel error patterns discovered during iteration)
- The task description

Default criteria if not specified:

- Type-safe (no `any`, proper inference)
- No obvious bugs or edge cases
- Follows existing patterns in codebase
- Readable and maintainable

## Step 2: Check Error Patterns (Pre-Generation)

Before generating, scan for relevant error patterns that might apply to this task:

```bash
# Search error patterns for relevant context
rg -i "<keywords from task>" ~/.config/opencode/knowledge/error-patterns.md -B 2 -A 10
```

If matches found, inject into generation context:

```markdown
## Known Error Patterns (Avoid These)

<matching patterns from error-patterns.md>
```

This prevents generating code that hits known pitfalls.

## Step 3: Initial Generation

Generate the first version. This could be:

- Writing new code
- Refactoring existing code
- Creating a design/plan

```markdown
## Round 1: Initial Generation

[Generate the thing]
```

## Step 4: Evaluation Loop

For each round until max-rounds or quality threshold met:

### 4a. Evaluate (Critic Agent)

Spawn a reviewer agent to critique:

```
Task(
  subagent_type="reviewer",
  description="Evaluate round N",
  prompt="You are a harsh but fair code critic. Review this code against these criteria:

CRITERIA:
<criteria list>

CODE:
<current version>

Provide:
1. Score (1-10) for each criterion
2. Overall score (1-10)
3. Specific issues found (with file:line references)
4. Concrete suggestions for improvement

Be specific. 'Could be better' is useless. 'Line 45: this null check misses the empty string case' is useful.

If overall score >= 8, respond with 'APPROVED' at the end.
Otherwise, list exactly what needs to change."
)
```

### 4b. Check for Approval

If evaluator says "APPROVED" or score >= 8:

- Exit loop
- Report success

### 4c. Optimize (Improve Based on Feedback)

Apply the evaluator's suggestions:

```markdown
## Round N: Optimization

Evaluator feedback:

- [issue 1]
- [issue 2]

Applying fixes...
```

Make the changes, then loop back to evaluation.

## Step 5: Final Report

```markdown
## Iteration Complete

### Rounds: N

### Final Score: X/10

### Evolution

| Round | Score | Key Changes                      |
| ----- | ----- | -------------------------------- |
| 1     | 5     | Initial implementation           |
| 2     | 7     | Fixed null handling, added types |
| 3     | 8     | Added edge case tests            |

### Final Criteria Scores

| Criterion | Score |
| --------- | ----- |
| Type-safe | 9/10  |
| No bugs   | 8/10  |
| Patterns  | 8/10  |
| Readable  | 8/10  |

### Remaining Issues (if any)

- [minor issues that didn't block approval]

### Files Changed

- [list]
```

## Step 6: Commit

If changes were made and approved:

```bash
git add .
git commit -m "refactor: <task> (iterate: N rounds, score: X/10)"
```

## Examples

```
# Refactor with default criteria
/iterate "refactor the payment processing module"

# Strict criteria, more rounds
/iterate --max-rounds 5 --criteria "100% type coverage, no any, full test coverage" "rewrite auth service"

# Quick iteration on a specific function
/iterate --max-rounds 2 "improve error handling in fetchUser"
```

## Failure Modes

**Stuck in loop (not improving):**

- After 2 rounds with same score, try a different approach
- Consider if the criteria are achievable

**Evaluator too harsh:**

- If never reaching 8/10 after max rounds, accept best version
- Report what couldn't be achieved

**Scope creep:**

- Evaluator may suggest things outside original scope
- Stick to original task, file new beads for discovered work

## Step 7: Learn from Novel Errors (if --learn)

If `--learn` flag was passed and novel errors were encountered during iteration:

1. **Identify novel patterns**: Errors that weren't in `error-patterns.md`
2. **Document the pattern**:

   ```markdown
   ### <Error Name>

   **Pattern:** `<error message regex>`

   **Common Causes:**

   - <what caused it>

   **Fixes:**
   \`\`\`typescript
   // the fix
   \`\`\`

   **Prevention:** <how to avoid>
   ```

3. **Add to knowledge base**:

   ```bash
   # Append to error-patterns.md under appropriate section
   ```

4. **File bead for tracking**:
   ```bash
   bd create "Error pattern: <type>" -t chore --tags error-pattern --json
   ```

This creates a self-improving feedback loop - each iteration teaches the system about new error patterns.
