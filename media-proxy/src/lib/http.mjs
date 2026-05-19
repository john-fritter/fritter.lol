import fetch from 'node-fetch';

export async function safeFetchJson(url, opts = {}, timeout = 1500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    if (!r.ok) return { ok: false, error: `${r.status} ${r.statusText}` };
    const j = await r.json();
    return { ok: true, json: j };
  } catch (e) {
    const msg = e.name === 'AbortError' ? `timeout after ${timeout}ms` : e.message;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

export { fetch };
