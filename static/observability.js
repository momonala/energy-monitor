const PROJECT = document.querySelector('main[data-project]').dataset.project;
const API = '/api/spyglass/dashboard/api';
const REFRESH_MS = 30_000;

// Metric names as stored by Spyglass: {project}.{calling_fn}.{stat}
const M = {
  mqttReceived: `${PROJECT}.on_message.mqtt.messages.mqtt_reading`,
  dbSaved:      `${PROJECT}.save_energy_reading.db.readings.saved`,
  dbDuplicate:  `${PROJECT}.save_energy_reading.db.readings.duplicate`,
  dbErrors:     `${PROJECT}.db_worker.mqtt.db_save.errors`,
  dbLatency:    `${PROJECT}.__enter__.db.save_reading`,
  queueDepth:   `${PROJECT}.on_message.mqtt.db_queue.depth`,
  queueWait:    `${PROJECT}.db_worker.mqtt.db_queue.wait_ms`,
  disconnect:      `${PROJECT}.on_disconnect.mqtt.disconnect`,
  deviceOffline:   `${PROJECT}.on_message.mqtt.device.offline`,
  deviceErrors:    `${PROJECT}.on_message.mqtt.device.errors`,
  lowReadings:     `${PROJECT}.log_db_health_check.db.health.low_readings`,
  lastHour:        `${PROJECT}.log_db_health_check.db.readings.last_hour`,
  sensorInterval:  `${PROJECT}.on_message.mqtt.sensor.interval_ms`,
};

// ── Chart registry ─────────────────────────────────────────

const charts = {};

// ── Time window helpers ────────────────────────────────────

function getTimeWindow() {
  const amount = parseInt(document.getElementById('windowAmount').value, 10) || 6;
  const unit = document.getElementById('windowUnit').value;
  const multiplier = unit === 'hours' ? 1 : unit === 'days' ? 24 : 168;
  const hours = amount * multiplier;
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function getRollupSeconds() {
  const val = document.getElementById('rollupWindow').value;
  return val === 'auto' ? null : parseInt(val, 10) * 60;
}

// ── Fetch helpers ──────────────────────────────────────────

async function fetchSeries(name) {
  const { from, to } = getTimeWindow();
  const interval = getRollupSeconds();
  const qs = new URLSearchParams({ project: PROJECT, name, from, to });
  if (interval) qs.set('interval', interval);
  try {
    const r = await fetch(`${API}/metrics/series?${qs}`);
    if (!r.ok) { console.error(`fetchSeries ${name}: HTTP ${r.status}`); return { points: [] }; }
    return r.json();
  } catch (e) {
    console.error(`fetchSeries ${name}:`, e);
    return { points: [] };
  }
}

async function fetchSummary(name) {
  const { from, to } = getTimeWindow();
  const qs = new URLSearchParams({ project: PROJECT, name, from, to });
  try {
    const r = await fetch(`${API}/metrics/summary?${qs}`);
    if (!r.ok) { console.error(`fetchSummary ${name}: HTTP ${r.status}`); return { latest_value: null }; }
    return r.json();
  } catch (e) {
    console.error(`fetchSummary ${name}:`, e);
    return { latest_value: null };
  }
}

// ── Utilities ──────────────────────────────────────────────

const sum    = pts => pts.reduce((a, p) => a + (p.value ?? 0), 0);
const fmt    = n   => n == null ? '—' : Math.round(n).toLocaleString('en');
const fmtMs  = n   => n == null ? '—' : `${n.toFixed(1)} ms`;
const fmtTs  = ts  => new Date(ts).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
const cssVar = v   => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// Merge two point arrays onto a shared timestamp axis; gaps fill with null.
function align(a, b) {
  const all = [...new Set([...a, ...b].map(p => p.timestamp))].sort();
  const ma  = new Map(a.map(p => [p.timestamp, p.value]));
  const mb  = new Map(b.map(p => [p.timestamp, p.value]));
  return {
    labels: all.map(fmtTs),
    a: all.map(ts => ma.get(ts) ?? null),
    b: all.map(ts => mb.get(ts) ?? null),
  };
}

// ── Chart factory ──────────────────────────────────────────

function chartTheme() {
  return {
    mono:  "'Fira Mono', Menlo, Monaco, monospace",
    muted: cssVar('--label-tertiary') || '#888',
    grid:  cssVar('--separator')      || 'rgba(255,255,255,0.08)',
  };
}

function buildChart(id, labels, datasets, extraOptions = {}) {
  if (charts[id]) charts[id].destroy();
  const { mono, muted, grid } = chartTheme();

  charts[id] = new Chart(document.getElementById(id), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: muted, font: { family: mono, size: 11 }, boxWidth: 10, padding: 14 },
        },
      },
      scales: {
        x: {
          ticks: { color: muted, font: { family: mono, size: 10 }, maxTicksLimit: 10 },
          grid:  { color: grid },
        },
        y: {
          ticks: { color: muted, font: { family: mono, size: 10 } },
          grid:  { color: grid },
          beginAtZero: true,
        },
      },
      ...extraOptions,
    },
  });
}

