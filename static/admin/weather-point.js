(() => {
  "use strict";
  const { h, createClass, CMS } = window;

  function normaliseDate(value) {
    if (typeof value === "string") return value;
    if (value && typeof value.toISOString === "function") {
      try {
        return value.toISOString().slice(0, 10);
      } catch {}
    }
    return value;
  }

  const WeatherPoint = createClass({
    getInitialState() {
      return { query: "", results: [], message: "", searching: false };
    },

    componentWillUnmount() {
      this.controller?.abort();
      clearTimeout(this.timer);
    },

    point() {
      const value = this.props.value;
      const point = value?.toJS ? value.toJS() : value || {};
      const date = normaliseDate(point.date);
      return date === point.date ? point : { ...point, date };
    },

    update(field, value) {
      this.props.onChange({ ...this.point(), [field]: value });
    },

    isValid() {
      const point = this.point();
      const parsed = new Date(`${point.date}T00:00:00Z`);
      if (typeof point.date !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(point.date) ||
          !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== point.date ||
          !["morning", "noon", "afternoon"].includes(point.period) ||
          typeof point.location !== "string" || !point.location.trim() ||
          typeof point.latitude !== "number" || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
          typeof point.longitude !== "number" || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) {
        return { error: { message: "Enter a valid date, period, location, latitude (-90 to 90) and longitude (-180 to 180). Place search is optional." } };
      }
      return true;
    },

    async search() {
      this.controller?.abort();
      clearTimeout(this.timer);
      const query = this.state.query.trim();
      if (query.length < 2) {
        this.setState({ message: "Enter at least two characters.", results: [], searching: false });
        return;
      }
      const controller = new AbortController();
      this.controller = controller;
      this.timer = setTimeout(() => controller.abort(), 8000);
      this.setState({ searching: true, results: [], message: "Searching Australian places..." });
      try {
        const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
        url.search = new URLSearchParams({ name: query, countryCode: "AU", count: "10", language: "en", format: "json" });
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("Search unavailable");
        const data = await response.json();
        if (this.controller !== controller) return;
        const results = (Array.isArray(data.results) ? data.results : []).filter(result =>
          result.country_code === "AU" && typeof result.name === "string" &&
          typeof result.latitude === "number" && Number.isFinite(result.latitude) && Math.abs(result.latitude) <= 90 &&
          typeof result.longitude === "number" && Number.isFinite(result.longitude) && Math.abs(result.longitude) <= 180);
        this.setState({ results, message: results.length ? "Select a location." : "No matches. Try another name or enter coordinates manually." });
      } catch {
        if (this.controller === controller) this.setState({ message: "Place search unavailable. You can enter coordinates manually." });
      } finally {
        if (this.controller === controller) {
          clearTimeout(this.timer);
          this.setState({ searching: false });
        }
      }
    },

    select(result) {
      // Persist the selection, never a lookup instruction for visitors to resolve.
      this.props.onChange({
        ...this.point(), location: result.name, region: result.admin1 || "",
        latitude: result.latitude, longitude: result.longitude,
      });
      this.setState({ results: [], message: "Location selected. Coordinates remain editable." });
    },

    render() {
      const point = this.point();
      const prefix = this.props.forID;
      const inputStyle = { display: "block", width: "100%", padding: "8px", margin: "4px 0 12px", boxSizing: "border-box" };
      const field = (name, label, type, options = {}) => h("label", { key: name, htmlFor: `${prefix}-${name}`, style: { display: "block" } },
        label,
        h("input", {
          id: `${prefix}-${name}`, type, value: point[name] ?? "", style: inputStyle, ...options,
          onChange: event => this.update(name, type === "number"
            ? (event.target.value === "" ? null : Number(event.target.value)) : event.target.value),
        }));
      return h("div", { className: this.props.classNameWrapper },
        field("date", "Date", "date", { required: true }),
        h("label", { htmlFor: `${prefix}-period`, style: { display: "block" } }, "Period"),
        h("select", { id: `${prefix}-period`, value: point.period ?? "", required: true, style: inputStyle,
          onChange: event => this.update("period", event.target.value) },
          h("option", { value: "" }, "Select a period"),
          h("option", { value: "morning" }, "Morning"),
          h("option", { value: "noon" }, "Noon"),
          h("option", { value: "afternoon" }, "Afternoon")),
        h("label", { htmlFor: prefix, style: { display: "block" } }, "Search Australian places",
          h("input", {
            id: prefix, type: "search", value: this.state.query, maxLength: 100, style: inputStyle,
            onChange: event => {
              this.controller?.abort();
              clearTimeout(this.timer);
              this.controller = null;
              this.setState({ query: event.target.value, results: [], message: "", searching: false });
            },
            onKeyDown: event => {
              if (event.key === "Enter") { event.preventDefault(); this.search(); }
            },
          })),
        h("button", { type: "button", onClick: this.search, disabled: this.state.searching }, "Search"),
        h("p", { role: "status", style: { margin: "8px 0" } }, this.state.message),
        h("ul", { style: { paddingLeft: "20px" } }, this.state.results.map((result, index) =>
          h("li", { key: result.id || index, style: { marginBottom: "8px" } },
            h("button", {
              type: "button", onClick: () => this.select(result),
              style: { textAlign: "left", whiteSpace: "normal" },
            }, [result.name, result.admin2, result.admin1, "Australia"].filter(Boolean).join(", "))))),
        field("location", "Location", "text", { required: true }),
        field("region", "Region", "text"),
        field("latitude", "Latitude", "number", { min: -90, max: 90, step: "any", required: true }),
        field("longitude", "Longitude", "number", { min: -180, max: 180, step: "any", required: true }),
        h("small", {}, "Place search: ", h("a", { href: "https://open-meteo.com/", target: "_blank", rel: "noopener" }, "Open-Meteo"),
          " / ", h("a", { href: "https://www.geonames.org/", target: "_blank", rel: "noopener" }, "GeoNames")));
    },
  });
  CMS.registerWidget("weather-point", WeatherPoint);

  // Decap's single-field list unwraps Immutable Maps by the field name (`point`).
  // Our Markdown deliberately stores flat points. Adapt only this list's values
  // to plain objects so newly created and YAML-loaded entries take the same path.
  const list = CMS.getWidget("list");
  const WeatherPoints = createClass({
    // Decap documents isValid() as the custom-widget validation hook:
    // https://decapcms.org/docs/custom-widgets/#advanced-field-validation
    isValid() {
      const value = this.props.value;
      const points = value?.toJS ? value.toJS() : value;
      const seen = new Set();
      for (const value of Array.isArray(points) ? points : []) {
        const point = value?.toJS ? value.toJS() : value;
        const date = normaliseDate(point?.date);
        // Individual controls report missing/invalid dates and periods.
        if (typeof date !== "string" || !["morning", "noon", "afternoon"].includes(point?.period)) continue;
        const key = `${date}:${point.period}`;
        if (seen.has(key)) return { error: { message:
          `Duplicate weather period: ${date} ${point.period}. Choose each Morning, Noon or Afternoon only once per date.` } };
        seen.add(key);
      }
      // Preserve the native list's size validation when validating this wrapper.
      const sizeError = this.control?.validateSize?.()[0];
      return sizeError ? { error: sizeError } : true;
    },
    validate() {
      this.control?.validate();
      // Native list validation visits children; also run this list's isValid().
      this.props.validate();
    },
    focus(path) { this.control?.focus(path); },
    render() {
      const value = this.props.value;
      return h(list.control, {
        ...this.props,
        value: value?.map ? value.map(point => point?.toJS ? point.toJS() : point) : value,
        ref: control => { this.control = control; },
      });
    },
  });
  CMS.registerWidget({ name: "weather-points", controlComponent: WeatherPoints,
    previewComponent: list.preview, schema: list.schema });
})();
