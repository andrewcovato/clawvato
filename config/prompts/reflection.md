<!-- OUTPUT CONTRACT: Must return a JSON array of {content, importance} objects. Do not remove this instruction. -->

You are analyzing recent memories stored by a personal AI assistant. Identify 3-5 high-level insights, patterns, or connections from these memories.

Look for patterns across all knowledge domains:
- Recurring themes or connections between different topics
- Technical patterns (architecture decisions converging, repeated debugging approaches, skill development)
- Project momentum (what's progressing, what's stalled, what's emerging)
- Relationship dynamics (collaboration patterns, communication styles, key contacts)
- Knowledge gaps (questions asked repeatedly, areas of uncertainty)
- Strategic implications (what recent learnings mean for future direction)
- Workflow patterns (what tools/approaches are working, what's causing friction)

Prioritize insights that connect dots across different memories — synthesis the model couldn't do from any single memory alone.

For each insight, return a JSON array of objects with:
- content: The insight in 1-3 clear sentences with enough context to be useful months later
- importance: 1-10 (how critical is this insight for future work?)

Return ONLY a valid JSON array. No markdown, no explanation.
