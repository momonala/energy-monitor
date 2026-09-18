/**
 * Dashboard: one global time context, three cursor-synced chart widgets
 * (power, daily usage, meter), and stat tiles that follow the selected window.
 *
 * Interaction model:
 *  - Preset buttons (1h…1y) set a live window whose right edge follows now.
 *  - Brushing any chart selects a custom window: all charts rescale together
 *    and the window tiles recompute. "Back to live" (or double-click) returns
 *    to the active preset.
 */
(() => {
  const {
    Fmt,
    formatAge,
    fetchJson,
    setConnectionStatus,
    startLivePower,
    renderDelta: renderDeltaVsTypical,
    getDateKey,
    loadCostPerKwh,
    saveCostPerKwh,
    readChartTheme,
    getChartSelectOptions,
    processReadingsData,
  } = window.EnergyMonitor;

  // ── DOM ─────────────────────────────────────────────────────────────────
  const statusConn = document.getElementById("status-connection");
  const btnLive = document.getElementById("btn-live");
  const btnRefresh = document.getElementById("btn-refresh");
  const btnToggleScale = document.getElementById("btn-toggle-scale");
  const btnToggleAvgMode = document.getElementById("btn-toggle-avg-mode");
  const costInput = document.getElementById("cost-input");
  const rangeButtons = Array.from(document.querySelectorAll("[data-range]"));

  const tile = {
    livePower: document.getElementById("tile-live-power"),
    liveTime: document.getElementById("tile-live-time"),
    meterTotal: document.getElementById("tile-meter-total"),
    energy: document.getElementById("tile-energy"),
    energyCost: document.getElementById("tile-energy-cost"),
    energyDelta: document.getElementById("tile-energy-delta"),
    avgPower: document.getElementById("tile-avg-power"),
    minPower: document.getElementById("tile-min-power"),
    maxPower: document.getElementById("tile-max-power"),
    day: document.getElementById("tile-day"),
    dayCost: document.getElementById("tile-day-cost"),
    dayDelta: document.getElementById("tile-day-delta"),
    week: document.getElementById("tile-week"),
    weekCost: document.getElementById("tile-week-cost"),
    weekDelta: document.getElementById("tile-week-delta"),
    month: document.getElementById("tile-month"),
    monthCost: document.getElementById("tile-month-cost"),
    monthDelta: document.getElementById("tile-month-delta"),
  };
  const typicalChipLabel = document.getElementById("lv-typical-label");
  const avgChipLabel = document.getElementById("lv-avg-label");
  const loadingEls = {
    power: document.getElementById("loading-power"),
    daily: document.getElementById("loading-daily"),
    meter: document.getElementById("loading-meter"),
  };

  // Each section reveals on its own fetch, so tiles group by data source
  const windowTileEls = [tile.energy, tile.energyCost, tile.energyDelta, tile.avgPower, tile.minPower, tile.maxPower].filter(Boolean);
  const periodTileEls = [
    tile.day, tile.dayCost, tile.dayDelta,
    tile.week, tile.weekCost, tile.weekDelta,
    tile.month, tile.monthCost, tile.monthDelta,
    tile.meterTotal,
  ].filter(Boolean);
  const liveTileEls = [tile.livePower, tile.liveTime].filter(Boolean);

  // ── Constants & state ───────────────────────────────────────────────────
  const SYNC_KEY = "energy-dashboard";
  const POLLING_MS = 10000;
  const LIVE_THRESHOLD_SEC = 120;
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  // Readings resolution scales with the view: raw 10s rows up to 6h, then
  // progressively coarser SQL buckets so no view ships more than ~10k points.
  function bucketMsForRange() {
    const durMs = range.endMs - range.startMs;
    if (durMs <= 6 * HOUR_MS) return 0; // raw rows
    if (durMs <= DAY_MS) return 60_000;
    if (durMs <= 7 * DAY_MS) return 120_000;
    if (durMs <= 30 * DAY_MS) return 600_000;
    return 3_600_000;
  }

  // "Avg power" window scales with the view: minute up to 6h, hour up to 30d,
  // day beyond (year view).
  function rollingWindowSec() {
    const durMs = range.endMs - range.startMs;
    if (durMs <= 6 * HOUR_MS) return 60;
    if (durMs <= 30 * DAY_MS) return 3600;
    return 86400;
  }

  function rollingLabel() {
    const w = rollingWindowSec();
    return `Avg power (${w === 60 ? "1m" : w === 3600 ? "1h" : "1d"})`;
  }
  const PRESETS_MS = {
    hour: HOUR_MS,
    "6h": 6 * HOUR_MS,
    day: DAY_MS,
    week: 7 * DAY_MS,
    month: 30 * DAY_MS,
    year: 365 * DAY_MS,
  };
  const TILE_SUMMARY_LOOKBACK_MS = 30 * DAY_MS;

  // Readings from /api/readings at the view's bucket resolution
  let xVals = [];
  let powerVals = [];
  let meterVals = [];
  let rollingVals = [];
  let loadedBucketMs = null;

  // Meter series thinned client-side (cumulative data needs far less detail)
  let meterXs = [];
  let meterYs = [];

  // Daily chart data (from /api/energy_summary for the window)
  let dayXs = [];
  let dayKwh = [];
  let dayTypical = [];
  let windowMovingAvg = []; // {t, kwh} per day

  // Typical baseline for tile deltas (all-time avg from a fixed 30-day summary)
  let avgDailyEnergyUsage = null;

  let costPerKwh = window.EnergyMonitor.DEFAULT_COST_PER_KWH;
  let powerScaleMode = "auto"; // 'auto' | 'fixed' — power y-axis
  let avgMode = "30d"; // '30d' moving average | 'total' flat all-time average

  // The global time window
  const range = {
    presetKey: "week",
    startMs: Date.now() - PRESETS_MS.week,
    endMs: Date.now(),
    live: true,
  };

  const charts = { power: null, daily: null, meter: null };
  const seriesShow = {
    power: { 1: true, 2: true },
    daily: { 1: true, 2: true },
    meter: { 1: true },
  };

  let lastDataTimestamp = null;
  let pollTimer = null;
  let pollController = null;
  let windowStatsController = null;
  let lastWindowStats = null;
  let lastPeriodStats = { day: null, week: null, month: null, latest: null };

  // ── Formatting helpers ──────────────────────────────────────────────────
  function fmtDateOnly(ms) {
    return new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  }

  function fmtGrouped(v, digits = 2) {
    if (v == null || Number.isNaN(v)) return "–";
    return Number(v).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  // ── Window helpers ──────────────────────────────────────────────────────
  function refreshLiveWindow() {
    if (!range.live) return;
    range.endMs = Date.now();
    range.startMs = range.endMs - PRESETS_MS[range.presetKey];
  }

  // transitions-dev tabs sliding: the pill tweens to the active preset button.
  const tabsPill = document.querySelector(".segmented .t-tabs-pill");

  function movePill(btn, animate = true) {
    if (!tabsPill) return;
    if (!btn) {
      tabsPill.classList.add("is-hidden");
      return;
    }
    tabsPill.classList.remove("is-hidden");
    if (!animate) {
      const prev = tabsPill.style.transition;
      tabsPill.style.transition = "none";
      tabsPill.style.transform = `translateX(${btn.offsetLeft}px)`;
      tabsPill.style.width = `${btn.offsetWidth}px`;
      void tabsPill.offsetWidth;
      tabsPill.style.transition = prev;
    } else {
      tabsPill.style.transform = `translateX(${btn.offsetLeft}px)`;
      tabsPill.style.width = `${btn.offsetWidth}px`;
    }
  }

  function activeRangeButton() {
    return rangeButtons.find((b) => b.classList.contains("is-active")) || null;
  }

  function setSegmentedActive(key) {
    rangeButtons.forEach((b) => b.classList.toggle("is-active", b.dataset.range === key));
    movePill(activeRangeButton());
  }

  // ── Loading states — each chart and tile group reveals independently ─────
  function setSkeleton(els, on) {
    els.forEach((el) => el.classList.toggle("skeleton", on));
  }

  function resetChart(key) {
    const el = loadingEls[key];
    if (!el) return;
    el.classList.remove("hidden");
    // Snap back to the pre-reveal state without animating the reverse
    const body = el.parentElement;
    body.classList.add("is-resetting");
    body.classList.remove("is-revealed");
    void body.offsetWidth;
    body.classList.remove("is-resetting");
  }

  function revealChart(key) {
    const el = loadingEls[key];
    if (!el) return;
    el.classList.add("hidden");
    el.parentElement.classList.add("is-revealed");
  }

  function resetCharts() {
    Object.keys(loadingEls).forEach(resetChart);
  }

  function reportFetchFailed() {
    setConnectionStatus(statusConn, false, "offline");
  }

  // ── Chart construction ──────────────────────────────────────────────────
  function chartSize(el) {
    const wrapper = el.parentElement;
    return {
      width: wrapper?.clientWidth || 800,
      height: wrapper?.clientHeight || 260,
    };
  }

  // Allowed time-tick steps: nothing between 3h and 1d, so any multi-day
  // window labels whole days rather than 6h/12h fractions.
  const M = 60;
  const H = 3600;
  const D = 86400;
  const X_TICK_INCRS = [
    1, 5, 10, 15, 30,
    M, 5 * M, 10 * M, 15 * M, 30 * M,
    H, 2 * H, 3 * H,
    D, 2 * D, 3 * D, 5 * D, 7 * D, 15 * D, 30 * D, 60 * D, 90 * D, 180 * D, 365 * D,
  ];

  function makeAxes(theme, unit) {
    const font = `11px ${theme.fontMono}`;
    return [
      {
        stroke: theme.axis,
        grid: { show: false },
        ticks: { stroke: theme.ticks },
        size: 32,
        space: 60,
        incrs: X_TICK_INCRS,
        font,
      },
      {
        label: unit,
        stroke: theme.axis,
        grid: { stroke: theme.grid, width: 1 },
        ticks: { stroke: theme.ticks },
        size: 52,
        font,
      },
    ];
  }

  /* Blank right-hand axis matching the power chart's second scale, so every
     chart's plot area spans the same pixels and the time axes line up. */
  function rightSpacerAxis() {
    return {
      side: 1,
      scale: "y",
      grid: { show: false },
      ticks: { show: false },
      size: 52,
      values: (u, splits) => splits.map(() => ""),
    };
  }

  /**
   * Brushing a chart sets the global window. uPlot draws the selection rect;
   * we consume it, clear it, and rescale every chart together.
   */
  function onSelect(u) {
    const s = u.select;
    if (!s || s.width <= 5) return;
    const x0 = u.posToVal(s.left, "x");
    const x1 = u.posToVal(s.left + s.width, "x");
    u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    if (Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0) {
      applyCustomRange(Math.floor(x0 * 1000), Math.floor(x1 * 1000));
    }
  }

  /**
   * Cursor tooltip: a floating box beside the crosshair. Cursor sync drives
   * this on every chart, so hovering one chart pops the box on all of them.
   */
  function renderTip(u, tip, tipContent) {
    const c = u.cursor;
    const idx = c && Number.isInteger(c.idx) ? c.idx : null;
    const content = idx != null && c.left >= 0 ? tipContent(idx) : null;
    if (!content) {
      tip.classList.add("hidden");
      return;
    }
    const rows = content.rows
      .map(
        (r) =>
          `<div class="chart-tip__row"><span class="legend-swatch ${r.swatch}"></span>` +
          `<span class="chart-tip__label">${r.label}</span><span class="chart-tip__value">${r.value}</span></div>`
      )
      .join("");
    tip.innerHTML = `<div class="chart-tip__title">${content.title}</div>${rows}`;
    tip.classList.remove("hidden");

    const body = tip.parentElement;
    const bodyRect = body.getBoundingClientRect();
    const overRect = u.over.getBoundingClientRect();
    const baseX = overRect.left - bodyRect.left;
    const baseY = overRect.top - bodyRect.top;
    let x = baseX + c.left + 14;
    if (x + tip.offsetWidth > body.clientWidth - 8) x = baseX + c.left - tip.offsetWidth - 14;
    let y = baseY + c.top + 14;
    y = Math.max(4, Math.min(y, body.clientHeight - tip.offsetHeight - 4));
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function buildChart(el, { series, axes, scales, tipContent }) {
    if (!window.uPlot || !el) return null;
    const body = el.closest(".widget-body");
    body?.querySelector(".chart-tip")?.remove(); // scale toggle rebuilds the chart
    const tip = document.createElement("div");
    tip.className = "chart-tip hidden";
    body?.appendChild(tip);
    const { width, height } = chartSize(el);
    const u = new uPlot(
      {
        width,
        height,
        scales,
        axes,
        series,
        legend: { show: false, live: false },
        select: getChartSelectOptions(),
        cursor: {
          sync: { key: SYNC_KEY, setSeries: false },
          drag: { x: true, y: false, setScale: false },
          points: { size: 6 },
        },
        hooks: {
          setSelect: [onSelect],
          setCursor: [(uInst) => renderTip(uInst, tip, tipContent)],
        },
      },
      series.map(() => []),
      el
    );
    if (body && !body.dataset.dblclickBound) {
      body.addEventListener("dblclick", backToLive);
      body.dataset.dblclickBound = "1";
    }
    return u;
  }

  function initCharts() {
    if (!window.uPlot) {
      console.warn("uPlot not loaded; charts disabled. Fetching will still run.");
      return;
    }
    const theme = readChartTheme();
    initPowerChart(theme);

    charts.daily = buildChart(document.getElementById("chart-daily"), {
      scales: { x: { time: true }, y: { range: (u, min, max) => [0, (max || 1) * 1.1] } },
      axes: [...makeAxes(theme, "kWh"), rightSpacerAxis()],
      series: [
        {},
        { label: "Daily usage", stroke: theme.dailyEnergy, width: 2 },
        { label: "30d avg", stroke: theme.typicalDaily, width: 2, dash: [6, 4] },
      ],
      tipContent: dailyTip,
    });

    charts.meter = buildChart(document.getElementById("chart-meter"), {
      scales: { x: { time: true }, y: { auto: true } },
      axes: [...makeAxes(theme, "kWh"), rightSpacerAxis()],
      series: [
        {},
        {
          label: "Meter",
          stroke: theme.energy,
          width: 1.5,
          points: { show: false },
          // Thinned to ~hourly samples, so smooth the segments between them
          ...(window.uPlot.paths && window.uPlot.paths.spline ? { paths: window.uPlot.paths.spline() } : {}),
        },
      ],
      tipContent: meterTip,
    });

    Object.entries(charts).forEach(([key, u]) => u && applySeriesShow(key));
  }

  function initPowerChart(theme = readChartTheme()) {
    // Live peaks reach tens of kW while the average sits around 100–300 W, so
    // the average gets its own right-hand scale. Axes are color-coded to their
    // series to keep the pairing readable.
    const axes = makeAxes(theme, "W live");
    axes[1].stroke = theme.power;
    axes.push({
      side: 1,
      scale: "y2",
      label: "W avg",
      stroke: theme.powerAvg,
      grid: { show: false },
      ticks: { stroke: theme.ticks },
      size: 52,
      font: `11px ${theme.fontMono}`,
    });
    charts.power = buildChart(document.getElementById("chart-power"), {
      scales: {
        x: { time: true },
        y: powerScaleMode === "fixed" ? { range: [0, 2000] } : { auto: true },
        y2: { auto: true },
      },
      axes,
      series: [
        {},
        { label: "Live power", stroke: theme.power, fill: theme.powerFill, width: 1.5 },
        { label: "Avg power (1h)", stroke: theme.powerAvg, width: 1.5, dash: [4, 4], scale: "y2" },
      ],
      tipContent: powerTip,
    });
  }

  function applySeriesShow(chartKey) {
    const u = charts[chartKey];
    if (!u) return;
    Object.entries(seriesShow[chartKey]).forEach(([idx, show]) => {
      if (u.series[idx]) u.setSeries(Number(idx), { show });
    });
  }

  function setChartData() {
    if (charts.power) charts.power.setData([xVals, powerVals, rollingVals]);
    if (charts.daily) charts.daily.setData([dayXs, dayKwh, dayTypical]);
    if (charts.meter) charts.meter.setData([meterXs, meterYs]);
  }

  function setXScales() {
    const min = range.startMs / 1000;
    const max = range.endMs / 1000;
    Object.values(charts).forEach((u) => u && u.setScale("x", { min, max }));
  }

  // ── Tooltip content per chart ───────────────────────────────────────────
  function powerTip(idx) {
    if (idx < 0 || idx >= xVals.length) return null;
    const rows = [];
    if (seriesShow.power[1]) rows.push({ swatch: "swatch-power", label: "Live power", value: `${Fmt.n(powerVals[idx], 0)} W` });
    if (seriesShow.power[2]) rows.push({ swatch: "swatch-power-avg", label: rollingLabel(), value: `${Fmt.n(rollingVals[idx], 0)} W` });
    if (!rows.length) return null;
    return { title: Fmt.t(xVals[idx] * 1000), rows };
  }

  function dailyTip(idx) {
    if (idx < 0 || idx >= dayXs.length) return null;
    const typicalLabel = avgMode === "30d" ? "30d avg" : "Total avg";
    const rows = [];
    if (seriesShow.daily[1]) rows.push({ swatch: "swatch-daily", label: "Daily usage", value: `${Fmt.n(dayKwh[idx], 2)} kWh` });
    if (seriesShow.daily[2]) rows.push({ swatch: "swatch-typical", label: typicalLabel, value: `${Fmt.n(dayTypical[idx], 2)} kWh` });
    if (!rows.length) return null;
    return { title: fmtDateOnly(dayXs[idx] * 1000), rows };
  }

  function meterTip(idx) {
    if (idx < 0 || idx >= meterXs.length || !seriesShow.meter[1]) return null;
    return {
      title: Fmt.t(meterXs[idx] * 1000),
      rows: [{ swatch: "swatch-meter", label: "Meter", value: `${fmtGrouped(meterYs[idx], 2)} kWh` }],
    };
  }

  // ── Derived series ──────────────────────────────────────────────────────
  /**
   * Trailing mean of power over the view-dependent window (time-based
   * two-pointer, so data gaps shrink the sample count rather than stretching
   * the horizon). powerVals is pre-filtered by processReadingsData.
   */
  function calculateRollingAvg() {
    const windowSec = rollingWindowSec();
    rollingVals = new Array(xVals.length).fill(null);
    let lo = 0;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < xVals.length; i++) {
      sum += powerVals[i];
      count++;
      while (xVals[lo] < xVals[i] - windowSec) {
        sum -= powerVals[lo];
        count--;
        lo++;
      }
      rollingVals[i] = sum / count;
    }
    updateRollingLabel();
  }

  function updateRollingLabel() {
    if (avgChipLabel) avgChipLabel.textContent = rollingLabel();
  }

  /**
   * Thin the cumulative meter series client-side: keep the last sample per
   * minute on short views, per hour otherwise. The line is smooth and
   * monotonic, so nothing visible is lost.
   */
  function thinMeterSeries() {
    const stepSec = range.endMs - range.startMs <= 6 * HOUR_MS ? 60 : 3600;
    meterXs = [];
    meterYs = [];
    let lastKey = null;
    for (let i = 0; i < xVals.length; i++) {
      const key = Math.floor(xVals[i] / stepSec);
      if (key !== lastKey) {
        meterXs.push(xVals[i]);
        meterYs.push(meterVals[i]);
        lastKey = key;
      } else {
        meterXs[meterXs.length - 1] = xVals[i];
        meterYs[meterYs.length - 1] = meterVals[i];
      }
    }
  }

  function recomputeDerived() {
    calculateRollingAvg();
    thinMeterSeries();
  }

  function rebuildDailySeries(dailyData) {
    dayXs = dailyData.map((d) => Math.floor(d.t / 1000) + 43200); // centre bars on their day
    dayKwh = dailyData.map((d) => d.kwh);
    rebuildTypicalSeries(dailyData);
  }

  function rebuildTypicalSeries(dailyData = null) {
    const days = dailyData || dayXs.map((sec) => ({ t: (sec - 43200) * 1000 }));
    if (avgMode === "30d") {
      const avgByDay = new Map(windowMovingAvg.map((d) => [getDateKey(new Date(d.t)), d.kwh]));
      dayTypical = days.map((d) => avgByDay.get(getDateKey(new Date(d.t))) ?? null);
    } else {
      dayTypical = days.map(() => avgDailyEnergyUsage);
    }
  }

  // ── Data fetching ───────────────────────────────────────────────────────
  async function fetchStats(startMs, endMs, signal = null) {
    const qs = new URLSearchParams({ start: String(startMs), end: String(endMs) });
    const body = await fetchJson(`/api/stats?${qs.toString()}`, signal ? { signal } : {});
    return body.stats || {};
  }

  async function fetchReadings({ incremental = false, signal = null } = {}) {
    const qs = new URLSearchParams();
    if (incremental && lastDataTimestamp) {
      qs.set("start", String(lastDataTimestamp + 1));
      qs.set("bucket_ms", String(loadedBucketMs ?? bucketMsForRange()));
    } else {
      loadedBucketMs = bucketMsForRange();
      qs.set("start", String(range.startMs));
      qs.set("end", String(range.endMs));
      qs.set("bucket_ms", String(loadedBucketMs));
    }
    try {
      const rows = await fetchJson(`/api/readings?${qs.toString()}`, signal ? { signal } : {});
      const next = processReadingsData(rows || []);
      if (incremental && xVals.length > 0) {
        const lastSec = xVals[xVals.length - 1];
        let from = next.xVals.length;
        for (let i = 0; i < next.xVals.length; i++) {
          if (next.xVals[i] > lastSec) {
            from = i;
            break;
          }
        }
        if (from < next.xVals.length) {
          xVals = xVals.concat(next.xVals.slice(from));
          powerVals = powerVals.concat(next.yVals.slice(from));
          meterVals = meterVals.concat(next.eVals.slice(from));
        }
        if (range.live) trimToWindow();
      } else {
        xVals = next.xVals;
        powerVals = next.yVals;
        meterVals = next.eVals;
      }
      if (xVals.length > 0) lastDataTimestamp = xVals[xVals.length - 1] * 1000;
      recomputeDerived();
      setChartData();
      if (!incremental) setXScales();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      console.error("[readings] fetch failed:", e);
      reportFetchFailed();
    } finally {
      // Reveal even on failure so the loaders never hang; the status dot
      // carries the offline signal.
      if (!incremental) {
        revealChart("power");
        revealChart("meter");
      }
    }
  }

  function trimToWindow() {
    const minSec = Math.floor(range.startMs / 1000);
    let i = 0;
    while (i < xVals.length && xVals[i] < minSec) i++;
    if (i > 0) {
      xVals = xVals.slice(i);
      powerVals = powerVals.slice(i);
      meterVals = meterVals.slice(i);
    }
  }

  async function fetchWindowSummary() {
    try {
      const qs = new URLSearchParams({ start: String(range.startMs), end: String(range.endMs) });
      const data = await fetchJson(`/api/energy_summary?${qs.toString()}`);
      windowMovingAvg = data.moving_avg_30d || [];
      rebuildDailySeries(data.daily || []);
    } catch (e) {
      console.error("[energySummary] window fetch failed:", e);
      windowMovingAvg = [];
      rebuildDailySeries([]);
    } finally {
      if (charts.daily) charts.daily.setData([dayXs, dayKwh, dayTypical]);
      setXScales();
      revealChart("daily");
    }
  }

  /** Fixed 30-day summary: the typical baseline for tile deltas. */
  async function fetchTileSummary() {
    try {
      const now = Date.now();
      const qs = new URLSearchParams({ start: String(now - TILE_SUMMARY_LOOKBACK_MS), end: String(now) });
      const data = await fetchJson(`/api/energy_summary?${qs.toString()}`);
      avgDailyEnergyUsage = data.avg_daily ?? null;
      // Tiles may have rendered before the baseline arrived — fill deltas in
      renderWindowTiles();
      renderPeriodTiles();
    } catch (e) {
      console.error("[energySummary] tile fetch failed:", e);
    }
  }

  /**
   * transitions-dev number pop-in: re-render the watt digits and replay the
   * per-digit entry, but only when the value actually changed — the poller
   * fires every few seconds and an unchanged number should sit still.
   */
  function setLiveDigits(str) {
    const group = tile.livePower;
    if (!group || group.textContent === str) return;
    group.classList.remove("is-animating");
    const chars = str.split("");
    group.replaceChildren(
      ...chars.map((ch, i) => {
        const span = document.createElement("span");
        span.className = "t-digit";
        span.textContent = ch;
        if (i === chars.length - 2) span.dataset.stagger = "1";
        else if (i === chars.length - 1) span.dataset.stagger = "2";
        return span;
      })
    );
    void group.offsetHeight; // force reflow so the animation replays
    group.classList.add("is-animating");
  }

  /** The live tile: current draw, reading time, and the meter total. */
  function renderLiveTile(data) {
    setSkeleton(liveTileEls, false);
    const watts = data && data.w;
    const stale = !data || data.stale;
    if (tile.livePower) {
      setLiveDigits(watts == null ? "–" : Fmt.n(watts, 0));
      tile.livePower.classList.toggle("is-stale", Boolean(stale));
    }
    if (tile.liveTime) {
      tile.liveTime.textContent = formatAge(data && data.age_s) || "–";
    }
  }

  // ── Tiles ───────────────────────────────────────────────────────────────
  function renderDelta(el, realKwh, days) {
    const typical = avgDailyEnergyUsage && days ? avgDailyEnergyUsage * days : null;
    renderDeltaVsTypical(el, realKwh, typical);
  }

  function renderWindowTiles() {
    const s = lastWindowStats;
    if (!s) return;
    const kwh = s.energy_used_kwh;
    tile.energy.textContent = Fmt.n(kwh, 2);
    tile.energyCost.textContent = Fmt.n(kwh != null ? kwh * costPerKwh : null, 2);
    renderDelta(tile.energyDelta, kwh, (range.endMs - range.startMs) / DAY_MS);
    tile.avgPower.textContent = Fmt.n(s.avg_power_watts, 0);
    tile.minPower.textContent = Fmt.n(s.min_power_watts, 0);
    tile.maxPower.textContent = Fmt.n(s.max_power_watts, 0);
  }

  async function updateWindowTiles() {
    if (windowStatsController) windowStatsController.abort();
    windowStatsController = new AbortController();
    try {
      lastWindowStats = await fetchStats(range.startMs, range.endMs, windowStatsController.signal);
      renderWindowTiles();
      setSkeleton(windowTileEls, false);
    } catch (e) {
      // A superseded (aborted) request keeps the skeleton for its successor
      if (e.name === "AbortError") return;
      console.error("[windowTiles] stats fetch failed:", e);
      setSkeleton(windowTileEls, false);
    }
  }

  function renderPeriodTiles() {
    const p = lastPeriodStats;
    const rows = [
      [p.day, tile.day, tile.dayCost, tile.dayDelta, 1],
      [p.week, tile.week, tile.weekCost, tile.weekDelta, 7],
      [p.month, tile.month, tile.monthCost, tile.monthDelta, 30],
    ];
    for (const [stats, valueEl, costEl, deltaEl, days] of rows) {
      if (!stats) continue;
      const kwh = stats.energy_used_kwh;
      valueEl.textContent = Fmt.n(kwh, 2);
      costEl.textContent = Fmt.n(kwh != null ? kwh * costPerKwh : null, 2);
      renderDelta(deltaEl, kwh, days);
    }
    if (p.latest && tile.meterTotal) {
      tile.meterTotal.textContent = fmtGrouped(p.latest.energy_in_kwh, 2);
    }
  }

  async function updatePeriodTiles() {
    const now = Date.now();
    const results = await Promise.allSettled([
      fetchStats(now - DAY_MS, now),
      fetchStats(now - 7 * DAY_MS, now),
      fetchStats(now - 30 * DAY_MS, now),
      fetchJson("/api/latest_reading"),
    ]);
    const names = ["1-day stats", "7-day stats", "30-day stats", "latest reading"];
    results.forEach((r, i) => {
      if (r.status === "rejected") console.error(`[periodTiles] ${names[i]} failed:`, r.reason);
    });
    const [day, week, month, latest] = results.map((r) => (r.status === "fulfilled" ? r.value : null));
    lastPeriodStats = {
      day: day ?? lastPeriodStats.day,
      week: week ?? lastPeriodStats.week,
      month: month ?? lastPeriodStats.month,
      latest: latest ?? lastPeriodStats.latest,
    };
    renderPeriodTiles();
    setSkeleton(periodTileEls, false);
  }

  // ── Range control ───────────────────────────────────────────────────────
  function applyPreset(key) {
    range.presetKey = key;
    range.live = true;
    refreshLiveWindow();
    setSegmentedActive(key);
    if (btnLive) btnLive.classList.add("hidden");
    // Fire independently — each section reveals as its own data lands
    resetCharts();
    setSkeleton(windowTileEls, true);
    fetchReadings();
    fetchWindowSummary();
    updateWindowTiles();
  }

  function applyCustomRange(startMs, endMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;
    range.startMs = startMs;
    range.endMs = endMs;
    range.live = false;
    setSegmentedActive(null);
    if (btnLive) btnLive.classList.remove("hidden");
    setXScales();
    updateWindowTiles();
    if (bucketMsForRange() !== loadedBucketMs) {
      // The new duration crosses a resolution tier — refetch at the finer
      // (or coarser) bucket, then re-apply the scales on the fresh data.
      fetchReadings().then(setXScales);
    } else {
      // Same tier: just recompute the view-dependent derived series
      recomputeDerived();
      setChartData();
    }
  }

  function backToLive() {
    if (range.live) return;
    applyPreset(range.presetKey);
  }

  // ── Polling ─────────────────────────────────────────────────────────────
  async function poll() {
    if (pollController) pollController.abort();
    pollController = new AbortController();
    await fetchReadings({ incremental: true, signal: pollController.signal });
    if (range.live) {
      refreshLiveWindow();
      setXScales();
      updateWindowTiles();
    }
    updatePeriodTiles();
    pollTimer = setTimeout(poll, POLLING_MS);
  }

  // ── Controls ────────────────────────────────────────────────────────────
  rangeButtons.forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.range));
  });

  if (btnLive) btnLive.addEventListener("click", backToLive);

  if (btnRefresh) {
    btnRefresh.addEventListener("click", async () => {
      if (btnRefresh.disabled) return;
      btnRefresh.disabled = true;
      btnRefresh.classList.add("btn-loading");
      try {
        refreshLiveWindow();
        resetCharts();
        setSkeleton(windowTileEls, true);
        setSkeleton(periodTileEls, true);
        // Sections reveal independently; the button spins until all settle
        await Promise.allSettled([
          fetchReadings(),
          fetchWindowSummary(),
          fetchTileSummary(),
          updateWindowTiles(),
          updatePeriodTiles(),
        ]);
      } finally {
        btnRefresh.disabled = false;
        btnRefresh.classList.remove("btn-loading");
      }
    });
  }

  if (btnToggleScale) {
    btnToggleScale.addEventListener("click", () => {
      powerScaleMode = powerScaleMode === "auto" ? "fixed" : "auto";
      btnToggleScale.textContent = powerScaleMode === "auto" ? "Auto scale" : "Fixed scale";
      // The y-range is baked into the uPlot options, so rebuild this chart
      if (charts.power) {
        charts.power.destroy();
        charts.power = null;
      }
      initPowerChart();
      applySeriesShow("power");
      if (charts.power) {
        charts.power.setData([xVals, powerVals, rollingVals]);
        charts.power.setScale("x", { min: range.startMs / 1000, max: range.endMs / 1000 });
      }
    });
  }

  if (btnToggleAvgMode) {
    btnToggleAvgMode.addEventListener("click", () => {
      avgMode = avgMode === "30d" ? "total" : "30d";
      btnToggleAvgMode.textContent = avgMode === "30d" ? "30d avg" : "Total avg";
      if (typicalChipLabel) typicalChipLabel.textContent = avgMode === "30d" ? "30d avg" : "Total avg";
      rebuildTypicalSeries();
      if (charts.daily) charts.daily.setData([dayXs, dayKwh, dayTypical]);
    });
  }

  // Legend chips toggle their series
  document.querySelectorAll(".widget").forEach((widget) => {
    const chartKey = widget.classList.contains("widget--power")
      ? "power"
      : widget.classList.contains("widget--daily")
        ? "daily"
        : "meter";
    widget.querySelectorAll(".legend-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const idx = Number(chip.dataset.series);
        const show = !seriesShow[chartKey][idx];
        seriesShow[chartKey][idx] = show;
        chip.classList.toggle("inactive", !show);
        chip.setAttribute("aria-pressed", String(show));
        const u = charts[chartKey];
        if (u && u.series[idx]) u.setSeries(idx, { show });
      });
    });
  });

  function initCostInput() {
    costPerKwh = loadCostPerKwh();
    if (!costInput) return;
    costInput.value = String(costPerKwh);
    costInput.addEventListener("change", () => {
      const value = parseFloat(costInput.value);
      if (!Number.isNaN(value) && value >= 0) {
        costPerKwh = value;
        saveCostPerKwh(value);
        renderWindowTiles();
        renderPeriodTiles();
      }
    });
  }

  window.addEventListener("resize", () => {
    Object.values(charts).forEach((u) => {
      if (u) u.setSize(chartSize(u.root.parentElement));
    });
    movePill(activeRangeButton(), false);
  });

  window.addEventListener("pagehide", () => {
    clearTimeout(pollTimer);
    if (pollController) pollController.abort();
  });

  // ── Init ────────────────────────────────────────────────────────────────
  resetCharts();
  setSkeleton([...windowTileEls, ...periodTileEls, ...liveTileEls], true);
  initCharts();
  initCostInput();
  startLivePower(null, { statusEl: statusConn, onUpdate: renderLiveTile });
  // First paint: snap the pill to the active preset without a transition
  requestAnimationFrame(() => movePill(activeRangeButton(), false));

  // Everything fires at once; each section reveals as soon as its data lands.
  fetchReadings().then(() => {
    pollTimer = setTimeout(poll, POLLING_MS);
  });
  fetchWindowSummary();
  fetchTileSummary();
  updateWindowTiles();
  updatePeriodTiles();
})();
