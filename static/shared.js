/**
 * Energy Monitor - Shared Utilities
 * Common code used by both desktop (app.js) and mobile (mobile.js) interfaces.
 */

// =============================================================================
// Chart Colors (Design Tokens)
// =============================================================================
const ChartColors = {
  power: "rgba(37, 99, 235, 1)",
  powerFill: "rgba(37,99,235,0.12)",
  energy: "rgb(235, 133, 37)",
  dailyEnergy: "rgb(255, 220, 50)",
  typicalDaily: "rgba(168, 85, 247, 0.7)",
  rollingAvg: "rgb(96, 165, 250)",
  axis: "#a3a3a3",
  grid: "rgba(255,255,255,0.06)",
  ticks: "rgba(255,255,255,0.12)",
};

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
// Connection Status
// =============================================================================
/**
 * Update the connection status indicator element.
 * @param {HTMLElement} statusEl - The status element to update
 * @param {boolean} ok - Whether the connection is OK
 */
function setConnectionStatus(statusEl, ok) {
  if (!statusEl) return;
  statusEl.textContent = ok ? "Connected" : "Offline";
  statusEl.style.borderColor = ok ? "rgba(34,197,94,0.6)" : "rgba(239,68,68,0.6)";
  statusEl.style.color = ok ? "#00c83f" : "#7f1d1d";
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
 * @param {number} opts.xSize - X-axis size
 * @param {number} opts.ySize - Y-axis size
 * @param {string} opts.font - Font for axis labels
 */
function getBaseChartAxes(opts = {}) {
  const { xSize = 56, ySize = 56, font = "10px sans-serif" } = opts;
  return [
    {
      stroke: ChartColors.axis,
      grid: { stroke: ChartColors.grid },
      ticks: { stroke: ChartColors.ticks },
      size: xSize,
      font,
    },
    {
      label: "W",
      stroke: ChartColors.axis,
      grid: { show: false },
      size: ySize,
      font,
    },
    {
      side: 1,
      label: "kWh",
      stroke: ChartColors.energy,
      grid: { show: false },
      scale: "y2",
      size: ySize,
      font,
    },
    {
      side: 1,
      label: "Daily",
      stroke: ChartColors.dailyEnergy,
      grid: { show: false },
      scale: "y3",
      size: ySize,
      font,
    },
  ];
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
  Fmt,
  formatDuration,
  setConnectionStatus,
  alignDailyDataToTimestamps,
  loadCostPerKwh,
  saveCostPerKwh,
  getBaseChartSeries,
  getBaseChartAxes,
  processReadingsData,
  DEFAULT_COST_PER_KWH,
};
