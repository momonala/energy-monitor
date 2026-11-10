const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createLivePowerPoller } = require(path.join(__dirname, "..", "..", "static", "live-power-poller.js"));

function fakeClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  let nextId = 1;
  const pending = new Map();
  const add = (fn, ms, every) => {
    const id = nextId++;
    pending.set(id, { fn, at: now + ms, every });
    return id;
  };
  const clock = {
    setTimeout: (fn, ms) => add(fn, ms, null),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearTimeout: (id) => pending.delete(id),
    clearInterval: (id) => pending.delete(id),
    now: () => now,
    timeouts: () => [...pending.values()].filter((t) => t.every == null).map((t) => t.at - now),
    intervals: () => [...pending.values()].filter((t) => t.every != null).length,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every == null) pending.delete(id);
        else t.at += t.every;
        t.fn();
      }
      now = target;
    },
  };
  return clock;
}

function fakeFetch({ ignoreAbort = false } = {}) {
  const calls = [];
  const fetchPower = (signal) =>
    new Promise((resolve, reject) => {
      const call = { signal, resolve, reject: (e) => reject(e) };
      signal.addEventListener("abort", () => {
        if (ignoreAbort) return;
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
      calls.push(call);
    });
  return { calls, fetchPower };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup({ hidden = false, withAge = true, ignoreAbort = false } = {}) {
  const clock = fakeClock();
  const net = fakeFetch({ ignoreAbort });
  const events = [];
  const state = { hidden };
  const poller = createLivePowerPoller({
    fetchPower: net.fetchPower,
    isHidden: () => state.hidden,
    onData: (data) => events.push(["data", data]),
    onFailure: (error) => events.push(["failure", error.message]),
    onAge: withAge ? (seconds) => events.push(["age", seconds]) : null,
    clock,
  });
  return { clock, net, events, state, poller };
}

async function succeed(net, data) {
  net.calls.at(-1).resolve(data);
  await flush();
}

async function fail(net, message = "HTTP 500") {
  net.calls.at(-1).reject(new Error(message));
  await flush();
}

test("start while visible fetches at once and polls every interval after a success", async () => {
  const { clock, net, events, poller } = setup();
  poller.start();
  assert.equal(poller.phase.name, "polling");
  assert.equal(net.calls.length, 1);

  await succeed(net, { w: 500, age_s: 2 });
  assert.deepEqual(clock.timeouts(), [5000]);
  assert.deepEqual(events, [
    ["age", 2],
    ["data", { w: 500, age_s: 2 }],
  ]);

  clock.advance(4999);
  assert.equal(net.calls.length, 1);
  clock.advance(1);
  assert.equal(net.calls.length, 2);
  assert.equal(poller.phase.name, "polling");
});

test("start while hidden does nothing until shown", async () => {
  const { clock, net, state, poller } = setup({ hidden: true });
  poller.start();
  assert.equal(poller.phase.name, "paused");
  assert.equal(net.calls.length, 0);
  assert.deepEqual(clock.timeouts(), []);

  state.hidden = false;
  poller.show();
  assert.equal(poller.phase.name, "polling");
  assert.equal(net.calls.length, 1);
});

test("consecutive failures back off 10s, 20s, 30s, 30s and report each failure", async () => {
  const { clock, net, events, poller } = setup();
  poller.start();
  const delays = [];
  for (let i = 0; i < 4; i++) {
    await fail(net);
    assert.deepEqual(poller.phase, { name: "backoff", failures: i + 1 });
    delays.push(...clock.timeouts());
    clock.advance(clock.timeouts()[0]);
  }
  assert.deepEqual(delays, [10000, 20000, 30000, 30000]);
  assert.equal(net.calls.length, 5);
  assert.deepEqual(
    events.filter(([kind]) => kind === "failure"),
    Array(4).fill(["failure", "HTTP 500"]),
  );
});

test("a success resets the backoff", async () => {
  const { clock, net, poller } = setup();
  poller.start();
  await fail(net);
  clock.advance(10000);
  await fail(net);
  clock.advance(20000);
  await succeed(net, { w: 1, age_s: 0 });
  assert.deepEqual(poller.phase, { name: "polling" });
  assert.deepEqual(clock.timeouts(), [5000]);

  clock.advance(5000);
  await fail(net);
  assert.deepEqual(poller.phase, { name: "backoff", failures: 1 });
  assert.deepEqual(clock.timeouts(), [10000]);
});

test("hiding aborts the request, clears timers and stays silent", async () => {
  const { clock, net, events, poller } = setup();
  poller.start();
  await succeed(net, { w: 1, age_s: 0 });
  clock.advance(5000);
  assert.equal(net.calls.length, 2);
  poller.hide();
  await flush();
  assert.equal(poller.phase.name, "paused");
  assert.equal(net.calls[1].signal.aborted, true);
  assert.deepEqual(clock.timeouts(), []);
  assert.equal(clock.intervals(), 0);
  assert.equal(events.filter(([kind]) => kind === "failure").length, 0);
});

test("showing after a backoff resets failures and fetches at once", async () => {
  const { clock, net, poller } = setup();
  poller.start();
  await fail(net);
  clock.advance(10000);
  await fail(net);
  assert.deepEqual(poller.phase, { name: "backoff", failures: 2 });
  poller.hide();
  poller.show();
  assert.deepEqual(poller.phase, { name: "polling" });
  assert.equal(net.calls.length, 3);
  await fail(net);
  assert.deepEqual(poller.phase, { name: "backoff", failures: 1 });
  assert.deepEqual(clock.timeouts(), [10000]);
});

test("a failure that lands after hiding is rendered but not rescheduled", async () => {
  const { clock, net, events, poller } = setup({ ignoreAbort: true });
  poller.start();
  poller.hide();
  await fail(net, "late");
  assert.equal(poller.phase.name, "paused");
  assert.deepEqual(clock.timeouts(), []);
  assert.deepEqual(events, [["failure", "late"]]);
  poller.show();
  await fail(net);
  assert.deepEqual(poller.phase, { name: "backoff", failures: 1 });
});

test("age ticks once a second after a success, survives failures, stops on hide", async () => {
  const { clock, net, events, poller } = setup();
  poller.start();
  await succeed(net, { w: 1, age_s: 3 });
  events.length = 0;
  clock.advance(1000);
  clock.advance(1000);
  assert.deepEqual(events, [
    ["age", 4],
    ["age", 5],
  ]);

  clock.advance(3000);
  await fail(net);
  assert.equal(clock.intervals(), 1);

  poller.hide();
  assert.equal(clock.intervals(), 0);
  poller.show();
  assert.equal(clock.intervals(), 0);
  await succeed(net, { w: 1, age_s: null });
  assert.equal(clock.intervals(), 1);
  assert.deepEqual(events.at(-2), ["age", null]);
});

test("without an age callback no ticker runs", async () => {
  const { clock, net, events, poller } = setup({ withAge: false });
  poller.start();
  await succeed(net, { w: 1, age_s: 3 });
  assert.equal(clock.intervals(), 0);
  assert.deepEqual(events, [["data", { w: 1, age_s: 3 }]]);
});

test("a throwing data handler counts as a failure", async () => {
  const clock = fakeClock();
  const net = fakeFetch();
  const failures = [];
  const poller = createLivePowerPoller({
    fetchPower: net.fetchPower,
    isHidden: () => false,
    onData: () => {
      throw new Error("render broke");
    },
    onFailure: (e) => failures.push(e.message),
    clock,
  });
  poller.start();
  await succeed(net, { w: 1 });
  assert.deepEqual(failures, ["render broke"]);
  assert.deepEqual(poller.phase, { name: "backoff", failures: 1 });
  assert.deepEqual(clock.timeouts(), [10000]);
});

test("stop is terminal: aborts, clears timers, ignores visibility", async () => {
  const { clock, net, poller } = setup();
  poller.start();
  await succeed(net, { w: 1, age_s: 0 });
  clock.advance(5000);
  poller.stop();
  await flush();
  assert.equal(net.calls[1].signal.aborted, true);
  assert.deepEqual(clock.timeouts(), []);
  assert.equal(clock.intervals(), 0);
  poller.show();
  poller.start();
  assert.equal(poller.phase.name, "stopped");
  assert.equal(net.calls.length, 2);
});
