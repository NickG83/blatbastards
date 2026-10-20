# Trip Weather (V1)

Ride Markdown owns locations, dates and coordinates. A Ride-only deferred script
reads Hugo's HTML-escaped configuration and makes one same-origin GET request to
`/api/weather`. The existing Cloudflare Pages Function batches forecastable
coordinates into one standard Open-Meteo Forecast API call, using best-match
models, metric units and only the seven required daily values. No build-time
weather requests, scheduled rebuilds, keys, database or separate Worker are needed.

## Content and authoring

`weather` is optional; each included point requires an ISO calendar date, location
and numeric coordinates. Region is optional. Maximum: 10 points.

The example in `content/rides/bastards-bushrangers.md` is:

```yaml
weather:
  - date: 2026-10-23
    location: Mulwala
    region: New South Wales
    latitude: -35.98536
    longitude: 146.00534
  - date: 2026-10-24
    location: Mansfield
    region: Victoria
    latitude: -37.052
    longitude: 146.08846
  - date: 2026-10-25
    location: Beechworth
    region: Victoria
    latitude: -36.35828
    longitude: 146.68584
  - date: 2026-10-26
    location: Yass
    region: New South Wales
    latitude: -34.84036
    longitude: 148.90987
```

These coordinates were selected from Open-Meteo's geocoding search with
`countryCode=AU`, `language=en`, `count=10`. Selected GeoNames IDs: 2156298,
2158839, 2176429, 2142412, respectively. No coordinates were approximated.

In Decap, add a **Weather Forecast Location**, enter a date and search for a place.
Results show the name, local government area, state and country. Selecting one
copies `name`, `admin1`, `latitude`, `longitude` into the flat point fields.
All fields remain editable. A remote camp can be entered manually without any
lookup. No search text or forecast values are persisted.

The native Decap list uses a small local `weather-point` widget through Decap's
documented `createClass`/`h` globals. There is no additional React package or build
pipeline. Registration precedes manual CMS initialization. Existing GitHub backend,
editorial workflow, auth routes and other fields are unchanged.

## API contract

`GET /api/weather?points=<URL-encoded JSON array>`; for example, construct the query
with `URLSearchParams` and this JSON:

```json
[{"latitude":-35.98536,"longitude":146.00534,"date":"2026-10-23"}]
```

Names are not sent. IDs are zero-based string indexes in the submitted array.
Only `points` is accepted, once. Limit: 4096 query characters, 1-10 points;
latitude -90..90, longitude -180..180, finite JSON numbers only; real dates in
`YYYY-MM-DD` format. Invalid input returns 400; other methods return 405 with
`Allow: GET`. Error bodies contain a concise `error` string, not internal details.

Successful validation returns 200 with:

```text
{
  generatedAt: ISO timestamp,
  source: "Open-Meteo",
  timeZone: "Australia/Sydney",
  today: "YYYY-MM-DD",
  horizonDays: 16,
  forecasts: [{ id, date, status, ...statusSpecificFields }]
}
```

`forecast` adds `condition`, `conditionLabel`, `temperatureMaxC`,
`temperatureMinC`, `precipitationProbability`, `precipitationMm`, `windMaxKmh`,
`gustMaxKmh`. Condition is one of `clear`, `partly-cloudy`, `cloudy`, `fog`,
`rain`, `showers`, `snow`, `thunderstorm`. Missing ancillary values are `null`,
displayed as "Not available", never zero. Missing core temperature/condition data
makes that point `unavailable`. The browser never reads provider field names/codes.

`not-yet-available` adds `availableFrom` (point date minus 15 calendar days).
`unavailable` indicates a provider failure/missing day; `past` indicates an expired
point submitted directly to the API. No upstream request is made for past or
beyond-horizon points. Successful points survive partial provider responses.

## Lifecycle, caching and failure

The standard API supports 16 days **including today**, not 16 days after today.
Actual model data may be missing near the horizon; that is unavailable, never a
fabricated forecast. Availability dates are estimates, not a promise of coverage.

V1 uses an explicit **Australia/Sydney trip clock**, shared by browser and API,
including daylight saving. This matches the initial NSW/Victoria trip and avoids
visitors in other time zones hiding cards at different times. Other Australian
time zones are not resolved individually; per-point time zones are a future schema
decision. Reopening/reloading the page advances lifecycle state; no midnight poll.

Past points are removed in the browser before requesting weather. All-past Rides
hide the whole section. The section is hidden by default, so disabled or failed
JavaScript leaves existing Ride features intact. Invalid individual coordinates
show an unavailable card without preventing the valid points' single API request.
Invalid/missing dates or names are skipped. Loading reserves space for daily
forecast content. Desktop uses two columns; the existing 768px breakpoint stacks
them. Attribution remains visible whenever the section is displayed:
"Weather data: Open-Meteo · Location data: GeoNames · CC BY 4.0".
Open-Meteo links to https://open-meteo.com/; GeoNames links to
https://www.geonames.org/ and credits the location data underlying Open-Meteo
Geocoding. The public attribution includes the CC BY 4.0 licence notice.

