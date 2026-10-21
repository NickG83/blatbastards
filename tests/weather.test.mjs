import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/api/weather.js";

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
const shift = days => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const point = (changes = {}) => ({ latitude: -37.052, longitude: 146.088, date: shift(2), period: "morning", ...changes });
const hours = Array.from({ length: 24 }, (_, hour) => hour);
const provider = (changes = {}, date = shift(2), timezone = "Australia/Sydney") => ({ timezone, hourly: {
  time: hours.map(hour => `${date}T${String(hour).padStart(2, "0")}:00`),
  weather_code: hours.map(() => 2), temperature_2m: hours.map(hour => hour + 10),
  precipitation_probability: hours.map(hour => hour), precipitation: hours.map(() => 0.1),
  wind_speed_10m: hours.map(hour => hour + 5), wind_gusts_10m: hours.map(hour => hour + 20),
  ...changes,
} });
async function request(points = [point()], options = {}) {
  const url = new URL("https://bbb.example/api/weather");
  url.searchParams.set("points", JSON.stringify(points));
  const pending = [];
  const response = await onRequest({ request: new Request(url, options), waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);
  return { response, body: await response.json() };
}

test("single point: normalises hourly period values and requests metric hourly best-match data", async context => {
  const warning = context.mock.method(console, "warn", () => {});
  const fetchMock = context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.origin, "https://api.open-meteo.com");
    assert.equal(options.redirect, "manual");
    assert.equal(url.searchParams.get("start_date"), shift(2));
    assert.equal(url.searchParams.get("end_date"), shift(2));
    assert.equal(url.searchParams.get("timezone"), "auto");
    assert.equal(url.searchParams.get("wind_speed_unit"), "kmh");
    assert.equal(url.searchParams.get("hourly"), "weather_code,temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m");
    assert.equal(url.searchParams.has("daily"), false);
    assert.equal(url.searchParams.get("temperature_unit"), "celsius");
    assert.equal(url.searchParams.get("precipitation_unit"), "mm");
    assert.equal(url.searchParams.has("models"), false);
    return Response.json(provider());
  });
  const { response, body } = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-BBB-Weather-Diagnostic"), "ok");
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(body.forecasts[0], {
    id: "0", date: shift(2), period: "morning", status: "forecast", localTimeZone: "Australia/Sydney", condition: "partly-cloudy", conditionLabel: "Partly cloudy",
    temperatureMaxC: 20, temperatureMinC: 16, precipitationProbability: 10, precipitationMm: 0.5, windMaxKmh: 15, gustMaxKmh: 30, hazards: [],
  });
  assert.equal(body.source, "Open-Meteo");
  assert.equal(body.horizonDays, 16);
  assert.ok(!JSON.stringify(body).includes("temperature_2m"));
  assert.equal(warning.mock.callCount(), 0);
});

test("multiple points use one upstream batch and deterministic input indexes", async context => {
  const fetchMock = context.mock.method(globalThis, "fetch", async url => {
    assert.equal(url.searchParams.get("latitude"), "-37.052,-34");
    return Response.json([provider(), provider({ weather_code: hours.map(() => 80) })]);
  });
  const { body } = await request([point(), point({ latitude: -34, period: "afternoon" })]);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(body.forecasts.map(forecast => forecast.id), ["0", "1"]);
  assert.equal(body.forecasts[1].condition, "showers");
});

