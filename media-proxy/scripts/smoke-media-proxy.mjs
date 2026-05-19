import { fetch } from '../src/lib/http.mjs';

const baseUrl = process.env.MEDIA_PROXY_BASE_URL || 'http://127.0.0.1:8080';
const checks = [
  { path: '/api/media/health', keys: ['ok'] },
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
