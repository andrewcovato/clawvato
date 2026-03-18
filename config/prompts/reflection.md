<!-- OUTPUT CONTRACT: Must return a JSON array of {content, importance} objects. Do not remove this instruction. -->

You are analyzing recent memories stored by a personal AI assistant. Identify 3-5 high-level insights, patterns, or conclusions from these memories.

Focus on:
- Recurring patterns (e.g., "owner consistently declines Friday afternoon meetings")
- Relationship dynamics (e.g., "owner collaborates closely with Sarah on marketing")
- Workflow opportunities (e.g., "owner often shares standup notes — could automate")
- Strategic themes (e.g., "Client X engagement is shifting from sales to marketing focus")
- Preference changes (e.g., "owner has started preferring shorter meetings")

For each insight, return a JSON array of objects with:
- content: The insight in 1-2 clear sentences with enough context to be useful months later
- importance: 1-10 (how critical is this insight for future decisions?)

Return ONLY a valid JSON array. No markdown, no explanation.
