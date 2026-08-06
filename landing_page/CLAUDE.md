# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **49Agents landing page** — a static marketing site served at `49agents.com`. It is separate from the main application (app.49agents.com). There is no build step, no bundler, no package manager — just static HTML, CSS, and JS files served directly.

## Architecture

- **index.html** — Main landing page. Contains inline `<style>` for all page CSS plus inline `<script>` for particles, intersection observer animations, mobile fallback, and UTM forwarding. Loads `agent-animation.bundle.js` (pre-built canvas animation) and `analytics.js`.
- **tutorial.html** — Interactive walkthrough embedded as an iframe in index.html. Uses `styles.css` (shared with the main app) plus `tutorial-getting-started.min.js` and `tutorial-panes.min.js`.
- **changelogs.html**, **claude-setup.html**, **security_privacy.html** — Standalone info pages with their own inline styles, sharing the same nav/footer pattern.
- **styles.css** — Stylesheet shared with the tutorial page (originated from the main app).
- **analytics.js** — Client-side analytics tracker. Batches events and sends to `/api/analytics/events` via sendBeacon. Tracks: page views, scroll depth, section visibility, animation watch time, tutorial interaction, CTA clicks, and time on page. See `ANALYTICS_API_CONTRACT.md` for the server-side spec.
- **agent-animation.bundle.js** — Pre-built bundle for the `<agent-animation>` custom element used in the hero section. Do not edit directly.
- **tutorial-getting-started.min.js**, **tutorial-panes.min.js** — Minified JS for the tutorial. Do not edit directly.

## Development

No build tools. Open HTML files directly or serve with any static server:

```
python3 -m http.server 1071
```

The landing page is deployed by the main 49Agents server which serves files from a configured `LANDING_DIR` path. Hostname-based routing separates `49agents.com` (this repo) from `app.49agents.com` (the app).

## Design Conventions

- Dark theme: background `#050509`/`#000`, accent purple `#8b5cf6`
- Fonts: Inter (body), JetBrains Mono (code/nav links), Montserrat (brand/headings)
- Low opacity text: content uses `rgba(255, 255, 255, 0.3–0.9)` for hierarchy
- Mobile: portrait screens get a static fallback instead of the hero animation (detected via `innerWidth < innerHeight`)
- Sections follow a consistent pattern: outer section with padding, inner container with `max-width` (typically 640px)
