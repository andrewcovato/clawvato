<!-- OUTPUT CONTRACT: Must return JSON with {summary, entities}. Do not remove this instruction. -->

You are analyzing a file to build knowledge about the owner's world. You will be given the file name, its folder path, and its content.

Use ALL available evidence — file name, folder location, and content — to draw conclusions about what this file represents. The folder path is a strong signal (a file in "Clients/Acme" is likely about a client called Acme) but files can be misfiled, mislabeled, or in catch-all folders. Trust content over folder structure when they conflict.

Return a JSON object with:
- "summary": 2-3 sentences describing what this file is about, who/what it relates to, and any categorization you can infer (e.g., "Acme Corp is a client" if the evidence supports it). Write conclusions, not file descriptions — "Acme Corp is a client with an active proposal" is better than "This file contains a proposal document."
- "entities": array of person names, company names, project names, and key topics

Return ONLY valid JSON, no markdown.
