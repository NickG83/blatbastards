# Trip Weather V2

Ride Markdown owns optional forecast locations, dates, periods and coordinates.
The public page progressively enhances this into **one card per ride date**, with
only the configured AM, NOON and PM rows. Dates sort ascending, and periods sort
Morning → Noon → Afternoon regardless of authoring order. Region is retained for
editing but omitted from public cards. No forecast data is stored in Markdown.

The deferred Ride-only script makes exactly **one same-origin GET `/api/weather`**
request. The existing Pages Function makes one small Open-Meteo coordinate batch
per active date. No database, scheduled process, new runtime framework, separate
Worker, weather secrets or build-time weather requests are needed.

## Content and Decap authoring

`weather` is optional. Each point requires a valid ISO calendar date, a lowercase
`period` (`morning`, `noon`, `afternoon`), a non-empty location and finite numeric
coordinates. Latitude: -90..90; longitude: -180..180. Region is optional.
Maximum: **30 points**, with at most three per date and no duplicate date+period.
Both the API and CMS reject duplicate date+period combinations. The CMS validates
individual points, limits the list to 30, and applies Decap's documented
[`isValid()` custom-widget hook](https://decapcms.org/docs/custom-widgets/#advanced-field-validation)
to the complete weather list. It normalizes Date/Date-like values with the existing
`normaliseDate()` behavior, handles Immutable and plain JS values, and reports the
duplicate date and period before publishing. Different periods on the same date
remain valid. Native child and list-size validation still run; the API keeps its
independent duplicate check. The flat Markdown schema is unchanged.

```yaml
weather:
  - date: 2026-10-23
    period: morning
    location: Canberra
    region: Australian Capital Territory
    latitude: -35.28346
    longitude: 149.12807
  - date: 2026-10-23
    period: afternoon
    location: Yarrawonga
    region: Victoria
    latitude: -36.01923
    longitude: 145.99973
```

Add a **Weather Forecast Location**, enter Date, choose the required Period
immediately below it, then search Australian places or enter coordinates manually.
The selector displays Morning, Noon, Afternoon and persists lowercase values.
Search results show name, local government area, state and country. Selection
copies name, region and coordinates, preserving date and period. Coordinates
remain editable. Search queries and forecasts are never persisted. The list
summary includes date, period and location.

The local `weather-point` widget uses Decap's `createClass`/`h` globals,
registered before manual CMS initialization. Its `normaliseDate()` handling is
preserved: YAML/Decap Date and Date-like objects normalize to `YYYY-MM-DD` before
validation, rendering and unrelated point updates (Issue #66 / PR #67).
The weather list uses a small `weather-points` adapter around Decap's native
list control. On YAML reload, Decap converts flat points into Immutable Maps and
its single-field list otherwise reads a nonexistent `point` property. The adapter
passes plain objects into the native list, preserving flat Markdown, dates,
periods, sorting and validation. It applies only to the weather list.
Decap CMS is pinned to **3.17.1** in `static/admin/index.html` because this adapter
wraps the native list control. The exact version was confirmed from the resolved
unpkg CDN URL and package metadata. Its bundle SHA-256
`95e216ad2ec85d48993e000e3b876ce95ad01b161a4f4652d9eb21b4664e93dc`
matched the bundle retained from the successful V2 validation. Future CMS upgrades
must rerun real editor creation and existing-entry edit/save/reload tests.
Existing GitHub auth, editorial workflow and other fields are unchanged.

Bastards & Bushrangers has eight points across four dates, with no Noon points:

| Date | Morning | Afternoon |
| --- | --- | --- |
| 23 October 2026 | Canberra | Yarrawonga |
| 24 October 2026 | Yarrawonga | Mansfield |
| 25 October 2026 | Mansfield | Beechworth |
| 26 October 2026 | Beechworth | Canberra |

## Hourly aggregation

[Open-Meteo's forecast documentation](https://open-meteo.com/en/docs) confirms
comma-separated coordinates return a list of result objects; a single coordinate
returns an object. `timezone=auto` resolves local timezones from coordinates.
Each date request specifies `start_date=<date>&end_date=<date>`, metric units
(Celsius, km/h, mm), default Best Match models, and exactly these hourly fields:

- `weather_code`
- `temperature_2m`
- `precipitation_probability`
- `precipitation`
- `wind_speed_10m`
- `wind_gusts_10m`

There are no daily forecast fields. Each point selects only its date and the
following **provider-labelled local hours**, without converting them to Sydney or
visitor time:

| Period | Public label | Window | Included hourly labels |
| --- | --- | --- | --- |
| morning | AM | 06:00–10:59 | 06, 07, 08, 09, 10 |
| noon | NOON | 11:00–14:59 | 11, 12, 13, 14 |
| afternoon | PM | 15:00–18:59 | 15, 16, 17, 18 |

Temperature minimum and maximum use valid temperatures in that period. Rain
probability is the maximum valid probability (0..100); precipitation amount is
the sum of valid nonnegative hourly amounts, rounded to three decimals to remove
floating-point summation noise. Wind speed and gusts are period maxima. Missing
or invalid ancillary values stay `null`, displayed as “Not available”, never zero.
A period needs at least one usable weather code and one valid temperature;
otherwise it is unavailable. Missing hours are not filled or extrapolated.
Duplicate hour labels are counted once.

Map usable WMO codes to the existing normalized categories, count their frequency,
and choose the most frequent category. Ties use this impact order, highest first:
**thunderstorm, snow, rain, showers, fog, cloudy, partly-cloudy, clear**.
Codes 0 and 1 both count as clear. A single severe hour cannot override a clearly
dominant benign category. Overnight weather cannot influence a riding period.

Thunderstorm, snow and fog also produce `hazards`, including hazards that dominate
the main condition. Each contiguous run has `{ condition, label, start, end }`.
Start/end identify the first/last provider-labelled hazard hours, not a promise
of continuous conditions between samples or a precise hazard duration. An isolated
hour has identical start and end. Separated hours remain separate runs; missing
hours break continuity. Runs sort by start time. Public markers show only hazards
that differ from the main condition, e.g. “⚡ 16–17” with accessible text
“Thunderstorm risk from 16:00 to 17:00 local time (Australia/Perth)”; isolated
hours use “risk at 16:00 local time (Australia/Perth)”. The timezone is accessibility
context rather than a visible card label.
Markers wrap, and convey no fabricated safety advice.

Open-Meteo documents precipitation as a preceding-hour sum and gusts as a
preceding-hour maximum. V2 deliberately aggregates the labelled hours above.
It also documents that ISO timestamps use the UTC offset resolved at request time,
ignoring DST changes within the forecast interval. V2 follows those provider labels;
it does not perform a separate DST-aware reinterpretation.

## API contract

```text
GET /api/weather?points=<URL-encoded JSON array>
```

Construct with `URLSearchParams`, using points shaped as:

```json
[{"latitude":-35.28346,"longitude":149.12807,"date":"2026-10-23","period":"morning"}]
```

The browser sends no location or region names. Exactly one `points` parameter is
allowed; unknown query parameters are rejected. Limit: **8192 encoded query
characters**, 1–30 points. Dates must be real `YYYY-MM-DD` calendar dates and
periods exactly one of the three lowercase strings. Duplicate date+period pairs
are rejected even if their coordinates differ. Invalid input returns 400; non-GET
methods return 405 with `Allow: GET`. Errors contain no internal details.

Validated requests return 200 with:

```text
{
  generatedAt: ISO timestamp,
  source: "Open-Meteo",
  timeZone: "Australia/Sydney",
  today: "YYYY-MM-DD",
  horizonDays: 16,
  forecasts: [{ id, date, period, status, ...statusSpecificFields }]
}
```

IDs remain stable zero-based string indexes in the submitted array, including
past and outside-horizon points. `forecast` adds:

```text
condition, conditionLabel, localTimeZone,
temperatureMaxC, temperatureMinC,
precipitationProbability, precipitationMm,
windMaxKmh, gustMaxKmh,
hazards: [{ condition, label, start: "HH:00", end: "HH:00" }]
```

`condition` is `clear`, `partly-cloudy`, `cloudy`, `fog`, `rain`, `showers`, `snow`
or `thunderstorm`. Gusts remain in the API but are absent from the public UI.
Each successful forecast includes `localTimeZone`, preserving the provider's
validated timezone identifier for the period/hazard clock (for example,
`Australia/Perth` or `Australia/Darwin`). Validation requires a bounded timezone
string recognized by `Intl.DateTimeFormat`; absent/invalid zones make that point
unavailable rather than inventing local context. The top-level `timeZone` remains
`Australia/Sydney`, describing the **lifecycle clock**. Other raw provider metadata,
field names and weather codes are not exposed.

`not-yet-available` includes `availableFrom` (date minus 15 days); `past` and
`unavailable` retain id, date and period. No provider calls are made for past or
outside-horizon points. Loading and wholly outside-horizon states render once
per date. A failed individual period retains its period/location and compact
unavailable state alongside successful sibling rows.

## Lifecycle, caching and graceful failure

The 16-day horizon includes today and the next 15 calendar days. Model data near
the boundary may be missing; availability dates are estimates, not promises.

V2 deliberately retains **Australia/Sydney lifecycle semantics** for `today`,
past/future card visibility and the availability horizon. This is separate from
location-local period aggregation and avoids redesigning lifecycle timezones in
this change. Browser and API use the same trip clock, independent of visitor
location. Reloading advances lifecycle state; there is no midnight polling.

The browser removes past dates before requesting forecasts. All-past Rides hide
the section and make no request. Rides without weather configuration have no
weather section/script. The section is hidden by default so disabled or failed
JavaScript leaves Ride content usable. Invalid individual coordinates affect only
that period; names are inserted as text. Invalid dates, periods or missing names
are skipped. Fetch failure leaves visible date/period states and attribution.

Active points group by date, each with one to three coordinates. At most four date
requests run concurrently under **one shared eight-second abort budget**, including
queued groups and provider body reads. Each provider response is stream-read with
a **128 KiB** bound; redirects are handled manually and never followed. A failed
date or missing coordinate result does not destroy other successful forecasts.
The browser aborts its single request after 12 seconds. There are no automatic
retries, per-card browser requests or visitor geocoding.

Cloudflare Cache API reuse remains best-effort and data-center-local. Canonical
cache **v3** includes normalized points **with period**, input order/IDs, and the
Sydney calendar day. Fully successful/non-error responses use
`Cache-Control: public, max-age=1800`. Any unavailable point makes the complete
response `no-store` and prevents cache insertion, preserving immediate retry on a
later load. Cache match/put failures never suppress forecasts. Old v2 daily
entries cannot be reused.

`X-BBB-Weather-Diagnostic` is `ok` only if all required date groups succeed.
Partial failures use the first failing date group's coarse category in input date
group order: `upstream-http-<status>`, `upstream-timeout`, `upstream-network`,
`upstream-json` or `upstream-data`. No-upstream responses use `ok`. The public
JSON/UI contain no provider diagnostic details.

Each failed date group emits one bounded structured warning with event
`WEATHER_UPSTREAM_FAILED`, category, point count and HTTP status when available.
V2 omits provider reason text entirely. No coordinates, provider bodies, headers,
URLs, stacks or exception internals are logged or returned.

## Presentation and accessibility

Cards use two desktop columns and one column at the existing 768px breakpoint.
Rows use CSS Grid, with inline summary/Rain/Wind on wide cards and two visual
lines on narrower cards. On the narrowest cards, metrics use the full row width.
Rain stays left and Wind right where space permits. Long locations and hazard
runs can wrap. There is no fixed or minimum card height, value truncation or
weather overflow at 390px/320px. A responsive map-width limit and title wrapping
also prevent existing Ride content overflowing the mobile page. Title wrapping
uses `.post-container:has(> .ride-weather) > .bb-page-title`, restricted to the
existing weather-containing Ride page markup; other page titles retain their
existing wrapping. The map iframe's responsive protection is retained.

Each card has one semantic `<time datetime>` header and at most one TODAY badge.
Condition icons retain the local mapping, hide decorative emoji from assistive
technology, and include screen-reader condition text. Temperatures and hazard
markers have accessible labels. The status region reports completion or partial
unavailability, and the grid exposes loading through `aria-busy`. Existing link
focus behavior and attribution remain:
“Weather data: Open-Meteo · Location data: GeoNames · CC BY 4.0”.

## Validation and local preview

```sh
node --test tests/*.test.mjs
hugo
node --check static/js/ride-weather.js
node --check static/admin/weather-point.js
node --check functions/api/weather.js
git diff --check
```

Use an existing Wrangler 4 installation:

```sh
wrangler pages dev public --port 8788 --compatibility-date 2026-08-08
```

The installed local workerd supports dates through 2026-08-08; this preview flag
is not a deployment configuration change. Browser/system libraries and Playwright
are installed outside the repository and add no production dependencies:

```sh
LD_LIBRARY_PATH=/tmp/bbb-browser-libs/root/usr/lib/x86_64-linux-gnu \
FONTCONFIG_FILE=/tmp/bbb-browser-libs/fonts.conf \
PLAYWRIGHT_MODULE=/home/nick/src/nfc-emergency-tag/node_modules/playwright \
node tests/ride-weather.browser.mjs
```

`WEATHER_TEST_URL` overrides localhost:8788. Tests fix the browser clock, mock the
single endpoint response and use Decap's in-memory test backend. The existing
Ride fixture comes from the actual Markdown, including unquoted YAML dates.
No GitHub saves, commits, pushes, production deployment or auth-flow changes are
performed. Screenshots go to `/tmp/bbb-weather-{desktop,mobile,narrow,cms}.png`.

Validation on this branch: **85 Node tests and 16 Chromium scenarios passed**;
Hugo built 34 pages; all three JavaScript syntax checks and `git diff --check`
passed. At 1440px the measured two-period card was approximately **132px**, and
the synthetic three-period card approximately **176px**. The stress fixture with
two hazard markers on every period grew naturally to approximately **226px**;
hazard wrapping is intentionally allowed. Both 390px and 320px layouts passed
card and full-page overflow checks. Actual Decap creation/search/manual editing
and two unrelated edit/save cycles on the existing eight-point Ride passed.
A local Wrangler Pages smoke test returned live forecasts with diagnostic `ok`,
1800-second cache headers and identical `generatedAt` on repeated requests,
confirming cache reuse. No deployed preview or production change was made.

The remediation suite also verifies that a duplicate normalized date+period cannot
reach Decap's `preSave` or alter the in-memory repository, while correcting it to
a distinct period on that date can publish. This negative test expects Decap
3.17.1's native empty promise rejection for an invalid publish; all other page
errors still fail the scenario. Pinned creation and existing-entry round trips,
per-result local timezone validation, local-time hazard accessibility text and
Ride-only title wrapping are covered.
