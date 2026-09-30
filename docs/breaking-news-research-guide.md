# Breaking-news research guide for Pi subagents

How to run fast, honest research when a big story breaks. Use this for flights, incidents, launches, outages — anything where facts move hourly.

## 1. Start with facets, not one query

Don't search the name four ways. Split the story on day one:

- what happened + timeline
- who — crew / people / officials named
- where — airport, airspace, diversion, map
- official response — airline / agency statement, government
- community — Reddit, X, video, photos

Example facet set for a flight incident:
```
"<flight> timeline divert"
"<flight> pilot crew identity"
"<flight> passengers account"
"<flight> airline statement official"
"<flight> reddit"
"<flight> site:x.com"
```

Run 3-4 facets in parallel. If you only run the flight number, you get four copies of the tracker story.

## 2. Fetch, don't just list

Search snippets are not research. Snippets tell you a page exists. Fetch tells you what it says.

Rules:
- Aim to open at least 8 news pieces in full.
- Say which ones failed and why (401, 403, paywall, too large, video-only).
- Never call a brief "comprehensive" from 2 opens + 18 snippets.
- Prefer wires + live blogs for freshness: Reuters, BBC live, CNN live, AP.
- Prefer aviation press for mechanics: Flightradar24 blog, AVHerald, Simple Flying.
- Prefer primary for quotes: airline press room, government office video, airport operator.

Fetch tip in Pi: `fetch_content` with 4-5 URLs at a time. If one fails with 401/403, note it and move on — don't silently drop it. If CNN-style live blogs return "too large", fetch via `web_search` snippets + `get_search_content` slices instead.

## 3. Stamp the clock

Breaking news expires in hours. For every fact keep:

- source + article age ("BBC 10h ago", "NYPost 6h ago")
- confirmed vs single-source vs social-only
- what is still missing (names, motive, official confirmation)

Re-query after 2-3 hours on the missing threads specifically: identity, motive, vetting, route suspension, investigation owner.

Never claim "this came out later" unless you checked timestamps. Searches minutes apart can return articles hours apart in age — state both.

## 4. Reddit — read-only use

What Pi can do without login:
- `web_search` with `"<topic> reddit"` surfaces thread titles + top snippets from r/aviation, r/worldnews, r/fearofflying, etc.
- `fetch_content` on old.reddit.com URLs sometimes works where www.reddit.com blocks.

What Reddit is good for:
- early timeline (squawk codes, tracker screenshots)
- spotting video / photos to verify elsewhere
- sentiment + questions people have

What Reddit is bad for:
- names, nationalities, manifests — post titles are immutable, edits bury corrections
- Treat every claim as lead, not fact. Require wire confirmation.

Read-only upgrade path (no password sharing):
1. Create a throwaway Reddit account, not your main.
2. Create app at reddit.com/prefs/apps → type `script`, redirect `http://localhost:8080`.
3. Grant only `read` + `history` scope, get a refresh token.
4. Store as env var, e.g. `REDDIT_REFRESH_TOKEN`, file `chmod 600`, never paste in chat.
5. Script with PRAW or raw OAuth: GET only — `search`, `comments`, `submission`. No POST.
6. Log the token source and revoke from reddit.com/prefs/apps when done.

Ask the subagent to print rate-limit headers and never print the token value.

## 5. X / Twitter — read-only use

What Pi can do without login:
- `web_search` with `"<topic> X twitter"` surfaces a few public posts (@Osint613, @aviationbrk style aggregators).
- Direct `fetch_content` on x.com usually fails or returns login wall. Nitter mirrors are mostly dead.

What X is good for:
- first photos / short video from the scene
- official airline / official handles posting statements

What X is bad for:
- names and casualty numbers — screenshots of manifests are routinely fake
- free API search is heavily rate-limited even with a token

Read-only upgrade path:
1. Create a project in developer.x.com, app with read-only permissions.
2. Use bearer token for app-only GET: recent search, lookup, user timeline.
3. Store as `X_BEARER_TOKEN` env var, `chmod 600`, never paste in chat.
4. Script: search query, `max_results 10-20`, save JSON + `includes.media` IDs. Respect 429 backoff.
5. Prefer official handles + wire reporters over aggregators. Quote handle + timestamp + URL for every X claim.

Tell the subagent: no likes, no reposts, no follows — GET only. If 429 hits, stop and report, don't retry-loop.

## 6. Copy-paste brief for the next story

> Breaking story: [one line]. Pull 20 sources across wires, nationals, trade press, official statements, Reddit, X. Fetch at least 8 in full, list failures with reason. Cover: timeline, hardware / flight / asset, people, official response, open questions. Stamp each fact with source + age. Flag single-source and social-only claims. Note what to re-check in 3 hours.

## 7. Self-check before you send

- Did I open enough, or just list?
- Did I mix snippet claims with fetched facts?
- Did I flag what's missing (identities, motive, official word)?
- Did I avoid repeating a name from X as fact?
- If challenged on timing, can I show search time vs article age?

---
Saved from FZ1073 session, 30 Sep 2026. Generic — no incident details here. See session log for that story.
