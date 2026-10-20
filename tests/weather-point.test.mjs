import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const script = await readFile(new URL("../static/admin/weather-point.js", import.meta.url), "utf8");
function widget(fetch) {
  let definition;
  const sandbox = {
    window: { createClass: value => value, CMS: { registerWidget: (name, control) => {
      assert.equal(name, "weather-point"); definition = control;
    } } }, fetch, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
  };
  vm.runInNewContext(script, sandbox);
  const instance = { ...definition, props: { value: {}, onChange(value) { instance.props.value = value; } },
    setState(value) { Object.assign(this.state, value); } };
  instance.state = instance.getInitialState();
  return instance;
}

const mansfield = { id: 2158839, name: "Mansfield", country_code: "AU", admin1: "Victoria", admin2: "Mansfield", latitude: -37.052, longitude: 146.08846 };
test("Australian search persists flat coordinates and region, preserving date", async () => {
  const control = widget(async url => {
    assert.equal(url.origin, "https://geocoding-api.open-meteo.com");
    assert.equal(url.searchParams.get("countryCode"), "AU");
    assert.equal(url.searchParams.get("name"), "Mansfield");
    return Response.json({ results: [mansfield, { ...mansfield, country_code: "US" }] });
  });
  control.update("date", "2026-10-24");
  control.state.query = "Mansfield";
  await control.search();
  assert.equal(control.state.results.length, 1);
  control.select(control.state.results[0]);
  assert.equal(JSON.stringify(control.props.value), JSON.stringify({
    date: "2026-10-24", location: "Mansfield", region: "Victoria", latitude: -37.052, longitude: 146.08846,
  }));
  assert.equal(control.isValid(), true);
  control.update("latitude", -37.1);
  assert.equal(control.props.value.latitude, -37.1);
});

test("manual coordinates require no search and support Immutable Decap values", () => {
  const control = widget(() => { throw new Error("Must not search"); });
  control.props.value = { toJS: () => ({ date: "2026-10-24", location: "Forest camp", latitude: 0, longitude: 0 }) };
  assert.equal(control.isValid(), true);
  control.update("longitude", 146.1);
  assert.equal(control.props.value.longitude, 146.1);
  assert.equal(control.props.value.location, "Forest camp");
});

test("Decap YAML Date values normalise to ISO strings before validation or update", () => {
  const control = widget(() => { throw new Error("Must not search"); });
  control.props.value = { toJS: () => ({
    date: new Date("2026-10-24T00:00:00.000Z"),
    location: "Mansfield",
    region: "Victoria",
    latitude: -37.052,
    longitude: 146.08846,
  }) };

  assert.equal(control.point().date, "2026-10-24");
  assert.equal(control.isValid(), true);

  // An unrelated change must not turn the round-tripped date into an invalid value.
  control.update("region", "Victoria");
  assert.equal(control.props.value.date, "2026-10-24");
  assert.equal(control.props.value.location, "Mansfield");
  assert.equal(control.props.value.latitude, -37.052);
  assert.equal(control.props.value.longitude, 146.08846);
});

test("four existing weather points remain valid after a YAML date round-trip", () => {
  const existing = [
    { date: "2026-10-23", location: "Yarrawonga", region: "Victoria", latitude: -36.01923, longitude: 145.99973 },
    { date: "2026-10-24", location: "Mansfield", region: "Victoria", latitude: -37.052, longitude: 146.08846 },
    { date: "2026-10-25", location: "Beechworth", region: "Victoria", latitude: -36.35828, longitude: 146.68584 },
    { date: "2026-10-26", location: "Canberra", region: "Australian Capital Territory", latitude: -35.28346, longitude: 149.12807 },
  ];

  const saved = existing.map(point => {
    const control = widget(() => { throw new Error("Must not search"); });
    control.props.value = { toJS: () => ({ ...point, date: new Date(`${point.date}T00:00:00.000Z`) }) };
    assert.equal(control.isValid(), true, point.location);
    control.update("location", point.location);
    return control.props.value;
  });

  assert.equal(JSON.stringify(saved), JSON.stringify(existing));
});

test("widget validates required fields and calendar dates", () => {
  const control = widget();
  for (const changes of [{ date: "2026-02-30" }, { date: new Date("invalid") }, { latitude: null }, { longitude: 181 }, { location: " " }]) {
    control.props.value = { date: "2026-10-24", location: "Camp", latitude: -37, longitude: 146, ...changes };
    assert.notEqual(control.isValid(), true);
  }
});

test("geocoding failure keeps manual values intact", async () => {
  const control = widget(async () => { throw new Error("Network down"); });
  control.props.value = { location: "Camp", latitude: -37, longitude: 146 };
  control.state.query = "Camp";
  await control.search();
  assert.match(control.state.message, /manually/);
  assert.equal(control.state.searching, false);
  assert.equal(control.props.value.latitude, -37);
});