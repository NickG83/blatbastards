// Open-Meteo's standard forecast includes today and the next 15 calendar days.
const FORECAST_DAYS = 16;
const DAY_MS = 86400000;
const TIME_ZONE = "Australia/Sydney";
const DAILY_FIELDS = [
  "weather_code", "temperature_2m_max", "temperature_2m_min",
  "precipitation_probability_max", "precipitation_sum",
  "wind_speed_10m_max", "wind_gusts_10m_max",
];

function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function validDate(date) {
  return typeof date === "string" && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && shiftDate(date, 0) === date;
}

function parsePoints(url) {
  if (url.search.length > 4096 || [...url.searchParams.keys()].some(key => key !== "points") ||
      url.searchParams.getAll("points").length !== 1) throw new Error("Invalid query");
  const points = JSON.parse(url.searchParams.get("points"));
  if (!Array.isArray(points) || points.length < 1 || points.length > 10) throw new Error("Invalid count");
  return points.map((point, index) => {
    if (!point || typeof point.latitude !== "number" || !Number.isFinite(point.latitude) ||
        Math.abs(point.latitude) > 90 || typeof point.longitude !== "number" ||
        !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180 || !validDate(point.date)) {
      throw new Error("Invalid point");
    }
    return { id: String(index), date: point.date, latitude: point.latitude, longitude: point.longitude };
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

function normalise(point, result) {
  const base = { id: point.id, date: point.date, status: "unavailable" };
  const daily = result?.daily;
  const index = Array.isArray(daily?.time) ? daily.time.indexOf(point.date) : -1;
  if (index < 0) return base;
  const values = DAILY_FIELDS.map(field => {
    const value = Array.isArray(daily[field]) ? daily[field][index] : null;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  });
  const condition = conditionFor(values[0]);
  if (!condition || values[1] === null || values[2] === null) return base;
  const nonnegative = value => value !== null && value >= 0 ? value : null;
  return {
    ...base, status: "forecast", condition: condition[0], conditionLabel: condition[1],
    temperatureMaxC: values[1], temperatureMinC: values[2],
    precipitationProbability: values[3] !== null && values[3] >= 0 && values[3] <= 100 ? values[3] : null,
    precipitationMm: nonnegative(values[4]), windMaxKmh: nonnegative(values[5]), gustMaxKmh: nonnegative(values[6]),
  };
}

async function fetchForecasts(points) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: points.map(point => point.latitude).join(","),
    longitude: points.map(point => point.longitude).join(","),
    daily: DAILY_FIELDS.join(","), forecast_days: String(FORECAST_DAYS), timezone: TIME_ZONE,
    temperature_unit: "celsius", wind_speed_unit: "kmh", precipitation_unit: "mm",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok || !response.body) throw new Error("Forecast unavailable");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131072) {
        await reader.cancel();
        throw new Error("Forecast too large");
      }
      chunks.push(value);
    }
    const data = JSON.parse(await new Blob(chunks).text());
    const results = Array.isArray(data) ? data : [data];
    return points.map((point, index) => normalise(point, results[index]));
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
    return json({ error: "Supply 1 to 10 points with numeric latitude (-90..90), longitude (-180..180) and an ISO date (YYYY-MM-DD)." }, 400);
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
  const horizonEnd = shiftDate(today, FORECAST_DAYS - 1);
  // A new trip day must not reuse yesterday's lifecycle decisions.
  const cacheURL = new URL("/api/weather", url.origin);
  cacheURL.search = new URLSearchParams({ v: "1", day: today, points: JSON.stringify(points) });
  const cacheKey = new Request(cacheURL);
  const cache = globalThis.caches?.default;
  try {
    const cached = await cache?.match(cacheKey);
    if (cached) return cached;
  } catch {}
  const active = points.filter(point => point.date >= today && point.date <= horizonEnd);
  let available = [];
  try {
    if (active.length) available = await fetchForecasts(active);
  } catch {}
  const forecasts = points.map(point => {
    const base = { id: point.id, date: point.date };
    if (point.date < today) return { ...base, status: "past" };
    if (point.date > horizonEnd) return {
      ...base, status: "not-yet-available", availableFrom: shiftDate(point.date, -(FORECAST_DAYS - 1)),
    };
    return available.find(forecast => forecast.id === point.id) || { ...base, status: "unavailable" };
  });
  const failed = forecasts.some(forecast => forecast.status === "unavailable");
  const response = json({
    generatedAt: new Date().toISOString(), source: "Open-Meteo", timeZone: TIME_ZONE,
    today, horizonDays: FORECAST_DAYS, forecasts,
  }, 200, failed ? "no-store" : "public, max-age=1800");
  if (cache && !failed) context.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
  return response;
}