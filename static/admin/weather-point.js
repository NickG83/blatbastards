(() => {
  "use strict";
  const { h, createClass, CMS } = window;
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
      return value?.toJS ? value.toJS() : value || {};
    },

    update(field, value) {
      this.props.onChange({ ...this.point(), [field]: value });
    },

    isValid() {
      const point = this.point();
      const parsed = new Date(`${point.date}T00:00:00Z`);
      if (typeof point.date !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(point.date) ||
          !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== point.date ||
          typeof point.location !== "string" || !point.location.trim() ||
          typeof point.latitude !== "number" || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
          typeof point.longitude !== "number" || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) {
        return { error: { message: "Enter a valid date, location, latitude (-90 to 90) and longitude (-180 to 180). Place search is optional." } };
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
})();