function line(label, data, color, extra = {}) {
  return { label, data, borderColor: color, backgroundColor: 'transparent',
           tension: 0.2, pointRadius: 0, borderWidth: 1.5, ...extra };
}

// ── Section loaders ────────────────────────────────────────

async function loadParity() {
  const [mqtt, saved, dup, err] = await Promise.all([
    fetchSeries(M.mqttReceived),
    fetchSeries(M.dbSaved),
    fetchSeries(M.dbDuplicate),
    fetchSeries(M.dbErrors),
  ]);

  const nMqtt  = sum(mqtt.points);
  const nSaved = sum(saved.points);
  const nDup   = sum(dup.points);
  const nErr   = sum(err.points);

  document.getElementById('stat-mqtt').textContent  = fmt(nMqtt);
  document.getElementById('stat-saved').textContent = fmt(nSaved);
  document.getElementById('stat-dup').textContent   = fmt(nDup);
  const errEl = document.getElementById('stat-err');
  errEl.textContent = fmt(nErr);
  errEl.className   = nErr > 0 ? 'stat-danger' : 'stat-healthy';
}

async function loadLatency() {
  const lat = await fetchSeries(M.dbLatency);
  const labels = lat.points.map(p => fmtTs(p.timestamp));
  const latVals = lat.points.map(p => p.value ?? null);
  buildChart('chartLatency', labels, [
    line('DB write (ms)', latVals, cssVar('--accent') || '#409cff'),
  ]);
}

async function loadDowntime() {
  const [disconn, deviceOffline, deviceErrors, low, lastHour] = await Promise.all([
    fetchSeries(M.disconnect),
    fetchSeries(M.deviceOffline),
    fetchSeries(M.deviceErrors),
    fetchSeries(M.lowReadings),
    fetchSummary(M.lastHour),
  ]);

  const nDisconn       = sum(disconn.points);
  const nDeviceOffline = sum(deviceOffline.points);
  const nDeviceErrors  = sum(deviceErrors.points);
  const nLow           = sum(low.points);

  const dEl = document.getElementById('stat-disconnects');
  dEl.textContent = fmt(nDisconn);
  dEl.className   = nDisconn > 0 ? 'stat-danger' : 'stat-healthy';

  const offEl = document.getElementById('stat-device-offline');
  offEl.textContent = fmt(nDeviceOffline);
  offEl.className   = nDeviceOffline > 0 ? 'stat-danger' : 'stat-healthy';

  const errEl = document.getElementById('stat-device-errors');
  errEl.textContent = fmt(nDeviceErrors);
  errEl.className   = nDeviceErrors > 0 ? 'stat-danger' : 'stat-healthy';

  const lEl = document.getElementById('stat-low');
  lEl.textContent = fmt(nLow);
  lEl.className   = nLow > 0 ? 'stat-danger' : 'stat-healthy';

  document.getElementById('stat-last-hour').textContent = fmt(lastHour.latest_value);
}

async function loadDbWrites() {
  const { from, to } = getTimeWindow();
  const rollup = getRollupSeconds() || 120;

  const fetchRaw = async name => {
    const qs = new URLSearchParams({ project: PROJECT, name, from, to });
    try {
      const r = await fetch(`${API}/metrics/series?${qs}`);
      if (!r.ok) { console.error(`loadDbWrites fetchRaw ${name}: HTTP ${r.status}`); return { points: [] }; }
      return r.json();
    } catch (e) {
      console.error(`loadDbWrites fetchRaw ${name}:`, e);
      return { points: [] };
    }
  };
  const [rawSaved, rawMqtt] = await Promise.all([
    fetchRaw(M.dbSaved),
    fetchRaw(M.mqttReceived),
  ]);

  const bucketMs  = rollup * 1000;
  const rawFromMs = new Date(from).getTime();
  const toMs      = new Date(to).getTime();
  const fromMs    = Math.floor(rawFromMs / bucketMs) * bucketMs;
  const windowHours = (toMs - rawFromMs) / 3_600_000;
  const numBuckets = Math.max(1, Math.ceil((toMs - fromMs) / bucketMs));

  const bucket = ts => Math.floor((new Date(ts).getTime() - fromMs) / bucketMs);
  const dbCounts   = new Array(numBuckets).fill(0);
  const mqttCounts = new Array(numBuckets).fill(0);
  for (const p of rawSaved.points) { const b = bucket(p.timestamp); if (b >= 0 && b < numBuckets) dbCounts[b]   += p.value ?? 0; }
  for (const p of rawMqtt.points)  { const b = bucket(p.timestamp); if (b >= 0 && b < numBuckets) mqttCounts[b] += p.value ?? 0; }

  const fmtBucket = ts => {
    const d = new Date(ts);
    return windowHours > 24
      ? d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  };
  const labels = Array.from({ length: numBuckets }, (_, i) =>
    fmtBucket(new Date(fromMs + i * bucketMs))
  );

  buildChart('chartDbWrites', labels, [
    line('MQTT received', mqttCounts, '#409cff', { tension: 0.4 }),
    line('DB writes',     dbCounts,   '#30d158', { tension: 0.4 }),
  ]);
}

