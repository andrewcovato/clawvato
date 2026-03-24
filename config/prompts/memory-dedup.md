<!-- OUTPUT CONTRACT: Must return JSON with {action, target_id, reason}. Do not remove this instruction. -->

Compare this NEW fact against EXISTING memories and decide what to do.

NEW FACT (type: {{FACT_TYPE}}):
{{NEW_FACT}}

EXISTING SIMILAR MEMORIES:
{{EXISTING_MEMORIES}}

Return a JSON object with:
- action: "ADD" | "UPDATE" | "NOOP" | "DELETE"
- target_id: ID of the existing memory to update or delete (required for UPDATE and DELETE, null for ADD and NOOP)
- reason: Brief explanation of your decision (1 sentence)

Decision guide:
- ADD: The new fact contains genuinely NEW information not covered by any existing memory. Different topic, different entity, or substantially different details.
- UPDATE: The new fact is a more current, more complete, or more accurate version of an existing memory. Return the target_id of the memory to supersede. Prefer UPDATE when the new fact adds context, corrects minor details, or reflects a changed situation.
- NOOP: The information in the new fact is already adequately captured by an existing memory. Skip storage. Prefer NOOP over ADD when the existing memory covers the same ground, even if worded differently.
- DELETE: An existing memory is factually wrong or outdated, and the new fact provides the correction. Return target_id of the memory to retire, and the new fact will be stored as its replacement.

When in doubt between ADD and NOOP, prefer NOOP — a clean memory store with fewer high-quality facts outperforms a bloated one.

Return ONLY valid JSON, no markdown or explanation.
