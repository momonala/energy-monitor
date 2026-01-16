/**
 * Mobile Energy Monitor - JavaScript
 * Simplified, non-interactive dashboard for mobile devices.
 * Uses shared utilities from shared.js
 */
(() => {
  // Import shared utilities
  const { Fmt, formatDuration, setConnectionStatus, alignDailyDataToTimestamps, 
          loadCostPerKwh, getBaseChartAxes, processReadingsData, ChartColors } = window.EnergyMonitor;

  // DOM Elements
  const chartEl = document.getElementById("chart");
  const chartLoading = document.getElementById("chart-loading");
  const statusConn = document.getElementById("status-connection");
  const daysInput = document.getElementById("days-input");
  const statEnergy = document.getElementById("stat-energy");
  const statCost = document.getElementById("stat-cost");
  const statTypicalEnergy = document.getElementById("stat-typical-energy");
  const statTypicalCost = document.getElementById("stat-typical-cost");
  const statAvg = document.getElementById("stat-avg");
  const statMax = document.getElementById("stat-max");
  const statMin = document.getElementById("stat-min");
  const statCount = document.getElementById("stat-count");
  const statRange = document.getElementById("stat-range");
  const dailyTableBody = document.getElementById("daily-table-body");
  const dailyTableTitle = document.getElementById("daily-table-title");

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
  let debounceTimer = null;

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

    // Destroy existing chart
    if (u) {
      u.destroy();
      u = null;
    }

    const { width, height } = getChartSize();
    const axes = getBaseChartAxes({ xSize: 40, ySize: 40, font: "10px sans-serif" });
    
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
          stroke: ChartColors.power,
          fill: ChartColors.powerFill,
          width: 1,
          scale: "y",
          show: seriesVisibility[1],
        },
        {
          label: "Energy",
          stroke: ChartColors.energy,
          width: 1,
          scale: "y2",
          show: seriesVisibility[2],
        },
        {
          label: "Daily Usage",
          stroke: ChartColors.dailyEnergy,
          width: 2,
          scale: "y3",
          show: seriesVisibility[3],
        },
        {
          label: "30d Avg",
          stroke: ChartColors.typicalDaily,
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

    // Apply initial visibility
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
    seriesVisibility[seriesIdx] = !seriesVisibility[seriesIdx];
    
    // Update button state
    if (seriesVisibility[seriesIdx]) {
      button.classList.add("active");
    } else {
      button.classList.remove("active");
    }
    
    // Update chart
    if (u && u.series && u.series[seriesIdx]) {
      u.setSeries(seriesIdx, { show: seriesVisibility[seriesIdx] });
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
  async function fetchData(days) {
    const now = Date.now();
    const startMs = now - days * 24 * 60 * 60 * 1000;

    showLoading();

    try {
      const [readingsRes, statsRes, summaryRes] = await Promise.all([
        fetch(`/api/readings?start=${startMs}&end=${now}`, { cache: "no-cache" }),
        fetch(`/api/stats?start=${startMs}&end=${now}`, { cache: "no-cache" }),
        fetch("/api/energy_summary", { cache: "no-cache" }),
      ]);

      if (!readingsRes.ok) throw new Error(`Readings HTTP ${readingsRes.status}`);
      if (!statsRes.ok) throw new Error(`Stats HTTP ${statsRes.status}`);
      if (!summaryRes.ok) throw new Error(`Summary HTTP ${summaryRes.status}`);

      const readings = await readingsRes.json();
      const statsData = await statsRes.json();
      const summaryData = await summaryRes.json();

      dailyEnergyData = summaryData.daily || [];
      movingAvgData = summaryData.moving_avg_30d || [];
      avgDailyEnergyUsage = summaryData.avg_daily || null;

      processReadings(readings);
      updateStats(statsData.stats, startMs, now);
      updateDailyTable(startMs, now);
      setConnectionStatus(statusConn, true);
    } catch (e) {
      console.error("Fetch error:", e);
      setConnectionStatus(statusConn, false);
      showError();
    } finally {
      hideLoading();
    }
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

    // Use shared processing utility
    const processed = processReadingsData(rows);
    xVals = processed.xVals;
    yVals = processed.yVals;
    eVals = processed.eVals;

    // Use shared alignment utility
    dailyEnergyVals = alignDailyDataToTimestamps(dailyEnergyData, xVals);
    typicalDailyVals = alignDailyDataToTimestamps(movingAvgData, xVals);

    updateChart();
  }

  function updateStats(stats, startMs, endMs) {
    if (!stats) {
      statEnergy.textContent = "–";
      statCost.textContent = "–";
      statTypicalEnergy.textContent = "–";
      statTypicalCost.textContent = "–";
      statAvg.textContent = "–";
      statMax.textContent = "–";
      statMin.textContent = "–";
      statCount.textContent = "–";
      statRange.textContent = "–";
      return;
    }

    const energy = stats.energy_used_kwh;
    statEnergy.textContent = Fmt.n(energy, 2);
    statCost.textContent = Fmt.n(energy != null ? energy * costPerKwh : null, 2);

    // Calculate typical usage based on duration and avg daily usage
    const durationDays = (endMs - startMs) / (24 * 60 * 60 * 1000);
    const typicalEnergy = avgDailyEnergyUsage != null ? avgDailyEnergyUsage * durationDays : null;
    statTypicalEnergy.textContent = Fmt.n(typicalEnergy, 2);
    statTypicalCost.textContent = Fmt.n(typicalEnergy != null ? typicalEnergy * costPerKwh : null, 2);

    statAvg.textContent = Fmt.n(stats.avg_power_watts, 0);
    statMax.textContent = Fmt.n(stats.max_power_watts, 0);
    statMin.textContent = Fmt.n(stats.min_power_watts, 0);
    statCount.textContent = stats.count != null ? String(stats.count) : "–";
    statRange.textContent = formatDuration(endMs - startMs);
  }

  /**
   * Update the daily breakdown table with data for the selected period.
   */
  function updateDailyTable(startMs, endMs) {
    if (!dailyTableBody) return;

    // Filter daily data to the selected period
    const filteredDaily = dailyEnergyData.filter(d => d.t >= startMs && d.t <= endMs);

    // Sort by date descending (most recent first)
    filteredDaily.sort((a, b) => b.t - a.t);

    // Build a map of 30d moving averages by date
    const avgMap = new Map();
    for (const d of movingAvgData) {
      const date = new Date(d.t);
      const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      avgMap.set(dateKey, d.kwh);
    }

    // Get 30d moving average of the latest day for comparison
    let baseline = avgDailyEnergyUsage;
    if (filteredDaily.length > 0) {
      const latestDate = new Date(filteredDaily[0].t);
      const latestKey = `${latestDate.getFullYear()}-${latestDate.getMonth()}-${latestDate.getDate()}`;
      baseline = avgMap.get(latestKey) ?? avgDailyEnergyUsage;
    }
    const baselineCost = baseline != null ? baseline * costPerKwh : null;

    // Update title with 30d average
    if (dailyTableTitle) {
      if (baseline != null) {
        dailyTableTitle.textContent = `Daily Breakdown (30d avg: ${Fmt.n(baseline, 1)} kWh, €${Fmt.n(baselineCost, 2)})`;
      } else {
        dailyTableTitle.textContent = "Daily Breakdown";
      }
    }

    // Build table rows - diff is compared against the 30d moving average
    const rows = filteredDaily.map(d => {
      const date = new Date(d.t);
      const diff = d.kwh != null && baseline != null ? d.kwh - baseline : null;
      const diffCost = diff != null ? diff * costPerKwh : null;
      const diffClass = diff != null ? (diff > 0 ? "text-over" : "text-under") : "";
      const diffSign = diff != null ? (diff > 0 ? "+" : "−") : "";
      const cost = d.kwh != null ? d.kwh * costPerKwh : null;

      const dateStr = date.toLocaleDateString(undefined, { 
        weekday: "short", 
        month: "short", 
        day: "numeric" 
      });

      const diffStr = diff != null 
        ? `${diffSign}(${Fmt.n(Math.abs(diff), 1)} kWh, €${Fmt.n(Math.abs(diffCost), 2)})`
        : "–";

      return `
        <tr>
          <td>${dateStr}</td>
          <td class="text-daily-energy">${Fmt.n(d.kwh, 1)}</td>
          <td>${Fmt.n(cost, 2)}</td>
          <td class="${diffClass}">${diffStr}</td>
        </tr>
      `;
    });

    dailyTableBody.innerHTML = rows.join("");
  }

  function showError() {
    statEnergy.textContent = "Error";
    statCost.textContent = "–";
    statTypicalEnergy.textContent = "–";
    statTypicalCost.textContent = "–";
    statAvg.textContent = "–";
    statMax.textContent = "–";
    statMin.textContent = "–";
    statCount.textContent = "–";
    statRange.textContent = "–";
    if (dailyTableBody) dailyTableBody.innerHTML = "";
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
    const value = parseInt(daysInput.value, 10);
    if (Number.isNaN(value) || value < 1) {
      daysInput.value = 1;
      fetchData(1);
    } else if (value > 365) {
      daysInput.value = 365;
      fetchData(365);
    } else {
      fetchData(value);
    }
  }

  function debouncedDaysChange() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(handleDaysChange, 500);
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
    daysInput.addEventListener("input", debouncedDaysChange);
    daysInput.addEventListener("change", handleDaysChange);
    window.addEventListener("resize", handleResize);

    // Set up chart series toggle buttons
    setupToggleButtons();

    const initialDays = parseInt(daysInput.value, 10) || 7;
    fetchData(initialDays);
  }

  init();
})();