Validated, fully non-error responses use `caches.default.match/put` with a
canonical, versioned key including the Sydney calendar day and submitted points.
`Cache-Control: public, max-age=1800` gives about 30 minutes of reuse. Cloudflare's
Cache API is data-center-local, best-effort and may evict entries. Cache failures
do not suppress forecasts. Responses containing an unavailable point are not
cached, allowing a later load to retry immediately.

Upstream URLs/fields are constructed internally. Open-Meteo redirects are handled
manually and are not followed; 3xx responses use `upstream-http-<status>`.
The response body is limited to 128 KiB and the request aborted after 8 seconds. Browser requests
abort after 12 seconds. HTTP/network/timeout/JSON failures show "Forecast
temporarily unavailable." No automatic retries, per-card calls or visitor
geocoding occur. No safety classifications or recommendations are made.

Validated responses include `X-BBB-Weather-Diagnostic`: `ok`,
`upstream-http-<status>` (including 429/403), `upstream-timeout`,
`upstream-network`, `upstream-json`, or `upstream-data`. The diagnostic describes
the overall upstream operation; partial/missing core forecasts use `upstream-data`
while retaining successful points. No-upstream past/beyond-horizon responses use
`ok`. The JSON contract and public UI do not consume or expose diagnostic details.
Failures emit one structured `console.warn` event, `WEATHER_UPSTREAM_FAILED`,
with category, point count, HTTP status when available, and an optional explicitly
returned provider error reason. Reasons are bounded to 160 printable ASCII
characters with URLs/numbers redacted. No stack traces, headers, coordinates or
internal exception messages are logged or returned. Raw provider bodies and
reasons never enter response headers/JSON. Inspect the coarse header with
`curl -i`; Pages Function logs supply only the sanitised reason when present.
The deployed `upstream-network` failure was caused by `redirect: "error"`, which
Workers rejects with a `TypeError` before sending a request. The subrequest now
uses `redirect: "manual"`; deployed recovery still requires a preview smoke test.
No egress workaround or manual `CF-Worker` header is used.

## Validation and preview

No package manifest, lint command or CI existed before this feature. Unit tests
use Node's built-in test runner (Node 24 used during implementation):

```sh
node --test tests/*.test.mjs
hugo
```

For a local full-stack preview with an available Wrangler 4 installation:

```sh
hugo --baseURL http://localhost:8788/
wrangler pages dev public --port 8788 --compatibility-date 2026-08-08
```

Repository-local custom CSS uses `relURL`, so a normal build emits
`/css/custom.css` and production, branch previews and local preview load their
own stylesheet. Explicit absolute external custom stylesheet URLs are preserved.
The local base URL override is optional for stylesheet loading. August 8 is the
latest date supported by the installed local workerd used for validation; this
is not a deployment setting.

Focused browser checks require Playwright and its browser/system dependencies,
but add no site/runtime dependency. With Playwright already installed elsewhere:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node tests/ride-weather.browser.mjs
```

Use `WEATHER_TEST_URL` to override localhost:8788. Browser checks hold/mock the
single weather response, fix the clock, and replace the Decap backend in-browser
with its in-memory test backend. They do not modify GitHub content or auth code.
Screenshots are written to `/tmp/bbb-weather-{desktop,mobile,cms}.png`.

Implementation validation: 30 Node tests and 12 focused Chromium scenarios passed;
Hugo v0.154.5+extended built 34 pages. Browser coverage includes card placement,
loading height, assets, responsive layout, today/past/all-past states, outside
horizon, one request, HTTP/network/malformed/partial failure, invalid points,
safe names, no-weather Ride, disabled JavaScript, and actual Decap search/select/
manual override/pre-save serialization. Live Open-Meteo four-coordinate data was
also passed through the normalizer without saving forecast data to the repository.

The NUC's local workerd upstream connection timed out during the live endpoint
check and correctly returned unavailable; curl could fetch live provider data.
Production edge connectivity/cache reuse still needs a Pages preview smoke test.
The local Cache API contract is unit-tested; it does not prove production hit rate.
Real workerd smoke checks returned 200 plus the expected 1800-second cache header
for an outside-horizon point, 405 for POST and 400 for invalid coordinates.
No production deployment, authenticated GitHub CMS save, or full auth flow was run.

The public free Open-Meteo service is for non-commercial use with published rate
limits (including 10,000 calls/day). Confirm current provider terms before any
commercial use or increased traffic. No availability guarantee or rate-limiter
service is introduced in V1.