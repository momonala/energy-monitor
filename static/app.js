(() => {
  const chartEl = document.getElementById("chart");
  const chartLoading = document.getElementById("chart-loading");
  const statusConn = document.getElementById("status-connection");
  const statusPts = document.getElementById("status-points");
  const statusLast = document.getElementById("status-last");
  const statEnergy = document.getElementById("stat-energy");
  const statAvg = document.getElementById("stat-avg");
  const statMax = document.getElementById("stat-max");
  const statMin = document.getElementById("stat-min");
  const statCount = document.getElementById("stat-count");
  const statRange = document.getElementById("stat-range");
  const btnReset = document.getElementById("btn-reset");
  const btnLastYear = document.getElementById("btn-last-year");
  const btnLastMonth = document.getElementById("btn-last-month");
  const btnLastWeek = document.getElementById("btn-last-week");
  const btnLastHour = document.getElementById("btn-last-hour");
  const btnLastDay = document.getElementById("btn-last-day");
  const btnRefresh = document.getElementById("btn-refresh");
  // Trace toggle buttons
  const btnTogglePower = document.getElementById("btn-toggle-power");
  const btnToggleDaily = document.getElementById("btn-toggle-daily");
  const btnToggleTypical = document.getElementById("btn-toggle-typical");
  const btnToggleAvgPower = document.getElementById("btn-toggle-avg-power");
  const btnToggleMeter = document.getElementById("btn-toggle-meter");
  // Hover overlay elements
  const hoverTime = document.getElementById("hover-time");
  const hoverTotalEnergy = document.getElementById("hover-total-energy");
  const hoverPower = document.getElementById("hover-power");
  const hoverAvgTrend = document.getElementById("hover-avg-trend");
  const hoverRollingAvg = document.getElementById("hover-rolling-avg");
  const hoverDailyEnergy = document.getElementById("hover-daily-energy");
  const hoverTypicalDailyEnergy = document.getElementById("hover-typical-daily-energy");
  // Secondary summary elements
  const statCurrentConsumption = document.getElementById("stat-current-consumption");
  const statCostRange = document.getElementById("stat-cost-range");
  const statTotalCost = document.getElementById("stat-total-cost");
  const statMonthEnergy = document.getElementById("stat-month-energy");
  const statMonthCost = document.getElementById("stat-month-cost");
  const statWeekEnergy = document.getElementById("stat-week-energy");
  const statWeekCost = document.getElementById("stat-week-cost");
  const statDayEnergy = document.getElementById("stat-day-energy");
  const statDayCost = document.getElementById("stat-day-cost");
  const statAvgEnergy = document.getElementById("stat-avg-energy");
  const statAvgCost = document.getElementById("stat-avg-cost");
  const statMonthAvgEnergy = document.getElementById("stat-month-avg-energy");
  const statMonthAvgCost = document.getElementById("stat-month-avg-cost");
  const statWeekAvgEnergy = document.getElementById("stat-week-avg-energy");
  const statWeekAvgCost = document.getElementById("stat-week-avg-cost");
  const statDayAvgEnergy = document.getElementById("stat-day-avg-energy");
  const statDayAvgCost = document.getElementById("stat-day-avg-cost");

  // All stat elements for skeleton loading
  const statElements = [
    statEnergy, statAvg, statMax, statMin, statCount, statRange, statCostRange,
    statCurrentConsumption, statTotalCost, statMonthEnergy, statMonthCost,
    statWeekEnergy, statWeekCost, statDayEnergy, statDayCost, statAvgEnergy, statAvgCost,
    statMonthAvgEnergy, statMonthAvgCost, statWeekAvgEnergy, statWeekAvgCost,
    statDayAvgEnergy, statDayAvgCost
  ].filter(Boolean);
  const statusLive = document.getElementById("status-live");

  let u = null;
  let xVals = [];
  let yVals = [];
  let eVals = [];
  let avgVals = []; // Historical average trendline values
  let rollingAvgVals = []; // Rolling 2-day average of power
  let dailyEnergyData = []; // Daily energy consumption data {t, kwh, is_partial}
  let dailyEnergyVals = []; // Interpolated daily energy values aligned with xVals
  let typicalDailyEnergyVals = []; // Typical daily energy values based on avgDailyEnergyUsage
  let costPerKwh = 0.3102;
  let avgDailyEnergyUsage = null; // kWh per day from historical data
  let powerScaleMode = 'auto'; // 'auto' or 'fixed' - controls power Y-axis scaling
  // Track series visibility: series index -> visible (true) or hidden (false)
  const seriesVisibility = {
    1: true, // Live Power
    2: true, // Daily Usage
    3: true, // Typical Usage
    4: true, // Avg Power
    5: true, // Meter Reading
    6: true, // Typical Daily Usage
  };

  let selection = { start: null, end: null };
  const pointerSelect = {
    active: false,
    pointerId: null,
    startPx: null,
    startMs: null,
  };
  const POLLING_MS = 10000;
  const MIN_DRAG_PX = 10;
  const LIVE_THRESHOLD_SEC = 120;

  let lastDataTimestamp = null;
  let isLiveView = true;

  // --------------------------------------------------------------------------
  // Loading State Helpers
  // --------------------------------------------------------------------------
  function showLoading() {
    if (chartLoading) chartLoading.classList.remove("hidden");
    statElements.forEach(el => el.classList.add("skeleton"));
  }

  function hideLoading() {
    if (chartLoading) chartLoading.classList.add("hidden");
    statElements.forEach(el => el.classList.remove("skeleton"));
  }

  // --------------------------------------------------------------------------
  // Formatting Helpers
  // --------------------------------------------------------------------------
  const dateTimeFmtOpts = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  };

  const fmt = {
    n: (v, digits = 2) =>
      v === null || v === undefined || Number.isNaN(v) ? "–" : Number(v).toFixed(digits),
    t: (ms) => {
      if (!ms) return "–";
      const d = new Date(ms);
      return d.toLocaleString(undefined, dateTimeFmtOpts);
    },
  };

  function setConnection(ok) {
    statusConn.textContent = ok ? "Connected" : "Offline";
    statusConn.style.borderColor = ok ? "rgba(34,197,94,0.6)" : "rgba(239,68,68,0.6)";
    statusConn.style.color = ok ? "#00c83f" : "#7f1d1d";
  }

  /**
   * Flash the connection indicator to show new data arrived
   */
  function flashLiveIndicator() {
    if (!statusConn) return;
    statusConn.classList.add("live");
    setTimeout(() => statusConn.classList.remove("live"), 1000);
  }

  /**
   * Update the live view indicator based on whether the chart's right edge
   * is near the latest data point (within 2 minutes)
   */
  function updateLiveIndicator() {
    if (!statusLive || !u || !xVals.length) return;
    const curX = u.scales && u.scales.x ? u.scales.x : null;
    const curMax = curX && Number.isFinite(curX.max) ? curX.max : null;
    const latestDataSec = xVals[xVals.length - 1];
    
    // Consider "live" if view's right edge is within threshold of latest data
    isLiveView = curMax !== null && (curMax >= latestDataSec - LIVE_THRESHOLD_SEC);
    
    if (isLiveView) {
      statusLive.classList.remove("hidden");
    } else {
      statusLive.classList.add("hidden");
    }
  }

  /**
   * Get chart dimensions from its container
   */
  function getChartSize() {
    const wrapper = chartEl.parentElement;
    return {
      width: wrapper?.clientWidth || chartEl.clientWidth || 800,
      height: wrapper?.clientHeight || 400,
    };
  }

  function initChart() {
    if (!window.uPlot) {
      console.warn("uPlot not loaded; chart disabled. Fetching will still run.");
      return;
    }
    const { width, height } = getChartSize();
    const opts = {
      width,
      height,
      scales: {
        x: { time: true },
        y: { 
          auto: powerScaleMode === 'auto',
          range: powerScaleMode === 'fixed' ? [0, 2000] : undefined
        },     // power (W)
        y2: { auto: true },    // cumulative energy (kWh)
        y3: { auto: true },    // daily energy (kWh)
      },
      axes: [
        {
          stroke: "#a3a3a3",
          grid: { stroke: "rgba(255,255,255,0.06)" },
          ticks: { stroke: "rgba(255,255,255,0.12)" },
          size: 56,
        },
        {
          label: "Watts",
          stroke: "#a3a3a3",
          grid: { show: false },
          size: 56,
        },
        {
          side: 1,
          label: "Total kWh",
          stroke: "rgb(235, 133, 37)",
          grid: { show: false },
          scale: "y2",
          size: 56,
        },
        {
          side: 1,
          label: "Daily kWh",
          stroke: "rgb(255, 220, 50)",
          grid: { show: false },
          scale: "y3",
          size: 56,
        }
      ],
      series: [
        {},
        {
          label: "Live Power",
          stroke: "rgba(37, 99, 235, 1)",
          fill: "rgba(37,99,235,0.12)",
          width: 1.5,
          scale: "y",
        },
        {
          label: "Daily Usage",
          stroke: "rgb(255, 220, 50)",
          width: 2,
          scale: "y3",
        },
        {
          label: "Typical Usage",
          stroke: "rgba(168, 85, 247, 0.5)",
          width: 2,
          scale: "y2",
        },
        {
          label: "Avg Power",
          stroke: "rgb(96, 165, 250)",
          width: 1.5,
          scale: "y",
        },
        {
          label: "Meter Reading",
          stroke: "rgb(235, 133, 37)",
          width: 1.5,
          scale: "y2",
        },
        {
          label: "Typical Daily Usage",
          stroke: "rgba(168, 85, 247, 0.5)",
          width: 2,
          scale: "y3",
        },
      ],
      legend: { show: false, live: false },
      select: {
        show: true,
        over: true,
        x: true,
        y: false,
        fill: "rgba(96,165,250,0.15)",
        stroke: "#60a5fa",
      },
      hooks: {
        setSelect: [
          (uInst) => {
            const s = uInst.select;
            if (s.width > 0) {
              const x0Sec = uInst.posToVal(s.left, "x");
              const x1Sec = uInst.posToVal(s.left + s.width, "x");
              if (isFinite(x0Sec) && isFinite(x1Sec) && x1Sec > x0Sec) {
                const startMs = Math.floor(x0Sec * 1000);
                const endMs = Math.floor(x1Sec * 1000);
                applySelectionRange(startMs, endMs);
              }
              // clear selection rectangle
              uInst.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            }
          },
        ],
        setCursor: [
          (uInst) => {
            const idx = uInst.cursor && Number.isInteger(uInst.cursor.idx) ? uInst.cursor.idx : null;
            updateHover(idx);
          },
        ],
      },
    };
    // Data order: x, power, daily, avgEnergy, avgPower, meterReading, typicalDaily
    u = new uPlot(opts, [xVals, yVals, dailyEnergyVals, avgVals, rollingAvgVals, eVals, typicalDailyEnergyVals], chartEl);
    
    // Set initial series visibility based on tracked state
    if (u && u.series) {
      Object.keys(seriesVisibility).forEach(seriesIdx => {
        const idx = parseInt(seriesIdx);
        if (u.series[idx]) {
          u.setSeries(idx, { show: seriesVisibility[idx] });
        }
      });
    }
    
    if (u && u.over) {
      const over = u.over;
      over.addEventListener("pointerdown", handlePointerSelectStart);
      over.addEventListener("pointermove", handlePointerSelectMove);
      over.addEventListener("pointerup", handlePointerSelectEnd);
      over.addEventListener("pointercancel", cancelPointerSelection);
      over.addEventListener("lostpointercapture", cancelPointerSelection);
    }

    // Double-click resets zoom to full range
    chartEl.addEventListener("dblclick", () => {
      if (xVals.length) {
        u.setScale("x", { min: xVals[0], max: xVals[xVals.length - 1] });
        clearSelection();
      }
    });
    
    // Prevent iOS Safari from scrolling page during chart interaction
    chartEl.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        e.preventDefault();
      }
    }, { passive: false });
  }

  function renderSelection() {
    if (selection.start && selection.end) {
      const delta = selection.end - selection.start;
      const line3 = `${formatDuration(delta)}`;
      statRange.innerHTML = `${line3}`;

    } else {
      statRange.textContent = "";
    }
  }

  function applySelectionRange(startMs, endMs, clampToData = true) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    if (clampToData && xVals.length) {
      const minMs = xVals[0] * 1000;
      const maxMs = xVals[xVals.length - 1] * 1000;
      startMs = Math.max(minMs, Math.min(startMs, maxMs));
      endMs = Math.max(minMs, Math.min(endMs, maxMs));
      if (endMs <= startMs) endMs = Math.min(maxMs, startMs + 1);
    }
    if (endMs <= startMs) return;
    selection = { start: startMs, end: endMs };
    clearPointerSelectionOverlay();
    
    // Recalculate the average trendline to start from the selection's start point
    calculateAvgTrendline(startMs, endMs);
    
    if (u) {
      // Update chart data with new trendline
      u.setData([xVals, yVals, dailyEnergyVals, avgVals, rollingAvgVals, eVals, typicalDailyEnergyVals]);
      // Set scale AFTER setData to preserve the zoom
      u.setScale("x", { min: startMs / 1000, max: endMs / 1000 });
    }
    updateLiveIndicator(); // Update immediately when view changes
    renderSelection();
    computeStatsLocal(startMs, endMs);
    updateLiveIndicator();
  }

  function clearSelection() {
    selection = { start: null, end: null };
    if (statEnergy) statEnergy.textContent = "–";
    if (statCostRange) statCostRange.textContent = "–";
    if (statAvg) statAvg.textContent = "–";
    if (statMax) statMax.textContent = "–";
    if (statMin) statMin.textContent = "–";
    if (statCount) statCount.textContent = "–";
    renderSelection();
    clearPointerSelectionOverlay();
    updateLiveIndicator();
  }

  /**
   * Calculate Exponential Moving Average (EMA) of power values.
   * EMA gives more weight to recent values while smoothing out noise.
   * The smoothing factor is chosen to approximate a 2-day response time.
   */
  function calculateRollingAvg() {
    if (xVals.length === 0 || yVals.length === 0) {
      rollingAvgVals = [];
      return;
    }
    
    // Smoothing factor: lower = smoother (more history), higher = more responsive
    // alpha ≈ 2/(N+1) where N is the equivalent window size
    // With 10-second sampling: 2 days = 17,280 points
    // For 2-day equivalent: alpha ≈ 2/(17280+1) ≈ 0.000116
    // Using 0.0001 for clean 2-day smoothing
    const alpha = 0.0001;
    
    rollingAvgVals = new Array(xVals.length).fill(null);
    
    // Initialize with first valid value
    let ema = null;
    for (let i = 0; i < xVals.length; i++) {
      if (yVals[i] != null && Number.isFinite(yVals[i])) {
        if (ema === null) {
          // Initialize EMA with first valid value
          ema = yVals[i];
        } else {
          // EMA formula: EMA_t = alpha * value_t + (1 - alpha) * EMA_{t-1}
          ema = alpha * yVals[i] + (1 - alpha) * ema;
        }
        rollingAvgVals[i] = ema;
      } else if (ema !== null) {
        // If current value is null but we have an EMA, keep the last EMA
        rollingAvgVals[i] = ema;
      }
    }
  }

  /**
   * Calculate the historical average trendline based on avgDailyEnergyUsage.
   * The trendline starts at the same point as the energy data and follows the average slope.
   * If a selection range is provided, the trendline starts from the first point in that range.
   */
  function calculateAvgTrendline(selectionStartMs = null, selectionEndMs = null) {
    if (!avgDailyEnergyUsage || xVals.length === 0 || eVals.length === 0) {
      avgVals = [];
      return;
    }
    
    // Determine the range to use for the trendline
    let rangeStartIdx = 0;
    let rangeEndIdx = xVals.length - 1;
    
    if (selectionStartMs !== null && selectionEndMs !== null) {
      const startSec = Math.floor(selectionStartMs / 1000);
      const endSec = Math.floor(selectionEndMs / 1000);
      
      // Find the first index within the selection
      while (rangeStartIdx < xVals.length && xVals[rangeStartIdx] < startSec) {
        rangeStartIdx++;
      }
      
      // Find the last index within the selection
      while (rangeEndIdx >= 0 && xVals[rangeEndIdx] > endSec) {
        rangeEndIdx--;
      }
    }
    
    // Find the first valid energy reading in the range to use as starting point
    let startEnergy = null;
    let startIdx = rangeStartIdx;
    for (let i = rangeStartIdx; i <= rangeEndIdx && i < eVals.length; i++) {
      if (eVals[i] != null && Number.isFinite(eVals[i])) {
        startEnergy = eVals[i];
        startIdx = i;
        break;
      }
    }
    
    if (startEnergy === null) {
      avgVals = [];
      return;
    }
    
    // Create trendline - fill all points to draw a continuous line
    // The line is mathematically just two points (start and end), but we need
    // to fill intermediate values for uPlot to render it
    const startTimeSec = xVals[startIdx];
    avgVals = new Array(xVals.length).fill(null);
    
    for (let i = startIdx; i < xVals.length; i++) {
      const durationDays = (xVals[i] - startTimeSec) / 86400; // seconds to days
      avgVals[i] = startEnergy + (avgDailyEnergyUsage * durationDays);
    }
  }

  /**
   * Interpolate daily energy consumption values to align with xVals timestamps.
   * Each point gets the daily kWh value for its corresponding day.
   */
  function calculateDailyEnergyVals() {
    if (!dailyEnergyData.length || !xVals.length) {
      dailyEnergyVals = new Array(xVals.length).fill(null);
      return;
    }

    // Build a map of date -> daily kWh
    const dailyMap = new Map();
    for (const d of dailyEnergyData) {
      const date = new Date(d.t);
      const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      dailyMap.set(dateKey, d.kwh);
    }

    // Map each xVal timestamp to its day's kWh value
    dailyEnergyVals = xVals.map(secTs => {
      const date = new Date(secTs * 1000);
      const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      return dailyMap.get(dateKey) ?? null;
    });
  }

  /**
   * Calculate typical daily energy values based on avgDailyEnergyUsage.
   * Each point gets the typical daily kWh value (avgDailyEnergyUsage).
   */
  function calculateTypicalDailyEnergyVals() {
    if (!avgDailyEnergyUsage || !xVals.length) {
      typicalDailyEnergyVals = new Array(xVals.length).fill(null);
      return;
    }

    // Each point gets the same typical daily value
    typicalDailyEnergyVals = new Array(xVals.length).fill(avgDailyEnergyUsage);
  }

  /**
   * Fetch energy summary (avg daily + daily usage) once at startup.
   */
  async function fetchEnergySummary() {
    try {
      const res = await fetch("/api/energy_summary", { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      avgDailyEnergyUsage = data.avg_daily;
      dailyEnergyData = data.daily;
      console.log(`Loaded energy summary: avg=${avgDailyEnergyUsage} kWh/day, ${dailyEnergyData.length} days`);
    } catch (e) {
      console.error("Failed to fetch energy summary:", e);
      avgDailyEnergyUsage = null;
      dailyEnergyData = [];
    }
  }

  function updateChart() {
    if (!u) {
      initChart();
      if (!u) return;
    }
    
    // Preserve current x-scale window across refresh
    const curX = u.scales && u.scales.x ? u.scales.x : null;
    const curMin = curX && Number.isFinite(curX.min) ? curX.min : null;
    const curMax = curX && Number.isFinite(curX.max) ? curX.max : null;
    
    // Calculate rolling average
    calculateRollingAvg();
    
    // Calculate average trendline based on current selection if available
    if (selection.start && selection.end) {
      calculateAvgTrendline(selection.start, selection.end);
    } else {
      calculateAvgTrendline();
    }
    
    // Calculate daily energy values aligned with chart timestamps
    calculateDailyEnergyVals();
    
    // Calculate typical daily energy values
    calculateTypicalDailyEnergyVals();
    
    u.setData([xVals, yVals, dailyEnergyVals, avgVals, rollingAvgVals, eVals, typicalDailyEnergyVals]);
    
    if (curMin !== null && curMax !== null && curMax > curMin && xVals.length > 0) {
      const latestDataSec = xVals[xVals.length - 1];
      const oldLatestSec = curMax;
      
      // If the view's right edge was near the latest data (within threshold),
      // auto-expand to include new data - user is likely watching "live"
      const isWatchingLive = (oldLatestSec >= latestDataSec - LIVE_THRESHOLD_SEC);
      
      if (isWatchingLive && latestDataSec > oldLatestSec) {
        // Expand view to include new data, keeping the same time window width
        const windowWidth = curMax - curMin;
        const newMax = latestDataSec;
        const newMin = newMax - windowWidth;
        u.setScale("x", { min: newMin, max: newMax });
        
        // Also update selection end if it was at the edge
        if (selection.end && Math.abs(selection.end / 1000 - oldLatestSec) < LIVE_THRESHOLD_SEC) {
          selection.end = latestDataSec * 1000;
        }
      } else {
        // Keep the exact same view
        u.setScale("x", { min: curMin, max: curMax });
      }
    }
    
    if (statusPts) statusPts.textContent = `${xVals.length} data points`;
    // header extras
    const lastIdx = xVals.length - 1;
    if (statusLast && lastIdx >= 0) {
      statusLast.textContent = `Last updated: ${fmt.t(xVals[lastIdx] * 1000)}`;
    }
    if (selection.start && selection.end) {
      computeStatsLocal(selection.start, selection.end);
    }
    
    // Update live view indicator
    updateLiveIndicator();
  }

  async function fetchReadings({ start = null, end = null, incremental = false } = {}) {
    const qs = new URLSearchParams();
    
    // For incremental updates, only fetch data newer than what we have
    if (incremental && lastDataTimestamp) {
      qs.set("start", String(lastDataTimestamp + 1));
    } else if (start) {
      qs.set("start", String(start));
    }
    if (end) qs.set("end", String(end));
    
    try {
      const res = await fetch(`/api/readings?${qs.toString()}`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      
      // No new data
      if (!rows.length) {
        setConnection(true);
        return;
      }
      
      // Map primary series from power if present
      let mapped = rows.map((r) => [r.t, r.p]);
      
      // If all power values are null/undefined, derive power from cumulative energy deltas
      if (mapped.length && mapped.every((pt) => pt[1] === null || pt[1] === undefined)) {
        const derived = [];
        for (let i = 1; i < rows.length; i++) {
          const a = rows[i - 1];
          const b = rows[i];
          if (a && b && a.e != null && b.e != null &&
              typeof a.t === "number" && typeof b.t === "number" && b.t > a.t) {
            const dE_kWh = b.e - a.e;
            const dt_ms = b.t - a.t;
            if (dt_ms > 0) {
              const watts = Math.max(0, (dE_kWh * 3600000000) / dt_ms);
              derived.push([b.t, watts]);
            }
          }
        }
        if (derived.length) {
          mapped = derived;
        }
      }
      
      // Filter out invalid power and energy values
      const newXVals = [];
      const newYVals = [];
      const newEVals = [];
      
      for (let i = 0; i < mapped.length; i++) {
        const energyVal = rows[i].e;
        if (mapped[i][1] != null && Number.isFinite(mapped[i][1]) && 
            energyVal != null && Number.isFinite(energyVal) && energyVal > 0) {
          newXVals.push(Math.floor(mapped[i][0] / 1000));
          newYVals.push(mapped[i][1]);
          newEVals.push(energyVal);
        }
      }
      
      if (incremental && xVals.length > 0) {
        // Append only new data points (avoid duplicates)
        const lastExistingTime = xVals[xVals.length - 1];
        let appendIndex = 0;
        for (let i = 0; i < newXVals.length; i++) {
          if (newXVals[i] > lastExistingTime) {
            appendIndex = i;
            break;
          }
          appendIndex = newXVals.length; // No new points
        }
        
        if (appendIndex < newXVals.length) {
          // Append new data
          xVals = xVals.concat(newXVals.slice(appendIndex));
          yVals = yVals.concat(newYVals.slice(appendIndex));
          eVals = eVals.concat(newEVals.slice(appendIndex));
          
          // Flash the connection indicator to show new data arrived
          flashLiveIndicator();
        }
      } else {
        // Full replacement (initial load or explicit refresh)
        // No downsampling - use all data points
        xVals = newXVals;
        yVals = newYVals;
        eVals = newEVals;
      }
      
      // Update last timestamp
      if (xVals.length > 0) {
        lastDataTimestamp = xVals[xVals.length - 1] * 1000;
      }
      
      updateChart();
      setConnection(true);
      // ensure monthly/weekly/daily summaries refresh
      updatePeriodSummaries();
    } catch (e) {
      console.error(e);
      setConnection(false);
    }
  }

  function computeStatsLocal(startMs, endMs) {
    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);
    if (!xVals.length || endSec <= startSec) return;
    // Find index bounds
    let i0 = 0;
    while (i0 < xVals.length && xVals[i0] < startSec) i0++;
    let i1 = xVals.length - 1;
    while (i1 >= 0 && xVals[i1] > endSec) i1--;
    if (i1 < i0) return;
    const ySlice = yVals.slice(i0, i1 + 1).filter((v) => Number.isFinite(v));
    const count = ySlice.length;
    const minP = count ? Math.min(...ySlice) : null;
    const maxP = count ? Math.max(...ySlice) : null;
    const avgP = count ? ySlice.reduce((a, b) => a + b, 0) / count : null;
    // Energy used from eVals if available
    let energyUsed = null;
    let eStart = null;
    let eEnd = null;
    for (let i = i0; i <= i1; i++) {
      if (eVals[i] != null && Number.isFinite(eVals[i])) {
        eStart = eVals[i];
        break;
      }
    }
    for (let i = i1; i >= i0; i--) {
      if (eVals[i] != null && Number.isFinite(eVals[i])) {
        eEnd = eVals[i];
        break;
      }
    }
    if (eStart != null && eEnd != null) {
      energyUsed = eEnd - eStart;
    } else {
      // Fallback: integrate power to energy (kWh) with trapezoidal rule
      let sumWs = 0;
      for (let i = i0 + 1; i <= i1; i++) {
        const dtSec = xVals[i] - xVals[i - 1];
        if (dtSec > 0 && Number.isFinite(yVals[i]) && Number.isFinite(yVals[i - 1])) {
          const wAvg = (yVals[i] + yVals[i - 1]) / 2; // W
          sumWs += wAvg * dtSec; // W*s
        }
      }
      energyUsed = sumWs / 3600000; // Ws -> kWh
    }
    statEnergy.textContent = fmt.n(energyUsed, 2);
    if (statCostRange) {
      const cost = energyUsed != null ? energyUsed * costPerKwh : null;
      statCostRange.textContent = fmt.n(cost, 2);
    }
    statAvg.textContent = fmt.n(avgP, 1);
    statMax.textContent = fmt.n(maxP, 0);
    statMin.textContent = fmt.n(minP, 0);
    statCount.textContent = String(count);
    
    // Calculate average energy consumption based on historical average
    if (statAvgEnergy && avgDailyEnergyUsage) {
      const durationDays = (endSec - startSec) / 86400;
      const avgEnergy = avgDailyEnergyUsage * durationDays;
      statAvgEnergy.textContent = fmt.n(avgEnergy, 2);
      if (statAvgCost) {
        const avgCost = avgEnergy * costPerKwh;
        statAvgCost.textContent = fmt.n(avgCost, 2);
      }
    } else {
      if (statAvgEnergy) statAvgEnergy.textContent = "–";
      if (statAvgCost) statAvgCost.textContent = "–";
    }
  }

  function updateHover(idx) {
    if (!xVals.length || idx == null || idx < 0 || idx >= xVals.length) {
      hoverTime.textContent = "";
      hoverTotalEnergy.textContent = "";
      hoverPower.textContent = "";
      if (hoverAvgTrend) hoverAvgTrend.textContent = "";
      if (hoverRollingAvg) hoverRollingAvg.textContent = "";
      if (hoverDailyEnergy) hoverDailyEnergy.textContent = "";
      if (hoverTypicalDailyEnergy) hoverTypicalDailyEnergy.textContent = "";
      return;
    }

    const tMs = xVals[idx] * 1000;
    hoverTime.textContent = fmt.t(tMs);
    hoverTotalEnergy.textContent = fmt.n(eVals[idx], 2);
    hoverPower.textContent = fmt.n(yVals[idx], 0);

    if (hoverDailyEnergy) {
      const dailyKwh = dailyEnergyVals[idx];
      hoverDailyEnergy.textContent = dailyKwh != null ? fmt.n(dailyKwh, 2) : "–";
    }

    if (hoverAvgTrend) {
      if (avgDailyEnergyUsage && eVals.length > 0) {
        let startEnergy = null;
        let startTimeSec = null;
        for (let i = 0; i < eVals.length; i++) {
          if (eVals[i] != null && Number.isFinite(eVals[i])) {
            startEnergy = eVals[i];
            startTimeSec = xVals[i];
            break;
          }
        }
        if (startEnergy !== null && startTimeSec !== null) {
          const durationDays = (xVals[idx] - startTimeSec) / 86400;
          const interpolatedAvg = startEnergy + (avgDailyEnergyUsage * durationDays);
          hoverAvgTrend.textContent = fmt.n(interpolatedAvg, 2);
        } else {
          hoverAvgTrend.textContent = "–";
        }
      } else {
        hoverAvgTrend.textContent = "–";
      }
    }

    if (hoverRollingAvg) {
      hoverRollingAvg.textContent = fmt.n(rollingAvgVals[idx], 0);
    }

    if (hoverTypicalDailyEnergy) {
      const typicalDailyKwh = typicalDailyEnergyVals[idx];
      hoverTypicalDailyEnergy.textContent = typicalDailyKwh != null ? fmt.n(typicalDailyKwh, 2) : "–";
    }
  }

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
  function selectRelativeRange(durationMs) {
    if (!xVals.length) return;
    const endMs = xVals[xVals.length - 1] * 1000;
    const startMs = Math.max(xVals[0] * 1000, endMs - durationMs);
    applySelectionRange(startMs, endMs);
  }

  function selectCalendarRange(startMs, endMs) {
    if (!xVals.length) return;
    applySelectionRange(startMs, endMs);
  }

  /**
   * Check if we should handle this pointer event for selection.
   * We handle all pointer types (mouse, touch, pen) for consistent cross-device behavior.
   */
  function shouldHandlePointer(evt) {
    if (!evt) return false;
    // Handle all pointer types for consistent iPad/desktop behavior
    return evt.pointerType === "touch" || evt.pointerType === "pen" || evt.pointerType === "mouse";
  }

  function getRelativeXPx(evt) {
    if (!u || !u.over) return null;
    const rect = u.over.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    const x = evt.clientX - rect.left;
    if (!Number.isFinite(x)) return null;
    return Math.max(0, Math.min(rect.width, x));
  }

  function pxToMs(px) {
    if (!u || px == null) return null;
    const xValSec = u.posToVal(px, "x");
    return Number.isFinite(xValSec) ? Math.floor(xValSec * 1000) : null;
  }

  function findNearestIndex(targetSec) {
    if (!xVals.length || !Number.isFinite(targetSec)) return null;
    let lo = 0;
    let hi = xVals.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const midVal = xVals[mid];
      if (midVal === targetSec) return mid;
      if (midVal < targetSec) lo = mid + 1;
      else hi = mid - 1;
    }
    if (lo >= xVals.length) return xVals.length - 1;
    if (hi < 0) return 0;
    return targetSec - xVals[hi] <= xVals[lo] - targetSec ? hi : lo;
  }

  function updateHoverAtPx(px) {
    if (!u || !xVals.length || px == null) return;
    const xValSec = u.posToVal(px, "x");
    const idx = findNearestIndex(xValSec);
    if (idx != null) {
      updateHover(idx);
    }
  }

  function renderPointerSelection(currentPx) {
    if (!pointerSelect.active || pointerSelect.startPx == null || currentPx == null || !u || !u.over) return;
    const left = Math.min(pointerSelect.startPx, currentPx);
    const width = Math.abs(pointerSelect.startPx - currentPx);
    const height = u.over.clientHeight || chartEl.clientHeight || 0;
    u.setSelect({ left, width, top: 0, height }, false);
  }

  function clearPointerSelectionOverlay() {
    if (!u) return;
    u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
  }

  function resetPointerSelectionState() {
    if (pointerSelect.pointerId != null && u && u.over && u.over.releasePointerCapture) {
      try {
        u.over.releasePointerCapture(pointerSelect.pointerId);
      } catch (_) {
        // ignore
      }
    }
    pointerSelect.active = false;
    pointerSelect.pointerId = null;
    pointerSelect.startPx = null;
    pointerSelect.startMs = null;
    clearPointerSelectionOverlay();
  }

  function handlePointerSelectStart(evt) {
    if (!shouldHandlePointer(evt) || !u || !xVals.length) return;
    
    // For touch, we want to prevent scrolling and other default behaviors
    evt.preventDefault();
    
    const px = getRelativeXPx(evt);
    if (px == null) return;
    const startMs = pxToMs(px);
    if (!Number.isFinite(startMs)) return;
    
    pointerSelect.active = true;
    pointerSelect.pointerId = evt.pointerId;
    pointerSelect.startPx = px;
    pointerSelect.startMs = startMs;
    
    // Capture pointer to receive events even if finger moves outside element
    if (u.over.setPointerCapture) {
      try {
        u.over.setPointerCapture(evt.pointerId);
      } catch (_) {
        // ignore inability to capture
      }
    }
    updateHoverAtPx(px);
    renderPointerSelection(px);
  }

  function handlePointerSelectMove(evt) {
    if (!pointerSelect.active || evt.pointerId !== pointerSelect.pointerId) return;
    evt.preventDefault();
    
    const px = getRelativeXPx(evt);
    if (px == null) return;
    updateHoverAtPx(px);
    renderPointerSelection(px);
  }

  function finalizePointerSelection(px) {
    const startPx = pointerSelect.startPx;
    const startMs = pointerSelect.startMs;
    const endPx = px != null ? px : startPx;
    const endMs = pxToMs(endPx);
    resetPointerSelectionState();
    
    // Require minimum drag distance to prevent accidental tap-to-zoom on touch devices
    const dragDistance = Math.abs(endPx - startPx);
    if (dragDistance < MIN_DRAG_PX) {
      return; // Ignore taps and tiny drags
    }
    
    // Clear active button since user made a custom selection
    setActiveButton(null);
    
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    const from = Math.min(startMs, endMs);
    let to = Math.max(startMs, endMs);
    if (to === from) {
      to = from + 1;
    }
    applySelectionRange(from, to);
  }

  function handlePointerSelectEnd(evt) {
    if (!pointerSelect.active || evt.pointerId !== pointerSelect.pointerId) return;
    evt.preventDefault();
    
    const px = getRelativeXPx(evt);
    finalizePointerSelection(px);
  }

  function cancelPointerSelection(evt) {
    if (!pointerSelect.active) return;
    if (evt && pointerSelect.pointerId != null && evt.pointerId !== pointerSelect.pointerId) return;
    resetPointerSelectionState();
  }

  // Time range buttons for active state tracking
  const timeRangeButtons = [btnLastHour, btnLastDay, btnLastWeek, btnLastMonth, btnLastYear].filter(Boolean);

  /**
   * Set the active time range button and clear others
   */
  function setActiveButton(activeBtn) {
    timeRangeButtons.forEach(btn => btn.classList.remove("active"));
    if (activeBtn) activeBtn.classList.add("active");
  }

  btnReset.addEventListener("click", () => {
    if (u && xVals.length) {
      // Recalculate trendline for full range
      calculateAvgTrendline();
      u.setScale("x", { min: xVals[0], max: xVals[xVals.length - 1] });
      u.setData([xVals, yVals, dailyEnergyVals, avgVals, rollingAvgVals, eVals, typicalDailyEnergyVals]);
    }
    setActiveButton(null); // Clear active state on reset
    clearSelection();
  });
  
  const btnToggleScale = document.getElementById("btn-toggle-scale");
  if (btnToggleScale) {
    btnToggleScale.addEventListener("click", () => {
      // Toggle between auto and fixed scale
      powerScaleMode = powerScaleMode === 'auto' ? 'fixed' : 'auto';
      
      // Update button text
      btnToggleScale.textContent = powerScaleMode === 'auto' ? '📊 Auto Scale' : '📊 Fixed Scale';
      
      // Recreate chart with new scale mode
      if (u) {
        u.destroy();
        u = null;
      }
      initChart();
      if (u && xVals.length > 0) {
        u.setData([xVals, yVals, dailyEnergyVals, avgVals, rollingAvgVals, eVals, typicalDailyEnergyVals]);
        // Restore current view if there's a selection
        if (selection.start && selection.end) {
          u.setScale("x", { min: selection.start / 1000, max: selection.end / 1000 });
        }
        // Restore series visibility
        Object.keys(seriesVisibility).forEach(seriesIdx => {
          const idx = parseInt(seriesIdx);
          if (u && u.series && u.series[idx]) {
            u.setSeries(idx, { show: seriesVisibility[idx] });
          }
        });
      }
    });
  }

  // Trace toggle button handlers
  function setupTraceToggle(btn, seriesIdx, additionalSeriesIdx = null) {
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (!u) return;
      const isVisible = seriesVisibility[seriesIdx] !== false;
      const newVisibility = !isVisible;
      seriesVisibility[seriesIdx] = newVisibility;
      
      // Update uPlot series visibility
      if (u.series && u.series[seriesIdx]) {
        u.setSeries(seriesIdx, { show: newVisibility });
      }
      
      // If there's an additional series (e.g., typical daily), toggle it too
      if (additionalSeriesIdx !== null) {
        seriesVisibility[additionalSeriesIdx] = newVisibility;
        if (u.series && u.series[additionalSeriesIdx]) {
          u.setSeries(additionalSeriesIdx, { show: newVisibility });
        }
      }
      
      // Update button appearance
      if (newVisibility) {
        btn.classList.remove("hidden");
      } else {
        btn.classList.add("hidden");
      }
    });
  }

  setupTraceToggle(btnTogglePower, 1);
  setupTraceToggle(btnToggleDaily, 2);
  setupTraceToggle(btnToggleTypical, 3, 6); // Toggle both typical usage (3) and typical daily (6)
  setupTraceToggle(btnToggleAvgPower, 4);
  setupTraceToggle(btnToggleMeter, 5);
  if (btnRefresh) {
    btnRefresh.addEventListener("click", async () => {
      if (btnRefresh.disabled) return;
      const originalLabel = btnRefresh.textContent;
      btnRefresh.disabled = true;
      btnRefresh.textContent = "Refreshing...";
      btnRefresh.classList.add("btn-loading");
      try {
        // Clear Python cache first, then refresh data
        await fetch("/api/clear_cache", { cache: "no-cache" }).catch(() => {});
        await fetchReadings();
        await fetchEnergySummary();
      } finally {
        btnRefresh.disabled = false;
        btnRefresh.textContent = originalLabel;
        btnRefresh.classList.remove("btn-loading");
      }
    });
  }
  if (btnLastHour) btnLastHour.addEventListener("click", () => {
    setActiveButton(btnLastHour);
    selectRelativeRange(60 * 60 * 1000);
  });
  if (btnLastDay) btnLastDay.addEventListener("click", () => {
    setActiveButton(btnLastDay);
    selectRelativeRange(24 * 60 * 60 * 1000);
  });
  if (btnLastWeek) btnLastWeek.addEventListener("click", () => {
    setActiveButton(btnLastWeek);
    const now = new Date();
    const day = now.getDay(); // 0 Sunday .. 6 Saturday
    const start = new Date(now);
    start.setHours(0,0,0,0);
    start.setDate(start.getDate() - day); // week starting Sunday
    selectCalendarRange(start.getTime(), now.getTime());
  });
  if (btnLastMonth) btnLastMonth.addEventListener("click", () => {
    setActiveButton(btnLastMonth);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds(), 0);
    selectCalendarRange(start.getTime(), now.getTime());
  });
  if (btnLastYear) btnLastYear.addEventListener("click", () => {
    setActiveButton(btnLastYear);
    const now = new Date();
    const start = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds(), 0);
    selectCalendarRange(start.getTime(), now.getTime());
  });

  async function poll() {
    // Use incremental update for polling (only fetch new data)
    await fetchReadings({ incremental: true });
    setTimeout(poll, POLLING_MS);
  }

  window.addEventListener("resize", () => {
    if (u) {
      const { width, height } = getChartSize();
      u.setSize({ width, height });
    }
  });

  // --------------------------------------------------------------------------
  // Keyboard Shortcuts
  // --------------------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    // Ignore if user is typing in an input
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    // Don't override browser shortcuts (Cmd/Ctrl + key)
    if (e.metaKey || e.ctrlKey) return;
    
    switch (e.key.toLowerCase()) {
      case "r":
        e.preventDefault();
        btnRefresh?.click();
        break;
      case "escape":
        e.preventDefault();
        btnReset?.click();
        break;
      case "1":
        e.preventDefault();
        btnLastHour?.click();
        break;
      case "2":
        e.preventDefault();
        btnLastDay?.click();
        break;
      case "3":
        e.preventDefault();
        btnLastWeek?.click();
        break;
      case "4":
        e.preventDefault();
        btnLastMonth?.click();
        break;
      case "5":
        e.preventDefault();
        btnLastYear?.click();
        break;
    }
  });

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------
  showLoading();
  initChart();
  
  // Fetch energy summary once at startup, then fetch readings
  fetchEnergySummary()
    .then(() => fetchReadings())
    .then(() => {
      hideLoading();
      loadCostFromStorage();
      updatePeriodSummaries();
      
      // Auto-apply default selection (entire loaded dataset) on initial load
      if (xVals.length > 0) {
        const startMs = xVals[0] * 1000;
        const endMs = xVals[xVals.length - 1] * 1000;
        applySelectionRange(startMs, endMs, false); // false = don't clamp to data (we're using all of it)
      }
      
      poll();
    })
    .catch((e) => {
      console.error("Initial fetch failed:", e);
      hideLoading();
      setTimeout(poll, POLLING_MS);
    });

  function loadCostFromStorage() {
  const input = document.getElementById("cost-input");
  let v = localStorage.getItem("cost_per_kwh");
  if (v != null) {
    costPerKwh = parseFloat(v) || costPerKwh;
    if (input) input.value = String(costPerKwh);
  } else if (input) {
    costPerKwh = parseFloat(input.value) || costPerKwh;
  }
  if (input) {
    input.addEventListener("change", () => {
      const nv = parseFloat(input.value);
      if (!Number.isNaN(nv) && nv >= 0) {
        costPerKwh = nv;
        localStorage.setItem("cost_per_kwh", String(costPerKwh));
        updatePeriodSummaries();
      }
    });
  }
  }

  async function updatePeriodSummaries() {
    const now = new Date();
    const nowMs = now.getTime();
    const last30DaysMs = nowMs - (30 * 24 * 60 * 60 * 1000);
    const last7DaysMs = nowMs - (7 * 24 * 60 * 60 * 1000);
    const last1DayMs = nowMs - (24 * 60 * 60 * 1000);

    try {
      const [monthStats, weekStats, dayStats, latestReading] = await Promise.all([
        fetchStats(last30DaysMs, nowMs),
        fetchStats(last7DaysMs, nowMs),
        fetchStats(last1DayMs, nowMs),
        fetchLatestReading(),
      ]);

      if (statMonthEnergy) statMonthEnergy.textContent = fmt.n(monthStats.energy_used_kwh, 2);
      if (statMonthCost) statMonthCost.textContent = fmt.n((monthStats.energy_used_kwh || 0) * costPerKwh, 2);
      if (statWeekEnergy) statWeekEnergy.textContent = fmt.n(weekStats.energy_used_kwh, 2);
      if (statWeekCost) statWeekCost.textContent = fmt.n((weekStats.energy_used_kwh || 0) * costPerKwh, 2);
      if (statDayEnergy) statDayEnergy.textContent = fmt.n(dayStats.energy_used_kwh, 2);
      if (statDayCost) statDayCost.textContent = fmt.n((dayStats.energy_used_kwh || 0) * costPerKwh, 2);
      if (statCurrentConsumption) statCurrentConsumption.textContent = fmt.n(latestReading.energy_in_kwh, 2);
      if (statTotalCost) statTotalCost.textContent = fmt.n((latestReading.energy_in_kwh || 0) * costPerKwh, 2);

      if (avgDailyEnergyUsage) {
        const avg30Days = avgDailyEnergyUsage * 30;
        const avg7Days = avgDailyEnergyUsage * 7;
        const avg1Day = avgDailyEnergyUsage;

        if (statMonthAvgEnergy) statMonthAvgEnergy.textContent = fmt.n(avg30Days, 2);
        if (statMonthAvgCost) statMonthAvgCost.textContent = fmt.n(avg30Days * costPerKwh, 2);
        if (statWeekAvgEnergy) statWeekAvgEnergy.textContent = fmt.n(avg7Days, 2);
        if (statWeekAvgCost) statWeekAvgCost.textContent = fmt.n(avg7Days * costPerKwh, 2);
        if (statDayAvgEnergy) statDayAvgEnergy.textContent = fmt.n(avg1Day, 2);
        if (statDayAvgCost) statDayAvgCost.textContent = fmt.n(avg1Day * costPerKwh, 2);
      } else {
        if (statMonthAvgEnergy) statMonthAvgEnergy.textContent = "–";
        if (statMonthAvgCost) statMonthAvgCost.textContent = "–";
        if (statWeekAvgEnergy) statWeekAvgEnergy.textContent = "–";
        if (statWeekAvgCost) statWeekAvgCost.textContent = "–";
        if (statDayAvgEnergy) statDayAvgEnergy.textContent = "–";
        if (statDayAvgCost) statDayAvgCost.textContent = "–";
      }
    } catch (e) {
      console.error("Failed to update period summaries:", e);
    }
  }

  async function fetchLatestReading() {
    const res = await fetch("/api/latest_reading", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchStats(startMs, endMs) {
    const qs = new URLSearchParams({ start: String(startMs), end: String(endMs) });
    const res = await fetch(`/api/stats?${qs.toString()}`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return body.stats || {};
  }

})();
