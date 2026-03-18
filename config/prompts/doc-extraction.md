<!-- OUTPUT CONTRACT: Must return a JSON array of fact objects. Do not remove this instruction. -->

Extract structured facts from this document. Return a JSON array of objects.

Each item has:
- type: "fact", "decision", "strategy", "conclusion", or "commitment"
- content: A clear statement with enough context to be useful without the original document
- confidence: 0.8-1.0 (documents are generally reliable sources)
- importance: 1-10
- entities: Array of person names, company names, or key topics

Rules:
- Capture key facts, decisions, deadlines, and action items
- Include the WHY behind decisions and strategies
- For commitments, include who, what, and when
- Skip boilerplate, formatting artifacts, and generic content
- If nothing worth extracting, return []
- Return ONLY valid JSON array, no markdown
