(() => {
  const {
    Fmt,
    formatDuration,
    fetchJson,
    setConnectionStatus,
    startLivePower,
    alignDailyDataToTimestamps,
    loadCostPerKwh,
    saveCostPerKwh,
    getDesktopChartAxes,
    getDesktopChartSeries,
    getChartSelectOptions,
    processReadingsData,
  } = window.EnergyMonitor;

  const chartEl = document.getElementById("chart");
  const chartLoading = document.getElementById("chart-loading");
  const statusConn = document.getElementById("status-connection");
  const livePowerEl = document.getElementById("live-power");
  const statEnergy = document.getElementById("stat-energy");
  const statAvg = document.getElementById("stat-avg");
  const statMax = document.getElementById("stat-max");
  const statMin = document.getElementById("stat-min");
  const statCount = document.getElementById("stat-count");
  const statRange = document.getElementById("stat-range");
  const btnReset = document.getElementById("btn-reset");
  const timeRangeSelect = document.getElementById("time-range-select");
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
  const hoverRollingAvg = document.getElementById("hover-rolling-avg");
  const hoverDailyEnergy = document.getElementById("hover-daily-energy");
  const hoverTypicalDailyEnergy = document.getElementById("hover-typical-daily-energy");
  const hoverTypicalLabel = document.getElementById("hover-typical-label");
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

  let u = null;
  let xVals = [];
  let yVals = [];
  let eVals = [];
  let rollingAvgVals = []; // Rolling 2-day average of power
  let dailyEnergyData = []; // Daily energy consumption data {t, kwh, is_partial}
  let dailyEnergyVals = []; // Interpolated daily energy values aligned with xVals
  let movingAvgDailyData = []; // 30-day moving average daily usage {t, kwh}
  let typicalDailyEnergyVals = []; // 30-day moving average values aligned with xVals
  let costPerKwh = window.EnergyMonitor.DEFAULT_COST_PER_KWH;
  let avgDailyEnergyUsage = null; // kWh per day from historical data
  let powerScaleMode = 'auto'; // 'auto' or 'fixed' - controls power Y-axis scaling
  let avgMode = '30d'; // '30d' for moving average or 'total' for flat line
  // Track series visibility: series index -> visible (true) or hidden (false)
  const seriesVisibility = {
    1: true, // Live Power
    2: true, // Daily Usage
    3: true, // Avg Power
    4: true, // Meter Reading
    5: true, // Typical Daily Usage
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
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const DEFAULT_CHART_LOOKBACK_MS = 7 * DAY_MS;
  const EMA_ALPHA = 0.0001;      // ≈ 2-day smoothing at 10s sample rate

  let lastDataTimestamp = null;
  let pollController = null;
  let chartLookbackMs = DEFAULT_CHART_LOOKBACK_MS;

  function getChartWindowEndMs() {
    return Date.now();
  }

  function getChartWindowStartMs() {
    return getChartWindowEndMs() - chartLookbackMs;
  }

  function trimToChartWindow() {
    if (!xVals.length) return;
    const minSec = Math.floor(getChartWindowStartMs() / 1000);
    let trimIndex = 0;
    while (trimIndex < xVals.length && xVals[trimIndex] < minSec) {
      trimIndex++;
    }
    if (trimIndex > 0) {
      xVals = xVals.slice(trimIndex);
      yVals = yVals.slice(trimIndex);
      eVals = eVals.slice(trimIndex);
    }
  }

  async function loadChartWindow() {
    const endMs = getChartWindowEndMs();
    const startMs = getChartWindowStartMs();
    await Promise.all([
      fetchReadings({ start: startMs, end: endMs }),
      fetchEnergySummary({ start: startMs, end: endMs }),
    ]);
  }

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

  /**
   * The header token reports data freshness, and the live-power poller owns that — it runs
   * every few seconds against the same backend. A chart fetch only speaks up when it fails.
   */
  function reportChartFetchFailed() {
    setConnectionStatus(statusConn, false, "offline");
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

  // Series order expected by uPlot: x, power, daily, avgPower, meterReading, typicalDaily
  function chartData() {
    return [xVals, yVals, dailyEnergyVals, rollingAvgVals, eVals, typicalDailyEnergyVals];
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
          auto: powerScaleMode === "auto",
          range: powerScaleMode === "fixed" ? [0, 2000] : undefined,
        },
        y2: { auto: true },
        y3: { auto: true },
      },
      axes: getDesktopChartAxes(),
      series: getDesktopChartSeries(),
      legend: { show: false, live: false },
      select: getChartSelectOptions(),
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
    u = new uPlot(opts, chartData(), chartEl);

    applySeriesVisibility();

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

  function applySeriesVisibility() {
    if (!u || !u.series) return;
    Object.keys(seriesVisibility).forEach(seriesIdx => {
      const idx = parseInt(seriesIdx);
      if (u.series[idx]) {
        u.setSeries(idx, { show: seriesVisibility[idx] });
      }
    });
  }

  function renderSelection() {
    if (selection.start && selection.end) {
      statRange.textContent = formatDuration(selection.end - selection.start);
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

    if (u) {
      u.setData(chartData());
      u.setScale("x", { min: startMs / 1000, max: endMs / 1000 });
    }
    renderSelection();
    updateSelectionStats(startMs, endMs);
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
  }

  /**
   * Exponential moving average of power; EMA_ALPHA approximates a 2-day window at
   * the 10s sample rate. Gaps hold the last EMA value so the line stays continuous.
   */
  function calculateRollingAvg() {
    if (xVals.length === 0 || yVals.length === 0) {
      rollingAvgVals = [];
      return;
    }
    rollingAvgVals = new Array(xVals.length).fill(null);
    let ema = null;
    for (let i = 0; i < xVals.length; i++) {
      if (yVals[i] != null && Number.isFinite(yVals[i])) {
        ema = ema === null ? yVals[i] : EMA_ALPHA * yVals[i] + (1 - EMA_ALPHA) * ema;
        rollingAvgVals[i] = ema;
      } else if (ema !== null) {
        rollingAvgVals[i] = ema;
      }
    }
  }

  function calculateDailyEnergyVals() {
    dailyEnergyVals = alignDailyDataToTimestamps(dailyEnergyData, xVals);
  }

  /**
   * Typical daily energy aligned with xVals: the 30-day moving average per day,
   * or a flat all-time average line, depending on avgMode.
   */
  function calculateTypicalDailyEnergyVals() {
    if (avgMode === '30d') {
      typicalDailyEnergyVals = alignDailyDataToTimestamps(movingAvgDailyData, xVals);
    } else if (avgDailyEnergyUsage) {
      typicalDailyEnergyVals = new Array(xVals.length).fill(avgDailyEnergyUsage);
    } else {
      typicalDailyEnergyVals = new Array(xVals.length).fill(null);
    }
  }

  /**
   * Fetch energy summary (avg daily + daily usage + 30d moving avg).
   */
  async function fetchEnergySummary({ start = null, end = null } = {}) {
    try {
      const qs = new URLSearchParams();
      if (start != null) qs.set("start", String(start));
      if (end != null) qs.set("end", String(end));
      const suffix = qs.toString();
      const data = await fetchJson(suffix ? `/api/energy_summary?${suffix}` : "/api/energy_summary");
      avgDailyEnergyUsage = data.avg_daily ?? null;
      dailyEnergyData = data.daily;
      movingAvgDailyData = data.moving_avg_30d || [];
      console.log(`Loaded energy summary: avg=${avgDailyEnergyUsage} kWh/day, ${dailyEnergyData.length} days, ${movingAvgDailyData.length} moving avg points`);
    } catch (e) {
      console.error("Failed to fetch energy summary:", e);
      avgDailyEnergyUsage = null;
      dailyEnergyData = [];
      movingAvgDailyData = [];
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

    calculateRollingAvg();
    calculateDailyEnergyVals();
    calculateTypicalDailyEnergyVals();
    u.setData(chartData());

    if (curMin !== null && curMax !== null && curMax > curMin && xVals.length > 0) {
      const latestDataSec = xVals[xVals.length - 1];
      const oldLatestSec = curMax;
      // A right edge near the latest data means the user is watching "live":
      // slide the window forward to include new points, keeping its width.
      const isWatchingLive = (oldLatestSec >= latestDataSec - LIVE_THRESHOLD_SEC);

      if (isWatchingLive && latestDataSec > oldLatestSec) {
        const windowWidth = curMax - curMin;
        u.setScale("x", { min: latestDataSec - windowWidth, max: latestDataSec });
        if (selection.end && Math.abs(selection.end / 1000 - oldLatestSec) < LIVE_THRESHOLD_SEC) {
          selection.end = latestDataSec * 1000;
        }
      } else {
        u.setScale("x", { min: curMin, max: curMax });
      }
    }

    if (selection.start && selection.end) {
      updateSelectionStats(selection.start, selection.end);
    }
  }

  async function fetchReadings({ start = null, end = null, incremental = false, signal = null } = {}) {
    const qs = new URLSearchParams();

    // Incremental updates only fetch data newer than what we already have
    if (incremental && lastDataTimestamp) {
      qs.set("start", String(lastDataTimestamp + 1));
    } else if (start) {
      qs.set("start", String(start));
    }
    if (end) qs.set("end", String(end));

    try {
      const fetchOpts = signal ? { signal } : {};
      const rows = await fetchJson(`/api/readings?${qs.toString()}`, fetchOpts);
      if (!rows.length) return;

      const { xVals: newXVals, yVals: newYVals, eVals: newEVals } = processReadingsData(rows);

      if (incremental && xVals.length > 0) {
        // Append only points newer than what we already have
        const lastExistingTime = xVals[xVals.length - 1];
        let appendIndex = newXVals.length;
        for (let i = 0; i < newXVals.length; i++) {
          if (newXVals[i] > lastExistingTime) {
            appendIndex = i;
            break;
          }
        }
        if (appendIndex < newXVals.length) {
          xVals = xVals.concat(newXVals.slice(appendIndex));
          yVals = yVals.concat(newYVals.slice(appendIndex));
          eVals = eVals.concat(newEVals.slice(appendIndex));
          trimToChartWindow();
        }
      } else {
        xVals = newXVals;
        yVals = newYVals;
        eVals = newEVals;
      }

      if (xVals.length > 0) {
        lastDataTimestamp = xVals[xVals.length - 1] * 1000;
      }

      updateChart();

      // Initial load calls updatePeriodSummaries once from the init block instead
      if (incremental) {
        updatePeriodSummaries();
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      console.error(e);
      reportChartFetchFailed();
    }
  }

  let selectionStatsController = null;

  /** Selection stats come from /api/stats so they match the server's raw-row numbers
   * (the chart only holds 2-min max-bucketed data). */
  async function updateSelectionStats(startMs, endMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;
    renderTypicalForRange(startMs, endMs);
    if (selectionStatsController) selectionStatsController.abort();
    selectionStatsController = new AbortController();
    try {
      const stats = await fetchStats(startMs, endMs, selectionStatsController.signal);
      const energyUsed = stats.energy_used_kwh;
      statEnergy.textContent = Fmt.n(energyUsed, 2);
      if (statCostRange) statCostRange.textContent = Fmt.n(energyUsed != null ? energyUsed * costPerKwh : null, 2);
      statAvg.textContent = Fmt.n(stats.avg_power_watts, 1);
      statMax.textContent = Fmt.n(stats.max_power_watts, 0);
      statMin.textContent = Fmt.n(stats.min_power_watts, 0);
      statCount.textContent = stats.count != null ? String(stats.count) : "–";
    } catch (e) {
      if (e.name === "AbortError") return;
      console.error("[selectionStats] fetch failed:", e);
    }
  }

  function renderTypicalForRange(startMs, endMs) {
    if (statAvgEnergy && avgDailyEnergyUsage) {
      const avgEnergy = avgDailyEnergyUsage * ((endMs - startMs) / DAY_MS);
      statAvgEnergy.textContent = Fmt.n(avgEnergy, 2);
      if (statAvgCost) statAvgCost.textContent = Fmt.n(avgEnergy * costPerKwh, 2);
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
      if (hoverRollingAvg) hoverRollingAvg.textContent = "";
      if (hoverDailyEnergy) hoverDailyEnergy.textContent = "";
      if (hoverTypicalDailyEnergy) hoverTypicalDailyEnergy.textContent = "";
      return;
    }

    const tMs = xVals[idx] * 1000;
    hoverTime.textContent = Fmt.t(tMs);
    hoverTotalEnergy.textContent = Fmt.n(eVals[idx], 2);
    hoverPower.textContent = Fmt.n(yVals[idx], 0);

    if (hoverDailyEnergy) {
      const dailyKwh = dailyEnergyVals[idx];
      hoverDailyEnergy.textContent = dailyKwh != null ? Fmt.n(dailyKwh, 2) : "–";
    }

    if (hoverRollingAvg) {
      hoverRollingAvg.textContent = Fmt.n(rollingAvgVals[idx], 0);
    }

    if (hoverTypicalDailyEnergy) {
      const typicalDailyKwh = typicalDailyEnergyVals[idx];
      hoverTypicalDailyEnergy.textContent = typicalDailyKwh != null ? Fmt.n(typicalDailyKwh, 2) : "–";
    }
  }

  function selectRelativeRange(durationMs) {
    if (!xVals.length) return;
    const endMs = xVals[xVals.length - 1] * 1000;
    const startMs = Math.max(xVals[0] * 1000, endMs - durationMs);
    applySelectionRange(startMs, endMs);
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
    if (!evt || !u || !xVals.length) return;
    
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
    
    // Clear active range since user made a custom selection
    setTimeRange(null);
    
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

  function setTimeRange(value) {
    if (timeRangeSelect) timeRangeSelect.value = value || '';
  }

  btnReset.addEventListener("click", () => {
    if (u && xVals.length) {
      u.setScale("x", { min: xVals[0], max: xVals[xVals.length - 1] });
      u.setData(chartData());
    }
    setTimeRange(null);
    clearSelection();
  });
  
  const btnToggleScale = document.getElementById("btn-toggle-scale");
  if (btnToggleScale) {
    btnToggleScale.addEventListener("click", () => {
      powerScaleMode = powerScaleMode === 'auto' ? 'fixed' : 'auto';
      btnToggleScale.textContent = powerScaleMode === 'auto' ? 'Auto' : 'Fixed';

      // The Y scale is fixed in the uPlot options, so recreate the chart
      if (u) {
        u.destroy();
        u = null;
      }
      initChart();
      if (u && xVals.length > 0) {
        u.setData(chartData());
        if (selection.start && selection.end) {
          u.setScale("x", { min: selection.start / 1000, max: selection.end / 1000 });
        }
      }
    });
  }

  const btnToggleAvgMode = document.getElementById("btn-toggle-avg-mode");
  if (btnToggleAvgMode) {
    btnToggleAvgMode.addEventListener("click", () => {
      avgMode = avgMode === '30d' ? 'total' : '30d';
      btnToggleAvgMode.textContent = avgMode === '30d' ? '30d' : 'Total';
      if (hoverTypicalLabel) {
        hoverTypicalLabel.textContent = avgMode === '30d' ? '30d Avg Daily Usage (kWh):' : 'Total Avg Daily Usage (kWh):';
      }
      if (u && u.series && u.series[5]) {
        u.series[5].label = avgMode === '30d' ? "30d Avg Daily Usage" : "Total Avg Daily Usage";
      }
      calculateTypicalDailyEnergyVals();
      if (u && xVals.length > 0) {
        u.setData(chartData());
        if (selection.start && selection.end) {
          u.setScale("x", { min: selection.start / 1000, max: selection.end / 1000 });
        }
      }
    });
  }

  function setupTraceToggle(btn, seriesIdx) {
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (!u) return;
      const newVisibility = seriesVisibility[seriesIdx] === false;
      seriesVisibility[seriesIdx] = newVisibility;
      if (u.series && u.series[seriesIdx]) {
        u.setSeries(seriesIdx, { show: newVisibility });
      }
      btn.classList.toggle("inactive", !newVisibility);
      btn.setAttribute("aria-pressed", String(newVisibility));
    });
  }

  setupTraceToggle(btnTogglePower, 1);
  setupTraceToggle(btnToggleDaily, 2);
  setupTraceToggle(btnToggleAvgPower, 3);
  setupTraceToggle(btnToggleMeter, 4);
  setupTraceToggle(btnToggleTypical, 5);
  if (btnRefresh) {
    btnRefresh.addEventListener("click", async () => {
      if (btnRefresh.disabled) return;
      const originalLabel = btnRefresh.textContent;
      btnRefresh.disabled = true;
      btnRefresh.textContent = "Refreshing...";
      btnRefresh.classList.add("btn-loading");
      try {
        await loadChartWindow();
      } finally {
        btnRefresh.disabled = false;
        btnRefresh.textContent = originalLabel;
        btnRefresh.classList.remove("btn-loading");
      }
    });
  }
  // Ranges within the loaded window just re-select; longer ones refetch with a wider lookback.
  const RELATIVE_RANGES_MS = { hour: HOUR_MS, day: DAY_MS };
  const LOOKBACK_RANGES_MS = { week: 7 * DAY_MS, month: 30 * DAY_MS, year: 365 * DAY_MS };

  if (timeRangeSelect) {
    timeRangeSelect.addEventListener("change", async () => {
      const value = timeRangeSelect.value;
      if (RELATIVE_RANGES_MS[value]) {
        selectRelativeRange(RELATIVE_RANGES_MS[value]);
      } else if (LOOKBACK_RANGES_MS[value]) {
        chartLookbackMs = LOOKBACK_RANGES_MS[value];
        showLoading();
        try {
          await loadChartWindow();
          applySelectionRange(getChartWindowStartMs(), Date.now(), false);
        } finally {
          hideLoading();
        }
      }
    });
  }

  async function poll() {
    if (pollController) pollController.abort();
    pollController = new AbortController();
    await fetchReadings({ incremental: true, signal: pollController.signal });
    setTimeout(poll, POLLING_MS);
  }

  window.addEventListener("pagehide", () => {
    if (pollController) pollController.abort();
  });

  window.addEventListener("resize", () => {
    if (u) {
      const { width, height } = getChartSize();
      u.setSize({ width, height });
    }
  });

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------
  showLoading();
  initChart();
  startLivePower(livePowerEl, { statusEl: statusConn });

  // Load chart data and summary in parallel for faster initial render
  // Use allSettled to ensure updatePeriodSummaries runs even if one fetch fails
  const initialEndMs = getChartWindowEndMs();
  const initialStartMs = getChartWindowStartMs();
  Promise.allSettled([
    fetchReadings({ start: initialStartMs, end: initialEndMs }),
    fetchEnergySummary({ start: initialStartMs, end: initialEndMs }),
  ])
    .then(([readingsResult, summaryResult]) => {
      if (readingsResult.status === "rejected") {
        console.error("fetchReadings failed:", readingsResult.reason);
      }
      if (summaryResult.status === "rejected") {
        console.error("fetchEnergySummary failed:", summaryResult.reason);
      }

      hideLoading();
      initCostInput();

      if (xVals.length > 0) {
        applySelectionRange(initialStartMs, initialEndMs, false);
      }

      // Still populates the "Real" stats even if fetchEnergySummary failed
      updatePeriodSummaries();
      poll();
    });

  function initCostInput() {
    costPerKwh = loadCostPerKwh();
    const input = document.getElementById("cost-input");
    if (!input) return;
    input.value = String(costPerKwh);
    input.addEventListener("change", () => {
      const value = parseFloat(input.value);
      if (!Number.isNaN(value) && value >= 0) {
        costPerKwh = value;
        saveCostPerKwh(value);
        updatePeriodSummaries();
      }
    });
  }

  async function updatePeriodSummaries() {
    const nowMs = Date.now();
    const last30DaysMs = nowMs - 30 * DAY_MS;
    const last7DaysMs = nowMs - 7 * DAY_MS;
    const last1DayMs = nowMs - DAY_MS;

    // Use allSettled to log individual failures and still populate successful stats
    const results = await Promise.allSettled([
      fetchStats(last30DaysMs, nowMs),
      fetchStats(last7DaysMs, nowMs),
      fetchStats(last1DayMs, nowMs),
      fetchJson("/api/latest_reading"),
    ]);

    const [monthResult, weekResult, dayResult, latestResult] = results;
    const apiNames = ["30-day stats", "7-day stats", "1-day stats", "latest reading"];

    results.forEach((result, idx) => {
      if (result.status === "rejected") {
        console.error(`[updatePeriodSummaries] ${apiNames[idx]} failed:`, result.reason);
      }
    });

    const monthStats = monthResult.status === "fulfilled" ? monthResult.value : null;
    const weekStats = weekResult.status === "fulfilled" ? weekResult.value : null;
    const dayStats = dayResult.status === "fulfilled" ? dayResult.value : null;
    const latestReading = latestResult.status === "fulfilled" ? latestResult.value : null;

    // Populate "Real" values from successful API calls
    if (monthStats) {
      if (statMonthEnergy) statMonthEnergy.textContent = Fmt.n(monthStats.energy_used_kwh, 2);
      if (statMonthCost) statMonthCost.textContent = Fmt.n((monthStats.energy_used_kwh || 0) * costPerKwh, 2);
    }
    if (weekStats) {
      if (statWeekEnergy) statWeekEnergy.textContent = Fmt.n(weekStats.energy_used_kwh, 2);
      if (statWeekCost) statWeekCost.textContent = Fmt.n((weekStats.energy_used_kwh || 0) * costPerKwh, 2);
    }
    if (dayStats) {
      if (statDayEnergy) statDayEnergy.textContent = Fmt.n(dayStats.energy_used_kwh, 2);
      if (statDayCost) statDayCost.textContent = Fmt.n((dayStats.energy_used_kwh || 0) * costPerKwh, 2);
    }
    if (latestReading) {
      if (statCurrentConsumption) statCurrentConsumption.textContent = Fmt.n(latestReading.energy_in_kwh, 2);
      if (statTotalCost) statTotalCost.textContent = Fmt.n((latestReading.energy_in_kwh || 0) * costPerKwh, 2);
    }

    // Populate "Typical" values (depends on avgDailyEnergyUsage from fetchEnergySummary)
    if (avgDailyEnergyUsage) {
      const avg30Days = avgDailyEnergyUsage * 30;
      const avg7Days = avgDailyEnergyUsage * 7;
      const avg1Day = avgDailyEnergyUsage;

      if (statMonthAvgEnergy) statMonthAvgEnergy.textContent = Fmt.n(avg30Days, 2);
      if (statMonthAvgCost) statMonthAvgCost.textContent = Fmt.n(avg30Days * costPerKwh, 2);
      if (statWeekAvgEnergy) statWeekAvgEnergy.textContent = Fmt.n(avg7Days, 2);
      if (statWeekAvgCost) statWeekAvgCost.textContent = Fmt.n(avg7Days * costPerKwh, 2);
      if (statDayAvgEnergy) statDayAvgEnergy.textContent = Fmt.n(avg1Day, 2);
      if (statDayAvgCost) statDayAvgCost.textContent = Fmt.n(avg1Day * costPerKwh, 2);
    } else {
      if (statMonthAvgEnergy) statMonthAvgEnergy.textContent = "–";
      if (statMonthAvgCost) statMonthAvgCost.textContent = "–";
      if (statWeekAvgEnergy) statWeekAvgEnergy.textContent = "–";
      if (statWeekAvgCost) statWeekAvgCost.textContent = "–";
      if (statDayAvgEnergy) statDayAvgEnergy.textContent = "–";
      if (statDayAvgCost) statDayAvgCost.textContent = "–";
    }
  }

  async function fetchStats(startMs, endMs, signal = null) {
    const qs = new URLSearchParams({ start: String(startMs), end: String(endMs) });
    const body = await fetchJson(`/api/stats?${qs.toString()}`, signal ? { signal } : {});
    return body.stats || {};
  }

})();
