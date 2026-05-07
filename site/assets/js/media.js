const api = '/api/media';
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = (value) => Number(value || 0).toLocaleString();

async function get(path) {
  const response = await fetch(`${api}${path}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function dateLabel(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function poster(item) {
  const title = `${item.grandparent_title ? item.grandparent_title + ' · ' : ''}${item.title || 'Unknown'}`;
  const image = item.poster || '';
  return `<figure class="poster">
    ${image ? `<img src="${esc(image)}" alt="${esc(title)}" loading="lazy">` : ''}
    <figcaption><div class="poster-title">${esc(title)}</div><div class="poster-meta">${esc(dateLabel(item.watched_at || item.added_at))}</div></figcaption>
  </figure>`;
}

function summarize(weeklyData = {}, monthlyData = {}) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const blocks = ['00-03', '03-06', '06-09', '09-12', '12-15', '15-18', '18-21', '21-24'];
  const weekdayTotals = { Sunday:0, Monday:0, Tuesday:0, Wednesday:0, Thursday:0, Friday:0, Saturday:0 };
  const timeTotals = { Morning:0, Afternoon:0, Evening:0, 'Late night':0 };
  let week = 0, month = 0;
  const bucket = (b) => (b === '06-09' || b === '09-12') ? 'Morning' : (b === '12-15' || b === '15-18') ? 'Afternoon' : (b === '18-21' || b === '21-24') ? 'Evening' : 'Late night';

  for (const day of days) for (const block of blocks) {
    const v = Number(weeklyData[`${day}_${block}`] || 0);
    week += v; timeTotals[bucket(block)] += v;
  }
  for (let i = 30; i >= 1; i--) {
    const v = Number(monthlyData[`day_${i}`] || 0);
    month += v;
    const d = new Date(); d.setHours(12,0,0,0); d.setDate(d.getDate() - (30 - i));
    const wd = d.toLocaleDateString(undefined, { weekday: 'long' });
    if (wd in weekdayTotals) weekdayTotals[wd] += v;
  }
  const bestDay = Object.entries(weekdayTotals).sort((a,b) => b[1]-a[1])[0];
  const bestTime = Object.entries(timeTotals).sort((a,b) => b[1]-a[1])[0];
  return [
    ['Plays this week', number(week)],
    ['Plays this month', number(month)],
    ['Most active day', bestDay?.[1] ? `${bestDay[0]} (${number(bestDay[1])})` : 'N/A'],
    ['Most active time', bestTime?.[1] ? bestTime[0] : 'N/A'],
  ].map(([label, value]) => `<div class="summary-tile"><div class="summary-label">${esc(label)}</div><div class="summary-value">${esc(value)}</div></div>`).join('');
}

async function boot() {
  try {
    const [watched, added, weekly, monthly] = await Promise.all([
      get('/recently-watched?limit=14'),
      get('/recently-added?limit=14'),
      get('/activity/weekly'),
      get('/activity/monthly'),
    ]);
    const watchedItems = watched.items || [];
    const addedItems = added.items || [];
    $('watched').innerHTML = watchedItems.length ? watchedItems.map(poster).join('') : '<p class="muted">No recent watch history.</p>';
    $('added').innerHTML = addedItems.length ? addedItems.map(poster).join('') : '<p class="muted">No recent additions.</p>';
    $('summary').innerHTML = summarize(weekly.data || {}, monthly.data || {});
    $('media-state').textContent = 'Live data loaded';
    $('media-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    console.error(error);
    $('media-state').textContent = 'Data unavailable';
    $('media-updated').textContent = error.message;
    $('watched').innerHTML = '<p class="muted">Could not load recently watched items.</p>';
    $('added').innerHTML = '<p class="muted">Could not load recently added items.</p>';
    $('summary').innerHTML = '<p class="muted">Could not load viewing summary.</p>';
  }
}

boot();
