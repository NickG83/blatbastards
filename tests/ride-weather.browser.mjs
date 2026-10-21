import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseURL = process.env.WEATHER_TEST_URL || "http://localhost:8788";
const browser = await chromium.launch({ headless: true });
const rideURL = `${baseURL}/rides/bastards-bushrangers/`;
let passed = 0;

function forecast(point, index) {
  return { id: String(index), date: point.date, period: point.period, status: "forecast", localTimeZone: "Australia/Sydney", condition: "partly-cloudy",
    conditionLabel: "Partly cloudy", temperatureMaxC: 24, temperatureMinC: 10,
    precipitationProbability: 15, precipitationMm: 0.4, windMaxKmh: 18, gustMaxKmh: 31, hazards: [] };
}

async function scenario(name, run) {
  if (process.env.WEATHER_TEST_SCENARIO && !name.includes(process.env.WEATHER_TEST_SCENARIO)) return;
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.setFixedTime(new Date("2026-10-23T00:00:00Z"));
  await page.route(/maps\.google|www\.google\.com\/maps/, route => route.abort());
  try {
    await run(page, context, errors);
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

async function replacePoints(page, points) {
  await page.route(rideURL, async route => {
    const response = await route.fetch();
    const html = await response.text();
    const value = JSON.stringify(points.map(point => ({ latitude: -35, longitude: 149, ...point })))
      .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    await route.fulfill({ response, body: html.replace(/data-weather="[^"]*"/, () => `data-weather="${value}"`) });
  });
}

try {
  await scenario("four date cards with AM/PM, one request, accessible conditions and compact responsive layout", async page => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let count = 0;
    await page.route("**/api/weather?*", async route => {
      count++;
      const points = JSON.parse(new URL(route.request().url()).searchParams.get("points"));
      assert.equal(points.length, 8);
      for (const point of points) assert.deepEqual(Object.keys(point).sort(), ["date", "latitude", "longitude", "period"]);
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
    assert.equal(await page.getByText("24° / 10°", { exact: true }).count(), 8);
    assert.equal(await page.locator(".ride-weather").getByText("Gusts", { exact: true }).count(), 0);
    assert.equal(await page.locator(".ride-weather-region").count(), 0);
    assert.equal(await page.locator("h1.bb-page-title").evaluate(node => getComputedStyle(node).overflowWrap), "anywhere");
    const section = await page.locator(".ride-weather").boundingBox();
    const facts = await page.locator(".ride-detail-meta").boundingBox();
    const hero = await page.locator('img[src="/uploads/bnbride_hero.jpg"]').boundingBox();
    assert.ok(facts.y < section.y && section.y < hero.y);
    const cards = await page.locator(".ride-weather-card").all();
    const first = await cards[0].boundingBox();
    const second = await cards[1].boundingBox();
    assert.ok(Math.abs(first.y - second.y) < 2 && first.x < second.x, "Two desktop columns");
    assert.ok(first.height <= 165, "Two periods remain close to the old 147px cards");
    assert.ok(loadingHeight < first.height, "Loading sizes naturally");
    for (const card of cards) {
      assert.deepEqual(await card.locator(".ride-weather-period-label").allTextContents(), ["AM", "PM"]);
      assert.equal(await card.locator("time[datetime]").count(), 1);
      assert.equal(await card.locator(".ride-weather-temperatures[aria-label='Maximum 24 degrees Celsius, minimum 10 degrees Celsius']").count(), 2);
      assert.deepEqual(await card.locator(".ride-weather-condition").allTextContents(), ["Partly cloudy", "Partly cloudy"]);
      assert.equal(await card.locator(".ride-weather-icon[aria-hidden='true']").count(), 2);
      assert.ok(["auto", "0px"].includes(await card.evaluate(node => getComputedStyle(node).minHeight)));
      assert.equal(await card.locator(".ride-weather-body").evaluate(node => getComputedStyle(node).minHeight), "0px");
      for (const row of await card.locator(".ride-weather-period").all()) {
        assert.deepEqual(await row.locator("dt").allTextContents(), ["Rain", "Wind"]);
        assert.deepEqual(await row.locator("dd").allTextContents(), ["15% · 0.4 mm", "18 km/h"]);
      }
    }
    console.log(`Two-period card: loading ${loadingHeight.toFixed(1)}px, forecast ${first.height.toFixed(1)}px`);
    await page.locator(".ride-weather").screenshot({ path: "/tmp/bbb-weather-desktop.png" });
    assert.equal(await page.locator('img[src="/uploads/bnbride_hero.jpg"]').evaluate(image => image.complete && image.naturalWidth > 0), true);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok((await cards[1].boundingBox()).y > (await cards[0].boundingBox()).y, "One mobile column");
      assert.equal(await page.locator(".ride-weather-today").isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No page overflow");
      for (const card of cards) {
        assert.equal(await card.evaluate(node => node.scrollWidth > node.clientWidth), false);
        for (const row of await card.locator(".ride-weather-period").all()) {
          assert.equal(await row.evaluate(node => node.scrollWidth > node.clientWidth), false);
          const rain = await row.locator(".ride-weather-rain").boundingBox();
          const wind = await row.locator(".ride-weather-wind").boundingBox();
          assert.ok(rain.x < wind.x, "Rain left, Wind right");
          assert.deepEqual(await row.locator("dd").allTextContents(), ["15% · 0.4 mm", "18 km/h"]);
        }
      }
      await page.locator(".ride-weather").screenshot({ path: `/tmp/bbb-weather-${width === 390 ? "mobile" : "narrow"}.png` });
    }
  });

  await scenario("synthetic three-period day sorts source order and shows compact accessible hazards", async page => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await replacePoints(page, [
      { date: "2026-10-24", period: "afternoon", location: "Yarrawonga" },
      { date: "2026-10-23", period: "afternoon", location: "Beechworth" },
      { date: "2026-10-23", period: "noon", location: "Gundagai" },
      { date: "2026-10-23", period: "morning", location: "Canberra" },
    ]);
    const requests = await mockWeather(page, values => values.map(value => ({ ...value, localTimeZone: "Australia/Perth", hazards: [
      { condition: "thunderstorm", label: "Thunderstorm", start: "16:00", end: "17:00" },
      { condition: "fog", label: "Fog", start: "07:00", end: "07:00" },
    ] })));
    await ready(page);
    assert.equal(requests.length, 1);
    const card = page.locator(".ride-weather-card").first();
    assert.equal(await card.locator("time").getAttribute("datetime"), "2026-10-23");
    assert.deepEqual(await card.locator(".ride-weather-period-label").allTextContents(), ["AM", "NOON", "PM"]);
    assert.equal(await card.getByRole("img", { name: "Thunderstorm risk from 16:00 to 17:00 local time (Australia/Perth)" }).count(), 3);
    assert.equal(await card.getByText("⚡ 16–17", { exact: true }).count(), 3);
    assert.equal(await card.getByRole("img", { name: "Fog risk at 07:00 local time (Australia/Perth)" }).count(), 3);
    assert.ok(!(await card.innerText()).includes("Australia/Perth"), "Timezone context stays in accessibility text");
    const withHazards = (await card.boundingBox()).height;
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await card.evaluate(node => node.scrollWidth > node.clientWidth), false, "Hazard markers wrap without overflow");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator(".ride-weather-hazards").evaluateAll(nodes => nodes.forEach(node => node.remove()));
    const height = (await card.boundingBox()).height;

    assert.ok(height <= 180, "Three-period card stays compact without fixed height");
    console.log(`Three-period card: ${height.toFixed(1)}px; with two hazard markers per period ${withHazards.toFixed(1)}px`);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await card.evaluate(node => node.scrollWidth > node.clientWidth), false);
    }
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
      assert.equal(await page.locator(".ride-weather-card").getByText("Forecast temporarily unavailable.", { exact: true }).count(), 8);
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
      ...forecasts.map((value, index) => index === 0 ? { ...value, windMaxKmh: null }
        : index === 1 ? { ...value, status: "unavailable" } : value),
    ]);
    await ready(page);
    assert.equal(await page.getByText("24° / 10°", { exact: true }).count(), 7);
    assert.equal(await page.getByText("Forecast temporarily unavailable.", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Not available", { exact: true }).count(), 1);
  });

  await scenario("invalid individual coordinates do not spoil other cards; names are text", async page => {
    await replacePoints(page, [
      { date: "2026-10-23", period: "morning", location: "<img src=x onerror=alert(1)>", latitude: 999 },
      { date: "2026-10-23", period: "afternoon", location: "Canberra" },
    ]);
    const requests = await mockWeather(page);
    await ready(page);
    assert.equal(requests[0].length, 1);
    assert.equal(await page.locator(".ride-weather-card").count(), 1);
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

  await scenario("page-title wrapping stays scoped to weather-configured Ride pages", async page => {
    await page.goto(`${baseURL}/rides/`, { waitUntil: "domcontentloaded" });
    assert.notEqual(await page.locator("h1.bb-page-title").evaluate(node => getComputedStyle(node).overflowWrap), "anywhere");
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
    await page.getByLabel("Period", { exact: true }).selectOption("noon");
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
    assert.deepEqual(saved, [{ date: "2026-10-24", period: "noon", location: "Mansfield", region: "Victoria", latitude: -37.1, longitude: 146.08846 }]);
    await page.getByText("2026-10-24 — noon — Mansfield", { exact: true }).waitFor();
    await page.screenshot({ path: "/tmp/bbb-weather-cms.png", fullPage: true });
  });
  await scenario("existing weather-loaded Ride preserves all eight periods through unrelated Decap edit/save", async page => {
    const content = await readFile(new URL("../content/rides/bastards-bushrangers.md", import.meta.url), "utf8");
    const expected = [...content.matchAll(/  - date: ([^\n]+)\n    period: ([^\n]+)\n    location: ([^\n]+)\n    region: ([^\n]+)\n    latitude: ([^\n]+)\n    longitude: ([^\n]+)/g)]
      .map(([, date, period, location, region, latitude, longitude]) => ({ date, period, location, region, latitude: Number(latitude), longitude: Number(longitude) }));
    await page.addInitScript(content => {
      window.repoFiles = { content: { rides: { "bastards-bushrangers.md": { content, path: "content/rides/bastards-bushrangers.md" } } } };
    }, content);
    await page.route("**/admin/config.yml", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace(/^backend:[\s\S]*?publish_mode: editorial_workflow/,
        "backend:\n  name: test-repo\n  login: false\npublish_mode: simple") });
    });
    await page.goto(`${baseURL}/admin/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Rides", exact: true }).waitFor({ timeout: 60000 });
    await page.goto(`${baseURL}/admin/#/collections/rides/entries/bastards-bushrangers`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Title", { exact: true }).waitFor();
    await page.getByLabel("Title", { exact: true }).fill("Such Is Life: Bastards & Bushrangers — test edit");
    await page.evaluate(() => window.CMS.registerEventListener({ name: "preSave", handler: ({ entry }) => {
      window.weatherSavedData = entry.get("data").toJS();
    } }));
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const publishNow = page.getByText("Publish now", { exact: true });
    if (await publishNow.count()) await publishNow.click();
    await page.waitForFunction(() => Boolean(window.weatherSavedData));
    const saved = await page.evaluate(() => window.weatherSavedData.weather.map(point => ({ ...point,
      date: typeof point.date === "string" ? point.date : point.date.toISOString().slice(0, 10),
    })));
    assert.deepEqual(saved, expected);
    await page.waitForFunction(() => window.repoFiles.content.rides["bastards-bushrangers.md"].content.includes("test edit"));
    // Reopen the serialized Markdown too: catching Date-object regressions requires a second editor load.
    await page.goto(`${baseURL}/admin/#/collections/rides`, { waitUntil: "domcontentloaded" });
    await page.goto(`${baseURL}/admin/#/collections/rides/entries/bastards-bushrangers`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Title", { exact: true }).waitFor();
    assert.equal(await page.getByText("2026-10-23 — morning — Canberra", { exact: true }).count(), 1);
    await page.getByLabel("Title", { exact: true }).fill("Such Is Life: Bastards & Bushrangers — second test edit");
    await page.evaluate(() => { window.weatherSavedData = null; });
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const secondPublish = page.getByText("Publish now", { exact: true });
    if (await secondPublish.count()) await secondPublish.click();
    await page.waitForFunction(() => Boolean(window.weatherSavedData));
    assert.deepEqual(await page.evaluate(() => window.weatherSavedData.weather.map(point => ({ ...point,
      date: typeof point.date === "string" ? point.date : point.date.toISOString().slice(0, 10),
    }))), expected);
  });
  await scenario("real Decap rejects duplicate date+period and accepts a different period on the same date", async (page, context, errors) => {
    const original = await readFile(new URL("../content/rides/bastards-bushrangers.md", import.meta.url), "utf8");
    const content = original.replace("distance: 1250", `  - date: 2026-10-23
    period: morning
    location: Second Canberra
    region: Australian Capital Territory
    latitude: -35.28346
    longitude: 149.12807
distance: 1250`);
    await page.addInitScript(content => {
      window.repoFiles = { content: { rides: { "bastards-bushrangers.md": { content, path: "content/rides/bastards-bushrangers.md" } } } };
    }, content);
    await page.route("**/admin/config.yml", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace(/^backend:[\s\S]*?publish_mode: editorial_workflow/,
        "backend:\n  name: test-repo\n  login: false\npublish_mode: simple") });
    });
    await page.goto(`${baseURL}/admin/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Rides", exact: true }).waitFor({ timeout: 60000 });
    assert.equal(await page.locator('script[src="https://unpkg.com/decap-cms@3.17.1/dist/decap-cms.js"]').count(), 1);
    await page.goto(`${baseURL}/admin/#/collections/rides/entries/bastards-bushrangers`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Title", { exact: true }).fill("Duplicate validation test");
    await page.evaluate(() => window.CMS.registerEventListener({ name: "preSave", handler: ({ entry }) => {
      window.weatherSaveCount = (window.weatherSaveCount || 0) + 1;
      window.weatherSavedData = entry.get("data").toJS();
    } }));
    // Decap 3.17.1 rejects invalid publishes with Promise.reject() and no reason.
    // Expect just that native validation rejection for this failed attempt;
    // leave all other page errors in the scenario's error list.
    const expectedError = "Uncaught (in promise) undefined";
    const rejectedPublish = page.waitForEvent("pageerror", { predicate: error => error.message === expectedError });
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const publishNow = page.getByText("Publish now", { exact: true });
    if (await publishNow.count()) await publishNow.click();
    await page.getByText("Duplicate weather period: 2026-10-23 morning. Choose each Morning, Noon or Afternoon only once per date.", { exact: true }).waitFor();
    await rejectedPublish;
    errors.splice(errors.indexOf(expectedError), 1);
    assert.equal(await page.evaluate(() => window.weatherSaveCount || 0), 0, "Duplicate never reaches preSave");
    assert.equal(await page.evaluate(() => window.repoFiles.content.rides["bastards-bushrangers.md"].content), content, "Duplicate cannot be published");
    await page.getByText("2026-10-23 — morning — Second Canberra", { exact: true }).locator("..").getByRole("button").first().click();
    await page.getByLabel("Period", { exact: true }).nth(8).selectOption("noon");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    if (await publishNow.count()) await publishNow.click();
    await page.waitForFunction(() => Boolean(window.weatherSavedData));
    const saved = await page.evaluate(() => window.weatherSavedData.weather);
    assert.equal(saved.length, 9);
    assert.deepEqual(saved.filter(point => (typeof point.date === "string" ? point.date : point.date.toISOString().slice(0, 10)) === "2026-10-23").map(point => point.period), ["morning", "afternoon", "noon"]);
    await page.waitForFunction(() => window.repoFiles.content.rides["bastards-bushrangers.md"].content.includes("period: noon"));
    assert.equal(await page.evaluate(() => window.weatherSaveCount), 1);
  });
  console.log(`${passed} browser scenarios passed; screenshots: /tmp/bbb-weather-{desktop,mobile}.png`);
} finally { await browser.close(); }
