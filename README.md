# fritter.lol

This repo contains the Docker/Caddy configuration and static site for `fritter.lol`, a self-hosted media and services stack running on Debian 12.

## Tracked public site

The public site lives in `site/` and is served by Caddy from `/srv/site` inside the container.

Current copy-bearing pages:

- `site/index.html` — public homepage
- `site/about.html` — about/contact page
- `site/media.html` — public-safe Jellyfin activity dashboard
- `site/server.html` — private server dashboard shell for `server.fritter.lol`
- `site/frittertopia.html` — placeholder page for Frittertopia
- `site/404.html` — not-found page

## Routing

Public clean URLs are handled in `config/caddy/Caddyfile`:

- `/media` -> `/media.html`
- `/about` -> `/about.html`
- `/frittertopia` -> `/frittertopia.html`

`server.fritter.lol` serves `site/server.html` behind basic auth and proxies read-only Prometheus API access under `/metrics/*`.

## Git hygiene

The repo root contains large runtime and media data. `.gitignore` ignores root-level files by default and explicitly allows only the deploy config, Caddy config, and static site files that should be versioned.
