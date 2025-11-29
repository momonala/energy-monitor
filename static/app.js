(() => {
  const chartEl = document.getElementById("chart");
  const statusConn = document.getElementById("status-connection");
  const statusPts = document.getElementById("status-points");
  const statusWindow = document.getElementById("status-window");
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
  const statMonthEnergy = document.getElementById("stat-month-energy");
  const statMonthCost = document.getElementById("stat-month-cost");
  const statWeekEnergy = document.getElementById("stat-week-energy");
  const statWeekCost = document.getElementById("stat-week-cost");
  const statDayEnergy = document.getElementById("stat-day-energy");
  const statDayCost = document.getElementById("stat-day-cost");

  let u = null;
  let xVals = [];
  let yVals = [];
  let eVals = [];
  let costPerKwh = 0.3102;

  let data = []; // [ [timeMs, powerW], ... ]
  let selection = { start: null, end: null };
  const pointerSelect = {
    active: false,
    pointerId: null,
    startPx: null,
    startMs: null,
  };
  let pollingMs = 10000;

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

  function initChart() {
    if (!window.uPlot) {
      console.warn("uPlot not loaded; chart disabled. Fetching will still run.");
      return;
    }
    const width = chartEl.clientWidth || 800;
    const height = Math.max(320, Math.floor(window.innerHeight * 0.6));
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

  function applySelectionRange(startMs, endMs, label = "range", clampToData = true) {
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
    renderSelection();
    computeStatsLocal(startMs, endMs);
    if (statusWindow) statusWindow.textContent = label;
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
    if (statusWindow) statusWindow.textContent = "live";
    clearPointerSelectionOverlay();
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
    if (curMin !== null && curMax !== null && curMax > curMin) {
      u.setScale("x", { min: curMin, max: curMax });
    }
    if (statusPts) statusPts.textContent = `${data.length} data points`;
    // header extras
    const lastIdx = xVals.length - 1;
    if (statusLast && lastIdx >= 0) {
      statusLast.textContent = `Last updated: ${fmt.t(xVals[lastIdx] * 1000)}`;
    }
    if (selection.start && selection.end) {
      computeStatsLocal(selection.start, selection.end);
    }
  }

  async function fetchReadings({ start = null, end = null } = {}) {
    const qs = new URLSearchParams();
    if (start) qs.set("start", String(start));
    if (end) qs.set("end", String(end));
    try {
      const res = await fetch(`/api/readings?${qs.toString()}`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
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
      data = mapped;
      // uPlot expects time scale in seconds
      xVals = mapped.map((m) => Math.floor(m[0] / 1000));
      yVals = mapped.map((m) => m[1]);
      eVals = rows.map((r) => r.e ?? null);
      updateChart();
      setConnection(true);
      if (usedDerived && statusWindow) statusWindow.textContent = "derived";
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
    if (statusWindow) statusWindow.textContent = "range";
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
  function selectRelativeRange(durationMs, label) {
    if (!xVals.length) return;
    const endMs = xVals[xVals.length - 1] * 1000;
    const startMs = Math.max(xVals[0] * 1000, endMs - durationMs);
    applySelectionRange(startMs, endMs, label);
  }

  function selectCalendarRange(startMs, endMs, label = "range") {
    if (!xVals.length) return;
    applySelectionRange(startMs, endMs, label);
  }

  function shouldUsePointerSelection(evt) {
    if (!evt) return false;
    if (evt.pointerType === "touch" || evt.pointerType === "pen") return true;
    if (evt.pointerType === "mouse") {
      return typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
    }
    return false;
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
    if (!shouldUsePointerSelection(evt) || !u || !xVals.length) return;
    const px = getRelativeXPx(evt);
    if (px == null) return;
    const startMs = pxToMs(px);
    if (!Number.isFinite(startMs)) return;
    pointerSelect.active = true;
    pointerSelect.pointerId = evt.pointerId;
    pointerSelect.startPx = px;
    pointerSelect.startMs = startMs;
    if (u.over.setPointerCapture) {
      try {
        u.over.setPointerCapture(evt.pointerId);
      } catch (_) {
        // ignore inability to capture
      }
    }
    updateHoverAtPx(px);
    renderPointerSelection(px);
    evt.preventDefault();
    if (statusWindow) statusWindow.textContent = "selecting";
  }

  function handlePointerSelectMove(evt) {
    if (!pointerSelect.active || evt.pointerId !== pointerSelect.pointerId || !shouldUsePointerSelection(evt)) return;
    const px = getRelativeXPx(evt);
    if (px == null) return;
    updateHoverAtPx(px);
    renderPointerSelection(px);
    evt.preventDefault();
  }

  function finalizePointerSelection(px) {
    const startMs = pointerSelect.startMs;
    const endMs = pxToMs(px != null ? px : pointerSelect.startPx);
    resetPointerSelectionState();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    const from = Math.min(startMs, endMs);
    let to = Math.max(startMs, endMs);
    if (to === from) {
      to = from + 1;
    }
    applySelectionRange(from, to);
  }

  function handlePointerSelectEnd(evt) {
    if (!pointerSelect.active || evt.pointerId !== pointerSelect.pointerId || !shouldUsePointerSelection(evt)) return;
    const px = getRelativeXPx(evt);
    finalizePointerSelection(px);
    evt.preventDefault();
  }

  function cancelPointerSelection(evt) {
    if (!pointerSelect.active) return;
    if (evt && pointerSelect.pointerId != null && evt.pointerId !== pointerSelect.pointerId) return;
    resetPointerSelectionState();
  }

  btnReset.addEventListener("click", () => {
    if (u && xVals.length) {
      u.setScale("x", { min: xVals[0], max: xVals[xVals.length - 1] });
    }
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
  if (btnLastHour) btnLastHour.addEventListener("click", () => selectRelativeRange(60 * 60 * 1000, "last hour"));
  if (btnLastDay) btnLastDay.addEventListener("click", () => selectRelativeRange(24 * 60 * 60 * 1000, "last day"));
  if (btnLastWeek) btnLastWeek.addEventListener("click", () => {
    const now = new Date();
    const day = now.getDay(); // 0 Sunday .. 6 Saturday
    const start = new Date(now);
    start.setHours(0,0,0,0);
    start.setDate(start.getDate() - day); // week starting Sunday
    selectCalendarRange(start.getTime(), now.getTime(), "last week");
  });
  if (btnLastMonth) btnLastMonth.addEventListener("click", () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds(), 0);
    selectCalendarRange(start.getTime(), now.getTime(), "last month");
  });
  if (btnLastYear) btnLastYear.addEventListener("click", () => {
    const now = new Date();
    const start = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds(), 0);
    selectCalendarRange(start.getTime(), now.getTime(), "last year");
  });

  async function poll() {
    await fetchReadings();
    setTimeout(poll, pollingMs);
  }

  window.addEventListener("resize", () => {
    if (u) {
      const width = chartEl.clientWidth || 800;
      const height = Math.max(320, Math.floor(window.innerHeight * 0.6));
      u.setSize({ width, height });
    }
  });

  initChart();
  fetchReadings()
    .then(() => {
      loadCostFromStorage();
      updatePeriodSummaries();
      poll();
    })
    .catch((e) => {
      console.error("Initial fetch failed:", e);
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

