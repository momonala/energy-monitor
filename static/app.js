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
  // Hover overlay elements
  const hoverTime = document.getElementById("hover-time");
  const hoverTotalEnergy = document.getElementById("hover-total-energy");
  const hoverPower = document.getElementById("hover-power");
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

  // All stat elements for skeleton loading
  const statElements = [
    statEnergy, statAvg, statMax, statMin, statCount, statRange, statCostRange,
    statCurrentConsumption, statTotalCost, statMonthEnergy, statMonthCost,
    statWeekEnergy, statWeekCost, statDayEnergy, statDayCost
  ].filter(Boolean);
  const statusLive = document.getElementById("status-live");

  let u = null;
  let xVals = [];
  let yVals = [];
  let eVals = [];
  let costPerKwh = 0.3102;

  let selection = { start: null, end: null };
  const pointerSelect = {
    active: false,
    pointerId: null,
    startPx: null,
    startMs: null,
  };
  let pollingMs = 10000;
  let isLoading = false;
  let lastDataTimestamp = null; // Track the latest data point we have
  let isLiveView = true; // Track if user is viewing real-time data
  const MIN_DRAG_PX = 10; // Minimum pixels to drag before selection applies (prevents tap-to-zoom)
  const LIVE_THRESHOLD_SEC = 120; // Seconds within latest data to consider "live" view (2 minutes)
  const MAX_CHART_POINTS = 2000; // Max points to render (downsampled if exceeded)

  // --------------------------------------------------------------------------
  // Loading State Helpers
  // --------------------------------------------------------------------------
  function showLoading() {
    isLoading = true;
    if (chartLoading) chartLoading.classList.remove("hidden");
    statElements.forEach(el => el.classList.add("skeleton"));
  }

  function hideLoading() {
    isLoading = false;
    if (chartLoading) chartLoading.classList.add("hidden");
    statElements.forEach(el => el.classList.remove("skeleton"));
  }

  // --------------------------------------------------------------------------
  // Data Downsampling (Largest-Triangle-Three-Buckets algorithm)
  // --------------------------------------------------------------------------
  /**
   * Downsample data using LTTB algorithm to preserve peaks while reducing point count.
   * This prevents rendering performance issues with millions of data points.
   */
  function downsampleLTTB(xVals, yVals, threshold = MAX_CHART_POINTS) {
    if (xVals.length <= threshold) {
      return { xVals, yVals };
    }
    
    const bucketSize = (xVals.length - 2) / (threshold - 2);
    const downsampled_x = [xVals[0]];
    const downsampled_y = [yVals[0]];
    
    let avgRangeStart = Math.floor(bucketSize) + 1;
    
    for (let i = 0; i < threshold - 2; i++) {
      const rangeStart = Math.floor((i + 1) * bucketSize) + 1;
      const rangeEnd = Math.floor((i + 2) * bucketSize) + 1;
      
      const avgRangeEnd = Math.min(rangeEnd, xVals.length);
      const avgX = (xVals[avgRangeEnd - 1] + xVals[rangeStart]) / 2;
      
      let avgY = 0;
      let count = 0;
      for (let j = rangeStart; j < avgRangeEnd; j++) {
        if (yVals[j] != null && Number.isFinite(yVals[j])) {
          avgY += yVals[j];
          count++;
        }
      }
      avgY = count > 0 ? avgY / count : null;
      
      // Find the point with the largest triangle area
      let maxArea = -1;
      let maxAreaIdx = -1;
      const pointAX = downsampled_x[downsampled_x.length - 1];
      const pointAY = downsampled_y[downsampled_y.length - 1];
      
      for (let j = rangeStart; j < avgRangeEnd; j++) {
        if (yVals[j] == null || !Number.isFinite(yVals[j])) continue;
        
        // Calculate triangle area between previous point, current point, and average of next bucket
        const pointBX = xVals[j];
        const pointBY = yVals[j];
        const pointCX = avgX;
        const pointCY = avgY;
        
        // Triangle area = 0.5 * |x1(y2 - y3) + x2(y3 - y1) + x3(y1 - y2)|
        const area = Math.abs(
          (pointAX * (pointBY - pointCY) +
            pointBX * (pointCY - pointAY) +
            pointCX * (pointAY - pointBY)) / 2
        );
        
        if (area > maxArea) {
          maxArea = area;
          maxAreaIdx = j;
        }
      }
      
      if (maxAreaIdx !== -1) {
        downsampled_x.push(xVals[maxAreaIdx]);
        downsampled_y.push(yVals[maxAreaIdx]);
      }
      
      avgRangeStart = avgRangeEnd;
    }
    
    downsampled_x.push(xVals[xVals.length - 1]);
    downsampled_y.push(yVals[yVals.length - 1]);
    
    return { xVals: downsampled_x, yVals: downsampled_y };
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
        y: { auto: true },     // power (W)
        y2: { auto: true },    // energy (kWh)
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
          label: "kWh",
          stroke: "rgb(235, 133, 37)",
          grid: { show: false },
          scale: "y2",
          size: 56,
        }
      ],
      series: [
        {},
        {
          label: "Power",
          stroke: "rgba(37, 99, 235, 1)",
          fill: "rgba(37,99,235,0.12)",
          width: 1.5,
          scale: "y",
        },
        {
          label: "Energy",
          stroke: "rgb(235, 133, 37)",
          width: 1.5,
          scale: "y2",
          
        },
      ],
      legend: { show: false },
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
    u = new uPlot(opts, [xVals, yVals, eVals], chartEl);
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
    if (u) {
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

  function updateChart() {
    if (!u) {
      initChart();
      if (!u) return;
    }
    
    // Preserve current x-scale window across refresh
    const curX = u.scales && u.scales.x ? u.scales.x : null;
    const curMin = curX && Number.isFinite(curX.min) ? curX.min : null;
    const curMax = curX && Number.isFinite(curX.max) ? curX.max : null;
    
    u.setData([xVals, yVals, eVals]);
    
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
      let usedDerived = false;
      if (mapped.length && mapped.every((pt) => pt[1] === null || pt[1] === undefined)) {
        const derived = [];
        for (let i = 1; i < rows.length; i++) {
          const a = rows[i - 1];
          const b = rows[i];
          if (
            a &&
            b &&
            a.e != null &&
            b.e != null &&
            typeof a.t === "number" &&
            typeof b.t === "number" &&
            b.t > a.t
          ) {
            const dE_kWh = b.e - a.e;
            const dt_ms = b.t - a.t;
            if (dt_ms > 0) {
              // Power (W) ≈ (ΔkWh / Δt_ms) * 3.6e9
              const watts = Math.max(0, (dE_kWh * 3600000000) / dt_ms);
              derived.push([b.t, watts]);
            }
          }
        }
        if (derived.length) {
          mapped = derived;
          usedDerived = true;
        }
      }
      
      // Filter out rows where power is null/undefined to prevent zeros and line breaks
      // Keep track of which original indices are valid for energy values
      const validIndices = [];
      const newXVals = [];
      const newYVals = [];
      const newEVals = [];
      
      for (let i = 0; i < mapped.length; i++) {
        if (mapped[i][1] != null && Number.isFinite(mapped[i][1])) {
          validIndices.push(i);
          newXVals.push(Math.floor(mapped[i][0] / 1000));
          newYVals.push(mapped[i][1]);
          newEVals.push(rows[i].e ?? null);
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
        // Apply downsampling if dataset is large
        const downsampled = downsampleLTTB(newXVals, newYVals, MAX_CHART_POINTS);
        xVals = downsampled.xVals;
        yVals = downsampled.yVals;
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
    statEnergy.textContent = fmt.n(energyUsed, 3);
    if (statCostRange) {
      const cost = energyUsed != null ? energyUsed * costPerKwh : null;
      statCostRange.textContent = fmt.n(cost, 2);
    }
    statAvg.textContent = fmt.n(avgP, 1);
    statMax.textContent = fmt.n(maxP, 0);
    statMin.textContent = fmt.n(minP, 0);
    statCount.textContent = String(count);
  }

  function updateHover(idx) {
    if (!xVals.length || idx == null || idx < 0 || idx >= xVals.length) {
      hoverTime.textContent = "";
      hoverTotalEnergy.textContent = "";
      hoverPower.textContent = "";
      return;
    }
    const tMs = xVals[idx] * 1000;
    const eNow = eVals[idx];
    const pNow = yVals[idx];
    hoverTime.textContent = fmt.t(tMs);
    hoverTotalEnergy.textContent = fmt.n(eNow, 3);
    hoverPower.textContent = fmt.n(pNow, 0);
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
      u.setScale("x", { min: xVals[0], max: xVals[xVals.length - 1] });
    }
    setActiveButton(null); // Clear active state on reset
    clearSelection();
  });
  if (btnRefresh) {
    btnRefresh.addEventListener("click", async () => {
      if (btnRefresh.disabled) return;
      const originalLabel = btnRefresh.textContent;
      btnRefresh.disabled = true;
      btnRefresh.textContent = "Refreshing...";
      btnRefresh.classList.add("btn-loading");
      try {
        await fetchReadings();
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
    setTimeout(poll, pollingMs);
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
  fetchReadings()
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
      setTimeout(poll, pollingMs);
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
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Week starting Sunday
  const day = now.getDay(); // 0=Sun..6=Sat
  const startOfWeek = new Date(now);
  startOfWeek.setHours(0,0,0,0);
  startOfWeek.setDate(startOfWeek.getDate() - day);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const longTimeAgo = new Date(now.getFullYear() - 100, 0, 1).getTime();

  try {
    const [dayStats, weekStats, monthStats, latestReading] = await Promise.all([
      fetchStats(startOfDay, now.getTime()),
      fetchStats(startOfWeek.getTime(), now.getTime()),
      fetchStats(startOfMonth, now.getTime()),
      fetchLatestReading(),
    ]);
    if (statDayEnergy) statDayEnergy.textContent = fmt.n(dayStats.energy_used_kwh, 3);
    if (statDayCost) statDayCost.textContent = fmt.n((dayStats.energy_used_kwh || 0) * costPerKwh, 2);
    if (statWeekEnergy) statWeekEnergy.textContent = fmt.n(weekStats.energy_used_kwh, 3);
    if (statWeekCost) statWeekCost.textContent = fmt.n((weekStats.energy_used_kwh || 0) * costPerKwh, 2);
    if (statMonthEnergy) statMonthEnergy.textContent = fmt.n(monthStats.energy_used_kwh, 3);
    if (statMonthCost) statMonthCost.textContent = fmt.n((monthStats.energy_used_kwh || 0) * costPerKwh, 2);
    if (statCurrentConsumption) statCurrentConsumption.textContent = fmt.n(latestReading.energy_in_kwh, 3);
    if (statTotalCost) statTotalCost.textContent = fmt.n((latestReading.energy_in_kwh || 0) * costPerKwh, 2);
    
  } catch (e) {
    console.error("Failed to update period summaries:", e);
  }
}

async function fetchLatestReading() {
  const res = await fetch(`/api/latest_reading`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body;
}

async function fetchStats(startMs, endMs) {
  const qs = new URLSearchParams({ start: String(startMs), end: String(endMs) });
  const res = await fetch(`/api/stats?${qs.toString()}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.stats || {};
}

})();

