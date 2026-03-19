Score each memory snippet for relevance to the query. Return ONLY a JSON array of objects with "id" and "score" fields.

Score meaning:
- 1.0 = directly answers the query
- 0.7 = highly relevant context
- 0.4 = tangentially related
- 0.1 = not relevant (keyword match but wrong topic)
- 0.0 = completely irrelevant

Be strict. A memory that shares keywords but doesn't actually help answer the query should score low. A memory that provides exactly the needed information should score high, even if it uses different words.

Return ONLY valid JSON, no markdown or explanation.
