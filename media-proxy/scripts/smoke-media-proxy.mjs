import { fetch } from '../src/lib/http.mjs';

const baseUrl = process.env.MEDIA_PROXY_BASE_URL || 'http://127.0.0.1:8080';
const checks = [
  { path: '/api/media/health', keys: ['ok', 'hasTmdb', 'hasJellyseerr', 'hasExternalSearch'] },
  { path: '/api/media/recently-watched?limit=1', keys: ['items'] },
  { path: '/api/media/recently-added?limit=1', keys: ['items'] },
  { path: '/api/media/library?limit=1', keys: ['items', 'total'] },
  { path: '/api/media/activity/weekly', keys: ['data'] },
  { path: '/api/media/activity/monthly', keys: ['data'] }
];

for (const check of checks) {
  const url = `${baseUrl}${check.path}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`${check.path}: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  for (const key of check.keys) {
    if (!(key in data)) throw new Error(`${check.path}: missing key ${key}`);
  }
  console.log(`ok ${check.path}`);
}

async function fetchJson(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${response.statusText}`);
  return response.json();
}

// Smoke check: GET /api/media/library pagination and startIndex alias.
{
  const firstPage = await fetchJson('/api/media/library?limit=1');
  if (!Array.isArray(firstPage.items)) throw new Error('/api/media/library?limit=1: items is not an array');

  if (Number(firstPage.total) >= 2 && firstPage.items.length > 0) {
    const secondPage = await fetchJson('/api/media/library?limit=1&start_index=1');
    const camelSecondPage = await fetchJson('/api/media/library?limit=1&startIndex=1');

    if (!Array.isArray(secondPage.items) || secondPage.items.length !== 1) {
      throw new Error('/api/media/library?limit=1&start_index=1: expected one item when total >= 2');
    }
    if (!Array.isArray(camelSecondPage.items) || camelSecondPage.items.length !== 1) {
      throw new Error('/api/media/library?limit=1&startIndex=1: expected one item when total >= 2');
    }

    const firstId = firstPage.items[0]?.id;
    const secondId = secondPage.items[0]?.id;
    const camelSecondId = camelSecondPage.items[0]?.id;
    if (firstId === secondId) {
      throw new Error('/api/media/library pagination: first and second page returned the same item');
    }
    if (secondId !== camelSecondId) {
      throw new Error('/api/media/library pagination: startIndex did not match start_index');
    }
    console.log('ok /api/media/library pagination (start_index and startIndex)');
  } else {
    console.log('skip /api/media/library pagination (fewer than 2 library items)');
  }
}

// Smoke check: GET /api/media/items/:id
// 1. Fetch a real item ID from the library, then verify the detail endpoint returns the expected shape.
// 2. Verify a nonexistent ID returns 404 JSON.
{
  const library = await fetchJson('/api/media/library?limit=1');

  if (Array.isArray(library.items) && library.items.length > 0) {
    const realId = library.items[0].id;
    const itemUrl = `${baseUrl}/api/media/items/${encodeURIComponent(realId)}`;
    const itemRes = await fetch(itemUrl, { headers: { Accept: 'application/json' } });
    if (!itemRes.ok) throw new Error(`/api/media/items/${realId}: ${itemRes.status} ${itemRes.statusText}`);
    const item = await itemRes.json();
    for (const key of ['id', 'title', 'year', 'media_type', 'provider_ids', 'poster']) {
      if (!(key in item)) throw new Error(`/api/media/items/:id: missing key ${key}`);
    }
    if (!('tmdb' in item.provider_ids) || !('imdb' in item.provider_ids)) {
      throw new Error('/api/media/items/:id: provider_ids missing tmdb or imdb');
    }
    console.log(`ok /api/media/items/:id (id=${realId})`);
  } else {
    console.log('skip /api/media/items/:id (library empty, no real ID to test)');
  }

  const fakeId = '00000000-0000-0000-0000-000000000000';
  const notFoundRes = await fetch(`${baseUrl}/api/media/items/${fakeId}`, { headers: { Accept: 'application/json' } });
  if (notFoundRes.status !== 404) {
    throw new Error(`/api/media/items/${fakeId}: expected 404, got ${notFoundRes.status}`);
  }
  const notFoundData = await notFoundRes.json();
  if (!('error' in notFoundData)) throw new Error(`/api/media/items/${fakeId}: 404 response missing error key`);
  console.log('ok /api/media/items/:id (404 for nonexistent id)');
}

// Smoke check: GET /api/media/search?q=...
{
  const missingQ = await fetch(`${baseUrl}/api/media/search`, { headers: { Accept: 'application/json' } });
  if (missingQ.status !== 400) {
    throw new Error(`/api/media/search without q: expected 400, got ${missingQ.status}`);
  }
  const missingQBody = await missingQ.json();
  if (!('error' in missingQBody)) throw new Error('/api/media/search without q: missing error key');
  console.log('ok /api/media/search (400 for missing q)');

  const health = await fetchJson('/api/media/health');
  const inLibraryTitle = process.env.SMOKE_LIBRARY_TITLE;
  if (inLibraryTitle) {
    const searchLibrary = await fetchJson(`/api/media/search?q=${encodeURIComponent(inLibraryTitle)}&limit=10`);
    if (!Array.isArray(searchLibrary.items)) throw new Error('/api/media/search in-library probe: items is not an array');
    const match = searchLibrary.items.find((item) => item.library_state === 'in_library');
    if (!match) throw new Error('/api/media/search in-library probe: expected at least one in_library result');
    for (const key of ['id', 'title', 'year', 'media_type', 'provider_ids', 'poster', 'library_state']) {
      if (!(key in match)) throw new Error(`/api/media/search in-library probe: missing key ${key}`);
    }
    console.log('ok /api/media/search in-library state');
  } else {
    console.log('skip /api/media/search in-library state (set SMOKE_LIBRARY_TITLE to enforce)');
  }

  const availableTitle = process.env.SMOKE_AVAILABLE_TITLE || 'The Matrix';
  const searchAvailable = await fetchJson(`/api/media/search?q=${encodeURIComponent(availableTitle)}&limit=10`);
  if (!Array.isArray(searchAvailable.items)) throw new Error('/api/media/search available probe: items is not an array');
  const candidate = searchAvailable.items.find((item) => item.media_type === 'movie');
  if (candidate) {
    for (const key of ['id', 'title', 'year', 'media_type', 'provider_ids', 'poster', 'library_state']) {
      if (!(key in candidate)) throw new Error(`/api/media/search available probe: missing key ${key}`);
    }
  }

  if (!health.hasExternalSearch) {
    console.log('skip /api/media/search available state assertion (no external search source configured)');
  } else {
    const available = searchAvailable.items.find((item) => item.library_state === 'available');
    if (!available) {
      throw new Error('/api/media/search available probe: expected at least one available result when external search is configured');
    }
    if (!('tmdb' in (available.provider_ids || {}))) {
      throw new Error('/api/media/search available probe: provider_ids missing tmdb');
    }
    console.log('ok /api/media/search available state');
  }
}
