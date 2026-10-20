import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseURL = process.env.WEATHER_TEST_URL || "http://localhost:8788";
const browser = await chromium.launch({ headless: true });
const rideURL = `${baseURL}/rides/bastards-bushrangers/`;
let passed = 0;

function forecast(point, index) {
  return { id: String(index), date: point.date, status: "forecast", condition: "partly-cloudy",
    conditionLabel: "Partly cloudy", temperatureMaxC: 24, temperatureMinC: 10,
    precipitationProbability: 15, precipitationMm: 0.4, windMaxKmh: 18, gustMaxKmh: 31 };
}

async function scenario(name, run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.setFixedTime(new Date("2026-10-23T00:00:00Z"));
  await page.route(/maps\.google|www\.google\.com\/maps/, route => route.abort());
  try {
    await run(page, context);
    assert.deepEqual(errors, [], "No uncaught page errors");
    console.log(`PASS ${name}`);
    passed++;
  } finally { await context.close(); }
}

async function mockWeather(page, transform = values => values) {
  const requests = [];
  page.on("request", request => {
    assert.ok(!request.url().includes("geocoding-api"), "Visitors never geocode");
  });
  await page.route("**/api/weather?*", async route => {
    const points = JSON.parse(new URL(route.request().url()).searchParams.get("points"));
    requests.push(points);
    await route.fulfill({ json: { forecasts: transform(points.map(forecast)) } });
  });
  return requests;
}

async function ready(page) {
  await page.goto(rideURL, { waitUntil: "domcontentloaded" });
  await page.locator('.ride-weather-grid[aria-busy="false"]').waitFor();
}

