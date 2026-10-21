import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const script = await readFile(new URL("../static/admin/weather-point.js", import.meta.url), "utf8");
function widget(fetch) {
  let definition;
  let listDefinition;
  const sandbox = {
    window: { h: (tag, props) => ({ tag, props }), createClass: value => value, CMS: { getWidget: () => ({ control: "native-list" }), registerWidget: (name, control) => {
      if (typeof name === "string") { assert.equal(name, "weather-point"); definition = control; }
      else listDefinition = name.controlComponent;
    } } }, fetch, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
  };
  vm.runInNewContext(script, sandbox);
  const instance = { ...definition, props: { value: {}, onChange(value) { instance.props.value = value; } },
    setState(value) { Object.assign(this.state, value); } };
  instance.listDefinition = listDefinition;
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
  control.update("period", "morning");
  control.state.query = "Mansfield";
  await control.search();
  assert.equal(control.state.results.length, 1);
  control.select(control.state.results[0]);
  assert.equal(JSON.stringify(control.props.value), JSON.stringify({
    date: "2026-10-24", period: "morning", location: "Mansfield", region: "Victoria", latitude: -37.052, longitude: 146.08846,
  }));
  assert.equal(control.isValid(), true);
  control.update("latitude", -37.1);
  assert.equal(control.props.value.latitude, -37.1);
});

test("manual coordinates require no search and support Immutable Decap values", () => {
  const control = widget(() => { throw new Error("Must not search"); });
  control.props.value = { toJS: () => ({ date: "2026-10-24", period: "morning", location: "Forest camp", latitude: 0, longitude: 0 }) };
  assert.equal(control.isValid(), true);
  control.update("longitude", 146.1);
  assert.equal(control.props.value.longitude, 146.1);
  assert.equal(control.props.value.location, "Forest camp");
});

test("Decap YAML Date values normalise to ISO strings before validation or update", () => {
  const control = widget(() => { throw new Error("Must not search"); });
  control.props.value = { toJS: () => ({
    date: new Date("2026-10-24T00:00:00.000Z"),
    period: "morning",
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

test("all eight migrated weather points preserve periods after YAML Date round-trip and unrelated edit", async () => {
  const content = await readFile(new URL("../content/rides/bastards-bushrangers.md", import.meta.url), "utf8");
  const entries = [...content.matchAll(/  - date: ([^\n]+)\n    period: ([^\n]+)\n    location: ([^\n]+)\n    region: ([^\n]+)\n    latitude: ([^\n]+)\n    longitude: ([^\n]+)/g)];
  assert.equal(entries.length, 8);
  const expected = entries.map(([, date, period, location, region, latitude, longitude]) => ({ date, period, location, region, latitude: Number(latitude), longitude: Number(longitude) }));
  assert.deepEqual(expected.map(point => point.period), ["morning", "afternoon", "morning", "afternoon", "morning", "afternoon", "morning", "afternoon"]);
  const saved = expected.map(point => {
    const control = widget(() => { throw new Error("Must not search"); });
    control.props.value = { toJS: () => ({ ...point, date: new Date(`${point.date}T00:00:00.000Z`) }) };
    assert.equal(control.isValid(), true, point.location);
    control.update("location", point.location);
    return control.props.value;
  });
  assert.equal(JSON.stringify(saved), JSON.stringify(expected));
});

for (const period of ["morning", "noon", "afternoon"]) test(`persists valid ${period} period through search and manual edits`, () => {
  const control = widget();
  control.props.value = { date: "2026-10-24", location: "Camp", latitude: -37, longitude: 146 };
  control.update("period", period);
  control.select(mansfield);
  control.update("latitude", -37.1);
  assert.equal(control.props.value.period, period);
  assert.equal(control.isValid(), true);
});

test("Date-like value survives unrelated edit and retains period", () => {
  const control = widget();
  control.props.value = { date: { toISOString: () => "2026-10-24T00:00:00.000Z" }, period: "noon", location: "Camp", latitude: 0, longitude: 0 };
  assert.equal(control.isValid(), true);
  control.update("region", "Victoria");
  assert.equal(control.props.value.date, "2026-10-24");
  assert.equal(control.props.value.period, "noon");
});

test("widget validates required fields and calendar dates", () => {
  const control = widget();
  for (const changes of [{ period: undefined }, { period: "" }, { period: "Morning" }, { period: "evening" }, { date: "2026-02-30" }, { date: new Date("invalid") }, { latitude: null }, { longitude: 181 }, { location: " " }]) {
    control.props.value = { date: "2026-10-24", period: "morning", location: "Camp", latitude: -37, longitude: 146, ...changes };
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

test("native list adapter preserves loaded flat maps and Date objects, delegates validation and focus", () => {
  const control = widget();
  const date = new Date("2026-10-24T00:00:00.000Z");
  const point = { date, period: "noon", location: "Camp", latitude: -37, longitude: 146 };
  const immutablePoint = { toJS: () => point };
  const loaded = { map: callback => [immutablePoint].map(callback) };
  let validates = 0;
  let listValidates = 0;
  let focus;
  const adapter = { ...control.listDefinition, props: { value: loaded, validate() { listValidates++; } } };
  const rendered = adapter.render();
  assert.equal(rendered.tag, "native-list");
  assert.deepEqual(rendered.props.value, [point]);
  assert.equal(rendered.props.value[0].date, date, "Date normalization still belongs to the point widget");
  rendered.props.ref({ validate() { validates++; }, focus(path) { focus = path; } });
  adapter.validate();
  adapter.focus("0.point");
  assert.equal(validates, 1);
  assert.equal(listValidates, 1);
  assert.equal(focus, "0.point");
  control.props.value = rendered.props.value[0];
  assert.equal(control.isValid(), true);
});

function listControl(value) {
  return { ...widget().listDefinition, props: { value } };
}

for (const period of ["morning", "noon", "afternoon"]) {
  test(`list rejects duplicate ${period} after Date/Date-like normalization in plain and Immutable values`, () => {
    const original = { date: "2026-10-24", period, location: "Camp", latitude: -37, longitude: 146 };
    const variants = [
      { ...original, date: new Date("2026-10-24T00:00:00.000Z"), location: "Other camp" },
      { ...original, date: { toISOString: () => "2026-10-24T00:00:00.000Z" } },
    ];
    for (const duplicate of variants) {
      for (const points of [
        [original, duplicate],
        { toJS: () => [original, duplicate] },
        [original, { toJS: () => duplicate }],
      ]) {
        const result = listControl(points).isValid();
        assert.match(result.error.message, /Duplicate weather period/);
        assert.ok(result.error.message.includes(`2026-10-24 ${period}`));
        assert.equal(original.date, "2026-10-24", "Validation leaves authored values intact");
      }
    }
  });
}

test("list accepts three different periods per date and the same period on another date", () => {
  const points = [
    { date: "2026-10-24", period: "morning" },
    { date: new Date("2026-10-24T00:00:00.000Z"), period: "noon" },
    { date: { toISOString: () => "2026-10-24T00:00:00.000Z" }, period: "afternoon" },
    { date: "2026-10-25", period: "morning" },
  ];
  for (const value of [points, { toJS: () => points }, [], undefined]) assert.equal(listControl(value).isValid(), true);
});

test("list-level validation retains native list size errors", () => {
  const control = listControl([]);
  control.control = { validateSize: () => [{ message: "Maximum 30 weather points" }] };
  assert.equal(control.isValid().error.message, "Maximum 30 weather points");
});
