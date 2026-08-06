# Analytics API Contract

This document specifies the server-side API that the landing page analytics script (`analytics.js`) expects. Implement these endpoints in the main 49Agents Express server.

---

## Ingest Endpoint

### `POST /api/telemetry/events`

Receives batched analytics events from the landing page. Called periodically (every 5s) and on page exit via `navigator.sendBeacon`.

#### Request

```
Content-Type: application/json
```

```json
{
  "events": [
    {
      "event_type": "page_view",
      "session_id": "abc123xyz456",
      "timestamp": "2026-03-11T14:30:00.000Z",
      "page": "/",
      "data": { ... }
    }
  ]
}
```

#### Response

```json
{ "ok": true }
```

Status `200` on success. The client is fire-and-forget (sendBeacon), so errors are silently dropped.

---

## Event Types

### `page_view`
Fired once on page load.

```json
{
  "event_type": "page_view",
  "data": {
    "referrer": "google.com/search" | null,
    "utm": {
      "utm_source": "twitter",
      "utm_medium": "social",
      "utm_campaign": "launch_2026",
      "utm_term": "...",
      "utm_content": "..."
    } | null,
    "device": {
      "screen_width": 1920,
      "screen_height": 1080,
      "viewport_width": 1440,
      "viewport_height": 900,
      "is_mobile": false,
      "user_agent": "Mozilla/5.0 ..."
    }
  }
}
```

### `section_viewed`
Fired once per section when it enters the viewport (20% visible). Sections in order:

| Section name       | Description                        |
|--------------------|------------------------------------|
| `animation`        | Hero animation (desktop)           |
| `animation_mobile` | Hero static fallback (mobile)      |
| `pitch`            | Tagline section                    |
| `features`         | Feature list                       |
| `tutorial`         | Interactive tutorial iframe        |
| `setup`            | Setup steps (clone, run, open)     |
| `cta`              | Final call-to-action               |

```json
{
  "event_type": "section_viewed",
  "data": {
    "section": "features",
    "time_on_page_ms": 12400
  }
}
```

### `animation_watch_time`
Fired once when the user scrolls past the hero animation for the first time.

```json
{
  "event_type": "animation_watch_time",
  "data": {
    "duration_ms": 8500
  }
}
```

### `tutorial_interaction`
Fired once when the user clicks into or focuses the tutorial iframe.

```json
{
  "event_type": "tutorial_interaction",
  "data": {
    "time_on_page_ms": 25000
  }
}
```

### `cta_click`
Fired when the user clicks the "Get Started on GitHub" button.

```json
{
  "event_type": "cta_click",
  "data": {
    "target": "https://github.com/49agents/49agents",
    "time_on_page_ms": 45000
  }
}
```

### `setup_code_click`
Fired when the user clicks a code snippet in the setup steps (likely to copy it).

```json
{
  "event_type": "setup_code_click",
  "data": {
    "code": "git clone https://github.com/49Agents/49Agents.git",
    "time_on_page_ms": 38000
  }
}
```

### `page_exit`
Fired when the user leaves the page (visibility change or beforeunload). This is the summary event — it contains the full session picture.

```json
{
  "event_type": "page_exit",
  "data": {
    "time_on_page_ms": 62000,
    "max_scroll_depth_pct": 87,
    "sections_seen": ["animation", "pitch", "features", "tutorial"],
    "animation_watch_time_ms": 8500,
    "tutorial_interacted": true,
    "cta_clicked": false
  }
}
```

---

## Common Fields on Every Event

| Field        | Type   | Description                                |
|--------------|--------|--------------------------------------------|
| `event_type` | string | One of the types listed above              |
| `session_id` | string | Random ID generated per page load          |
| `timestamp`  | string | ISO 8601 timestamp from the client         |
| `page`       | string | `location.pathname` (e.g. `/`, `/tutorial`)|
| `data`       | object | Event-specific payload                     |

---

## Suggested Database Schema (SQLite)

