// Open-Meteo's standard forecast includes today and the next 15 calendar days.
const FORECAST_DAYS = 16;
const DAY_MS = 86400000;
const TIME_ZONE = "Australia/Sydney";
const HOURLY_FIELDS = [
  "weather_code", "temperature_2m", "precipitation_probability", "precipitation",
  "wind_speed_10m", "wind_gusts_10m",
];
const PERIODS = { morning: [6, 10], noon: [11, 14], afternoon: [15, 18] };
// Highest impact first, used only to break frequency ties.
const IMPACT = ["thunderstorm", "snow", "rain", "showers", "fog", "cloudy", "partly-cloudy", "clear"];

function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function validDate(date) {
  return typeof date === "string" && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && shiftDate(date, 0) === date;
}

function parsePoints(url) {
  if (url.search.length > 8192 || [...url.searchParams.keys()].some(key => key !== "points") ||
      url.searchParams.getAll("points").length !== 1) throw new Error("Invalid query");
  const points = JSON.parse(url.searchParams.get("points"));
  if (!Array.isArray(points) || points.length < 1 || points.length > 30) throw new Error("Invalid count");
  const seen = new Set();
  return points.map((point, index) => {
    if (!point || typeof point.latitude !== "number" || !Number.isFinite(point.latitude) ||
        Math.abs(point.latitude) > 90 || typeof point.longitude !== "number" ||
        !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180 || !validDate(point.date) ||
        typeof point.period !== "string" || !Object.hasOwn(PERIODS, point.period)) {
      throw new Error("Invalid point");
    }
    const pair = `${point.date}:${point.period}`;
    if (seen.has(pair)) throw new Error("Duplicate period");
    seen.add(pair);
    return { id: String(index), date: point.date, period: point.period, latitude: point.latitude, longitude: point.longitude };
  });
}

function conditionFor(code) {
  if (code === 0) return ["clear", "Clear sky"];
  if (code === 1) return ["clear", "Mainly clear"];
  if (code === 2) return ["partly-cloudy", "Partly cloudy"];
  if (code === 3) return ["cloudy", "Overcast"];
  if ([45, 48].includes(code)) return ["fog", "Fog"];
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67].includes(code)) return ["rain", "Rain"];
  if ([80, 81, 82].includes(code)) return ["showers", "Showers"];
  if ([71, 73, 75, 77, 85, 86].includes(code)) return ["snow", "Snow"];
  if ([95, 96, 97, 99].includes(code)) return ["thunderstorm", "Thunderstorm"];
  return null;
}

function validTimeZone(value) {
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch { return false; }
}

function normalise(point, result) {
  const base = { id: point.id, date: point.date, period: point.period, status: "unavailable" };
  const hourly = result?.hourly;
  if (!Array.isArray(hourly?.time) || !validTimeZone(result?.timezone)) return base;
  const [first, last] = PERIODS[point.period];
  // Provider ISO timestamps are already labelled in this coordinate's local clock.
  // Do not reinterpret them with the visitor's or Sydney's timezone.
  const records = [];
  const seen = new Set();
  hourly.time.forEach((time, index) => {
    if (typeof time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(time) ||
        time.slice(0, 10) !== point.date) return;
    const hour = Number(time.slice(11, 13));
    if (hour < first || hour > last || seen.has(hour)) return;
    seen.add(hour);
    const values = HOURLY_FIELDS.map(field => {
      const value = Array.isArray(hourly[field]) ? hourly[field][index] : null;
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    });
    records.push({ hour, values, condition: conditionFor(values[0]) });
  });
  records.sort((a, b) => a.hour - b.hour);
  const counts = new Map();
  for (const { condition } of records) {
    if (condition) counts.set(condition[0], (counts.get(condition[0]) || 0) + 1);
  }
  const categories = IMPACT.filter(category => counts.has(category));
  categories.sort((a, b) => counts.get(b) - counts.get(a));
  const category = categories[0];
  const valuesFor = (index, valid = () => true) => records.map(record => record.values[index])
    .filter(value => value !== null && valid(value));
  const temperatures = valuesFor(1);
  if (!category || !temperatures.length) return base;
  const maximum = values => values.length ? Math.max(...values) : null;
  const nonnegative = value => value >= 0;
  const precipitation = valuesFor(3, nonnegative);
  const hazards = [];
  const clock = hour => `${String(hour).padStart(2, "0")}:00`;
  for (const hazard of ["thunderstorm", "snow", "fog"]) {
    let run;
    for (const record of records) {
      if (record.condition?.[0] !== hazard) continue;
      // End is the last provider-labelled hazard hour, not an invented duration.
      if (run && record.hour === run.last + 1) {
        run.last = record.hour;
        run.value.end = clock(record.hour);
      } else {
        const value = { condition: hazard, label: record.condition[1], start: clock(record.hour), end: clock(record.hour) };
        hazards.push(value);
        run = { last: record.hour, value };
      }
    }
  }
  hazards.sort((a, b) => a.start.localeCompare(b.start));
  const labels = { clear: "Clear sky", "partly-cloudy": "Partly cloudy", cloudy: "Overcast",
    fog: "Fog", rain: "Rain", showers: "Showers", snow: "Snow", thunderstorm: "Thunderstorm" };
  return {
    ...base, status: "forecast", localTimeZone: result.timezone, condition: category, conditionLabel: labels[category],
    temperatureMaxC: Math.max(...temperatures), temperatureMinC: Math.min(...temperatures),
    precipitationProbability: maximum(valuesFor(2, value => value >= 0 && value <= 100)),
    precipitationMm: precipitation.length ? Number(precipitation.reduce((sum, value) => sum + value, 0).toFixed(3)) : null,
    windMaxKmh: maximum(valuesFor(4, nonnegative)), gustMaxKmh: maximum(valuesFor(5, nonnegative)), hazards,
  };
}

