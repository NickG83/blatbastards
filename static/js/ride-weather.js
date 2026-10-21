(() => {
  "use strict";
  const section = document.querySelector(".ride-weather");
  if (!section) return;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
  const dateFormatter = new Intl.DateTimeFormat("en-AU", {
    weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
  const availabilityFormatter = new Intl.DateTimeFormat("en-AU", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
  const periods = { morning: "AM", noon: "NOON", afternoon: "PM" };
  const icons = {
    clear: "\u2600\ufe0f", "partly-cloudy": "\u26c5", cloudy: "\u2601\ufe0f", fog: "\ud83c\udf2b\ufe0f",
    rain: "\ud83c\udf27\ufe0f", showers: "\ud83c\udf26\ufe0f", snow: "\u2744\ufe0f", thunderstorm: "\u26c8\ufe0f",
  };
  const grid = section.querySelector(".ride-weather-grid");
  const status = section.querySelector(".ride-weather-status");

  function validDate(date) {
    if (typeof date !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function metric(value, unit, digits = 0) {
    return typeof value === "number" && Number.isFinite(value)
      ? `${new Intl.NumberFormat("en-AU", { maximumFractionDigits: digits }).format(value)}${unit}`
      : "Not available";
  }

  function showState(body, message, detail) {
    body.replaceChildren(element("p", "ride-weather-message", message));
    if (detail) body.append(element("p", "ride-weather-detail", detail));
  }

  function availability(body, forecast) {
    const detail = validDate(forecast?.availableFrom)
      ? `Forecast expected from around ${availabilityFormatter.format(new Date(`${forecast.availableFrom}T00:00:00Z`))}` : undefined;
    showState(body, "Forecast not yet available", detail);
  }

  function renderPeriod(row, forecast) {
    const body = element("div", "ride-weather-period-body");
    row.append(body);
    if (!forecast || forecast.status !== "forecast") {
      if (forecast?.status === "not-yet-available") availability(body, forecast);
      else showState(body, "Forecast temporarily unavailable.");
      return false;
    }
    const summary = element("div", "ride-weather-summary");
    const icon = element("span", "ride-weather-icon", icons[forecast.condition] || "");
    icon.setAttribute("aria-hidden", "true");
    const temperatures = element("span", "ride-weather-temperatures",
      `${metric(forecast.temperatureMaxC, "\u00b0")} / ${metric(forecast.temperatureMinC, "\u00b0")}`);
    temperatures.setAttribute("aria-label", `Maximum ${metric(forecast.temperatureMaxC, " degrees Celsius")}, minimum ${metric(forecast.temperatureMinC, " degrees Celsius")}`);
    summary.append(icon, element("span", "sr-only ride-weather-condition", forecast.conditionLabel || "Condition unavailable"), temperatures);
    const metrics = element("dl", "ride-weather-metrics");
    for (const [label, value] of [
      ["Rain", `${metric(forecast.precipitationProbability, "%")} \u00b7 ${metric(forecast.precipitationMm, " mm", 1)}`],
      ["Wind", metric(forecast.windMaxKmh, " km/h")],
    ]) {
      const group = element("div", `ride-weather-metric ride-weather-${label.toLowerCase()}`);
      group.append(element("dt", "", label), element("dd", "", value));
      metrics.append(group);
    }
    body.replaceWith(summary, metrics);
    const hazards = element("div", "ride-weather-hazards");
    for (const hazard of Array.isArray(forecast.hazards) ? forecast.hazards : []) {
      if (!["thunderstorm", "snow", "fog"].includes(hazard?.condition) || hazard.condition === forecast.condition ||
          !/^(?:[01]\d|2[0-3]):00$/.test(hazard.start) || !/^(?:[01]\d|2[0-3]):00$/.test(hazard.end)) continue;
      const label = { thunderstorm: "Thunderstorm", snow: "Snow", fog: "Fog" }[hazard.condition];
      const single = hazard.start === hazard.end;
      const clock = typeof forecast.localTimeZone === "string" ? `local time (${forecast.localTimeZone})` : "local time";
      const marker = element("span", "ride-weather-hazard");
      marker.setAttribute("role", "img");
      marker.setAttribute("aria-label", single ? `${label} risk at ${hazard.start} ${clock}` : `${label} risk from ${hazard.start} to ${hazard.end} ${clock}`);
      const visual = element("span", "", `${hazard.condition === "thunderstorm" ? "\u26a1" : icons[hazard.condition]} ${hazard.start.slice(0, 2)}${single ? "" : `\u2013${hazard.end.slice(0, 2)}`}`);
      visual.setAttribute("aria-hidden", "true");
      marker.append(visual);
      hazards.append(marker);
    }
    if (hazards.childElementCount) row.append(hazards);
    return true;
  }

  async function load() {
    let points;
    try { points = JSON.parse(section.dataset.weather); } catch { return; }
    if (!Array.isArray(points)) return;
    const order = Object.keys(periods);
    points = points.slice(0, 30).filter(point => point && validDate(point.date) && point.date >= today &&
      typeof point.period === "string" && Object.hasOwn(periods, point.period) &&
      typeof point.location === "string" && point.location.trim());
    points.sort((a, b) => a.date.localeCompare(b.date) || order.indexOf(a.period) - order.indexOf(b.period));
    if (!points.length) return;
    const groups = new Map();
    points.forEach(point => {
      if (!groups.has(point.date)) groups.set(point.date, []);
      groups.get(point.date).push(point);
    });
    const cards = [...groups].map(([day, points]) => {
      const article = element("article", "ride-weather-card");
      const header = element("h4", "ride-weather-header");
      const date = element("time", "ride-weather-date", dateFormatter.format(new Date(`${day}T00:00:00Z`)));
      date.dateTime = day;
      header.append(date);
      if (day === today) header.append(element("span", "ride-weather-today", "TODAY"));
      const body = element("div", "ride-weather-body");
      showState(body, "Loading forecast\u2026");
      article.append(header, body);
      grid.append(article);
      return { day, points, body };
    });
    section.hidden = false;
    status.textContent = "Loading forecasts.";
    const requestPoints = points.filter(({ latitude, longitude }) =>
      typeof latitude === "number" && Number.isFinite(latitude) && Math.abs(latitude) <= 90 &&
      typeof longitude === "number" && Number.isFinite(longitude) && Math.abs(longitude) <= 180);
    const results = new Map();
    const render = () => {
      let unavailable = false;
      for (const card of cards) {
        const forecasts = card.points.map(point => results.get(point));
        if (forecasts.every(forecast => forecast?.status === "not-yet-available")) {
          availability(card.body, forecasts[0]);
          continue;
        }
        card.body.replaceChildren();
        card.points.forEach((point, index) => {
          const row = element("div", "ride-weather-period");
          row.dataset.period = point.period;
          row.append(element("span", "ride-weather-period-label", periods[point.period]),
            element("span", "ride-weather-location", point.location));
          if (!renderPeriod(row, forecasts[index])) unavailable = true;
          card.body.append(row);
        });
      }
      status.textContent = unavailable ? "Some forecasts are temporarily unavailable." : "Forecasts updated.";
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      if (requestPoints.length) {
        const url = new URL("/api/weather", location.origin);
        url.searchParams.set("points", JSON.stringify(requestPoints.map(point => ({
          latitude: point.latitude, longitude: point.longitude, date: point.date, period: point.period,
        }))));
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("Weather unavailable");
        const data = await response.json();
        if (!Array.isArray(data.forecasts)) throw new Error("Weather unavailable");
        requestPoints.forEach((point, index) => {
          const forecast = data.forecasts.find(forecast => forecast?.id === String(index));
          if (forecast?.date === point.date && forecast?.period === point.period) results.set(point, forecast);
        });
      }
    } catch { /* Render unavailable periods while keeping all Ride content usable. */ }
    finally {
      clearTimeout(timer);
      render();
      grid.setAttribute("aria-busy", "false");
    }
  }

  load().catch(() => { section.hidden = true; });
})();