for (const [label, points] of [
  ["invalid latitude", [point({ latitude: 91 })]],
  ["invalid longitude", [point({ longitude: -181 })]],
  ["numeric string", [point({ latitude: "-37" })]],
  ["null coordinate", [point({ longitude: null })]],
  ["invalid calendar date", [point({ date: "2026-02-30" })]],
  ["non-ISO date", [point({ date: "23/10/2026" })]],
  ["missing point", [null]], ["empty list", []],
  ["excessive count", Array.from({ length: 31 }, () => point())],
]) test(label, async context => {
  const fetchMock = context.mock.method(globalThis, "fetch", () => { throw new Error("Should not fetch"); });
  assert.equal((await request(points)).response.status, 400);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("GET only", async () => {
  const { response } = await request(undefined, { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET");
});

test("malformed, duplicate, unknown and oversized queries are rejected", async () => {
  for (const query of ["points=oops", "points=[]&points=[]", "points=[]&url=https://evil.example", `points=${"x".repeat(8193)}`]) {
    const response = await onRequest({ request: new Request(`https://bbb.example/api/weather?${query}`) });
    assert.equal(response.status, 400);
  }
});

test("horizon is today plus 15 days; later and past points need no upstream", async context => {
  const fetchMock = context.mock.method(globalThis, "fetch", () => { throw new Error("Should not fetch"); });
  const { body } = await request([point({ date: shift(16) }), point({ date: shift(-1) })]);
  assert.equal(body.forecasts[0].status, "not-yet-available");
  assert.equal(body.forecasts[0].availableFrom, shift(1));
  assert.equal(body.forecasts[1].status, "past");
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("today and last supported day are forecastable", async context => {
  context.mock.method(globalThis, "fetch", async url => Response.json(provider({}, url.searchParams.get("start_date"))));
  const { body } = await request([point({ date: today }), point({ date: shift(15) })]);
  assert.deepEqual(body.forecasts.map(forecast => forecast.status), ["forecast", "forecast"]);
});

for (const [label, upstream, diagnostic, upstreamStatus] of [
  ["HTTP 301 redirect is not followed", () => Response.redirect("https://unexpected.example/", 301), "upstream-http-301", 301],
  ["HTTP 302 redirect is not followed", () => Response.redirect("https://unexpected.example/", 302), "upstream-http-302", 302],
  ["HTTP 307 redirect is not followed", () => Response.redirect("https://unexpected.example/", 307), "upstream-http-307", 307],
  ["HTTP failure", () => new Response("Failed", { status: 503 }), "upstream-http-503", 503],
  ["HTTP rate limit", () => Response.json({ error: true, reason: "Rate limit exceeded" }, { status: 429 }), "upstream-http-429", 429],
  ["HTTP forbidden", () => new Response("Provider denied this request", { status: 403 }), "upstream-http-403", 403],
  ["malformed JSON", () => new Response("not JSON"), "upstream-json", 200],
  ["malformed shape", () => Response.json({ error: true }), "upstream-data", 200],
  ["oversized response", () => new Response("x".repeat(131073)), "upstream-data", 200],
  ["network/abort failure", () => { throw new DOMException("Aborted", "AbortError"); }, "upstream-timeout"],
  ["network failure", () => { throw new Error("Internal connection details"); }, "upstream-network"],
]) test(label, async context => {
  const fetchMock = context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.origin, "https://api.open-meteo.com");
    assert.equal(options.redirect, "manual");
    return upstream();
  });
  const warning = context.mock.method(console, "warn", () => {});
  const { response, body } = await request();
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(response.status, 200);
  assert.equal(body.forecasts[0].status, "unavailable");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-BBB-Weather-Diagnostic"), diagnostic);
  assert.deepEqual(Object.keys(body).sort(), ["forecasts", "generatedAt", "horizonDays", "source", "timeZone", "today"]);
  assert.deepEqual(body.forecasts, [{ id: "0", date: shift(2), period: "morning", status: "unavailable" }]);
  assert.equal(warning.mock.callCount(), 1);
  const logged = JSON.parse(warning.mock.calls[0].arguments[0]);
  assert.equal(logged.event, "WEATHER_UPSTREAM_FAILED");
  assert.equal(logged.category, diagnostic);
  assert.equal(logged.pointCount, 1);
  assert.equal(logged.upstreamStatus, upstreamStatus);
  assert.ok(!JSON.stringify(logged).includes("Internal connection details"));
  assert.equal(logged.reason, undefined);
});

test("partial locations retain successes, missing metrics stay null rather than zero", async context => {
  context.mock.method(globalThis, "fetch", async () => Response.json([
    provider({ precipitation_probability: hours.map(() => null), wind_gusts_10m: [] }), {},
  ]));
  const warning = context.mock.method(console, "warn", () => {});
  const { response, body } = await request([point(), point({ period: "noon" })]);
  assert.equal(body.forecasts[0].status, "forecast");
  assert.equal(body.forecasts[0].precipitationProbability, null);
  assert.equal(body.forecasts[0].gustMaxKmh, null);
  assert.equal(body.forecasts[1].status, "unavailable");
  assert.equal(response.headers.get("X-BBB-Weather-Diagnostic"), "upstream-data");
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(JSON.parse(warning.mock.calls[0].arguments[0]).pointCount, 2);
});

test("missing dates/core values and unknown weather codes are unavailable", async context => {
  context.mock.method(console, "warn", () => {});
  for (const changes of [{ time: [] }, { weather_code: hours.map(() => 123) }, { temperature_2m: hours.map(() => null) }]) {
    const fetchMock = context.mock.method(globalThis, "fetch", async () => Response.json(provider(changes)));
    assert.equal((await request()).body.forecasts[0].status, "unavailable");
    fetchMock.mock.restore();
  }
});

test("successful responses reuse canonical Cloudflare cache keys for 30 minutes", async context => {
  const stored = new Map();
  globalThis.caches = { default: {
    match: async key => stored.get(key.url)?.clone(),
    put: async (key, response) => { stored.set(key.url, response); },
  } };
  context.after(() => { delete globalThis.caches; });
  const fetchMock = context.mock.method(globalThis, "fetch", async () => Response.json(provider()));
  const first = await request();
  const second = await request();
  assert.equal(first.response.headers.get("Cache-Control"), "public, max-age=1800");
  assert.equal(first.response.headers.get("X-BBB-Weather-Diagnostic"), "ok");
  assert.equal(second.response.headers.get("X-BBB-Weather-Diagnostic"), "ok");
  assert.deepEqual(first.body, second.body);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(stored.size, 1);
});

test("cache failure cannot prevent a forecast", async context => {
  globalThis.caches = { default: {
    match: async () => { throw new Error("Cache down"); },
    put: async () => { throw new Error("Cache down"); },
  } };
  context.after(() => { delete globalThis.caches; });
  context.mock.method(globalThis, "fetch", async () => Response.json(provider()));
  assert.equal((await request()).body.forecasts[0].status, "forecast");
});

test("upstream timeout aborts the request after eight seconds", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  context.mock.method(console, "warn", () => {});
  context.mock.method(globalThis, "fetch", async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    context.mock.timers.tick(8000);
  }));
  const { response, body } = await request();
  assert.equal(body.forecasts[0].status, "unavailable");
  assert.equal(response.headers.get("X-BBB-Weather-Diagnostic"), "upstream-timeout");
});

