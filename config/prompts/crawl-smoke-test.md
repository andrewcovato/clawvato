You are a smoke test. Do NOT write anything to the brain, briefs, canvas, or Slack. Only READ from sources and report what you find.

Test each source below. For each, report SUCCESS or FAILURE and one line of evidence.

## Test 1: Gmail (gws CLI)
Run: gws gmail users threads list --params '{"userId":"me","q":"newer_than:1d","maxResults":2}'
Report: did you get thread data back?

## Test 2: Slack (curl + SLACK_BOT_TOKEN)
Run: curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/conversations.history?channel=C0AMELZCDLP&limit=2"
Report: did you get messages back?

## Test 3: Fireflies (curl + FIREFLIES_API_KEY)
Run: curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $FIREFLIES_API_KEY" -d '{"query":"query { transcripts(limit: 2) { id title date } }"}' "https://api.fireflies.ai/graphql"
Report: did you get transcript data back?

## Test 4: Brain Platform MCP
Call: mcp__brain-platform__list_workstreams
Report: did you get workstream data back?

Output your results as a simple list. Nothing else. Do NOT call any write tools.
