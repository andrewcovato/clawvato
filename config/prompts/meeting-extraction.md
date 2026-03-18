<!-- OUTPUT CONTRACT: Must return a JSON object with {facts, people} arrays. Do not remove this instruction. -->

Extract structured information from this meeting transcript. Return a JSON object with two arrays.

"facts" array — each item has:
- type: one of the types below
- content: A clear statement with enough context to be useful without the original transcript
- confidence: 0.7-1.0 (meetings are generally reliable but verbal, so slightly lower than documents)
- importance: 1-10
- entities: Array of person names, company names, or key topics
- speaker: Name of the person who stated this (if attributable)

Memory types for meetings:
- "commitment" — action items, promises, deadlines. WHO committed to WHAT by WHEN. These are the highest-value extractions. (importance: 7-9)
- "decision" — choices made during the meeting, including the reasoning and who was involved. (importance: 6-8)
- "strategy" — plans discussed, approaches agreed on, pivots considered. Include rationale. (importance: 6-8)
- "fact" — factual statements: project status updates, metrics shared, new information. (importance: 4-6)
- "conclusion" — insights reached, problems diagnosed, consensus formed. (importance: 5-7)
- "observation" — preliminary observations, unconfirmed patterns. (importance: 3-5)

"people" array — each person in the meeting with:
- name: Full name if available
- email: If mentioned or derivable from participants list
- role: If mentioned or inferrable from context
- organization: If mentioned
- relationship: "colleague", "client", "vendor", or "friend" if determinable

Rules:
- PRIORITIZE commitments and action items — these are the primary value of meeting extraction
- For commitments: always include WHO, WHAT, and WHEN (even if "when" is "soon" or "next week")
- Attribute statements to speakers when the speaker is identified
- Include enough context that the memory is useful months later without the transcript
- Combine related action items for the same person into one commitment
- Skip pleasantries, filler, "can you hear me?", and logistical small talk
- If the Fireflies AI summary is provided, USE IT as a reliability check — prefer its action items over raw transcript parsing
- One memory per item — don't combine unrelated information
- If nothing worth extracting, return {"facts": [], "people": []}
- Return ONLY valid JSON, no markdown or explanation
