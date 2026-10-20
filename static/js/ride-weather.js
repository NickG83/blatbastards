(() => {
  "use strict";
  const section = document.querySelector(".ride-weather");
  if (!section) return;
  const timeZone = "Australia/Sydney";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  const dateFormatter = new Intl.DateTimeFormat("en-AU", {
    weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
  const availabilityFormatter = new Intl.DateTimeFormat("en-AU", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
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

  function renderForecast(card, forecast) {
    if (!forecast || forecast.date !== card.point.date) {
      showState(card.body, "Forecast temporarily unavailable.");
      return;
    }
    if (forecast.status === "not-yet-available") {
      const detail = validDate(forecast.availableFrom)
        ? `Forecast expected from around ${availabilityFormatter.format(new Date(`${forecast.availableFrom}T00:00:00Z`))}` : undefined;
      showState(card.body, "Forecast not yet available", detail);
      return;
    }
    if (forecast.status !== "forecast") {
      showState(card.body, "Forecast temporarily unavailable.");
      return;
    }
    const summary = element("div", "ride-weather-summary");
    const icon = element("span", "ride-weather-icon", icons[forecast.condition] || "");
    icon.setAttribute("aria-hidden", "true");
    const temperatures = element("p", "ride-weather-temperatures",
      `${metric(forecast.temperatureMaxC, "\u00b0C")} / ${metric(forecast.temperatureMinC, "\u00b0C")}`);
    temperatures.setAttribute("aria-label", `Maximum ${metric(forecast.temperatureMaxC, " degrees Celsius")}, minimum ${metric(forecast.temperatureMinC, " degrees Celsius")}`);
    summary.append(icon, temperatures, element("p", "ride-weather-condition", forecast.conditionLabel || "Condition unavailable"));
    const metrics = element("dl", "ride-weather-metrics");
    for (const [label, value] of [
      ["Rain", `${metric(forecast.precipitationProbability, "%")} \u00b7 ${metric(forecast.precipitationMm, " mm", 1)}`],
      ["Wind", metric(forecast.windMaxKmh, " km/h")],
    ]) metrics.append(element("dt", "", label), element("dd", "", value));
    card.body.replaceChildren(summary, metrics);
  }

  async function load() {
    let points;
    try {
      points = JSON.parse(section.dataset.weather);
    } catch { return; }
    if (!Array.isArray(points)) return;
    points = points.slice(0, 10).filter(point => point && validDate(point.date) && point.date >= today &&
      typeof point.location === "string" && point.location.trim());
    if (!points.length) return;

    const cards = points.map(point => {
      const article = element("article", "ride-weather-card");
      const header = element("div", "ride-weather-header");
      const dateRow = element("div", "ride-weather-date-row");
      const date = element("time", "ride-weather-date", dateFormatter.format(new Date(`${point.date}T00:00:00Z`)));
      date.dateTime = point.date;
      dateRow.append(date);
      if (point.date === today) dateRow.append(element("span", "ride-weather-today", "TODAY"));
      header.append(element("h4", "ride-weather-location", point.location), dateRow);
      const body = element("div", "ride-weather-body");
      showState(body, "Loading forecast\u2026");
      article.append(header);
      if (typeof point.region === "string" && point.region) article.append(element("p", "ride-weather-region", point.region));
      article.append(body);
      grid.append(article);
      return { point, body };
    });
    section.hidden = false;
    status.textContent = "Loading forecasts.";
    const requestCards = cards.filter(card => {
      const { latitude, longitude } = card.point;
      const valid = typeof latitude === "number" && Number.isFinite(latitude) && Math.abs(latitude) <= 90 &&
        typeof longitude === "number" && Number.isFinite(longitude) && Math.abs(longitude) <= 180;
      if (!valid) showState(card.body, "Forecast temporarily unavailable.");
      return valid;
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      if (requestCards.length) {
        const url = new URL("/api/weather", location.origin);
        url.searchParams.set("points", JSON.stringify(requestCards.map(({ point }) => ({
          latitude: point.latitude, longitude: point.longitude, date: point.date,
        }))));
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("Weather unavailable");
        const data = await response.json();
        if (!Array.isArray(data.forecasts)) throw new Error("Weather unavailable");
        requestCards.forEach((card, index) => renderForecast(card,
          data.forecasts.find(forecast => forecast?.id === String(index))));
      }
      status.textContent = "Forecasts updated.";
    } catch {
      requestCards.forEach(card => showState(card.body, "Forecast temporarily unavailable."));
      status.textContent = "Forecast temporarily unavailable.";
    } finally {
      clearTimeout(timer);
      grid.setAttribute("aria-busy", "false");
    }
  }

  load().catch(() => { section.hidden = true; });
})();