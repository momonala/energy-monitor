/**
 * Energy Monitor - Shared Utilities
 * Common code used by desktop, mobile, and compare interfaces.
 */

// =============================================================================
// Design tokens bridge (CSS custom properties → JS)
// =============================================================================

/** Read a CSS custom property from :root. */
function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Chart and UI colors sourced from tokens.css — single source of truth. */
function readChartTheme() {
  return {
    power: getCssVar("--series-power"),
    powerFill: getCssVar("--series-power-fill"),
    energy: getCssVar("--series-energy"),
    dailyEnergy: getCssVar("--series-daily"),
    typicalDaily: getCssVar("--series-typical"),
    rollingAvg: getCssVar("--series-rolling"),
    axis: getCssVar("--series-axis"),
    grid: getCssVar("--series-grid"),
    ticks: getCssVar("--series-ticks"),
    selectFill: getCssVar("--series-select-fill"),
    selectStroke: getCssVar("--series-select-stroke"),
    accent: getCssVar("--accent"),
    fontSans: getCssVar("--font-sans") || '"Inter", system-ui, sans-serif',
  };
}

const ChartColors = readChartTheme();

// =============================================================================
// Formatting Helpers
// =============================================================================
const DateTimeFmtOpts = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

const Fmt = {
  /**
   * Format a number with specified decimal places, or return "–" if invalid.
   */
  n: (v, digits = 2) =>
    v === null || v === undefined || Number.isNaN(v) ? "–" : Number(v).toFixed(digits),

  /**
   * Format a timestamp (ms) to a localized date-time string.
   */
  t: (ms) => {
    if (!ms) return "–";
    const d = new Date(ms);
    return d.toLocaleString(undefined, DateTimeFmtOpts);
  },
};

/**
 * Format a duration in milliseconds to a human-readable string (e.g., "2d 5h 30m").
 */
function formatDuration(ms) {
  if (ms <= 0 || !Number.isFinite(ms)) return "0s";
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  if (secs || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(" ");
}

// =============================================================================
// Fetch Utilities
// =============================================================================
const DEFAULT_FETCH_OPTS = { cache: "no-cache" };

/**
 * Fetch JSON from a URL. Throws on HTTP error or parse failure.
 * @param {string} url - URL to fetch
 * @param {RequestInit} options - Optional fetch options (merged with cache: "no-cache")
 * @returns {Promise<unknown>} - Parsed JSON body
 */
async function fetchJson(url, options = {}) {
  const opts = { ...DEFAULT_FETCH_OPTS, ...options };
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}: ${url}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") msg = body.error;
    } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

// =============================================================================
// Connection Status
// =============================================================================
/**
 * Update the connection status indicator element.
 * @param {HTMLElement} statusEl - The status element to update
 * @param {boolean} ok - Whether the connection is OK
 */
function setConnectionStatus(statusEl, ok) {
  if (!statusEl) return;
  const label = statusEl.querySelector(".header-status__label");
  if (label) {
    label.textContent = ok ? "Connected" : "Offline";
  } else {
    statusEl.textContent = ok ? "Connected" : "Offline";
  }
  statusEl.classList.remove("header-status--connected", "header-status--offline", "header-status--pending");
  statusEl.classList.add(ok ? "header-status--connected" : "header-status--offline");
}

// =============================================================================
// Daily Energy Calculations
// =============================================================================
/**
 * Build a date key string for grouping by day.
 */
function getDateKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Interpolate daily energy values to align with chart xVals timestamps.
 * @param {Array} dailyData - Array of {t, kwh} daily energy data
 * @param {Array} xVals - Array of timestamps (seconds since epoch)
 * @returns {Array} - Array of kWh values aligned with xVals
 */
function alignDailyDataToTimestamps(dailyData, xVals) {
  if (!dailyData.length || !xVals.length) {
    return new Array(xVals.length).fill(null);
  }

  // Build a map of date -> kWh
  const dailyMap = new Map();
  for (const d of dailyData) {
    const date = new Date(d.t);
    dailyMap.set(getDateKey(date), d.kwh);
  }

  // Map each xVal timestamp to its day's kWh value
  return xVals.map((secTs) => {
    const date = new Date(secTs * 1000);
    return dailyMap.get(getDateKey(date)) ?? null;
  });
}

// =============================================================================
// Cost Management
// =============================================================================
const DEFAULT_COST_PER_KWH = 0.3102;

