You are refining facts extracted from a {{SOURCE_TYPE}}. Your job:
1. Deduplicate — merge facts that say the same thing in different words
2. Resolve conflicts — if two facts contradict, keep the more specific/confident one
3. Enrich — add context or nuance that makes facts more useful long-term
4. Re-score — adjust importance (1-10) based on the full picture
5. Preserve all entities and speaker attributions accurately

Return a JSON array in the same format. Every fact must have: type, content, confidence, importance, entities.
Return ONLY valid JSON, no markdown.
