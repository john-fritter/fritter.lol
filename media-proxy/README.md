# media-proxy

`media-proxy` is the local media-stack adapter for fritter.lol. It exposes a small public-safe HTTP API at `/api/media/*` for the static media dashboard today and for Fritterflix later.

It is intentionally **not** the Fritterflix app backend. Its job is to know how to talk to Jellyfin and related media-stack services; Fritterflix should own product/user state such as auth, ratings, reviews, watchlists, wheel candidates, audit logs, TMDB enrichment, and MCP tools.

## Current responsibilities

- Proxy Jellyfin images without exposing the Jellyfin API token to browsers.
- Read recently watched items from multiple Jellyfin sources:
  - Jellyfin per-user API data
  - Jellyfin activity log
  - Playback Reporting SQLite database
- Reconcile and deduplicate household watch history.
- Read recently added Jellyfin library items.
- Read normalized movie-library pages for Fritterflix without exposing Jellyfin response shapes.
- Build weekly and monthly playback activity summaries.
- Cache short-lived endpoint responses in memory.

## Runtime

The service is run by the `/srv/seedbox/docker-compose.yml` stack as `media-proxy`.

Caddy routes public requests like this:

```text
/api/media/* -> media-proxy:8080
```

The container starts with:

```text
node src/server.mjs
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port inside the container. Defaults to `8080`. |
| `JELLYFIN_URL` | Internal Jellyfin base URL, e.g. `http://jellyfin:8096`. |
| `JELLYFIN_TOKEN` | Jellyfin API token. Never expose this to browser clients. |
| `JELLYFIN_USER_ID` | Fallback Jellyfin user ID for user-scoped endpoints. |
| `JELLYFIN_DB_PATH` | Read-only path to Playback Reporting SQLite database. |
| `TIMEOUT_MS` | Upstream request timeout. |
| `ACTIVITY_TIMEZONE` | Timezone for activity buckets. Defaults to `America/Los_Angeles`. |

## Endpoints

Current endpoint contract:

```text
GET /health
GET /api/media/health
GET /api/media/img?u=<url>&auth=jellyfin
GET /api/media/recently-watched?limit=12
GET /api/media/recently-added?limit=10
GET /api/media/library?limit=50&start_index=0&played=all&sort=recently_added
GET /api/media/items/:id
GET /api/media/activity/weekly
GET /api/media/activity/monthly
GET /api/media/activity/debug/events?limit=250
GET /api/media/debug/jellyfin-info
GET /debug-routes
```

`GET /api/media/library` accepts `limit`, `start_index`, `startIndex`, and `offset` pagination params. `limit` defaults to `50` and is capped at `200` items per page. `start_index` is the canonical zero-based page offset; `startIndex` and `offset` are accepted as aliases.

The static site dashboard currently consumes:

```text
/api/media/recently-watched?limit=14
/api/media/recently-added?limit=14
/api/media/activity/weekly
/api/media/activity/monthly
```

## Source layout

```text
src/
  server.mjs                         # process entrypoint
  app.mjs                            # Express app assembly
  config/env.mjs                     # environment parsing
  clients/jellyfinClient.mjs         # authenticated Jellyfin API client
  repositories/playbackReportingRepository.mjs
  services/imageService.mjs
  services/recentlyWatchedService.mjs
  services/recentlyAddedService.mjs
  services/libraryService.mjs
  services/itemService.mjs
  services/activityService.mjs
  routes/*.mjs                       # thin Express route modules
  lib/cache.mjs
  lib/http.mjs
  lib/normalize.mjs
  lib/time.mjs
scripts/
  smoke-media-proxy.mjs              # endpoint contract smoke check
```

## Local checks

From `/srv/seedbox`:

```bash
npm --prefix media-proxy run check
docker compose build media-proxy
docker compose up -d --no-deps media-proxy
docker compose exec -T media-proxy npm run smoke
```

From `/srv/seedbox/media-proxy`:

```bash
npm run check
MEDIA_PROXY_BASE_URL=http://127.0.0.1:8080 npm run smoke
```

## Production operation

Use narrow service operations only:

```bash
cd /srv/seedbox
docker compose ps media-proxy
docker compose logs --tail=100 media-proxy
docker compose build media-proxy
docker compose up -d --no-deps media-proxy
```

Do not restart the whole media stack for media-proxy-only changes unless there is a specific reason.

## Security notes

`/api/media/img` currently accepts a URL in `?u=` and proxies it, adding Jellyfin auth when `auth=jellyfin` is supplied. This preserves existing behavior, but before treating this as public/open-source safe it should be restricted to configured Jellyfin/media-stack hosts.

## Fritterflix boundary

Recommended ownership boundary:

- `media-proxy` owns local media-stack state: Jellyfin library/item metadata, image proxying, watch history, activity aggregation, and possibly future Radarr/Sonarr/Jellyseerr adapter behavior.
- Fritterflix owns product/user state: users, auth/session, ratings, reviews, viewings, audit log, watchlist, wheel candidates, TMDB enrichment/cache, and MCP tools.

Fritterflix-facing media-proxy endpoints:

```text
GET /api/media/library
GET /api/media/items/:id
```

Those should return normalized data. Fritterflix should not need to understand raw Jellyfin response shapes.

`GET /api/media/library` returns movie-only Jellyfin library rows in this shape:

```json
{
  "items": [
    {
      "id": "jellyfin-item-id",
      "title": "Movie Title",
      "year": 2026,
      "media_type": "movie",
      "provider_ids": { "tmdb": "123", "imdb": "tt123" },
      "poster": "/api/media/img?...",
      "added_at": 1770000000000,
      "runtime_minutes": 120,
      "genres": ["Drama"],
      "official_rating": "PG-13",
      "community_rating": 8.5,
      "critic_rating": null,
      "user_data": { "played": false, "play_count": 0, "last_played_at": null, "is_favorite": false }
    }
  ],
  "total": 1,
  "start_index": 0,
  "limit": 50,
  "source": "jellyfin-user-items",
  "sort": "recently_added",
  "unwatched_first": true
}
```

`GET /api/media/items/:id` returns a single normalized movie in the same item shape (without the list envelope). Returns `404` JSON `{ "error": "item not found" }` when the ID doesn't exist or isn't a movie.
