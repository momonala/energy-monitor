/**
 * Compare page: two calendar (date) selectors for Period A and B.
 * On "Compare", fetch readings and stats for both ranges, then show two charts and comparison tables.
 */
(function () {
  "use strict";

  const EM = window.EnergyMonitor;
  const { fetchJson, Fmt, loadCostPerKwh, alignDailyDataToTimestamps, processReadingsData } = EM;
  if (!fetchJson || !Fmt || !loadCostPerKwh || !alignDailyDataToTimestamps || !processReadingsData) {
    console.error("Compare: EnergyMonitor (shared.js) must load first.");
    return;
  }

  const btnCompare = document.getElementById("btn-compare");
  const compareError = document.getElementById("compare-error");
  const compareWarning = document.getElementById("compare-warning");
  const compareLoading = document.getElementById("compare-loading");
  const compareResults = document.getElementById("compare-results");

  let uA = null;
  let uB = null;
  let calendarA = null;
  let calendarB = null;

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function showError(msg) {
    if (compareError) {
      compareError.textContent = msg;
      compareError.classList.remove("hidden");
    }
  }

  function clearError() {
    if (compareError) {
      compareError.textContent = "";
      compareError.classList.add("hidden");
    }
  }

  function showWarning(msg) {
    if (compareWarning) {
      compareWarning.textContent = msg;
      compareWarning.classList.remove("hidden");
    }
  }

  function clearWarning() {
    if (compareWarning) {
      compareWarning.textContent = "";
      compareWarning.classList.add("hidden");
    }
  }

  function setLoading(loading) {
    if (compareLoading) compareLoading.classList.toggle("hidden", !loading);
    if (btnCompare) {
      btnCompare.disabled = loading;
      btnCompare.classList.toggle("loading", loading);
    }
  }

  /**
   * Create a range calendar in containerEl. Click start date then end date; range is highlighted.
   * options.onRangeChange(startDate, endDate) is called when range is complete.
   * Returns { getRange() -> { startMs, endMs } | null, setRange(startDate, endDate) }.
   */
  function createRangeCalendar(containerEl, initialStart, initialEnd, options) {
    if (!containerEl) return null;
    options = options || {};
    let viewYear = (initialStart || new Date()).getFullYear();
    let viewMonth = (initialStart || new Date()).getMonth();
    let startDate = initialStart ? new Date(initialStart.getFullYear(), initialStart.getMonth(), initialStart.getDate()) : null;
    let endDate = initialEnd ? new Date(initialEnd.getFullYear(), initialEnd.getMonth(), initialEnd.getDate()) : null;
    let step = startDate && !endDate ? "end" : "start";

    const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

    function dateKey(d) {
      return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
    }

    function isInRange(d) {
      if (!startDate || !endDate) return false;
      const t = d.getTime();
      const s = startDate.getTime();
      const e = endDate.getTime();
      return t >= Math.min(s, e) && t <= Math.max(s, e);
    }

    function render() {
      const first = new Date(viewYear, viewMonth, 1);
      const last = new Date(viewYear, viewMonth + 1, 0);
      const startPad = first.getDay();
      const daysInMonth = last.getDate();
      const totalCells = Math.ceil((startPad + daysInMonth) / 7) * 7;
      let html = "";
      html += '<div class="range-calendar-nav">';
      html += '<button type="button" class="range-calendar-prev" aria-label="Previous month">&larr;</button>';
      html += '<span class="range-calendar-month">' + MONTHS[viewMonth] + " " + viewYear + "</span>";
      html += '<button type="button" class="range-calendar-next" aria-label="Next month">&rarr;</button>';
      html += "</div>";
      html += '<div class="range-calendar-weekdays">' + WEEKDAYS.map((w) => "<span>" + w + "</span>").join("") + "</div>";
      html += '<div class="range-calendar-days">';
      const todayKey = dateKey(new Date());
      for (let i = 0; i < totalCells; i++) {
        const dayOffset = i - startPad;
        const d = new Date(viewYear, viewMonth, dayOffset + 1);
        const key = dateKey(d);
        const isOther = d.getMonth() !== viewMonth;
        const isStart = startDate && key === dateKey(startDate);
        const isEnd = endDate && key === dateKey(endDate);
        const inRange = isInRange(d);
        let cls = "day";
        if (isOther) cls += " other-month";
        if (inRange) cls += " in-range";
        if (isStart) cls += " start";
        if (isEnd) cls += " end";
        html += '<button type="button" class="' + cls + '" data-date="' + key + '">' + d.getDate() + "</button>";
      }
      html += "</div>";
      containerEl.innerHTML = html;

      containerEl.querySelectorAll(".day").forEach((btn) => {
        btn.addEventListener("click", () => {
          const str = btn.getAttribute("data-date");
          const [y, m, day] = str.split("-").map(Number);
          const clicked = new Date(y, m - 1, day);
          if (step === "start") {
            startDate = clicked;
            endDate = null;
            step = "end";
          } else {
            endDate = clicked;
            if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
              const tmp = startDate;
              startDate = endDate;
              endDate = tmp;
            }
            step = "start";
          }
          render();
        });
      });
      containerEl.querySelector(".range-calendar-prev")?.addEventListener("click", () => {
        viewMonth--;
        if (viewMonth < 0) {
          viewMonth = 11;
          viewYear--;
        }
        render();
      });
      containerEl.querySelector(".range-calendar-next")?.addEventListener("click", () => {
        viewMonth++;
        if (viewMonth > 11) {
          viewMonth = 0;
          viewYear++;
        }
        render();
      });

      if (startDate && endDate && options.onRangeChange) options.onRangeChange(startDate, endDate);
    }

    render();
    return {
      getRange() {
        if (!startDate || !endDate) return null;
        const s = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0, 0);
        const e = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), 23, 59, 59, 999);
        return { startMs: s.getTime(), endMs: e.getTime() };
      },
      setRange(start, end) {
        startDate = start ? new Date(start.getFullYear(), start.getMonth(), start.getDate()) : null;
        endDate = end ? new Date(end.getFullYear(), end.getMonth(), end.getDate()) : null;
        step = startDate && !endDate ? "end" : "start";
        if (start) {
          viewYear = start.getFullYear();
          viewMonth = start.getMonth();
        }
        render();
        if (startDate && endDate && options.onRangeChange) options.onRangeChange(startDate, endDate);
      },
    };
  }

  function calculateRollingAvg(yVals) {
    if (yVals.length === 0) return [];
    const alpha = 0.0001;
    const out = new Array(yVals.length).fill(null);
    let ema = null;
    for (let i = 0; i < yVals.length; i++) {
      if (yVals[i] != null && Number.isFinite(yVals[i])) {
        ema = ema === null ? yVals[i] : alpha * yVals[i] + (1 - alpha) * ema;
        out[i] = ema;
      } else if (ema !== null) {
        out[i] = ema;
      }
    }
    return out;
  }

  function buildChartData(rows, dailyData, movingAvgData) {
    const { xVals, yVals, eVals } = processReadingsData(Array.isArray(rows) ? rows : []);
    const dailyEnergyVals = alignDailyDataToTimestamps(dailyData || [], xVals);
    const typicalDailyEnergyVals = alignDailyDataToTimestamps(movingAvgData || [], xVals);
    const rollingAvgVals = calculateRollingAvg(yVals);
    return { xVals, yVals, eVals, dailyEnergyVals, typicalDailyEnergyVals, rollingAvgVals };
  }

  function minMax(arr) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v != null && Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return min <= max ? { min, max } : null;
  }

  function combineMinMax(acc, next) {
    if (!next) return acc;
    if (!acc) return { min: next.min, max: next.max };
    return { min: Math.min(acc.min, next.min), max: Math.max(acc.max, next.max) };
  }

  function getSharedScales(dataA, dataB) {
    const yRange = [dataA, dataB].reduce(
      (acc, d) => combineMinMax(combineMinMax(acc, minMax(d?.yVals)), minMax(d?.rollingAvgVals)),
      null
    );
    const y2Range = [dataA, dataB].reduce((acc, d) => combineMinMax(acc, minMax(d?.eVals)), null);
    const y3Range = [dataA, dataB].reduce(
      (acc, d) => combineMinMax(combineMinMax(acc, minMax(d?.dailyEnergyVals)), minMax(d?.typicalDailyEnergyVals)),
      null
    );
    const scales = {};
    if (yRange) {
      if (yRange.min === yRange.max) yRange.max = yRange.min + 1;
      scales.y = yRange;
    }
    if (y2Range) {
      if (y2Range.min === y2Range.max) y2Range.max = y2Range.min + 1;
      scales.y2 = y2Range;
    }
    if (y3Range) {
      if (y3Range.min === y3Range.max) y3Range.max = y3Range.min + 1;
      scales.y3 = y3Range;
    }
    return scales;
  }

  function setHover(prefix, data, idx) {
    if (!data || idx == null || idx < 0) return clearHover(prefix);
    const { xVals, yVals, eVals, dailyEnergyVals, typicalDailyEnergyVals, rollingAvgVals } = data;
    const tMs = xVals[idx] != null ? xVals[idx] * 1000 : null;
    setText(`hover-${prefix}-time`, tMs != null ? Fmt.t(tMs) : "–");
    setText(`hover-${prefix}-meter`, Fmt.n(eVals?.[idx], 2));
    setText(`hover-${prefix}-daily`, dailyEnergyVals?.[idx] != null ? Fmt.n(dailyEnergyVals[idx], 2) : "–");
    setText(`hover-${prefix}-typical`, typicalDailyEnergyVals?.[idx] != null ? Fmt.n(typicalDailyEnergyVals[idx], 2) : "–");
    setText(`hover-${prefix}-power`, Fmt.n(yVals?.[idx], 0));
    setText(`hover-${prefix}-rolling`, Fmt.n(rollingAvgVals?.[idx], 0));
    const overlay = document.getElementById(`hover-overlay-${prefix}`);
    if (overlay) overlay.classList.remove("hidden");
  }

  function clearHover(prefix) {
    setText(`hover-${prefix}-time`, "–");
    setText(`hover-${prefix}-meter`, "–");
    setText(`hover-${prefix}-daily`, "–");
    setText(`hover-${prefix}-typical`, "–");
    setText(`hover-${prefix}-power`, "–");
    setText(`hover-${prefix}-rolling`, "–");
    const overlay = document.getElementById(`hover-overlay-${prefix}`);
    if (overlay) overlay.classList.add("hidden");
  }

  function createChart(containerEl, data, label, sharedScales) {
    if (!window.uPlot || !containerEl || !data.xVals.length) return null;
    const { xVals, yVals, eVals, dailyEnergyVals, typicalDailyEnergyVals, rollingAvgVals } = data;
    const width = containerEl.clientWidth || 400;
    const height = containerEl.clientHeight || 280;
    const prefix = label.toLowerCase();
    const scales = {
      x: { time: true },
      y: sharedScales?.y || { auto: true },
      y2: sharedScales?.y2 || { auto: true },
      y3: sharedScales?.y3 || { auto: true },
    };
    const opts = {
      width,
      height,
      scales,
      axes: [
        { stroke: "#a3a3a3", grid: { stroke: "rgba(255,255,255,0.06)" }, ticks: { stroke: "rgba(255,255,255,0.12)" }, size: 40 },
        { label: "W", stroke: "#a3a3a3", grid: { show: false }, size: 40 },
        { side: 1, label: "kWh", stroke: "rgb(235, 133, 37)", grid: { show: false }, scale: "y2", size: 40 },
        { side: 1, label: "Daily", stroke: "rgb(255, 220, 50)", grid: { show: false }, scale: "y3", size: 40 },
      ],
      series: [
        {},
        { label: "Power", stroke: "rgba(37, 99, 235, 1)", fill: "rgba(37,99,235,0.12)", width: 1.5, scale: "y" },
        { label: "Daily", stroke: "rgb(255, 220, 50)", width: 2, scale: "y3" },
        { label: "Avg P", stroke: "rgb(96, 165, 250)", width: 1.5, scale: "y" },
        { label: "Meter", stroke: "rgb(235, 133, 37)", width: 1.5, scale: "y2" },
        { label: "30d", stroke: "rgba(168, 85, 247, 0.5)", width: 2, scale: "y3" },
      ],
      legend: { show: false },
      hooks: {
        setCursor: [
          (uInst) => {
            const idx = uInst.cursor && Number.isInteger(uInst.cursor.idx) ? uInst.cursor.idx : null;
            if (idx != null) setHover(prefix, data, idx);
            else clearHover(prefix);
          },
        ],
      },
    };
    const u = new uPlot(
      opts,
      [xVals, yVals, dailyEnergyVals, rollingAvgVals, eVals, typicalDailyEnergyVals],
      containerEl
    );
    if (xVals.length) u.setScale("x", { min: xVals[0], max: xVals[xVals.length - 1] });
    clearHover(prefix);
    return u;
  }

  function getEndOfTodayMs() {
    const d = new Date();
    const startOfTomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    return startOfTomorrow.getTime() - 1;
  }

  function trimRangeToToday(range) {
    if (!range || !Number.isFinite(range.startMs) || !Number.isFinite(range.endMs)) return null;
    const endOfToday = getEndOfTodayMs();
    return {
      startMs: range.startMs,
      endMs: Math.min(range.endMs, endOfToday),
    };
  }

  function daysInRange(range) {
    if (!range || !Number.isFinite(range.startMs) || !Number.isFinite(range.endMs)) return null;
    return Math.ceil((range.endMs - range.startMs) / (24 * 60 * 60 * 1000));
  }

  function renderPeriodStats(prefix, stats, range) {
    const kwh = stats?.energy_used_kwh;
    const costPerKwh = loadCostPerKwh();
    const cost = kwh != null && Number.isFinite(kwh) ? kwh * costPerKwh : null;
    const days = daysInRange(range);
    const dailyAvg = kwh != null && days != null && days > 0 ? kwh / days : null;
    setText(`${prefix}-energy`, Fmt.n(kwh, 2));
    setText(`${prefix}-daily-avg`, Fmt.n(dailyAvg, 2));
    setText(`${prefix}-cost`, Fmt.n(cost, 2));
    setText(`${prefix}-days`, days != null ? String(days) : "–");
    setText(`${prefix}-power-avg`, Fmt.n(stats?.avg_power_watts, 0));
    setText(`${prefix}-count`, stats?.count != null ? String(stats.count) : "–");
  }

  function formatDiffValueNoSign(val, digits, suffix) {
    if (val == null || !Number.isFinite(val)) return "–";
    return Fmt.n(Math.abs(val), digits) + (suffix || "");
  }

  /** Returns { text, direction: 'more'|'less'|'neutral' } for diff display with arrow and green/red. */
  function formatDiffWithArrow(absoluteVal, pctVal, absDigits, absSuffix) {
    if (absoluteVal == null || !Number.isFinite(absoluteVal)) return { text: "–", direction: "neutral" };
    const arrow = absoluteVal > 0 ? "↑ " : absoluteVal < 0 ? "↓ " : "";
    const direction = absoluteVal > 0 ? "more" : absoluteVal < 0 ? "less" : "neutral";
    const absStr = formatDiffValueNoSign(absoluteVal, absDigits, absSuffix);
    const pctStr = pctVal != null && Number.isFinite(pctVal) ? formatDiffValueNoSign(pctVal, 1, "%") : "";
    const text = arrow + absStr + (pctStr ? " (" + pctStr + ")" : "");
    return { text, direction };
  }

  function setDiffBox(id, absoluteVal, pctVal, absDigits, absSuffix) {
    const el = document.getElementById(id);
    if (!el) return;
    const { text, direction } = formatDiffWithArrow(absoluteVal, pctVal, absDigits, absSuffix);
    const rest = text.replace(/^[↑↓]\s/, "");
    if (direction === "less") {
      el.innerHTML = '<span class="diff-value-less">↓</span> ' + rest;
    } else if (direction === "more") {
      el.innerHTML = '<span class="diff-value-more">↑</span> ' + rest;
    } else {
      el.textContent = text;
    }
  }

  function renderDiff(statsA, statsB, rangeA, rangeB) {
    const a = statsA?.energy_used_kwh;
    const b = statsB?.energy_used_kwh;
    const costPerKwh = loadCostPerKwh();
    const diffKwh = a != null && b != null && Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
    const diffPct = a != null && b != null && Number.isFinite(a) && Number.isFinite(b) && a !== 0 ? ((b - a) / a) * 100 : null;
    const diffCost = diffKwh != null && Number.isFinite(diffKwh) ? diffKwh * costPerKwh : null;

    setDiffBox("diff-energy", diffKwh, diffPct, 2, " kWh");

    const daysA = daysInRange(rangeA);
    const daysB = daysInRange(rangeB);
    const dailyAvgA = a != null && daysA != null && daysA > 0 ? a / daysA : null;
    const dailyAvgB = b != null && daysB != null && daysB > 0 ? b / daysB : null;
    const diffDailyAvg = dailyAvgA != null && dailyAvgB != null ? dailyAvgB - dailyAvgA : null;
    const dailyAvgPct = dailyAvgA != null && dailyAvgA !== 0 && Number.isFinite(dailyAvgB) ? ((dailyAvgB - dailyAvgA) / dailyAvgA) * 100 : null;
    setDiffBox("diff-daily-avg", diffDailyAvg, dailyAvgPct, 2, " kWh/day");

    const avgA = statsA?.avg_power_watts;
    const avgB = statsB?.avg_power_watts;
    const diffPowerAvg = avgA != null && avgB != null && Number.isFinite(avgA) && Number.isFinite(avgB) ? avgB - avgA : null;
    const powerPct = avgA != null && avgA !== 0 && Number.isFinite(avgB) ? ((avgB - avgA) / avgA) * 100 : null;
    setDiffBox("diff-power-avg", diffPowerAvg, powerPct, 0, " W");

    const costA = a != null && Number.isFinite(a) ? a * costPerKwh : null;
    const costB = b != null && Number.isFinite(b) ? b * costPerKwh : null;
    const costPct = costA != null && costA !== 0 && Number.isFinite(costB) ? ((costB - costA) / costA) * 100 : null;
    setDiffBox("diff-cost", diffCost, costPct, 2, " €");

    const avgCostPerDayA = costA != null && daysA != null && daysA > 0 ? costA / daysA : null;
    const avgCostPerDayB = costB != null && daysB != null && daysB > 0 ? costB / daysB : null;
    const diffCostPerDay = avgCostPerDayA != null && avgCostPerDayB != null ? avgCostPerDayB - avgCostPerDayA : null;
    const costPerDayPct = avgCostPerDayA != null && avgCostPerDayA !== 0 && Number.isFinite(avgCostPerDayB) ? ((avgCostPerDayB - avgCostPerDayA) / avgCostPerDayA) * 100 : null;
    setDiffBox("diff-cost-per-day", diffCostPerDay, costPerDayPct, 2, " €/day");

    const diffArrowEl = document.getElementById("diff-arrow");
    if (diffArrowEl) {
      diffArrowEl.classList.remove("diff-arrow-less", "diff-arrow-more");
      if (diffKwh != null && diffKwh < 0) {
        diffArrowEl.textContent = "↓";
        diffArrowEl.classList.add("diff-arrow-less");
      } else if (diffKwh != null && diffKwh > 0) {
        diffArrowEl.textContent = "↑";
        diffArrowEl.classList.add("diff-arrow-more");
      } else {
        diffArrowEl.textContent = "";
      }
    }
  }

  function getDefaultCompareRanges() {
    const today = new Date();
    const day = today.getDay();
    const thisWeekStart = new Date(today);
    thisWeekStart.setHours(0, 0, 0, 0);
    thisWeekStart.setDate(thisWeekStart.getDate() - day);
    const thisWeekEnd = new Date(today);

    const fourWeeksAgo = new Date(today);
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
    const dayA = fourWeeksAgo.getDay();
    const monthAgoWeekStart = new Date(fourWeeksAgo);
    monthAgoWeekStart.setHours(0, 0, 0, 0);
    monthAgoWeekStart.setDate(monthAgoWeekStart.getDate() - dayA);
    const monthAgoWeekEnd = new Date(monthAgoWeekStart);
    monthAgoWeekEnd.setDate(monthAgoWeekEnd.getDate() + 6);

    return { monthAgoWeekStart, monthAgoWeekEnd, thisWeekStart, thisWeekEnd };
  }

  function setDefaultDates() {
    const def = getDefaultCompareRanges();
    if (calendarA) calendarA.setRange(def.monthAgoWeekStart, def.monthAgoWeekEnd);
    if (calendarB) calendarB.setRange(def.thisWeekStart, def.thisWeekEnd);
  }

  async function runCompare() {
    const rangeA = calendarA?.getRange() ?? null;
    const rangeB = calendarB?.getRange() ?? null;
    if (!rangeA || !rangeB) {
      showError("Select a date range in both calendars (click start date, then end date).");
      return;
    }

    const trimmedA = trimRangeToToday(rangeA);
    const trimmedB = trimRangeToToday(rangeB);

    clearError();
    clearWarning();
    setLoading(true);
    if (compareResults) {
      compareResults.classList.add("hidden");
      compareResults.classList.remove("visible");
    }

    if (uA) {
      uA.destroy();
      uA = null;
    }
    if (uB) {
      uB.destroy();
      uB = null;
    }

    try {
      const [statsARes, statsBRes, readingsARes, readingsBRes, summaryRes] = await Promise.all([
        fetchJson(`/api/stats?start=${trimmedA.startMs}&end=${trimmedA.endMs}`),
        fetchJson(`/api/stats?start=${trimmedB.startMs}&end=${trimmedB.endMs}`),
        fetchJson(`/api/readings?start=${trimmedA.startMs}&end=${trimmedA.endMs}`),
        fetchJson(`/api/readings?start=${trimmedB.startMs}&end=${trimmedB.endMs}`),
        fetchJson("/api/energy_summary"),
      ]);

      const statsA = statsARes?.stats ?? null;
      const statsB = statsBRes?.stats ?? null;
      const dailyData = summaryRes?.daily ?? [];
      const movingAvgData = summaryRes?.moving_avg_30d ?? [];

      const energyMissingA = statsA?.energy_used_kwh == null;
      const energyMissingB = statsB?.energy_used_kwh == null;
      if (energyMissingA || energyMissingB) {
        const parts = [];
        if (energyMissingA && energyMissingB) {
          parts.push("Energy (kWh) could not be calculated for either period");
        } else if (energyMissingA) {
          parts.push("Energy (kWh) could not be calculated for Period A");
        } else {
          parts.push("Energy (kWh) could not be calculated for Period B");
        }
        parts.push(
          "— cumulative meter data is missing in that range (e.g. meter reset or gaps). " +
            "Power, days, and data points are still shown where available."
        );
        showWarning(parts.join(" "));
      }

      renderPeriodStats("stat-a", statsA, trimmedA);
      renderPeriodStats("stat-b", statsB, trimmedB);
      renderDiff(statsA, statsB, trimmedA, trimmedB);

      if (compareResults) {
        compareResults.classList.remove("hidden");
        requestAnimationFrame(() => compareResults.classList.add("visible"));
      }

      const dataA = buildChartData(readingsARes, dailyData, movingAvgData);
      const dataB = buildChartData(readingsBRes, dailyData, movingAvgData);

      const sharedScales = getSharedScales(dataA, dataB);

      const chartAEl = document.getElementById("chart-a");
      const chartBEl = document.getElementById("chart-b");
      if (chartAEl && dataA.xVals.length > 0) {
        uA = createChart(chartAEl, dataA, "A", sharedScales);
      }
      if (chartBEl && dataB.xVals.length > 0) {
        uB = createChart(chartBEl, dataB, "B", sharedScales);
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to load data.");
    } finally {
      setLoading(false);
    }
  }

  function onResize() {
    const chartAEl = document.getElementById("chart-a");
    const chartBEl = document.getElementById("chart-b");
    if (uA && chartAEl) {
      const w = chartAEl.clientWidth;
      const h = chartAEl.clientHeight;
      if (w && h) uA.setSize({ width: w, height: h });
    }
    if (uB && chartBEl) {
      const w = chartBEl.clientWidth;
      const h = chartBEl.clientHeight;
      if (w && h) uB.setSize({ width: w, height: h });
    }
  }

  const calendarAContainer = document.getElementById("calendar-a");
  const calendarBContainer = document.getElementById("calendar-b");
  const dropdownA = document.getElementById("dropdown-calendar-a");
  const dropdownB = document.getElementById("dropdown-calendar-b");
  const triggerA = document.getElementById("trigger-period-a");
  const triggerB = document.getElementById("trigger-period-b");
  const rangeTextA = document.getElementById("range-text-a");
  const rangeTextB = document.getElementById("range-text-b");

  function formatRangeLabel(startDate, endDate) {
    if (!startDate || !endDate) return "";
    const opts = { day: "numeric", month: "short" };
    const sameYear = startDate.getFullYear() === endDate.getFullYear();
    const startOpts = sameYear ? opts : { ...opts, year: "numeric" };
    const endOpts = { ...opts, year: "numeric" };
    return startDate.toLocaleDateString("en-GB", startOpts) + " – " + endDate.toLocaleDateString("en-GB", endOpts);
  }

  function updateRangeDisplay(rangeEl, startDate, endDate) {
    if (!rangeEl) return;
    rangeEl.textContent = startDate && endDate ? formatRangeLabel(startDate, endDate) : "Select dates";
  }

  function setupCalendarToggle(trigger, dropdown) {
    if (!trigger || !dropdown) return;
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const isCollapsed = dropdown.classList.toggle("collapsed");
      trigger.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    });
  }

  function closePopoverIfOutside(target, trigger, dropdown) {
    if (!dropdown || !trigger || !target) return;
    if (!dropdown.classList.contains("collapsed") && !dropdown.contains(target) && !trigger.contains(target)) {
      dropdown.classList.add("collapsed");
      trigger.setAttribute("aria-expanded", "false");
    }
  }

  /* Use mousedown so we run before calendar day click handlers; those replace innerHTML so the
   * clicked node is detached by the time "click" bubbles, and we would wrongly close. */
  document.addEventListener("mousedown", (e) => {
    closePopoverIfOutside(e.target, triggerA, dropdownA);
    closePopoverIfOutside(e.target, triggerB, dropdownB);
  });

  const def = getDefaultCompareRanges();
  if (calendarAContainer) {
    calendarA = createRangeCalendar(calendarAContainer, def.monthAgoWeekStart, def.monthAgoWeekEnd, {
      onRangeChange(startDate, endDate) {
        updateRangeDisplay(rangeTextA, startDate, endDate);
      },
    });
    setupCalendarToggle(triggerA, dropdownA);
  }
  if (calendarBContainer) {
    calendarB = createRangeCalendar(calendarBContainer, def.thisWeekStart, def.thisWeekEnd, {
      onRangeChange(startDate, endDate) {
        updateRangeDisplay(rangeTextB, startDate, endDate);
      },
    });
    setupCalendarToggle(triggerB, dropdownB);
  }

  setDefaultDates();
  updateRangeDisplay(rangeTextA, def.monthAgoWeekStart, def.monthAgoWeekEnd);
  updateRangeDisplay(rangeTextB, def.thisWeekStart, def.thisWeekEnd);

  if (btnCompare) btnCompare.addEventListener("click", runCompare);
  window.addEventListener("resize", onResize);
})();
