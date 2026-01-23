# Mastra Agent Patterns

Extracted from Sam Bhagwat's "Patterns for Building AI Agents" and "Principles of Building AI Agents" (2nd Edition, May 2025).

## Part I: Configure Your Agents

### Pattern 1: Whiteboard Agent Capabilities

**Problem:** Agent feature overload - exec team dumps massive wishlist on engineer.

**Solution:** Organizational design for agents. Treat it like hiring a human team:

1. Write down everything you want the agent to do (be comprehensive)
2. Group similar capabilities together:
   - Pulling from same data sources
   - Could be performed by same job title
   - Returned by same API call
3. Figure out natural divisions:
   - Different responsible departments
   - Type of task (data fetching vs synthesis vs triggering actions)
   - Different steps in a business process
4. Group related capabilities into agents

**Example:** Sales agent breaks into: support agent + sales agent with 3 subagents (customer discovery, account synthesis, next steps).

### Pattern 2: Evolve Your Agent Architecture

**Problem:** Monolithic mega-agents that try to do everything (like Michael Scott).

**Solution:** Discover architecture by iterating:

1. List tasks you want agent to perform
2. Start with ONE burning problem
3. Build that agent really well
4. Notice what users ask for next
5. If separate, build new agent
6. If unwieldy, split it
7. If multiple agents, add routing logic
8. Repeat

**Key insight:** Most production agents are orchestrated specialists, not mega-agents.

**Example evolution:**

- v1: LinkedIn post writer
- v2: Add social media agent (separate)
- v3: Add router agent to direct requests
- v4: Add blog writer agent
- v5: Add content coordinator for consistency

Final: Coordinator → Router → Specialists (parallel or sequential)

### Pattern 3: Dynamic Agents

**Problem:** Different users need different agent behaviors, but you don't want to maintain multiple versions.

**Solution:** Agents that adapt at runtime based on:

- User roles/tiers
- Preferences
- System state

**Example:**

```
Free tier: basic support, topK=8, GPT-3.5
Pro tier: detailed technical support, topK=8, GPT-3.5
Enterprise: priority support + human escalation, topK=15, GPT-5
```

### Pattern 4: Human-in-the-Loop (HITL)

**Problem:** Full agent autonomy is often untenable. Performance is heterogeneous - agents fail on certain task classes even while excelling at others.

**Solution:** Design agents with human checkpoints:

1. **In-the-loop:** Agent pauses mid-execution for human input (decisions, clarification, approval)
2. **Post-processing:** Human reviews/approves output before finalization
3. **Deferred tool execution:** Agent continues while collecting human feedback asynchronously

**Key insight:** Deferred execution aligns best with real-world workflows - humans don't want to babysit agents step-by-step.

