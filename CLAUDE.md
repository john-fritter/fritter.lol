# CLAUDE.md — fritter.lol

## WHY
This repo holds the deployable configuration and public site for `fritter.lol`, a self-hosted media/services stack on Debian 12.

## WHAT
- Docker Compose for the stack in `docker-compose.yml`.
- Caddy routing and TLS config in `config/caddy/`.
- Public-safe static site content in `site/`.
- Supporting service config lives under `config/` and is mounted into the containers.

## HOW
- Keep changes small and specific to the service or site you’re touching.
- Use `README.md` for the current repo map and service overview instead of duplicating it here.
- Use `docker compose` and the existing service configs as the source of truth; check the compose file before assuming ports, volumes, or environment variables.
- Be careful with runtime data and media under the repo root: don’t move, delete, or rewrite large data paths unless the task explicitly calls for it.
- Prefer editing the relevant file directly (`docker-compose.yml`, `config/caddy/Caddyfile`, or `site/*`) and validate the change in the smallest relevant way.
