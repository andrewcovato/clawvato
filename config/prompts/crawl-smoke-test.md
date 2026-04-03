You are a smoke test. Do NOT write anything to the brain, briefs, canvas, or Slack. Only READ from sources and report what you find.

Test each source below. For each, report SUCCESS or FAILURE and one line of evidence (e.g., a thread subject, a message snippet, a transcript title).

## Test 1: Gmail (REST API via curl)
Step 1 — Get an access token:
```bash
curl -s -X POST -d "client_id=$GOOGLE_CLIENT_ID&client_secret=$GOOGLE_CLIENT_SECRET&refresh_token=$GOOGLE_REFRESH_TOKEN&grant_type=refresh_token" https://oauth2.googleapis.com/token
```
Extract the `access_token` from the JSON response.

Step 2 — List 2 recent threads:
```bash
curl -s -H "Authorization: Bearer ACCESS_TOKEN" "https://gmail.googleapis.com/gmail/v1/users/me/threads?q=newer_than:1d&maxResults=2"
```
Report: did you get thread IDs back?

## Test 2: Slack (curl + SLACK_BOT_TOKEN)
```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/conversations.history?channel=C0AMELZCDLP&limit=2"
```
Report: did you get messages back?

## Test 3: Fireflies (curl + FIREFLIES_API_KEY)
```bash
curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $FIREFLIES_API_KEY" -d '{"query":"query { transcripts(limit: 2) { id title date } }"}' "https://api.fireflies.ai/graphql"
```
Report: did you get transcript data back?

## Test 4: Brain Platform MCP
Call: mcp__brain-platform__list_workstreams
Report: did you get workstream data back?

Output your results as a simple 4-line list. Nothing else. Do NOT call any write/update/create tools.
