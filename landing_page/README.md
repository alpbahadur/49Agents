# 49Agents Landing Page

## What is 49Agents?

49Agents is a browser-based terminal management platform. You install a lightweight agent on your machine, and access your terminals from any browser through an infinite canvas UI.

## Domains

| Domain | What it serves |
|--------|---------------|
| **49agents.com** | Landing/marketing page (this repo) |
| **app.49agents.com** | The web application — infinite canvas with terminal panes, file browser, notes, git graph, etc. |

## App Overview (app.49agents.com)

The app is an infinite canvas where you can open and arrange:
- **Terminal panes** — real tmux sessions streamed via WebSocket
- **Note panes** — markdown notes with live preview
- **File browser** — browse and edit files with Monaco editor
- **Git graph** — visual commit history
- **Beads issues** — lightweight issue tracking
- **Web pages** — embedded iframes
- **Directories** — folder browsing

Users install the `49-agent` daemon on their machine, pair it with their account via a 6-character code, and their terminals appear in the browser.

## Architecture

```
User's Machine                     Cloud Server
┌──────────────┐                  ┌──────────────────┐
│  49-agent    │ ── WebSocket ──► │  Express.js       │
│  (tmux+ttyd) │                  │  SQLite (users,   │
└──────────────┘                  │    layouts, notes) │
                                  │  WebSocket relay   │
                                  └────────┬──────────┘
                                           │
                                  ◄── WSS ─┘
                                  │
                            ┌─────┴──────┐
                            │  Browser    │
                            │  (xterm.js) │
                            └────────────┘
```

The cloud server is a **pure relay** — no terminal data is stored. It just routes I/O between the agent and the browser in real time.

## Tech Stack

### Backend (Cloud Server)
- **Node.js + Express.js**
- **SQLite** (better-sqlite3) — users, layouts, preferences
- **WebSocket** (ws) — real-time agent/browser relay
- **Auth:** GitHub & Google OAuth (arctic), JWT sessions (jose)
- **Billing:** Stripe

### Frontend (App)
- **Vanilla JavaScript** — no framework, ~10K lines
- **xterm.js** — terminal rendering
- **Monaco Editor** — file editing (from CDN)
- **marked.js** — markdown rendering (from CDN)
- **Plain CSS** with custom properties
- Build: Terser + javascript-obfuscator → `.min.js` files

### Agent (runs on user's machine)
- **Node.js** CLI daemon
- Manages **tmux** sessions via **ttyd**
- Connects to cloud server over WebSocket

## Hosting

- Cloud server runs on a Linux VPS
- Express serves both the static frontend and the API/WebSocket endpoints
- Hostname-based routing separates landing page vs app:
  - `49agents.com` → landing page (served from `LANDING_DIR`)
  - `app.49agents.com` → the web app
- No Docker — direct Node.js deployment
- No Nginx required (Express handles everything), but can be placed behind a reverse proxy

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default: 1071) |
| `LANDING_DIR` | Path to landing page files |
| `APP_HOST` | App subdomain (e.g. `app.49agents.com`) |
| `CLOUD_HOST` | Public hostname |
| `GITHUB_CLIENT_ID/SECRET` | GitHub OAuth |
| `GOOGLE_CLIENT_ID/SECRET` | Google OAuth |
| `JWT_SECRET` | Session signing |
| `STRIPE_*` | Billing |

## Related Repos

- **Main codebase** (private): cloud server + agent + web app
- **This repo**: landing page at 49agents.com
