/**
 * Mobile Energy Monitor - JavaScript
 * Simplified, non-interactive dashboard for mobile devices.
 * Uses shared utilities from shared.js
 */
(() => {
  const { Fmt, fetchJson, setConnectionStatus, startLivePower, describeDelta, renderDelta, getDateKey,
          alignDailyDataToTimestamps, loadCostPerKwh, getBaseChartAxes, processReadingsData,
          readChartTheme } = window.EnergyMonitor;

  const chartEl = document.getElementById("chart");
  const chartLoading = document.getElementById("chart-loading");
  const statusConn = document.getElementById("status-connection");
  const daysInput = document.getElementById("days-input");
  const statRangeLabel = document.getElementById("stat-range-label");
  const statEnergy = document.getElementById("stat-energy");
  const statCost = document.getElementById("stat-cost");
  const statEnergyDelta = document.getElementById("stat-energy-delta");
  const statTypicalEnergy = document.getElementById("stat-typical-energy");
  const statTypicalCost = document.getElementById("stat-typical-cost");
  const dailyTableBody = document.getElementById("daily-table-body");
  const dailyBaselineKwh = document.getElementById("daily-baseline-kwh");
  const dailyBaselineCost = document.getElementById("daily-baseline-cost");
  const statMeterTotal = document.getElementById("stat-meter-total");
  const livePowerEl = document.getElementById("live-power");
  const liveMetaEl = document.getElementById("live-meta");
  const btnShowChart = document.getElementById("btn-show-chart");
  const chartContent = document.querySelector(".js-chart-content");

  // State
  let u = null; // uPlot instance
  let xVals = [];
  let yVals = [];
  let eVals = [];
  let dailyEnergyVals = [];
  let typicalDailyVals = [];
  let dailyEnergyData = [];
  let movingAvgData = [];
  let avgDailyEnergyUsage = null;
  let costPerKwh = loadCostPerKwh();
  let chartLoaded = false;
  let chartAbortController = null;
  let lastStats = null;
  let lastStartMs = null;
  let lastEndMs = null;

  // Series visibility: index -> visible
  const seriesVisibility = {
    1: true, // Power
    2: true, // Energy/Meter
    3: true, // Daily Usage
    4: true, // 30d Avg
  };

  // --------------------------------------------------------------------------
  // Chart Initialization (Non-Interactive)
  // --------------------------------------------------------------------------
  function getChartSize() {
    const wrapper = chartEl?.parentElement;
    return {
      width: wrapper?.clientWidth || chartEl?.clientWidth || 320,
      height: 220,
    };
  }

  function initChart() {
    if (!window.uPlot || !chartEl) {
      console.warn("uPlot not loaded; chart disabled.");
      return;
    }

    if (u) {
      u.destroy();
      u = null;
    }

    const { width, height } = getChartSize();
    const theme = readChartTheme();
    const axes = getBaseChartAxes({ xSize: 40, ySize: 40, font: `10px ${theme.fontSans}`, hideYLabels: true });
    
    const opts = {
      width,
      height,
      scales: {
        x: { time: true },
        y: { auto: true },
        y2: { auto: true },
        y3: { auto: true },
      },
      axes,
      series: [
        {},
        {
          label: "Power",
          stroke: theme.power,
          fill: theme.powerFill,
          width: 1,
          scale: "y",
          show: seriesVisibility[1],
        },
        {
          label: "Energy",
          stroke: theme.energy,
          width: 1,
          scale: "y2",
          show: seriesVisibility[2],
        },
        {
          label: "Daily Usage",
          stroke: theme.dailyEnergy,
          width: 2,
          scale: "y3",
          show: seriesVisibility[3],
        },
        {
          label: "30d Avg",
          stroke: theme.typicalDaily,
          width: 2,
          scale: "y3",
          show: seriesVisibility[4],
        },
      ],
      legend: { show: false },
      cursor: { show: false },
      select: { show: false },
    };

    u = new uPlot(opts, [xVals, yVals, eVals, dailyEnergyVals, typicalDailyVals], chartEl);
    applySeriesVisibility();
  }

  function updateChart() {
    if (!u) {
      initChart();
    }
    if (u) {
      u.setData([xVals, yVals, eVals, dailyEnergyVals, typicalDailyVals]);
      applySeriesVisibility();
    }
  }

  /**
   * Apply current series visibility to the chart.
   */
  function applySeriesVisibility() {
    if (!u || !u.series) return;
    Object.keys(seriesVisibility).forEach(idx => {
      const seriesIdx = parseInt(idx);
      if (u.series[seriesIdx]) {
        u.setSeries(seriesIdx, { show: seriesVisibility[seriesIdx] });
      }
    });
  }

  /**
   * Toggle a series visibility and update the chart.
   */
  function toggleSeries(seriesIdx, button) {
    const isVisible = !seriesVisibility[seriesIdx];
    seriesVisibility[seriesIdx] = isVisible;
    button.classList.toggle("active", isVisible);
    button.setAttribute("aria-pressed", String(isVisible));
    if (u && u.series && u.series[seriesIdx]) {
      u.setSeries(seriesIdx, { show: isVisible });
    }
  }

  /**
   * Set up toggle button event listeners.
   */
  function setupToggleButtons() {
    const toggleButtons = document.querySelectorAll(".mobile-toggle");
    toggleButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        const seriesIdx = parseInt(btn.dataset.series);
        if (!Number.isNaN(seriesIdx)) {
          toggleSeries(seriesIdx, btn);
        }
      });
    });
  }

  // --------------------------------------------------------------------------
  // Data Fetching
  // --------------------------------------------------------------------------
  function fmtCost(kwh) {
    return Fmt.n(kwh != null ? kwh * costPerKwh : null, 2);
  }

  function updateMeterTotal(latestReading) {
    if (!statMeterTotal) return;
    statMeterTotal.textContent = Fmt.n(latestReading?.energy_in_kwh, 2);
  }

  /**
   * Fire latest_reading, stats, and energy_summary independently; update UI as each resolves.
   * Table is shown by default (energy_summary); chart stays lazy (readings only when "Show chart").
   */
  function loadInitialData(days) {
    const now = Date.now();
    const startMs = now - days * 24 * 60 * 60 * 1000;

    // Connection status is owned by the live-power poller — it runs every few seconds.
    fetchJson("/api/latest_reading")
      .then(updateMeterTotal)
      .catch((e) => {
        console.error("Latest reading fetch error:", e);
        updateMeterTotal(null);
      });

    fetchJson(`/api/stats?start=${startMs}&end=${now}`)
      .then((statsData) => {
        lastStats = statsData.stats;
        lastStartMs = startMs;
        lastEndMs = now;
        updateStats(lastStats, startMs, now);
      })
      .catch((e) => {
        console.error("Stats fetch error:", e);
        setConnectionStatus(statusConn, false);
        updateStats(null, startMs, now);
      });

    fetchJson(`/api/energy_summary?start=${startMs}&end=${now}`)
      .then((summaryData) => {
        dailyEnergyData = summaryData.daily || [];
        movingAvgData = summaryData.moving_avg_30d || [];
        avgDailyEnergyUsage = summaryData.avg_daily || null;
        updateDailyTable(startMs, now);
        if (lastStats != null && lastStartMs != null && lastEndMs != null) {
          updateStats(lastStats, lastStartMs, lastEndMs);
        }
      })
      .catch((e) => {
        console.error("Energy summary fetch error:", e);
      });
  }

  /**
   * Fetch readings + energy_summary, then render chart and daily table.
   * Call only when user has clicked "Show chart" or when days change and chart is already visible.
   */
  async function fetchChartData(days) {
    const now = Date.now();
    const startMs = now - days * 24 * 60 * 60 * 1000;

    chartAbortController = new AbortController();
    const signal = chartAbortController.signal;

    if (chartContent) chartContent.classList.add("is-visible");
    if (btnShowChart) { btnShowChart.textContent = "Hide chart"; btnShowChart.setAttribute("aria-expanded", "true"); }
    showLoading();

    try {
      const [readings, summaryData] = await Promise.all([
        fetchJson(`/api/readings?start=${startMs}&end=${now}`, { signal }),
        fetchJson(`/api/energy_summary?start=${startMs}&end=${now}`, { signal }),
      ]);

      dailyEnergyData = summaryData.daily || [];
      movingAvgData = summaryData.moving_avg_30d || [];
      avgDailyEnergyUsage = summaryData.avg_daily || null;

      processReadings(readings);
      updateChart();
      updateDailyTable(startMs, now);
      if (lastStats != null && lastStartMs != null && lastEndMs != null) {
        updateStats(lastStats, lastStartMs, lastEndMs);
      }
      chartLoaded = true;
      setConnectionStatus(statusConn, true);
    } catch (e) {
      if (e.name === "AbortError") {
        return;
      }
      console.error("Chart fetch error:", e);
      setConnectionStatus(statusConn, false);
      if (btnShowChart) { btnShowChart.textContent = "Show chart"; btnShowChart.setAttribute("aria-expanded", "false"); }
      if (chartContent) chartContent.classList.remove("is-visible");
      chartLoaded = false;
    } finally {
      chartAbortController = null;
      hideLoading();
    }
  }

  function hideChart() {
    if (chartAbortController) {
      chartAbortController.abort();
      chartAbortController = null;
    }
    if (btnShowChart) { btnShowChart.textContent = "Show chart"; btnShowChart.setAttribute("aria-expanded", "false"); }
    if (chartContent) chartContent.classList.remove("is-visible");
    chartLoaded = false;
    if (u) {
      u.destroy();
      u = null;
    }
    hideLoading();
  }

  function processReadings(rows) {
    if (!rows.length) {
      xVals = [];
      yVals = [];
      eVals = [];
      dailyEnergyVals = [];
      typicalDailyVals = [];
      updateChart();
      return;
    }

    ({ xVals, yVals, eVals } = processReadingsData(rows));
    dailyEnergyVals = alignDailyDataToTimestamps(dailyEnergyData, xVals);
    typicalDailyVals = alignDailyDataToTimestamps(movingAvgData, xVals);

    updateChart();
  }

  function updateStats(stats, startMs, endMs) {
    const durationDays = (endMs - startMs) / (24 * 60 * 60 * 1000);
    statRangeLabel.textContent = `${Math.round(durationDays)} days`;

    const energy = stats?.energy_used_kwh ?? null;
    const typicalEnergy = avgDailyEnergyUsage != null ? avgDailyEnergyUsage * durationDays : null;
    statEnergy.textContent = Fmt.n(energy, 2);
    statCost.textContent = fmtCost(energy);
    renderDelta(statEnergyDelta, energy, typicalEnergy);
    statTypicalEnergy.textContent = Fmt.n(typicalEnergy, 2);
    statTypicalCost.textContent = fmtCost(typicalEnergy);
  }

  /**
   * Update the daily breakdown table with data for the selected period.
   */
  function updateDailyTable(startMs, endMs) {
    if (!dailyTableBody) return;

    const filteredDaily = dailyEnergyData
      .filter(d => d.t >= startMs && d.t <= endMs)
      .sort((a, b) => b.t - a.t);

    // Every row is compared against one baseline: the 30d moving average as of the most recent day shown
    const latestDay = filteredDaily[0];
    const latestDayKey = latestDay ? getDateKey(new Date(latestDay.t)) : null;
    const baseline = movingAvgData.find(d => getDateKey(new Date(d.t)) === latestDayKey)?.kwh ?? avgDailyEnergyUsage;
    dailyBaselineKwh.textContent = Fmt.n(baseline, 1);
    dailyBaselineCost.textContent = fmtCost(baseline);

    const rows = filteredDaily.map(d => {
      const dateStr = new Date(d.t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      const delta = describeDelta(d.kwh, baseline);
      return `
        <tr>
          <td>${dateStr}</td>
          <td>${Fmt.n(d.kwh, 1)}</td>
          <td>${fmtCost(d.kwh)}</td>
          <td class="${delta ? delta.className : ""}">${delta ? delta.text : "–"}</td>
        </tr>
      `;
    });

    dailyTableBody.innerHTML = rows.join("");
  }

  // --------------------------------------------------------------------------
  // Loading States
  // --------------------------------------------------------------------------
  function showLoading() {
    if (chartLoading) chartLoading.classList.remove("hidden");
  }

  function hideLoading() {
    if (chartLoading) chartLoading.classList.add("hidden");
  }

  // --------------------------------------------------------------------------
  // Input Handling
  // --------------------------------------------------------------------------
  function handleDaysChange() {
    const value = parseInt(daysInput.value, 10) || 7;
    loadInitialData(value);
    if (chartLoaded) fetchChartData(value);
  }

  // --------------------------------------------------------------------------
  // Window Resize
  // --------------------------------------------------------------------------
  function handleResize() {
    if (u) {
      const { width, height } = getChartSize();
      u.setSize({ width, height });
    }
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------
  function init() {
    daysInput.addEventListener("change", handleDaysChange);
    window.addEventListener("resize", handleResize);

    setupToggleButtons();

    if (btnShowChart) {
      btnShowChart.addEventListener("click", () => {
        if (chartLoaded) {
          hideChart();
        } else {
          const days = parseInt(daysInput.value, 10) || 7;
          fetchChartData(days);
        }
      });
    }

    startLivePower(livePowerEl, { statusEl: statusConn, metaHost: liveMetaEl });

    const initialDays = parseInt(daysInput.value, 10) || 7;
    loadInitialData(initialDays);
  }

  init();
})();
