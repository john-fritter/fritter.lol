const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const q = async (query) => {
  const url = `/metrics/api/v1/query?query=${encodeURIComponent(query)}`;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const json = await response.json();
  if (json.status !== 'success') throw new Error(json.error || 'Prometheus query failed');
  return json.data.result || [];
};
const value = (result) => Number(result?.[0]?.value?.[1]);
const bytes = (n) => {
  if (!Number.isFinite(n)) return '—';
  const units = ['B','KB','MB','GB','TB']; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
};
const duration = (seconds) => {
  if (!Number.isFinite(seconds)) return '—';
  const d = Math.floor(seconds / 86400); seconds %= 86400;
  const h = Math.floor(seconds / 3600); seconds %= 3600;
  const m = Math.floor(seconds / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
};
const pct = (used, total) => total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : 0;

async function boot() {
  try {
    const [load1, load5, load15, memTotal, memAvail, diskSize, diskAvail, uptime, targets] = await Promise.all([
      q('node_load1'), q('node_load5'), q('node_load15'),
      q('node_memory_MemTotal_bytes'), q('node_memory_MemAvailable_bytes'),
      q('node_filesystem_size_bytes{mountpoint="/"}'), q('node_filesystem_avail_bytes{mountpoint="/"}'),
      q('time()-node_boot_time_seconds'), q('up'),
    ]);

    const l1 = value(load1), l5 = value(load5), l15 = value(load15);
    $('load1').textContent = Number.isFinite(l1) ? l1.toFixed(2) : '—';
    $('load-all').textContent = [l1,l5,l15].map(v => Number.isFinite(v) ? v.toFixed(2) : '—').join(' / ');

    const mt = value(memTotal), ma = value(memAvail), mu = mt - ma, mp = pct(mu, mt);
    $('mem-pct').innerHTML = `${mp.toFixed(0)}<small>%</small>`;
    $('mem-bar').style.width = `${mp}%`;
    $('mem-detail').textContent = `${bytes(mu)} used of ${bytes(mt)}`;

    const ds = value(diskSize), da = value(diskAvail), du = ds - da, dp = pct(du, ds);
    $('disk-pct').innerHTML = `${dp.toFixed(0)}<small>%</small>`;
    $('disk-bar').style.width = `${dp}%`;
    $('disk-detail').textContent = `${bytes(du)} used of ${bytes(ds)}`;

    $('uptime').textContent = duration(value(uptime));

    $('targets').innerHTML = targets.map((r) => {
      const up = r.value?.[1] === '1';
      const job = r.metric?.job || 'unknown';
      const instance = r.metric?.instance || '';
      return `<div class="list-row"><span><span class="dot ${up ? 'good' : 'bad'}"></span> ${esc(job)}</span><span class="muted code-ish">${esc(instance)}</span></div>`;
    }).join('') || '<p class="muted">No scrape targets found.</p>';

    $('server-state').textContent = 'Metrics online';
    $('server-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    console.error(error);
    $('server-state').textContent = 'Metrics unavailable';
    $('server-updated').textContent = error.message;
  }
}

boot();
setInterval(boot, 30000);
