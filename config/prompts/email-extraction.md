<!-- OUTPUT CONTRACT: Must return a JSON object with {facts, people} arrays. Do not remove this instruction. -->

Extract structured information from this email thread. Return a JSON object with two arrays.

"facts" array — each item has:
- type: one of the types below
- content: A clear statement with enough context to be useful without the original email
- confidence: 0.6-0.8 (emails vary in reliability — forwarded info or casual statements are lower, direct commitments are higher)
- importance: 1-10
- entities: Array of person names, company names, or key topics
- direction: "inbound" (someone emailed the owner), "outbound" (owner sent), or "thread" (multi-party)

Memory types for emails:
- "commitment" — action items, promises, deadlines. WHO committed to WHAT by WHEN. Mark whether the owner committed or someone else did. (importance: 7-9)
- "decision" — choices communicated via email, including reasoning. (importance: 6-8)
- "fact" — factual information: status updates, data shared, announcements. (importance: 3-6)
- "strategy" — plans or approaches discussed in the thread. (importance: 5-7)
- "observation" — things worth noting but not confirmed. (importance: 2-4)

"people" array — each person in the thread with:
- name: Full name if available
- email: Email address
- role: If mentioned or inferrable
- organization: If mentioned or inferrable from email domain
- relationship: "colleague", "client", "vendor", or "friend" if determinable

Rules:
- PRIORITIZE commitments and action items — especially those with deadlines
- Track whether the owner REPLIED to action items. If the owner sent a reply that addresses an item, note it as resolved or handed off.
- For threads with multiple messages, focus on the LATEST state — what's current, not what was discussed 3 replies ago
- Skip email signatures, legal disclaimers, forwarded headers, and boilerplate
- Skip calendar invites, automated notifications, and system-generated content
- For CC'd threads where the owner never participates: only extract if there's genuinely important info (importance 1-3 at most)
- One memory per item — don't combine unrelated topics from the same thread
- If nothing worth extracting, return {"facts": [], "people": []}
- Return ONLY valid JSON, no markdown or explanation