test("provider bodies, headers, URLs and exception internals never leak", async context => {
  const privateText = "PRIVATE token=secret -37.052,146.088 https://api.example/private";
  context.mock.method(globalThis, "fetch", async () => Response.json({ error: true, reason: privateText },
    { status: 429, headers: { "X-Private": privateText } }));
  const warning = context.mock.method(console, "warn", () => {});
  const { response, body } = await request();
  assert.equal(response.headers.get("X-BBB-Weather-Diagnostic"), "upstream-http-429");
  const logged = JSON.parse(warning.mock.calls[0].arguments[0]);
  assert.deepEqual(Object.keys(logged).sort(), ["category", "event", "pointCount", "upstreamStatus"]);
  assert.ok(!JSON.stringify([logged, body, [...response.headers]]).includes("PRIVATE"));
  assert.ok(!JSON.stringify(logged).includes("-37.052"));
});

const periods = ["morning", "noon", "afternoon"];
const manyPoints = count => Array.from({ length: count }, (_, index) => point({
  date: shift(Math.floor(index / 3)), period: periods[index % 3],
  latitude: index % 2 ? -90 : 90, longitude: index % 2 ? -180 : 180,
}));

test("30 compact points with coordinate boundaries fit the query and use ten date batches", async context => {
  const fetchMock = context.mock.method(globalThis, "fetch", async url => {
    assert.equal(url.searchParams.get("latitude").split(",").length, 3);
    return Response.json(periods.map(() => provider({}, url.searchParams.get("start_date"))));
  });
  const { response, body } = await request(manyPoints(30));
  assert.equal(response.status, 200);
  assert.equal(body.forecasts.length, 30);
  assert.ok(body.forecasts.every(forecast => forecast.status === "forecast"));
  assert.equal(fetchMock.mock.callCount(), 10);
});

