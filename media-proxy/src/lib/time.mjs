export function normalizeTimestamp(value) {
  if (!value) return null;
  const coerceNumericTimestamp = (numValue) => {
    if (!Number.isFinite(numValue) || numValue <= 0) return null;
    // .NET ticks (100ns since 0001-01-01)
    if (numValue > 1000000000000000) {
      const ms = Math.floor((numValue - 621355968000000000) / 10000);
      return ms > 0 ? new Date(ms) : null;
    }
    // Unix ms
    if (numValue > 1000000000000) return new Date(numValue);
    // Unix s
    if (numValue > 1000000000) return new Date(numValue * 1000);
    return null;
  };

  if (typeof value === 'number') {
    const d = coerceNumericTimestamp(value);
    return d && Number.isFinite(d.getTime()) ? d : null;
  }

  if (typeof value === 'string') {
    const maybeNum = Number(value);
    if (Number.isFinite(maybeNum)) {
      const d = coerceNumericTimestamp(maybeNum);
      if (d && Number.isFinite(d.getTime())) return d;
    }
  }

  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function getActivityDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);

  const read = (type) => parts.find((p) => p.type === type)?.value || '';
  const year = read('year');
  const month = read('month');
  const day = read('day');
  const hour = Number(read('hour')) % 24;
  const minute = read('minute');
  const second = read('second');
  const weekday = read('weekday');

  return {
    weekday,
    hour,
    local_date: `${year}-${month}-${day}`,
    local_time: `${String(hour).padStart(2, '0')}:${minute}:${second}`
  };
}

export function getWeeklyBucketForDate(date, timezone) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const timeBlocks = ['00-03', '03-06', '06-09', '09-12', '12-15', '15-18', '18-21', '21-24'];
  const parts = getActivityDateParts(date, timezone);
  if (!days.includes(parts.weekday) || !Number.isFinite(parts.hour)) return null;
  const block = timeBlocks[Math.floor(parts.hour / 3)];
  if (!block) return null;
  return `${parts.weekday}_${block}`;
}

export function buildMonthlyBucketMap(timezone) {
  const map = new Map();
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  for (let i = 1; i <= 30; i++) {
    const date = new Date(now - ((30 - i) * dayMs));
    map.set(dateFormatter.format(date), `day_${i}`);
  }
  return map;
}
