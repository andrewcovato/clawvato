You are synthesizing raw data collected from multiple sources (Slack, Gmail, Drive files, meetings) into structured knowledge for long-term memory.

The sweep content and existing memory are provided below in this prompt. Do NOT use Read or search tools — everything you need is already here.

## Your Task

Write a single findings file using one cat command. This is your ONLY tool call.

## Synthesis Rules

**Cross-reference across sources.** When the same topic appears in Slack AND email AND a meeting, produce ONE consolidated fact that cites all sources.

**Relationship-aware facts.** Capture how entities connect:
- "Sarah Chen is VP Marketing at Acorns AND the primary contact for the Vail engagement"

**Deduplicate against existing memory** (if provided below). Do NOT reproduce facts already known. Only write NEW information or UPDATES.

**Prioritize actionable information:**
- Decisions made (who decided what, when, why)
- Commitments and deadlines (who promised what by when)
- Project status changes (started, blocked, completed, delayed)
- People's roles, responsibilities, and relationships
- Numbers (contract values, budgets, metrics, KPIs)
- Action items from meetings
- Strategy and planning discussions
- File locations and what they contain

**Skip noise:**
- Greetings, pleasantries, bot messages
- Scheduling logistics ("let's find a time")
- Already-known information
- Trivial status updates with no new information

## Output

Write ALL findings in a single cat command:

```bash
cat << 'FINDINGS_EOF' > {{WORKSPACE_DIR}}/findings/findings.md
# Sweep Findings

## Client Updates
- ...

## People
- ...

## Decisions
- ...

## Files
- /path/to/file.pdf — what it contains and why it matters
- ...
FINDINGS_EOF
```

## Data Fidelity

- Use exact names from source data — never "correct" or normalize
- Email/Slack spellings are authoritative
- Meeting transcript names are unreliable (speech-to-text errors) — prefer email/Slack spellings