for (const period of [undefined, null, "", "Morning", "evening", ["morning"], "toString"]) {
  test(`reject invalid/missing period ${JSON.stringify(period)}`, async () => {
    assert.equal((await request([point({ period })])).response.status, 400);
  });
}
test("reject duplicate date+period even at different coordinates", async () => {
  assert.equal((await request([point(), point({ latitude: 0 })])).response.status, 400);
});

for (const [period, low, high] of [["morning", 6, 10], ["noon", 11, 14], ["afternoon", 15, 18]]) {
  test(`${period} selects only local ${low}–${high} hours for all metrics and condition`, async context => {
    context.mock.method(globalThis, "fetch", async () => Response.json(provider({
      weather_code: hours.map(hour => hour >= low && hour <= high ? 2 : 95),
      temperature_2m: hours.map(hour => hour >= low && hour <= high ? hour : -100),
      precipitation_probability: hours.map(hour => hour >= low && hour <= high ? hour : 100),
      precipitation: hours.map(hour => hour >= low && hour <= high ? 0.1 : 999),
      wind_speed_10m: hours.map(hour => hour >= low && hour <= high ? hour : 999),
      wind_gusts_10m: hours.map(hour => hour >= low && hour <= high ? hour + 10 : 999),
    }, shift(2), "Australia/Perth")));
    const { body } = await request([point({ period })]);
    assert.deepEqual(body.forecasts[0], {
      id: "0", date: shift(2), period, status: "forecast", localTimeZone: "Australia/Perth", condition: "partly-cloudy", conditionLabel: "Partly cloudy",
      temperatureMaxC: high, temperatureMinC: low, precipitationProbability: high,
      precipitationMm: (high - low + 1) / 10, windMaxKmh: high, gustMaxKmh: high + 10, hazards: [],
    });
  });
}

test("three locations on one date batch together; different dates use distinct requests and stable IDs", async context => {
  const points = [point({ date: shift(3), period: "afternoon" }), point(), point({ period: "noon" }), point({ period: "afternoon" })];
  const fetchMock = context.mock.method(globalThis, "fetch", async url => {
    const date = url.searchParams.get("start_date");
    assert.equal(url.searchParams.get("end_date"), date);
    const count = url.searchParams.get("latitude").split(",").length;
    return Response.json(Array.from({ length: count }, () => provider({}, date)));
  });
  const { body } = await request(points);
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.deepEqual(body.forecasts.map(value => value.id), ["0", "1", "2", "3"]);
  assert.ok(body.forecasts.every(value => value.status === "forecast"));
});

for (const [codes, expected] of [
  [[2, 2, 95, 2, 2], "partly-cloudy"],
  [[0, 1, 2, 2, 95], "partly-cloudy"],
  [[61, 80, 61, 80, null], "rain"],
  [[45, 3, 45, 3, null], "fog"],
  [[71, 95, 71, 95, null], "thunderstorm"],
  [[0, 2, 0, 2, null], "partly-cloudy"],
]) test(`representative condition ${codes} -> ${expected}`, async context => {
  context.mock.method(globalThis, "fetch", async () => Response.json(provider({
    weather_code: hours.map(hour => codes[hour - 6] ?? null),
  })));
  assert.equal((await request()).body.forecasts[0].condition, expected);
});