**Warning:** Humans become the bottleneck (agents don't sleep).

---

## Part II: Engineer Agent Context

### Pattern 5: Parallelize Carefully

**Problem:** Parallel subagents create incompatible outputs that can't be merged.

**Solution:** Use single-threaded linear agent for tasks with nuance. Combine into single multiturn thread to preserve continuous context.

**Example:** Building a game - if you parallelize "character movement" and "path generation" separately, you get incompatible systems (platformer controls + branching paths requiring stopping).

**Note:** Teams disagree here:

- Devin (Cognition): Avoids parallelizing
- Claude Code: Relies heavily on parallel subagents

### Pattern 6: Share Context Between Subagents

**Problem:** Subagents working in isolation create mutually incompatible outputs.

**Solution:** Ensure subagents share context along the way:

- Run in sequence
- Check output along the way
- Share full trace, not just "I made a red button"

**Example:** Without context: "I made a red button"
With context: Subagent B sees full trace including user request, brand color research, user approval → understands WHY it's red.

### Pattern 7: Avoid Context Failure Modes

**Problem:** Jumbo context windows let you stuff in data, but model has to pay attention to everything.

**Five failure modes:**

1. **Context poisoning:** Hallucination gets into context, repeatedly referenced
2. **Context distraction:** Context so long model overfocuses on it, discounts training data
3. **Context confusion:** Irrelevant context generates low-quality responses
4. **Context clash:** New info conflicts with previous info in prompt
5. **Context rot:** Around 100k tokens, models lose ability to discern important from noise

**Example:** Pokemon agent - performance degraded at ~125K tokens despite 500K window. Fixed by:

- RAG to filter to top K results
- Context pruning tool
- Structured context storage
- Result: 34% → 90%+ accuracy

### Pattern 8: Compress Context

**Problem:** Naive approach appends all context → eventually overflows window.

**Solution:** Periodic context compression:

- Compress at every step
- Compress at x% threshold of window capacity
- Prune oldest context (hierarchical summarization)
- Recursive summarization (chunk → summarize → combine → summarize)
- At certain post-process tool calls (token-heavy search)
- Summarization at agent-agent boundaries

**Warning:** If specific events/decisions must be captured, identify them and DON'T compress those.

**Example:** Claude Code runs autocompact at 95% capacity, summarizes full trajectory.

### Pattern 9: Feed Errors Into Context

**Problem:** LLM-generated code sometimes doesn't work.

**Solution:** Give agent the error message. Agent generates fixes, applies them, re-executes.

**Key insight:** If you notice commonly repeated error patterns, put them into your prompt!

**Example:** Cursor Auto Run, Windsurf Cascade, Replit Agent, Lovable - all feed errors back into context for automated fix loops.

---

## Part III: Evaluate Agent Responses

### Pattern 10: List Failure Modes

Before building evals, enumerate how your agent can fail:

- Wrong tool selection
- Hallucinated data
- Missed edge cases
- Inconsistent outputs

### Pattern 11: List Critical Business Metrics

What matters for your use case:

- Accuracy
- Latency
- Cost per query
- User satisfaction

### Pattern 12: Cross-Reference Failure Modes and Success Metrics

Map failures to metrics to prioritize what to fix.

### Pattern 13: Iterate Against Your Evals

Use evals as the feedback loop for improvement.

### Pattern 14: Create an Eval Test Suite

Systematic test cases covering your failure modes.

### Pattern 15: Have SMEs Label Data

Subject matter experts provide ground truth.

### Pattern 16: Create Datasets from Production Data

Real usage patterns > synthetic tests.

### Pattern 17: Evaluate Production Data

Monitor live performance, not just test suites.

---

## Part IV: Secure Your Agents

### Pattern 18: Prevent the Lethal Trifecta

The dangerous combination:

1. Agent has access to sensitive data
2. Agent can take actions
3. Agent accepts untrusted input

### Pattern 19: Sandbox Code Execution

Never let agents run arbitrary code in production environment.

### Pattern 20: Granular Agent Access Control

Principle of least privilege - agents get only what they need.

### Pattern 21: Agent Guardrails

Input sanitization (prompt injection defense) + output validation.

---

## Principles (from 2nd book)

### Levels of Agent Autonomy

Like self-driving cars:

- **Low:** Binary choices in decision tree
- **Medium:** Memory, tool calling, retry failed tasks
- **High:** Planning, divide tasks into subtasks, manage task queue

### Tool Design is Most Important

Before coding, write out clearly:

- What is the list of all tools you'll need?
- What will each of them do?

**Key insight:** Think like an analyst. Break problem into clear, reusable operations. Write each as a tool.

### Memory Architecture

**Working memory:** Long-term user characteristics
**Hierarchical memory:** Recent messages + relevant long-term memories

Settings:

- `lastMessages`: Sliding window of recent context
- `semanticRecall`: RAG search through past conversations
- `topK`: Number of messages to retrieve
- `messageRange`: Range on each side of match to include

### Memory Processors

- **TokenLimiter:** Removes oldest messages when approaching limit
- **ToolCallFilter:** Removes tool calls from memory (saves tokens, forces fresh tool calls)

### Multi-Agent Patterns

1. **Agent Supervisor:** Central coordinator
2. **Control Flow:** Explicit routing logic
3. **Workflows as Tools:** Agents can invoke workflows
4. **Combining Patterns:** Mix and match as needed

### A2A (Agent-to-Agent) vs MCP

- **MCP:** Connects agents to tools/resources
- **A2A:** Connects agents to other agents

---

## Key Takeaways

1. **Start small, iterate** - Don't build mega-agents
2. **Context is not free** - Every token influences behavior
3. **Parallelize with caution** - Shared context prevents incompatible outputs
4. **Feed errors back** - Self-healing loops
5. **Compress strategically** - Don't lose critical decisions
6. **Tool design first** - Most important step before coding
7. **HITL for risk** - Humans for high-stakes decisions
8. **Evals are essential** - Can't improve what you can't measure