try {
  await scenario("four cards, placement, loading, one request, desktop/mobile and assets", async page => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let count = 0;
    await page.route("**/api/weather?*", async route => {
      count++;
      const points = JSON.parse(new URL(route.request().url()).searchParams.get("points"));
      assert.equal(points.length, 4);
      await gate;
      await route.fulfill({ json: { forecasts: points.map(forecast) } });
    });
    await page.goto(rideURL, { waitUntil: "domcontentloaded" });
    await page.getByText("Loading forecast…", { exact: true }).first().waitFor();
    assert.equal(await page.locator(".ride-weather-card").count(), 4);
    const loadingHeight = (await page.locator(".ride-weather-card").first().boundingBox()).height;
    release();
    await page.locator('.ride-weather-grid[aria-busy="false"]').waitFor();
    assert.equal(count, 1);
    assert.equal(await page.locator(".ride-weather-today").count(), 1);
    assert.equal(await page.locator(".ride-weather-today").isVisible(), true);
    assert.equal(await page.getByText("24°C / 10°C", { exact: true }).count(), 4);
    const after = await page.locator(".ride-weather").boundingBox();
    assert.equal(await page.locator(".ride-weather-metrics").getByText("Gusts", { exact: true }).count(), 0);
    assert.deepEqual(await page.locator(".ride-weather-card").first().locator("dt").allTextContents(), ["Rain", "Wind"]);
    assert.equal(await page.locator('.ride-weather-header > .ride-weather-location').count(), 4);
    assert.equal(await page.locator('.ride-weather-header > .ride-weather-date-row > time[datetime]').count(), 4);
    assert.equal(await page.locator('.ride-weather-temperatures[aria-label="Maximum 24 degrees Celsius, minimum 10 degrees Celsius"]').count(), 4);
    assert.equal(await page.locator(".ride-weather-summary > .ride-weather-condition").count(), 4);
    const facts = await page.locator(".ride-detail-meta").boundingBox();
    const hero = await page.locator('img[src="/uploads/bnbride_hero.jpg"]').boundingBox();
    assert.ok(facts.y < after.y && after.y < hero.y);
    const cards = await page.locator(".ride-weather-card").all();
    const first = await cards[0].boundingBox();
    const second = await cards[1].boundingBox();
    assert.equal(first.y, second.y);
    assert.ok(first.x < second.x);
    assert.ok(first.height < 220, "Forecast card is compact");
    assert.ok(loadingHeight < first.height, "Loading sizes naturally without a reserved forecast body");
    for (const card of cards) {
      const location = await card.locator(".ride-weather-location").boundingBox();
      const date = await card.locator(".ride-weather-date").boundingBox();
      assert.ok(location.x < date.x, "Location is left of date");
      assert.ok(Math.max(location.y, date.y) < Math.min(location.y + location.height, date.y + date.height), "Location and date share a desktop row");
      assert.equal(await card.locator(".ride-weather-body").evaluate(body => getComputedStyle(body).minHeight), "0px");
    }
    console.log(`Card height: loading ${loadingHeight}px, forecast ${first.height}px`);
    await page.locator(".ride-weather").screenshot({ path: "/tmp/bbb-weather-desktop.png" });
    assert.equal(await page.locator('img[src="/uploads/bnbride_hero.jpg"]').evaluate(image => image.complete && image.naturalWidth > 0), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok((await cards[1].boundingBox()).y > (await cards[0].boundingBox()).y);
    const overflow = await page.locator(".ride-weather").evaluate(section => section.scrollWidth > section.clientWidth);
    assert.equal(overflow, false);
    await page.locator(".ride-weather").screenshot({ path: "/tmp/bbb-weather-mobile.png" });
    await page.setViewportSize({ width: 320, height: 740 });
    assert.ok((await cards[1].boundingBox()).y > (await cards[0].boundingBox()).y);
    assert.equal(await page.locator(".ride-weather-today").isVisible(), true);
    assert.equal(await page.locator(".ride-weather").evaluate(section => section.scrollWidth > section.clientWidth), false);
    assert.equal(await cards[0].evaluate(card => card.scrollWidth > card.clientWidth), false);
    await page.locator(".ride-weather").screenshot({ path: "/tmp/bbb-weather-narrow.png" });
  });

  await scenario("past point disappears; today and later points use one request", async page => {
    await page.clock.setFixedTime(new Date("2026-10-24T00:00:00Z"));
    const requests = await mockWeather(page);
    await ready(page);
    assert.equal(await page.locator(".ride-weather-card").count(), 3);
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0].date, "2026-10-24");
    assert.equal(await page.locator(".ride-weather-today").count(), 1);
  });

  await scenario("all past hides section and makes no request", async page => {
    await page.clock.setFixedTime(new Date("2026-10-27T00:00:00Z"));
    const requests = await mockWeather(page);
    await page.goto(rideURL, { waitUntil: "load" });
    assert.equal(await page.locator(".ride-weather").isVisible(), false);
    assert.equal(requests.length, 0);
  });

  await scenario("not yet available shows endpoint-derived availability", async page => {
    await page.clock.setFixedTime(new Date("2026-09-01T00:00:00Z"));
    await mockWeather(page, forecasts => forecasts.map(value => ({ ...value, status: "not-yet-available", availableFrom: "2026-10-08" })));
    await ready(page);
    assert.equal(await page.getByText("Forecast not yet available", { exact: true }).count(), 4);
    assert.match(await page.locator(".ride-weather").textContent(), /8 October 2026/);
  });

  for (const failure of ["http", "network", "malformed"]) {
    await scenario(`${failure} failure leaves Ride and attribution usable`, async page => {
      await page.route("**/api/weather?*", route => failure === "network" ? route.abort()
        : route.fulfill(failure === "http" ? { status: 503, body: "Failed" } : { json: { forecasts: null } }));
      await ready(page);
      assert.equal(await page.locator(".ride-weather-card").getByText("Forecast temporarily unavailable.", { exact: true }).count(), 4);
      assert.equal(await page.locator(".ride-detail-content").isVisible(), true);
      assert.equal(await page.locator(".ride-map-embed iframe").count(), 1);
      const attribution = page.locator(".ride-weather-attribution");
      assert.equal(await attribution.isVisible(), true);
      assert.equal(await attribution.textContent(), "Weather data: Open-Meteo · Location data: GeoNames · CC BY 4.0");
      for (const [name, url] of [["Open-Meteo", "https://open-meteo.com/"], ["GeoNames", "https://www.geonames.org/"]]) {
        const link = attribution.getByRole("link", { name, exact: true });
        assert.equal(await link.count(), 1);
        assert.equal(await link.getAttribute("href"), url);
        assert.equal(await link.getAttribute("target"), "_blank");
        assert.equal(await link.getAttribute("rel"), "noopener");
      }
    });
  }

  await scenario("partial response keeps good forecasts and missing metrics are not zero", async page => {
    await mockWeather(page, forecasts => [
      { ...forecasts[0], windMaxKmh: null }, { ...forecasts[1], status: "unavailable" }, forecasts[2], forecasts[3],
    ]);
    await ready(page);
    assert.equal(await page.getByText("24°C / 10°C", { exact: true }).count(), 3);
    assert.equal(await page.getByText("Forecast temporarily unavailable.", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Not available", { exact: true }).count(), 1);
  });

  await scenario("invalid individual coordinates do not spoil other cards; names are text", async page => {
    await page.route(rideURL, async route => {
      const response = await route.fetch();
      const html = await response.text();
      await route.fulfill({ response, body: html.replace("-35.98536", "999").replace("Mulwala&#34;", "&lt;img src=x onerror=alert(1)&gt;&#34;") });
    });
    const requests = await mockWeather(page);
    await ready(page);
    assert.equal(requests[0].length, 3);
    assert.equal(await page.locator(".ride-weather-card").count(), 4);
    assert.equal(await page.locator(".ride-weather img").count(), 0);
    assert.equal(await page.getByText("Forecast temporarily unavailable.", { exact: true }).count(), 1);
  });

  await scenario("Ride without config has no section or weather script", async page => {
    const requests = await mockWeather(page);
    await page.goto(`${baseURL}/rides/black-stump-bogan/`, { waitUntil: "load" });
    assert.equal(await page.locator(".ride-weather").count(), 0);
    assert.equal(await page.locator('script[src="/js/ride-weather.js"]').count(), 0);
    assert.equal(requests.length, 0);
  });

  const noJS = await browser.newContext({ javaScriptEnabled: false });
  const page = await noJS.newPage();
  await page.goto(rideURL, { waitUntil: "domcontentloaded" });
  assert.equal(await page.locator(".ride-weather").isVisible(), false);
  assert.equal(await page.locator(".ride-detail-content").isVisible(), true);
  assert.equal(await page.locator(".ride-map-embed iframe").count(), 1);
  assert.equal(await page.locator(".ride-gallery-img").count(), 1);
  await noJS.close();
  console.log("PASS JavaScript disabled preserves Ride details/map/gallery/attendees");
  passed++;

  await scenario("real Decap editor searches AU places and saves flat point data", async page => {
    await page.route("**/admin/config.yml", async route => {
      const response = await route.fetch();
      const yaml = await response.text();
      await route.fulfill({ response, body: yaml.replace(/^backend:[\s\S]*?publish_mode: editorial_workflow/,
        "backend:\n  name: test-repo\n  login: false\npublish_mode: simple") });
    });
    const searches = [];
    await page.route("https://geocoding-api.open-meteo.com/**", async route => {
      const url = new URL(route.request().url());
      searches.push(url);
      assert.equal(url.searchParams.get("countryCode"), "AU");
      await route.fulfill({ json: { results: [
        { id: 2158839, name: "Mansfield", country_code: "AU", admin1: "Victoria", admin2: "Mansfield", latitude: -37.052, longitude: 146.08846 },
        { id: 9957346, name: "Mansfield", country_code: "AU", admin1: "Queensland", admin2: "Brisbane", latitude: -27.53929, longitude: 153.09895 },
      ] } });
    });
    await page.goto(`${baseURL}/admin/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Rides", exact: true }).waitFor({ timeout: 60000 });
    await page.getByRole("link", { name: "Rides", exact: true }).click();
    await page.locator('a[href="#/collections/rides/new"]').click();
    await page.getByRole("button", { name: "Add weather forecast location", exact: true }).waitFor();
    assert.equal(searches.length, 0);
    await page.getByRole("button", { name: "Add weather forecast location", exact: true }).click();
    await page.getByLabel("Search Australian places", { exact: true }).fill("Mansfield");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "Mansfield, Mansfield, Victoria, Australia", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Mansfield, Brisbane, Queensland, Australia", exact: true }).count(), 1);
    await page.getByRole("button", { name: "Mansfield, Mansfield, Victoria, Australia", exact: true }).click();
    assert.equal(await page.getByLabel("Location", { exact: true }).inputValue(), "Mansfield");
    assert.equal(await page.getByLabel("Latitude", { exact: true }).inputValue(), "-37.052");
    assert.equal(await page.getByLabel("Longitude", { exact: true }).inputValue(), "146.08846");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-24");
    await page.getByLabel("Latitude", { exact: true }).fill("-37.1");
    assert.equal(searches.length, 1);
    await page.getByLabel("Title", { exact: true }).fill("Weather authoring test");
    await page.getByLabel("Region", { exact: true }).first().fill("Victoria");
    await page.locator('[contenteditable="true"]').first().fill("Ride notes for in-memory authoring validation.");
    await page.evaluate(() => window.CMS.registerEventListener({
      name: "preSave", handler: ({ entry }) => {
        window.weatherSavedData = entry.get("data").toJS();
      },
    }));
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const publishNow = page.getByText("Publish now", { exact: true });
    if (await publishNow.count()) await publishNow.click();
    await page.waitForFunction(() => Boolean(window.weatherSavedData));
    const saved = await page.evaluate(() => window.weatherSavedData.weather);
    assert.deepEqual(saved, [{ date: "2026-10-24", location: "Mansfield", region: "Victoria", latitude: -37.1, longitude: 146.08846 }]);
    await page.getByText("2026-10-24 — Mansfield", { exact: true }).waitFor();
    await page.screenshot({ path: "/tmp/bbb-weather-cms.png", fullPage: true });
  });
  console.log(`${passed} browser scenarios passed; screenshots: /tmp/bbb-weather-{desktop,mobile}.png`);
} finally { await browser.close(); }