test("hazards retain isolated hours and contiguous runs without bridging gaps", async context => {
  context.mock.method(globalThis, "fetch", async () => Response.json(provider({
    weather_code: hours.map(hour => ({ 6: 95, 7: 95, 8: 2, 9: 95, 10: 45 })[hour] ?? 71),
  })));
  const { body } = await request();
  assert.deepEqual(body.forecasts[0].hazards, [
    { condition: "thunderstorm", label: "Thunderstorm", start: "06:00", end: "07:00" },
    { condition: "thunderstorm", label: "Thunderstorm", start: "09:00", end: "09:00" },
    { condition: "fog", label: "Fog", start: "10:00", end: "10:00" },
  ]);
});

test("isolated thunderstorm does not replace dominant benign condition and is retained as hazard", async context => {
  context.mock.method(globalThis, "fetch", async () => Response.json(provider({ weather_code: hours.map(hour => hour === 8 ? 95 : 2) })));
  const value = (await request()).body.forecasts[0];
  assert.equal(value.condition, "partly-cloudy");
  assert.deepEqual(value.hazards, [{ condition: "thunderstorm", label: "Thunderstorm", start: "08:00", end: "08:00" }]);
});

test("missing/invalid ancillary values remain null; partial core data remains usable", async context => {
  context.mock.method(globalThis, "fetch", async () => Response.json(provider({
    temperature_2m: hours.map(hour => hour === 6 ? 12 : null),
    precipitation_probability: hours.map(() => 101), precipitation: hours.map(() => -1),
    wind_speed_10m: [], wind_gusts_10m: hours.map(() => "5"),
  })));
  const value = (await request()).body.forecasts[0];
  assert.equal(value.status, "forecast");
  assert.equal(value.temperatureMinC, 12);
  assert.equal(value.temperatureMaxC, 12);
  for (const key of ["precipitationProbability", "precipitationMm", "windMaxKmh", "gustMaxKmh"]) assert.equal(value[key], null);
});

test("partial date failure retains successful date, is no-store and never cached", async context => {
  let puts = 0;
  globalThis.caches = { default: { match: async () => undefined, put: async () => { puts++; } } };
  context.after(() => { delete globalThis.caches; });
  context.mock.method(console, "warn", () => {});
  context.mock.method(globalThis, "fetch", async url => url.searchParams.get("start_date") === shift(2)
    ? Response.json(provider()) : new Response("PRIVATE", { status: 503 }));
  const { response, body } = await request([point(), point({ date: shift(3) })]);
  assert.deepEqual(body.forecasts.map(value => value.status), ["forecast", "unavailable"]);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-BBB-Weather-Diagnostic"), "upstream-http-503");
  assert.equal(puts, 0);
});

test("v3 canonical cache reuses one upstream fetch set and period changes key", async context => {
  const stored = new Map();
  globalThis.caches = { default: {
    match: async key => stored.get(key.url)?.clone(), put: async (key, response) => stored.set(key.url, response),
  } };
  context.after(() => { delete globalThis.caches; });
  const fetchMock = context.mock.method(globalThis, "fetch", async url => Response.json(provider({}, url.searchParams.get("start_date"))));
  const points = [point(), point({ date: shift(3) })];
  const first = await request(points);
  const second = await request(points.map(({ latitude, longitude, date, period }) => ({ period, date, longitude, latitude })));
  assert.deepEqual(first.body, second.body);
  assert.equal(fetchMock.mock.callCount(), 2);
  await request([point({ period: "noon" }), points[1]]);
  assert.equal(fetchMock.mock.callCount(), 4);
  assert.equal(stored.size, 2);
  for (const key of stored.keys()) assert.equal(new URL(key).searchParams.get("v"), "3");
});

