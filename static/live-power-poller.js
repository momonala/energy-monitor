/**
 * Energy Monitor - live power poller state machine.
 *
 * Phases:
 *   idle     created, not started
 *   polling  a request is in flight or the next one is scheduled at the regular interval
 *   backoff  the last request failed; the retry waits min(interval * 2^failures, max)
 *   paused   the page is hidden; nothing is in flight or scheduled
 *   stopped  terminal
 *
 * Only transition() touches the poll timer, the age ticker and the abort controller.
 */

const LIVE_POWER_INTERVAL_MS = 5000;
const LIVE_POWER_MAX_BACKOFF_MS = 30000;
const LIVE_POWER_AGE_TICK_MS = 1000;

function liveBackoffDelay(failures, intervalMs, maxBackoffMs) {
  return Math.min(intervalMs * 2 ** failures, maxBackoffMs);
}

function extrapolateAge(sample, nowMs) {
  if (sample == null || sample.seconds == null) return null;
  return sample.seconds + (nowMs - sample.at) / 1000;
}

/**
 * @param {{
 *   fetchPower: (signal: AbortSignal) => Promise<object|null>,
 *   isHidden: () => boolean,
 *   onData: (data: object|null) => void,
 *   onFailure: (error: Error) => void,
 *   onAge?: ((seconds: number|null) => void) | null,
 *   intervalMs?: number,
 *   maxBackoffMs?: number,
 *   clock?: {setTimeout, clearTimeout, setInterval, clearInterval, now: () => number},
 * }} options
 */
function createLivePowerPoller({
  fetchPower,
  isHidden,
  onData,
  onFailure,
  onAge = null,
  intervalMs = LIVE_POWER_INTERVAL_MS,
  maxBackoffMs = LIVE_POWER_MAX_BACKOFF_MS,
  clock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    now: () => Date.now(),
  },
}) {
  let phase = { name: "idle" };
  let timer = null;
  let ageTimer = null;
  let controller = null;
  let ageSample = null;

  const inFlightPhases = new Set(["polling", "backoff"]);

  function request() {
    if (controller) controller.abort();
    controller = new AbortController();
    const { signal } = controller;
    (async () => {
      try {
        const data = await fetchPower(signal);
        transition({ type: "success", data });
      } catch (error) {
        if (error && error.name === "AbortError") return;
        transition({ type: "failure", error });
      }
    })();
  }

  function schedule(delayMs) {
    timer = clock.setTimeout(() => transition({ type: "due" }), delayMs);
  }

  function halt() {
    clock.clearTimeout(timer);
    clock.clearInterval(ageTimer);
    ageTimer = null;
    if (controller) controller.abort();
  }

  function emitAge() {
    onAge(extrapolateAge(ageSample, clock.now()));
  }

  function recordAge(data, tick) {
    if (!onAge) return;
    ageSample = { seconds: data && data.age_s != null ? data.age_s : null, at: clock.now() };
    emitAge();
    if (tick && !ageTimer) ageTimer = clock.setInterval(emitAge, LIVE_POWER_AGE_TICK_MS);
  }

  function transition(event) {
    const active = inFlightPhases.has(phase.name);
    const stopped = phase.name === "stopped";
    if (stopped && event.type !== "success" && event.type !== "failure") return phase;
    switch (event.type) {
      case "start":
        if (phase.name !== "idle") break;
        if (isHidden()) {
          phase = { name: "paused" };
        } else {
          phase = { name: "polling" };
          request();
        }
        break;
      case "due":
        if (active) request();
        break;
      case "success":
        if (active) phase = { name: "polling" };
        recordAge(event.data, active);
        onData(event.data);
        if (active) schedule(intervalMs);
        break;
      case "failure": {
        const failures = active ? (phase.name === "backoff" ? phase.failures : 0) + 1 : 0;
        if (active) phase = { name: "backoff", failures };
        onFailure(event.error);
        if (active) schedule(liveBackoffDelay(failures, intervalMs, maxBackoffMs));
        break;
      }
      case "hide":
        halt();
        phase = { name: "paused" };
        break;
      case "show":
        phase = { name: "polling" };
        request();
        break;
      case "stop":
        halt();
        phase = { name: "stopped" };
        break;
    }
    return phase;
  }

  return {
    start: () => transition({ type: "start" }),
    hide: () => transition({ type: "hide" }),
    show: () => transition({ type: "show" }),
    stop: () => transition({ type: "stop" }),
    get phase() {
      return phase;
    },
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    LIVE_POWER_INTERVAL_MS,
    LIVE_POWER_MAX_BACKOFF_MS,
    LIVE_POWER_AGE_TICK_MS,
    liveBackoffDelay,
    extrapolateAge,
    createLivePowerPoller,
  };
}
