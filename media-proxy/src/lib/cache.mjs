const cache = new Map();

const ttl = (ms) => ({ t: Date.now() + ms });

export function getCache(key) {
  const value = cache.get(key);
  return (value && value.t > Date.now()) ? value.data : null;
}

export function setCache(key, data, ms = 10000) {
  cache.set(key, { data, ...ttl(ms) });
}

export async function withCache(key, ms, load) {
  const hit = getCache(key);
  if (hit) return hit;
  const data = await load();
  setCache(key, data, ms);
  return data;
}
