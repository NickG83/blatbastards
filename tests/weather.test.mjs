import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/api/weather.js";

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
const shift = days => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const point = (changes = {}) => ({ latitude: -37.052, longitude: 146.088, date: shift(2), ...changes });
const provider = (changes = {}) => ({ daily: {
  time: [shift(2)], weather_code: [2], temperature_2m_max: [24], temperature_2m_min: [10],
  precipitation_probability_max: [15], precipitation_sum: [0.4], wind_speed_10m_max: [18], wind_gusts_10m_max: [31],
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

test("single point: normalises daily values and requests only metric daily best-match data", async context => {
  const warning = context.mock.method(console, "warn", () => {});
  const fetchMock = context.mock.method(globalThis, "fetch", async url => {
    assert.equal(url.origin, "https://api.open-meteo.com");
    assert.equal(url.searchParams.get("forecast_days"), "16");
    assert.equal(url.searchParams.get("timezone"), "Australia/Sydney");
    assert.equal(url.searchParams.get("wind_speed_unit"), "kmh");
    assert.equal(url.searchParams.has("hourly"), false);
    assert.equal(url.searchParams.has("models"), false);
    return Response.json(provider());
  });
  const { response, body } = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-BBB-Weather-Diagnostic"), "ok");
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(body.forecasts[0], {
    id: "0", date: shift(2), status: "forecast", condition: "partly-cloudy", conditionLabel: "Partly cloudy",
    temperatureMaxC: 24, temperatureMinC: 10, precipitationProbability: 15, precipitationMm: 0.4, windMaxKmh: 18, gustMaxKmh: 31,
  });
  assert.equal(body.source, "Open-Meteo");
  assert.equal(body.horizonDays, 16);
  assert.ok(!JSON.stringify(body).includes("temperature_2m"));
  assert.equal(warning.mock.callCount(), 0);
});

test("multiple points use one upstream batch and deterministic input indexes", async context => {
  const fetchMock = context.mock.method(globalThis, "fetch", async url => {
    assert.equal(url.searchParams.get("latitude"), "-37.052,-34");
    return Response.json([provider(), provider({ weather_code: [80] })]);
  });
  const { body } = await request([point(), point({ latitude: -34 })]);
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
  ["excessive count", Array.from({ length: 11 }, () => point())],
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
  for (const query of ["points=oops", "points=[]&points=[]", "points=[]&url=https://evil.example", `points=${"x".repeat(4097)}`]) {
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
  context.mock.method(globalThis, "fetch", async () => Response.json([
    provider({ time: [today] }), provider({ time: [shift(15)] }),
  ]));
  const { body } = await request([point({ date: today }), point({ date: shift(15) })]);
  assert.deepEqual(body.forecasts.map(forecast => forecast.status), ["forecast", "forecast"]);
});

for (const [label, upstream, diagnostic, upstreamStatus] of [
  ["HTTP failure", () => new Response("Failed", { status: 503 }), "upstream-http-503", 503],
  ["HTTP rate limit", () => Response.json({ error: true, reason: "Rate limit exceeded" }, { status: 429 }), "upstream-http-429", 429],
  ["HTTP forbidden", () => new Response("Provider denied this request", { status: 403 }), "upstream-http-403", 403],
  ["malformed JSON", () => new Response("not JSON"), "upstream-json", 200],
  ["malformed shape", () => Response.json({ error: true }), "upstream-data", 200],
  ["oversized response", () => new Response("x".repeat(131073)), "upstream-data", 200],
  ["network/abort failure", () => { throw new DOMException("Aborted", "AbortError"); }, "upstream-timeout"],
  ["network failure", () => { throw new Error("Internal connection details"); }, "upstream-network"],
]) test(label, async context => {
  context.mock.method(globalThis, "fetch", async () => upstream());
  const warning = context.mock.method(console, "warn", () => {});
  const { response, body } = await request();
  assert.equal(response.status, 200);
  assert.equal(body.forecasts[0].status, "unavailable");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-BBB-Weather-Diagnostic"), diagnostic);
  assert.deepEqual(Object.keys(body).sort(), ["forecasts", "generatedAt", "horizonDays", "source", "timeZone", "today"]);
  assert.deepEqual(body.forecasts, [{ id: "0", date: shift(2), status: "unavailable" }]);
  assert.equal(warning.mock.callCount(), 1);
  const logged = JSON.parse(warning.mock.calls[0].arguments[0]);
  assert.equal(logged.event, "WEATHER_UPSTREAM_FAILED");
  assert.equal(logged.category, diagnostic);
  assert.equal(logged.pointCount, 1);
  assert.equal(logged.upstreamStatus, upstreamStatus);
  assert.ok(!JSON.stringify(logged).includes("Internal connection details"));
  if (label === "HTTP rate limit") assert.equal(logged.reason, "Rate limit exceeded");
});

test("partial locations retain successes, missing metrics stay null rather than zero", async context => {
  context.mock.method(globalThis, "fetch", async () => Response.json([
    provider({ precipitation_probability_max: [null], wind_gusts_10m_max: [] }), {},
  ]));
  const warning = context.mock.method(console, "warn", () => {});
  const { response, body } = await request([point(), point()]);
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
  for (const changes of [{ time: [] }, { weather_code: [123] }, { temperature_2m_max: [null] }]) {
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

test("provider error reasons are bounded and sanitised in logs, never sent to the browser", async context => {
  const reason = `Rate limit\n\u0000 for -37.052,146.088 at https://api.example/private?token=secret ${"detail ".repeat(100)}`;
  context.mock.method(globalThis, "fetch", async () => Response.json({ error: true, reason, extra: "PRIVATE BODY" }, { status: 429 }));
  const warning = context.mock.method(console, "warn", () => {});
  const { response, body } = await request();
  assert.equal(response.headers.get("X-BBB-Weather-Diagnostic"), "upstream-http-429");
  assert.deepEqual(body.forecasts, [{ id: "0", date: shift(2), status: "unavailable" }]);
  const logged = JSON.parse(warning.mock.calls[0].arguments[0]);
  assert.deepEqual(Object.keys(logged).sort(), ["category", "event", "pointCount", "reason", "upstreamStatus"]);
  assert.ok(logged.reason.length <= 160);
  assert.match(logged.reason, /^[\x20-\x7e]+$/);
  assert.ok(!logged.reason.includes("-37.052"));
  assert.ok(!logged.reason.includes("146.088"));
  assert.ok(!logged.reason.includes("secret"));
  assert.ok(!JSON.stringify(logged).includes("PRIVATE BODY"));
  assert.ok(!JSON.stringify(body).includes("Rate limit"));
});

test("ten points and coordinate boundary values are accepted", async context => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () =>
    Response.json(Array.from({ length: 10 }, () => provider())));
  const { response, body } = await request(Array.from({ length: 10 }, (value, index) =>
    point({ latitude: index % 2 ? -90 : 90, longitude: index % 2 ? -180 : 180 })));
  assert.equal(response.status, 200);
  assert.equal(body.forecasts.length, 10);
  assert.ok(body.forecasts.every(forecast => forecast.status === "forecast"));
  assert.equal(fetchMock.mock.callCount(), 1);
});