/**
 * Load cost per kWh from localStorage.
 * @returns {number} - The cost per kWh
 */
function loadCostPerKwh() {
  const stored = localStorage.getItem("cost_per_kwh");
  if (stored != null) {
    const parsed = parseFloat(stored);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_COST_PER_KWH;
}

/**
 * Save cost per kWh to localStorage.
 * @param {number} cost - The cost to save
 */
function saveCostPerKwh(cost) {
  if (!Number.isNaN(cost) && cost >= 0) {
    localStorage.setItem("cost_per_kwh", String(cost));
  }
}

// =============================================================================
// Preset Periods (compare page and shared date logic)
// =============================================================================
/** Preset ids for getPresetPeriod. */
const PRESET_IDS = ["today", "this_week", "this_month", "last_week", "last_month"];

/**
 * Get start and end timestamps (ms) and label for a preset period.
 * Week starts Sunday to match main dashboard behaviour.
 * @param {string} presetId - One of: today, this_week, this_month, last_week, last_month
 * @returns {{ startMs: number, endMs: number, label: string }} - Bounds in ms and display label
 */
function getPresetPeriod(presetId) {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  let label = presetId;

  switch (presetId) {
    case "today": {
      start.setHours(0, 0, 0, 0);
      end.setTime(now.getTime());
      label = "Today";
      break;
    }
    case "this_week": {
      const day = now.getDay();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - day);
      end.setTime(now.getTime());
      label = "This week";
      break;
    }
    case "this_month": {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end.setTime(now.getTime());
      label = "This month";
      break;
    }
    case "last_week": {
      const day = now.getDay();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - day - 7);
      end.setTime(start.getTime());
      end.setDate(end.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      label = "Last week";
      break;
    }
    case "last_month": {
      start.setMonth(start.getMonth() - 1);
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end.setTime(start.getTime());
      end.setMonth(end.getMonth() + 1);
      end.setDate(0);
      end.setHours(23, 59, 59, 999);
      label = "Last month";
      break;
    }
    default:
      start.setHours(0, 0, 0, 0);
      end.setTime(now.getTime());
  }

  return {
    startMs: start.getTime(),
    endMs: end.getTime(),
    label,
  };
}

// =============================================================================
// Chart Series Configurations
// =============================================================================
/**
 * Get base chart series configurations (shared between desktop and mobile).
 */
function getBaseChartSeries() {
  return [
    {}, // x-axis placeholder
    {
      label: "Power",
      stroke: ChartColors.power,
      fill: ChartColors.powerFill,
      width: 1,
      scale: "y",
    },
    {
      label: "Daily Usage",
      stroke: ChartColors.dailyEnergy,
      width: 2,
      scale: "y3",
    },
    {
      label: "30d Avg",
      stroke: ChartColors.typicalDaily,
      width: 2,
      scale: "y3",
    },
    {
      label: "Energy",
      stroke: ChartColors.energy,
      width: 1,
      scale: "y2",
    },
  ];
}

/**
 * Get base chart axes configurations.
 * @param {Object} opts - Options for axis sizing
 */
function getBaseChartAxes(opts = {}) {
  const theme = readChartTheme();
  const { xSize = 56, ySize = 56, font = `11px ${theme.fontSans}`, hideYLabels = false } = opts;
  return [
    {
      stroke: theme.axis,
      grid: { stroke: theme.grid },
      ticks: { stroke: theme.ticks },
      size: xSize,
      font,
    },
    {
      label: "W",
      stroke: theme.axis,
      grid: { show: false },
      size: ySize,
      font,
      ...(hideYLabels ? { label: "", values: () => [] } : {}),
    },
    {
      side: 1,
      label: "kWh",
      stroke: theme.energy,
      grid: { show: false },
      scale: "y2",
      size: ySize,
      font,
      ...(hideYLabels ? { label: "", values: () => [] } : {}),
    },
    {
      side: 1,
      label: "Daily",
      stroke: theme.dailyEnergy,
      grid: { show: false },
      scale: "y3",
      size: ySize,
      font,
      ...(hideYLabels ? { label: "", values: () => [] } : {}),
    },
  ];
}

/**
 * Full desktop chart axes (labels + themed strokes).
 */