async function fetchDate(points, signal) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: points.map(point => point.latitude).join(","),
    longitude: points.map(point => point.longitude).join(","),
    hourly: HOURLY_FIELDS.join(","), start_date: points[0].date, end_date: points[0].date, timezone: "auto",
    temperature_unit: "celsius", wind_speed_unit: "kmh", precipitation_unit: "mm",
  });
  let diagnostic = "upstream-network";
  let upstreamStatus;
  try {
    const response = await fetch(url, { signal, redirect: "manual" });
    upstreamStatus = response.status;
    if (!response.ok) {
      diagnostic = `upstream-http-${response.status}`;
      await response.body?.cancel();
      throw new Error("Forecast unavailable");
    }
    diagnostic = "upstream-data";
    if (!response.body) throw new Error("Forecast unavailable");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131072) {
        diagnostic = "upstream-data";
        await reader.cancel();
        throw new Error("Forecast too large");
      }
      chunks.push(value);
    }
    let data;
    try {
      data = JSON.parse(await new Blob(chunks).text());
    } catch (error) {
      diagnostic = "upstream-json";
      throw error;
    }
    diagnostic = "upstream-data";
    const results = Array.isArray(data) ? data : [data];
    const forecasts = points.map((point, index) => normalise(point, results[index]));
    if (forecasts.every(forecast => forecast.status === "forecast")) return { forecasts, diagnostic: "ok" };
    console.warn(JSON.stringify({ event: "WEATHER_UPSTREAM_FAILED", category: diagnostic,
      upstreamStatus, pointCount: points.length }));
    return { forecasts, diagnostic };
  } catch (error) {
    if (signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") diagnostic = "upstream-timeout";
    console.warn(JSON.stringify({ event: "WEATHER_UPSTREAM_FAILED", category: diagnostic,
      upstreamStatus, pointCount: points.length }));
    return { forecasts: [], diagnostic };
  }
}

async function fetchForecasts(points) {
  const groups = new Map();
  for (const point of points) {
    if (!groups.has(point.date)) groups.set(point.date, []);
    groups.get(point.date).push(point);
  }
  const queue = [...groups.values()];
  const results = new Array(queue.length);
  const controller = new AbortController();
  // One overall budget, including queued groups and response parsing.
  const timer = setTimeout(() => controller.abort(), 8000);
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (next < queue.length) {
        const index = next++;
        results[index] = await fetchDate(queue[index], controller.signal);
      }
    }));
    return {
      forecasts: results.flatMap(result => result.forecasts),
      diagnostic: results.find(result => result.diagnostic !== "ok")?.diagnostic || "ok",
    };
  } finally {
    clearTimeout(timer);
  }
}

function json(data, status = 200, cacheControl = "no-store", headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cacheControl, ...headers },
  });
}

export async function onRequest(context) {
  if (context.request.method !== "GET") return json({ error: "Method not allowed" }, 405, "no-store", { Allow: "GET" });
  const url = new URL(context.request.url);
  let points;
  try {
    points = parsePoints(url);
  } catch {
    return json({ error: "Supply 1 to 30 unique date+period points with numeric latitude (-90..90), longitude (-180..180), an ISO date (YYYY-MM-DD) and period (morning, noon, afternoon)." }, 400);
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
  const horizonEnd = shiftDate(today, FORECAST_DAYS - 1);
  // A new trip day must not reuse yesterday's lifecycle decisions.
  const cacheURL = new URL("/api/weather", url.origin);
  cacheURL.search = new URLSearchParams({ v: "3", day: today, points: JSON.stringify(points) });
  const cacheKey = new Request(cacheURL);
  const cache = globalThis.caches?.default;
  try {
    const cached = await cache?.match(cacheKey);
    if (cached) return cached;
  } catch {}
  const active = points.filter(point => point.date >= today && point.date <= horizonEnd);
  const upstream = active.length ? await fetchForecasts(active) : { forecasts: [], diagnostic: "ok" };
  const forecasts = points.map(point => {
    const base = { id: point.id, date: point.date, period: point.period };
    if (point.date < today) return { ...base, status: "past" };
    if (point.date > horizonEnd) return {
      ...base, status: "not-yet-available", availableFrom: shiftDate(point.date, -(FORECAST_DAYS - 1)),
    };
    return upstream.forecasts.find(forecast => forecast.id === point.id) || { ...base, status: "unavailable" };
  });
  const failed = forecasts.some(forecast => forecast.status === "unavailable");
  const response = json({
    generatedAt: new Date().toISOString(), source: "Open-Meteo", timeZone: TIME_ZONE,
    today, horizonDays: FORECAST_DAYS, forecasts,
  }, 200, failed ? "no-store" : "public, max-age=1800", { "X-BBB-Weather-Diagnostic": upstream.diagnostic });
  if (cache && !failed) {
    try {
      context.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
    } catch {}
  }
  return response;
}