// ── Logs ───────────────────────────────────────────────────

let logsData = [];

// Strip the verbose "YYYY-MM-DD HH:MM:SS,mmm LEVEL [fn] logger " prefix
// that the Python logging formatter prepends to each message body.
function cleanMessage(msg) {
  return msg.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} \w+ \[[^\]]+\] \S+ /, '').trim();
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(str) {
  return String(str).replace(/[&<>"']/g, c => ESC_MAP[c]);
}

function levelClass(level) {
  return `level-badge level-${level.toLowerCase()}`;
}

async function loadLogs() {
  const { from, to } = getTimeWindow();
  const qs = new URLSearchParams({ project: PROJECT, from, to });
  try {
    const r = await fetch(`/api/spyglass/logs?${qs}`);
    if (!r.ok) { console.error(`loadLogs: HTTP ${r.status}`); logsData = []; }
    else logsData = await r.json();
  } catch (e) {
    console.error('loadLogs:', e);
    logsData = [];
  }
  renderLogHistogram();
  renderLogTable();
}

function renderLogHistogram() {
  const { from, to } = getTimeWindow();
  const rollup   = getRollupSeconds() || 120;
  const bucketMs = rollup * 1000;
  const fromMs   = Math.floor(new Date(from).getTime() / bucketMs) * bucketMs;
  const toMs     = new Date(to).getTime();
  const numBuckets = Math.max(1, Math.ceil((toMs - fromMs) / bucketMs));

  const LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];
  const counts = Object.fromEntries(LEVELS.map(l => [l, new Array(numBuckets).fill(0)]));
  const labels = Array.from({ length: numBuckets }, (_, i) =>
    fmtTs(new Date(fromMs + i * bucketMs).toISOString())
  );

  for (const log of logsData) {
    const bucket = Math.floor((new Date(log.timestamp).getTime() - fromMs) / bucketMs);
    if (bucket >= 0 && bucket < numBuckets && counts[log.level]) {
      counts[log.level][bucket]++;
    }
  }

  const COLORS = {
    DEBUG:    'rgba(150,150,150,0.6)',
    INFO:     'rgba(64,156,255,0.6)',
    WARNING:  'rgba(255,214,10,0.6)',
    ERROR:    'rgba(255,69,58,0.7)',
    CRITICAL: 'rgba(255,69,58,0.95)',
  };

  if (charts.chartLogLevels) charts.chartLogLevels.destroy();
  const { mono, muted, grid } = chartTheme();

  charts.chartLogLevels = new Chart(document.getElementById('chartLogLevels'), {
    type: 'bar',
    data: {
      labels,
      datasets: LEVELS.map(l => ({
        label: l,
        data: counts[l],
        backgroundColor: COLORS[l],
        borderWidth: 0,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: muted, font: { family: mono, size: 11 }, boxWidth: 10, padding: 12 } },
      },
      scales: {
        x: { stacked: true, ticks: { color: muted, font: { family: mono, size: 10 }, maxTicksLimit: 10 }, grid: { color: grid } },
        y: { stacked: true, beginAtZero: true, ticks: { color: muted, font: { family: mono, size: 10 } }, grid: { color: grid } },
      },
    },
  });
}

function renderLogTable() {
  const levelFilter   = document.getElementById('logLevelFilter').value;
  const loggerFilter  = document.getElementById('logLoggerFilter').value.toLowerCase();
  const contentFilter = document.getElementById('logContentFilter').value.toLowerCase();

  let filtered = logsData;
  if (levelFilter)   filtered = filtered.filter(l => l.level === levelFilter);
  if (loggerFilter)  filtered = filtered.filter(l => l.logger_name.toLowerCase().includes(loggerFilter));
  if (contentFilter) filtered = filtered.filter(l => l.message.toLowerCase().includes(contentFilter));

  document.getElementById('logsCount').textContent =
    `Showing ${filtered.length.toLocaleString('en')} of ${logsData.length.toLocaleString('en')} logs`;

  const tbody = document.getElementById('logsTableBody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="logs-empty">No logs match the current filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(log => {
    const ts  = new Date(log.timestamp).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const msg = esc(cleanMessage(log.message));
    const logger = esc(log.logger_name);
    return `<tr>
      <td class="logs-time">${ts}</td>
      <td><span class="${levelClass(log.level)}">${esc(log.level)}</span></td>
      <td class="logs-logger" title="${logger}">${logger}</td>
      <td class="logs-message">${msg}</td>
    </tr>`;
  }).join('');
}