test("synchronous cache failures cannot suppress forecasts", async context => {
  globalThis.caches = { default: {
    match() { throw new Error("Private cache internals"); },
    put() { throw new Error("Private cache internals"); },
  } };
  context.after(() => { delete globalThis.caches; });
  context.mock.method(globalThis, "fetch", async () => Response.json(provider()));
  assert.equal((await request()).body.forecasts[0].status, "forecast");
});

test("multiple date groups share one overall timeout and keep completed dates", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  context.mock.method(console, "warn", () => {});
  const signals = [];
  const fetchMock = context.mock.method(globalThis, "fetch", async (url, { signal }) => {
    signals.push(signal);
    const date = url.searchParams.get("start_date");
    if (date === shift(2)) return Response.json(provider({}, date));
    if (signal.aborted) throw new DOMException("PRIVATE", "AbortError");
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("PRIVATE", "AbortError"))));
  });
  const pending = request(Array.from({ length: 6 }, (_, index) => point({ date: shift(index + 2) })));
  await new Promise(setImmediate);
  assert.equal(fetchMock.mock.callCount(), 5, "At most four date requests are in flight after the first completes");
  context.mock.timers.tick(8000);
  const { body, response } = await pending;
  assert.deepEqual(body.forecasts.map(value => value.status), ["forecast", ...Array(5).fill("unavailable")]);
  assert.ok(signals.every(signal => signal === signals[0] && signal.aborted));
  assert.equal(response.headers.get("X-BBB-Weather-Diagnostic"), "upstream-timeout");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("snow runs and gaps between missing provider hours are preserved", async context => {
  context.mock.method(globalThis, "fetch", async () => Response.json(provider({
    time: [6, 7, 9, 10].map(hour => `${shift(2)}T${String(hour).padStart(2, "0")}:00`),
    weather_code: [71, 73, 75, 2], temperature_2m: [12, 13, 14, 15],
  })));
  const value = (await request()).body.forecasts[0];
  assert.equal(value.condition, "snow");
  assert.deepEqual(value.hazards, [
    { condition: "snow", label: "Snow", start: "06:00", end: "07:00" },
    { condition: "snow", label: "Snow", start: "09:00", end: "09:00" },
  ]);
});

test("successful forecasts retain each validated local timezone separately from the Sydney lifecycle clock", async context => {
  context.mock.method(globalThis, "fetch", async () => Response.json([
    { ...provider({}, shift(2), "Australia/Perth"), utc_offset_seconds: 28800, timezone_abbreviation: "AWST", elevation: 50 },
    { ...provider({}, shift(2), "Australia/Darwin"), utc_offset_seconds: 34200, timezone_abbreviation: "ACST" },
    provider({}, shift(2), "Etc/GMT+3"),
  ]));
  const { body } = await request([point(), point({ period: "noon" }), point({ period: "afternoon" })]);
  assert.equal(body.timeZone, "Australia/Sydney");
  assert.deepEqual(body.forecasts.map(value => value.localTimeZone), ["Australia/Perth", "Australia/Darwin", "Etc/GMT+3"]);
  assert.ok(body.forecasts.every(value => value.status === "forecast"));
  for (const raw of ["utc_offset_seconds", "timezone_abbreviation", "elevation", '"timezone"']) assert.ok(!JSON.stringify(body).includes(raw));
});

for (const timezone of [undefined, null, 42, "", "Invalid/Timezone", " Australia/Perth", "Australia/Perth\n", "x".repeat(101)]) {
  test(`invalid provider timezone ${JSON.stringify(timezone)} is unavailable without leaking metadata`, async context => {
    context.mock.method(console, "warn", () => {});
    context.mock.method(globalThis, "fetch", async () => Response.json({ ...provider(), timezone }));
    const { body, response } = await request();
    assert.deepEqual(body.forecasts, [{ id: "0", date: shift(2), period: "morning", status: "unavailable" }]);
    assert.equal(response.headers.get("X-BBB-Weather-Diagnostic"), "upstream-data");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  });
}