```sql
CREATE TABLE analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  session_id TEXT NOT NULL,
  client_timestamp TEXT NOT NULL,
  server_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  page TEXT NOT NULL,
  data TEXT NOT NULL,  -- JSON string
  ip TEXT,
  country TEXT         -- from Cloudflare CF-IPCountry header if available
);

CREATE INDEX idx_events_type ON analytics_events(event_type);
CREATE INDEX idx_events_session ON analytics_events(session_id);
CREATE INDEX idx_events_server_ts ON analytics_events(server_timestamp);
```

### Server-side enrichment

When inserting events, the server should add:
- `server_timestamp` — server time (don't trust client clocks for ordering)
- `ip` — from `req.ip` or `x-forwarded-for` (for unique visitor approximation)
- `country` — from `CF-IPCountry` header (Cloudflare provides this for free)

---

## Query Endpoint (for Admin Dashboard)

### `GET /api/analytics/dashboard`

Returns aggregated analytics data. Requires admin authentication.

#### Query Parameters

| Param    | Type   | Default | Description             |
|----------|--------|---------|-------------------------|
| `period` | string | `7d`    | `1d`, `7d`, `30d`, `all`|

#### Response

```json
{
  "period": "7d",
  "summary": {
    "total_sessions": 342,
    "avg_time_on_page_ms": 34000,
    "avg_scroll_depth_pct": 62,
    "cta_click_rate": 0.18,
    "tutorial_interaction_rate": 0.31,
    "avg_animation_watch_time_ms": 7200,
    "mobile_pct": 0.24
  },
  "funnel": {
    "animation": 342,
    "pitch": 310,
    "features": 268,
    "tutorial": 195,
    "setup": 152,
    "cta": 128
  },
  "top_referrers": [
    { "referrer": "google.com/search", "count": 89 },
    { "referrer": "twitter.com/", "count": 45 },
    { "referrer": "news.ycombinator.com/", "count": 32 }
  ],
  "utm_campaigns": [
    { "campaign": "launch_2026", "sessions": 56, "cta_clicks": 12 },
    { "campaign": "hn_post", "sessions": 32, "cta_clicks": 8 }
  ],
  "daily_sessions": [
    { "date": "2026-03-05", "sessions": 48 },
    { "date": "2026-03-06", "sessions": 52 }
  ]
}
```

#### Suggested SQL queries for the dashboard

**Total sessions:**
```sql
SELECT COUNT(DISTINCT session_id) FROM analytics_events
WHERE event_type = 'page_view' AND server_timestamp >= ?;
```

**Funnel (sections seen):**
```sql
SELECT
  json_extract(data, '$.section') AS section,
  COUNT(DISTINCT session_id) AS count
FROM analytics_events
WHERE event_type = 'section_viewed' AND server_timestamp >= ?
GROUP BY section;
```

**Average time on page:**
```sql
SELECT AVG(json_extract(data, '$.time_on_page_ms')) AS avg_ms
FROM analytics_events
WHERE event_type = 'page_exit' AND server_timestamp >= ?;
```

**Top referrers:**
```sql
SELECT
  json_extract(data, '$.referrer') AS referrer,
  COUNT(*) AS count
FROM analytics_events
WHERE event_type = 'page_view'
  AND json_extract(data, '$.referrer') IS NOT NULL
  AND server_timestamp >= ?
GROUP BY referrer
ORDER BY count DESC
LIMIT 20;
```

**UTM campaign performance:**
```sql
SELECT
  json_extract(data, '$.utm.utm_campaign') AS campaign,
  COUNT(DISTINCT session_id) AS sessions
FROM analytics_events
WHERE event_type = 'page_view'
  AND json_extract(data, '$.utm.utm_campaign') IS NOT NULL
  AND server_timestamp >= ?
GROUP BY campaign
ORDER BY sessions DESC;
```

**CTA click rate:**
```sql
SELECT
  ROUND(
    CAST((SELECT COUNT(DISTINCT session_id) FROM analytics_events WHERE event_type = 'cta_click' AND server_timestamp >= ?) AS REAL) /
    NULLIF((SELECT COUNT(DISTINCT session_id) FROM analytics_events WHERE event_type = 'page_view' AND server_timestamp >= ?), 0),
    3
  ) AS click_rate;
```