function renderPatterns() {
  const patternCounts = new Map();
  for (const log of logsData) {
    const pattern = cleanMessage(log.message)
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s,]*/g, '<ts>')
      .replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi, '<uuid>')
      .replace(/\b\d+\.\d+\b/g, '<float>')
      .replace(/\b\d+\b/g, '<int>');
    patternCounts.set(pattern, (patternCounts.get(pattern) || 0) + 1);
  }

  const sorted = [...patternCounts.entries()].sort((a, b) => b[1] - a[1]);
  const tbody = document.getElementById('patternsTableBody');
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="2" class="logs-empty">No logs in this window.</td></tr>`;
    return;
  }
  tbody.innerHTML = sorted.map(([pattern, count]) =>
    `<tr><td>${count.toLocaleString('en')}</td><td class="logs-message">${esc(pattern)}</td></tr>`
  ).join('');
}

async function loadIntervalStats() {
  const series = await fetchSeries(M.sensorInterval);
  const vals = series.points.map(p => p.value).filter(v => v != null);
  if (!vals.length) {
    ['min', 'avg', 'max'].forEach(k => {
      const el = document.getElementById(`stat-interval-${k}`);
      if (el) el.textContent = '—';
    });
    return;
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const avg = vals.reduce((a, v) => a + v, 0) / vals.length;
  const minEl = document.getElementById('stat-interval-min');
  const avgEl = document.getElementById('stat-interval-avg');
  const maxEl = document.getElementById('stat-interval-max');
  if (minEl) minEl.textContent = fmtMs(min);
  if (avgEl) avgEl.textContent = fmtMs(avg);
  if (maxEl) maxEl.textContent = fmtMs(max);
}

// ── Main refresh ───────────────────────────────────────────

async function loadAll() {
  const results = await Promise.allSettled([loadParity(), loadLatency(), loadDowntime(), loadDbWrites(), loadLogs(), loadIntervalStats()]);
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) {
    failed.forEach(r => console.error('[loadAll] section failed:', r.reason));
  }
  const lastUpdatedEl = document.getElementById('lastUpdated');
  const ts = new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  lastUpdatedEl.textContent = failed.length ? `${ts} — ${failed.length} section(s) failed` : ts;
  lastUpdatedEl.style.color = failed.length ? 'var(--danger, #ff453a)' : '';
}

// ── Event bindings ─────────────────────────────────────────

document.getElementById('refreshBtn').addEventListener('click', loadAll);
document.getElementById('windowAmount').addEventListener('change', loadAll);
document.getElementById('windowUnit').addEventListener('change', loadAll);
document.getElementById('rollupWindow').addEventListener('change', loadAll);

// Log filters re-render from cached data — no refetch needed
document.getElementById('logLevelFilter').addEventListener('change', renderLogTable);
document.getElementById('logLoggerFilter').addEventListener('input', renderLogTable);
document.getElementById('logContentFilter').addEventListener('input', renderLogTable);

// View toggle: Logs ↔ Patterns
document.getElementById('logsViewBtn').addEventListener('click', () => {
  document.getElementById('logsView').hidden = false;
  document.getElementById('patternsView').hidden = true;
  document.getElementById('logsViewBtn').classList.add('is-active');
  document.getElementById('patternsViewBtn').classList.remove('is-active');
});

document.getElementById('patternsViewBtn').addEventListener('click', () => {
  document.getElementById('logsView').hidden = true;
  document.getElementById('patternsView').hidden = false;
  document.getElementById('patternsViewBtn').classList.add('is-active');
  document.getElementById('logsViewBtn').classList.remove('is-active');
  renderPatterns();
});

loadAll();
setInterval(loadAll, REFRESH_MS);