function getDesktopChartAxes() {
  const theme = readChartTheme();
  const font = `11px ${theme.fontSans}`;
  return [
    {
      stroke: theme.axis,
      grid: { stroke: theme.grid },
      ticks: { stroke: theme.ticks },
      size: 56,
      font,
    },
    {
      label: "Watts",
      stroke: theme.axis,
      grid: { show: false },
      size: 56,
      font,
    },
    {
      side: 1,
      label: "Total kWh",
      stroke: theme.energy,
      grid: { show: false },
      scale: "y2",
      size: 56,
      font,
    },
    {
      side: 1,
      label: "Daily kWh",
      stroke: theme.dailyEnergy,
      grid: { show: false },
      scale: "y3",
      size: 56,
      font,
    },
  ];
}

/**
 * Desktop chart series definitions aligned with tokens.
 */
function getDesktopChartSeries() {
  const theme = readChartTheme();
  return [
    {},
    {
      label: "Live Power",
      stroke: theme.power,
      fill: theme.powerFill,
      width: 1.5,
      scale: "y",
    },
    {
      label: "Daily Usage",
      stroke: theme.dailyEnergy,
      width: 2,
      scale: "y3",
    },
    {
      label: "Avg Power",
      stroke: theme.rollingAvg,
      width: 1.5,
      scale: "y",
    },
    {
      label: "Meter Reading",
      stroke: theme.energy,
      width: 1.5,
      scale: "y2",
    },
    {
      label: "30d Avg Daily Usage",
      stroke: theme.typicalDaily,
      width: 2,
      scale: "y3",
    },
  ];
}

/** Compact chart axes for compare page side-by-side charts. */
function getCompareChartAxes() {
  const theme = readChartTheme();
  const font = `11px ${theme.fontSans}`;
  return [
    {
      stroke: theme.axis,
      grid: { stroke: theme.grid },
      ticks: { stroke: theme.ticks },
      size: 40,
      font,
    },
    { label: "W", stroke: theme.axis, grid: { show: false }, size: 40, font },
    { side: 1, label: "kWh", stroke: theme.energy, grid: { show: false }, scale: "y2", size: 40, font },
    { side: 1, label: "Daily", stroke: theme.dailyEnergy, grid: { show: false }, scale: "y3", size: 40, font },
  ];
}

/** Short-label series for compare charts. */
function getCompareChartSeries() {
  const theme = readChartTheme();
  return [
    {},
    { label: "Power", stroke: theme.power, fill: theme.powerFill, width: 1.5, scale: "y" },
    { label: "Daily", stroke: theme.dailyEnergy, width: 2, scale: "y3" },
    { label: "Avg P", stroke: theme.rollingAvg, width: 1.5, scale: "y" },
    { label: "Meter", stroke: theme.energy, width: 1.5, scale: "y2" },
    { label: "30d", stroke: theme.typicalDaily, width: 2, scale: "y3" },
  ];
}
/** uPlot select overlay styling from tokens. */
function getChartSelectOptions() {
  const theme = readChartTheme();
  return {
    show: true,
    over: true,
    x: true,
    y: false,
    fill: theme.selectFill,
    stroke: theme.selectStroke,
  };
}

// =============================================================================
// Reading Processing
// =============================================================================
/**
 * Filter and process raw readings into chart-ready arrays.
 * @param {Array} rows - Array of {t, p, e} readings
 * @returns {Object} - {xVals, yVals, eVals}
 */
function processReadingsData(rows) {
  const xVals = [];
  const yVals = [];
  const eVals = [];

  for (const r of rows) {
    if (r.p != null && Number.isFinite(r.p) && r.e != null && Number.isFinite(r.e) && r.e > 0) {
      xVals.push(Math.floor(r.t / 1000));
      yVals.push(r.p);
      eVals.push(r.e);
    }
  }

  return { xVals, yVals, eVals };
}

// Export to window for use by other scripts
window.EnergyMonitor = {
  ChartColors,
  readChartTheme,
  getCssVar,
  Fmt,
  formatDuration,
  fetchJson,
  setConnectionStatus,
  alignDailyDataToTimestamps,
  loadCostPerKwh,
  saveCostPerKwh,
  getPresetPeriod,
  PRESET_IDS,
  getBaseChartSeries,
  getBaseChartAxes,
  getDesktopChartAxes,
  getDesktopChartSeries,
  getCompareChartAxes,
  getCompareChartSeries,
  getChartSelectOptions,
  processReadingsData,
  DEFAULT_COST_PER_KWH,
};
