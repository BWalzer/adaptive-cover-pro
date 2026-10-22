// Cover Geometry: a visual editor for Adaptive Cover Pro vertical blinds.
//
// The sidebar panel registered by geometry_editor.py (admin only). It reads an
// entry over the integration's websocket API (adaptive_cover_pro/editor/*),
// draws the window from the front and in section plus a top-down sun chart,
// and saves only the changed fields in one editor/update call, which the
// server validates with the same rules as the set_* services.
//
// The predicted position mirrors engine/covers/vertical.py and
// engine/sun_geometry.py. It is geometry only: min/max position,
// interpolation, climate, cloud and manual override are not modelled.

const DOMAIN = "adaptive_cover_pro";
const RAD = Math.PI / 180;
const M_PER_IN = 0.0254;

const C = {
  window_height: "#3b82f6",
  window_width: "#0ea5a4",
  sill_height: "#8b5cf6",
  window_depth: "#b45309",
  distance_shaded_area: "#16a34a",
  set_azimuth: "#ef4444",
  fov: "#f59e0b",
  elevation: "#0891b2",
  blind_spot: "#db2777",
};

// k: option key; kind: len | deg | bool | select.
const FIELDS = [
  {
    sec: "Window",
    k: "window_height",
    kind: "len",
    color: C.window_height,
    label: "Window height",
    min: 0.1,
    max: 50,
    help: "Glass height the blind covers: from the sill to the top of the opening.",
  },
  {
    sec: "Window",
    k: "window_width",
    kind: "len",
    color: C.window_width,
    label: "Window width",
    min: 0.1,
    max: 50,
    nullable: true,
    help: "Glass width. Not used by the position calculation; glare zones use it.",
  },
  {
    sec: "Window",
    k: "sill_height",
    kind: "len",
    color: C.sill_height,
    label: "Sill height",
    min: 0,
    max: 50,
    help: "Floor to the bottom of the glass.",
  },
  {
    sec: "Window",
    k: "window_depth",
    kind: "len",
    color: C.window_depth,
    label: "Reveal depth",
    min: 0,
    max: 5,
    help: "How far the glass sits back from the outside face of the wall. The top of the reveal shades the glass when the sun is high. 0 if flush.",
  },
  {
    sec: "Room",
    k: "distance_shaded_area",
    kind: "len",
    color: C.distance_shaded_area,
    label: "Sun may reach",
    min: 0.1,
    max: 50,
    help: "How far from the glass sun may land on the floor. Everything beyond this line is kept in shade (e.g. the front edge of a desk).",
  },
  {
    sec: "Orientation",
    k: "set_azimuth",
    kind: "deg",
    color: C.set_azimuth,
    label: "Window faces",
    min: 0,
    max: 359,
    slider: true,
    help: "Compass bearing straight out through the glass: 0 N, 90 E, 180 S, 270 W.",
  },
  {
    sec: "Orientation",
    k: "fov_left",
    kind: "deg",
    color: C.fov,
    label: "Sun counts from the left",
    min: 0,
    max: 180,
    slider: true,
    help: "Standing inside, looking out: how far to your left (degrees from straight out) the sun still counts.",
  },
  {
    sec: "Orientation",
    k: "fov_right",
    kind: "deg",
    color: C.fov,
    label: "Sun counts from the right",
    min: 0,
    max: 180,
    slider: true,
    help: "Same, to your right.",
  },
  {
    sec: "Sun height",
    k: "min_elevation",
    kind: "deg",
    color: C.elevation,
    label: "Ignore sun lower than",
    min: 0,
    max: 90,
    nullable: true,
    help: "Sun below this elevation (hidden by trees or buildings) is ignored. Empty = no limit.",
  },
  {
    sec: "Sun height",
    k: "max_elevation",
    kind: "deg",
    color: C.elevation,
    label: "Ignore sun higher than",
    min: 0,
    max: 90,
    nullable: true,
    help: "Sun above this elevation is ignored (e.g. a deep overhang already shades it). Empty = no limit.",
  },
  {
    sec: "Blind spot",
    k: "blind_spot",
    kind: "bool",
    color: C.blind_spot,
    label: "Blind spot on",
    help: "A wedge of sky where something outside already blocks the sun (a tree, the neighbour's house).",
  },
  {
    sec: "Blind spot",
    k: "blind_spot_left_gamma",
    kind: "deg",
    color: C.blind_spot,
    label: "Wedge, left edge",
    min: -180,
    max: 180,
    slider: true,
    help: "Degrees to the left of straight out. Negative means right of straight out.",
  },
  {
    sec: "Blind spot",
    k: "blind_spot_right_gamma",
    kind: "deg",
    color: C.blind_spot,
    label: "Wedge, right edge",
    min: -180,
    max: 180,
    slider: true,
    help: "Degrees to the right of straight out. Negative means left of straight out.",
  },
  {
    sec: "Blind spot",
    k: "blind_spot_elevation",
    kind: "deg",
    color: C.blind_spot,
    label: "Only when sun is",
    min: 0,
    max: 90,
    nullable: true,
    help: "Limit the wedge to sun below (a tree) or above (a balcony) this elevation. Empty = at any height.",
  },
  {
    sec: "Blind spot",
    k: "blind_spot_elevation_mode",
    kind: "select",
    color: C.blind_spot,
    label: "…below or above it",
    options: ["below", "above"],
    help: "",
  },
];
const FIELD = Object.fromEntries(FIELDS.map((f) => [f.k, f]));

// ---------------------------------------------------------------- sun and model

// Low-precision solar position (Astronomical Almanac), good to ~0.5°.
function sunPosition(date, lat, lon) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  const H = (gmst + lon) * RAD - ra;
  const phi = lat * RAD;
  const el = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H),
  );
  const az = Math.atan2(
    -Math.sin(H),
    Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H),
  );
  return { az: (az / RAD + 360) % 360, el: el / RAD };
}

// Times are in HA's time zone, not the browser's.
const tzFormats = {};
function tzParts(date, tz) {
  tzFormats[tz] ||= new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const p = tzFormats[tz].formatToParts(date);
  const g = (t) => +p.find((x) => x.type === t).value;
  return {
    y: g("year"),
    mo: g("month") - 1,
    d: g("day"),
    minute: g("hour") * 60 + g("minute"),
  };
}
function zonedDate({ y, mo, d }, minute, tz) {
  const guess = Date.UTC(y, mo, d, 0, minute);
  const offset = (t) => {
    const p = tzParts(new Date(t), tz);
    return (Date.UTC(p.y, p.mo, p.d, 0, p.minute) - t) / 60000;
  };
  let t = guess - offset(guess) * 60000;
  t = guess - offset(t) * 60000; // second pass settles DST edges
  return new Date(t);
}

const clampedCos = (gamma) => Math.max(Math.cos(gamma * RAD), 0.01);
const gammaOf = (winAzi, solAzi) =>
  ((((winAzi - solAzi + 180) % 360) + 360) % 360) - 180;

// Why the sun does or doesn't drive the blind right now.
function sunState(cfg, az, el) {
  const gamma = gammaOf(cfg.set_azimuth, az);
  const out = { gamma, el, az };
  if (el < 0) return { ...out, ok: false, why: "Sun is down" };
  if (Math.cos(el * RAD) * Math.cos(gamma * RAD) <= 0)
    return { ...out, ok: false, why: "Sun is behind the wall" };
  if (!(gamma < cfg.fov_left && gamma > -cfg.fov_right))
    return { ...out, ok: false, why: "Sun is outside the accepted angle" };
  const minE = cfg.min_elevation,
    maxE = cfg.max_elevation;
  if (minE != null && el < minE)
    return { ...out, ok: false, why: `Sun is lower than ${minE}°` };
  if (maxE != null && el > maxE)
    return { ...out, ok: false, why: `Sun is higher than ${maxE}°` };
  if (cfg.blind_spot && inBlindSpot(cfg, gamma, el))
    return { ...out, ok: false, why: "Sun is in the blind spot" };
  return { ...out, ok: true, why: "Sun is on the window" };
}

function inBlindSpot(cfg, gamma, el) {
  const l = cfg.blind_spot_left_gamma,
    r = cfg.blind_spot_right_gamma;
  if (l == null || r == null || !(gamma >= -r && gamma <= l)) return false;
  const thr = cfg.blind_spot_elevation;
  if (thr == null) return true;
  return cfg.blind_spot_elevation_mode === "above" ? el >= thr : el <= thr;
}

// Exposed glass from the bottom, metres (0 = closed, window_height = open).
function blindDrop(cfg, el, gamma) {
  const h = cfg.window_height;
  if (el < 2) return 0;
  let d = cfg.distance_shaded_area;
  if (cfg.sill_height > 0)
    d -=
      (cfg.sill_height / Math.max(Math.tan(el * RAD), 0.05)) *
      clampedCos(gamma);
  if (d < 0) d = 0;
  const drop = (dist) => (dist / clampedCos(gamma)) * Math.tan(el * RAD);
  if (cfg.window_depth > 0 && drop(d + cfg.window_depth) >= h) return h;
  return Math.min(Math.max(drop(d), 0), h);
}

function predict(cfg, az, el) {
  const s = sunState(cfg, az, el);
  if (!s.ok) return { ...s, pct: cfg.default_percentage ?? 100, drop: null };
  const drop = blindDrop(cfg, el, s.gamma);
  return { ...s, drop, pct: Math.round((drop / cfg.window_height) * 100) };
}

// ---------------------------------------------------------------- svg helpers

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const f1 = (n) => (Math.round(n * 10) / 10).toString();

// A dimension line with end ticks and a centred label, in screen coordinates.
function dim(x1, y1, x2, y2, label, color, k, side = 1) {
  const dx = x2 - x1,
    dy = y2 - y1,
    len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * 5,
    ny = (dx / len) * 5;
  const mx = (x1 + x2) / 2 + nx * 2.4 * side,
    my = (y1 + y2) / 2 + ny * 2.4 * side;
  const vertical = Math.abs(dx) < Math.abs(dy);
  return `<g class="dim" data-k="${k}" style="--c:${color}">
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />
    <line x1="${x1 - nx}" y1="${y1 - ny}" x2="${x1 + nx}" y2="${y1 + ny}" />
    <line x1="${x2 - nx}" y1="${y2 - ny}" x2="${x2 + nx}" y2="${y2 + ny}" />
    <text x="${mx}" y="${my}" text-anchor="${vertical ? (side > 0 ? "end" : "start") : "middle"}"
      dominant-baseline="${vertical ? "middle" : side > 0 ? "hanging" : "auto"}">${esc(label)}</text>
  </g>`;
}

// ---------------------------------------------------------------- the element

class AcpDesigner extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._entries = [];
    this._entryId = null;
    this._orig = null;
    this._cfg = null;
    this._meta = null;
    this._day = null; // { y, mo, d } in HA's time zone, set once hass arrives
    this._minute = 0;
    this._focus = null;
    this._status = "";
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._setNow();
      this._init();
    }
  }
  get hass() {
    return this._hass;
  }
  set narrow(v) {
    this._narrow = v;
  }
  set panel(v) {
    this._panel = v;
  }

  get _imperial() {
    return this._hass?.config?.unit_system?.length === "mi";
  }
  _toUnit(m) {
    return this._imperial ? m / M_PER_IN : m * 100;
  }
  _fromUnit(v) {
    return this._imperial ? v * M_PER_IN : v / 100;
  }
  get _lenUnit() {
    return this._imperial ? "in" : "cm";
  }
  _fmtLen(m) {
    if (!this._imperial)
      return m >= 1 ? `${m.toFixed(2)} m` : `${Math.round(m * 100)} cm`;
    const inches = m / M_PER_IN;
    if (inches < 24) return `${f1(inches)}″`;
    const ft = Math.floor(inches / 12);
    return `${ft}′ ${f1(inches - ft * 12)}″`;
  }

  async _init() {
    this._renderShell();
    try {
      this._entries = await this._hass.callWS({
        type: `${DOMAIN}/editor/entries`,
      });
      const want = new URLSearchParams(location.search).get("entry");
      const editable = this._entries.filter((e) => e.editable);
      this._entryId = (
        this._entries.find((e) => e.entry_id === want) ||
        editable[0] ||
        this._entries[0]
      )?.entry_id;
      this._renderPicker();
      if (this._entryId) await this._load();
      else this._setStatus("No Adaptive Cover Pro covers set up yet.");
    } catch (e) {
      this._setStatus(`Could not list covers: ${e.message || e}`, true);
    }
  }

  // Clear everything entry-specific, so nothing from the previous entry can be
  // shown, reverted to or saved.
  _clearEntry() {
    this._orig = null;
    this._cfg = null;
    this._meta = null;
    this._renderForm();
    this._markDirty();
    this._renderAll();
  }

  // Returns true when the entry loaded and is still the one selected.
  async _load() {
    this._setStatus("Loading…");
    const id = this._entryId;
    try {
      const r = await this._hass.callWS({
        type: `${DOMAIN}/editor/get`,
        entry_id: id,
      });
      // The picker moved on while this was in flight: a newer load owns the form.
      if (this._entryId !== id) return false;
      if (!r.editable) {
        this._clearEntry();
        this._setStatus(
          `The geometry editor only draws vertical blinds so far; "${r.title}" is ${r.cover_type}.`,
          true,
        );
        return false;
      }
      const o = r.options;
      this._orig = {
        window_height: o.window_height,
        window_width: o.window_width ?? null,
        sill_height: o.sill_height ?? 0,
        window_depth: o.window_depth ?? 0,
        distance_shaded_area: o.distance_shaded_area,
        set_azimuth: o.set_azimuth,
        fov_left: o.fov_left,
        fov_right: o.fov_right,
        min_elevation: o.min_elevation ?? null,
        max_elevation: o.max_elevation ?? null,
        blind_spot: !!o.blind_spot,
        // Shown as a starting wedge when none is stored; _save sends them.
        blind_spot_left_gamma: o.blind_spot_left_gamma ?? 10,
        blind_spot_right_gamma: o.blind_spot_right_gamma ?? 10,
        blind_spot_elevation: o.blind_spot_elevation ?? null,
        blind_spot_elevation_mode: o.blind_spot_elevation_mode || "below",
        default_percentage: o.default_percentage,
      };
      this._bsStored =
        o.blind_spot_left_gamma != null && o.blind_spot_right_gamma != null;
      this._cfg = { ...this._orig };
      const live = r.live;
      this._meta = {
        name: r.title,
        loc: r.location,
        live:
          live?.sun_azimuth != null
            ? {
                az: live.sun_azimuth,
                el: live.sun_elevation,
                pct: live.calculated_position,
              }
            : null,
      };
      this._setStatus(
        r.loaded
          ? ""
          : `"${r.title}" isn't running right now, so saving is unavailable until it is.`,
        !r.loaded,
      );
      this._renderForm();
      this._renderAll();
      return true;
    } catch (e) {
      if (this._entryId !== id) return false;
      this._clearEntry();
      this._setStatus(`Could not load: ${e.message || e}`, true);
      return false;
    }
  }

  _dirty() {
    if (!this._orig || !this._cfg) return [];
    return FIELDS.filter((f) => {
      const a = this._orig[f.k],
        b = this._cfg[f.k];
      if (a == null || b == null) return a !== b;
      return typeof a === "number" ? Math.abs(a - b) > 1e-6 : a !== b;
    });
  }

  async _save() {
    const changed = this._dirty();
    const id = this._entryId;
    if (!changed.length) return;
    const changes = Object.fromEntries(
      changed.map((f) => [f.k, this._cfg[f.k]]),
    );
    // The wedge edges are validated as a pair, and an entry that never stored
    // them is showing the starting wedge: send both whenever either changes or
    // the blind spot is on without stored edges.
    if (
      "blind_spot_left_gamma" in changes ||
      "blind_spot_right_gamma" in changes ||
      (this._cfg.blind_spot && !this._bsStored)
    ) {
      changes.blind_spot_left_gamma = this._cfg.blind_spot_left_gamma;
      changes.blind_spot_right_gamma = this._cfg.blind_spot_right_gamma;
    }
    const saveBtn = this.shadowRoot.getElementById("save");
    saveBtn.disabled = true;
    this._setStatus("Saving…");
    try {
      // One options update on the server, so at most one reload.
      await this._hass.callWS({
        type: `${DOMAIN}/editor/update`,
        entry_id: id,
        changes,
      });
    } catch (e) {
      this._setStatus(`Not saved: ${e.message || e}`, true);
      this._markDirty();
      return;
    }
    if (this._entryId !== id) return;
    // _load reports its own errors; only claim success when it worked.
    if (await this._load()) this._setStatus("Saved.");
  }

  _setStatus(msg, err = false) {
    this._status = msg;
    const el = this.shadowRoot.getElementById("status");
    if (el) {
      el.textContent = msg;
      el.classList.toggle("err", err);
    }
  }

  // ---------------------------------------------------------------- shell + form

  _renderShell() {
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
      <div class="top">
        <h1>Cover geometry</h1>
        <select id="entry"></select>
        <span id="status"></span>
        <span class="grow"></span>
        <button id="revert" class="ghost">Revert</button>
        <button id="save" disabled>Save</button>
      </div>
      <div class="main">
        <form id="form" autocomplete="off"></form>
        <div class="views">
          <section class="card time">
            <div class="readout" id="readout"></div>
            <div class="row">
              <input type="date" id="date">
              <input type="range" id="minute" min="0" max="1439" step="5">
              <span id="clock" class="mono"></span>
              <button id="now" class="ghost">Now</button>
            </div>
            <div class="row try">
              <label class="trylabel"><input type="checkbox" id="trytoggle"> Try a blind position</label>
              <input type="range" id="trypct" min="0" max="100" step="1" value="50" disabled>
              <span id="trytext" class="mono"></span>
            </div>
          </section>
          <section class="card daycard">
            <header><h2>Through the day</h2><span class="sub">ACP's predicted position; shaded while the sun is on the window</span></header>
            <svg id="day" viewBox="0 0 640 120"></svg>
          </section>
          <section class="card">
            <header><h2>Front view</h2><span class="sub" id="frontsub"></span></header>
            <svg id="front" viewBox="0 0 640 380"></svg>
            <div class="muted">Solid amber: the sun is on the glass and ACP moves the blind for it. Dashed grey: ACP ignores it there. Shaded areas are outside the accepted angle, past the sun-height limits, or in the blind spot. The blind is drawn over the glass at its position for the selected time.</div>
          </section>
          <section class="card">
            <header><h2>Side view</h2><span class="sub">a slice through the window, outside on the left</span></header>
            <svg id="side" viewBox="0 0 640 360"></svg>
            <div class="muted" id="sunnote"></div>
          </section>
          <section class="card">
            <header><h2>Top view</h2><span class="sub">today's sun path; centre is overhead, the rim is the horizon</span></header>
            <svg id="plan" viewBox="0 0 440 440"></svg>
          </section>
        </div>
      </div>`;
    const $ = (id) => this.shadowRoot.getElementById(id);
    $("entry").addEventListener("change", (e) => {
      this._entryId = e.target.value;
      this._load();
    });
    $("save").addEventListener("click", () => this._save());
    $("revert").addEventListener("click", () => {
      if (!this._orig) return;
      this._cfg = { ...this._orig };
      this._renderForm();
      this._renderAll();
    });
    $("date").addEventListener("input", (e) => {
      const [y, m, d] = e.target.value.split("-").map(Number);
      if (y) {
        this._day = { y, mo: m - 1, d };
        this._renderAll();
      }
    });
    $("minute").addEventListener("input", (e) => {
      this._minute = +e.target.value;
      this._renderAll();
    });
    $("now").addEventListener("click", () => {
      this._setNow();
      this._renderAll();
    });
    // A preview only: draws the blind at a chosen position so you can see
    // where the sun would land. It never moves the real cover.
    $("trytoggle").addEventListener("change", (e) => {
      $("trypct").disabled = !e.target.checked;
      this._tryPct = e.target.checked ? +$("trypct").value : null;
      this._renderAll();
    });
    $("trypct").addEventListener("input", (e) => {
      this._tryPct = +e.target.value;
      this._renderAll();
    });
    // Clicking a labelled part of a drawing jumps to its field.
    for (const id of ["front", "side", "plan"]) {
      $(id).addEventListener("click", (e) => {
        const k = e.target.closest("[data-k]")?.dataset.k;
        const input =
          k &&
          this.shadowRoot.querySelector(
            `[data-field="${k === "fov" ? "fov_left" : k}"] input`,
          );
        if (input) {
          input.focus();
          input.select?.();
        }
      });
      $(id).addEventListener("mouseover", (e) =>
        this._highlight(e.target.closest("[data-k]")?.dataset.k || null),
      );
      $(id).addEventListener("mouseleave", () => this._highlight(null));
    }
  }

  _renderPicker() {
    const sel = this.shadowRoot.getElementById("entry");
    sel.innerHTML = this._entries
      .map(
        (e) =>
          `<option value="${e.entry_id}" ${e.entry_id === this._entryId ? "selected" : ""}>${esc(e.title)}${e.editable ? "" : " (not a vertical blind)"}</option>`,
      )
      .join("");
  }

  _renderForm() {
    const form = this.shadowRoot.getElementById("form");
    if (!this._cfg) {
      form.innerHTML = "";
      return;
    }
    let html = "",
      sec = null;
    for (const f of FIELDS) {
      if (f.sec !== sec) {
        if (sec) html += "</fieldset>";
        sec = f.sec;
        html += `<fieldset><legend>${sec}</legend>`;
      }
      const v = this._cfg[f.k];
      let input;
      if (f.kind === "bool") {
        input = `<input type="checkbox" ${v ? "checked" : ""}>`;
      } else if (f.kind === "select") {
        input = `<select>${f.options.map((o) => `<option ${o === v ? "selected" : ""}>${o}</option>`).join("")}</select>`;
      } else {
        const shown =
          v == null ? "" : f.kind === "len" ? +this._toUnit(v).toFixed(2) : v;
        const unit = f.kind === "len" ? this._lenUnit : "°";
        const step = f.kind === "len" ? (this._imperial ? 0.25 : 1) : 1;
        input = `<input type="number" step="${step}" value="${shown}" ${f.nullable ? 'placeholder="none"' : ""}><span class="unit">${unit}</span>`;
        if (f.slider)
          input += `<input type="range" min="${f.min}" max="${f.max}" step="1" value="${v ?? 0}">`;
      }
      html += `<div class="field ${f.kind}" data-field="${f.k}" style="--c:${f.color}">
          <label><i></i>${f.label}<b class="dirty" title="changed">●</b></label>
          <div class="ctl">${input}</div>
          ${f.help ? `<p>${f.help}</p>` : ""}
        </div>`;
    }
    html += "</fieldset>";
    form.innerHTML = html;
    for (const el of form.querySelectorAll(".field")) {
      const f = FIELD[el.dataset.field];
      el.addEventListener("mouseenter", () => this._highlight(f.k));
      el.addEventListener("mouseleave", () => this._highlight(null));
      el.addEventListener("focusin", () => this._highlight(f.k));
      el.addEventListener("input", (e) =>
        this._onInput(f, e.target, el, false),
      );
      el.addEventListener("change", (e) =>
        this._onInput(f, e.target, el, true),
      );
    }
    this._markDirty();
  }

  // `committed` is the change event (Enter or leaving the box). Only then is the
  // box being typed in rewritten, so a clamped value shows what will be saved
  // without fighting the user mid-typing.
  _onInput(f, target, el, committed) {
    if (!this._cfg) return;
    let v;
    if (f.kind === "bool") v = target.checked;
    else if (f.kind === "select") v = target.value;
    else if (target.value === "") v = f.nullable ? null : this._cfg[f.k];
    else {
      v = +target.value;
      if (Number.isNaN(v)) return;
      if (f.kind === "len") v = this._fromUnit(v);
      v = Math.min(Math.max(v, f.min), f.max);
      // Keep the number box and slider of the same field in step.
      for (const other of el.querySelectorAll("input")) {
        if (other !== target || committed)
          other.value = f.kind === "len" ? +this._toUnit(v).toFixed(2) : v;
      }
    }
    this._cfg[f.k] = v;
    this._markDirty();
    this._renderAll();
  }

  _markDirty() {
    const dirty = new Set(this._dirty().map((f) => f.k));
    for (const el of this.shadowRoot.querySelectorAll(".field")) {
      el.classList.toggle("is-dirty", dirty.has(el.dataset.field));
      el.classList.toggle(
        "off",
        el.dataset.field.startsWith("blind_spot_") && !this._cfg?.blind_spot,
      );
    }
    const save = this.shadowRoot.getElementById("save");
    save.disabled = !dirty.size;
    save.textContent = dirty.size
      ? `Save ${dirty.size} change${dirty.size > 1 ? "s" : ""}`
      : "Save";
  }

  _highlight(k) {
    if (k === this._focus) return;
    this._focus = k;
    const keys = k
      ? [
          k,
          k.startsWith("fov") ? "fov" : null,
          k.startsWith("blind_spot") ? "blind_spot" : null,
          /elevation$/.test(k) && !k.startsWith("blind") ? "elevation" : null,
        ]
      : [];
    for (const el of this.shadowRoot.querySelectorAll("[data-k]"))
      el.classList.toggle("hl", keys.includes(el.dataset.k));
    for (const el of this.shadowRoot.querySelectorAll(".field"))
      el.classList.toggle(
        "hl",
        keys.includes(el.dataset.field) ||
          (k === "fov" && el.dataset.field.startsWith("fov")) ||
          (k === "blind_spot" && el.dataset.field.startsWith("blind_spot")) ||
          (k === "elevation" && /^(min|max)_elevation$/.test(el.dataset.field)),
      );
    this.shadowRoot.querySelector(".views").classList.toggle("focusing", !!k);
  }

  // ---------------------------------------------------------------- drawings

  get _tz() {
    return (
      this._hass?.config?.time_zone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
  }
  _setNow() {
    const { minute, ...day } = tzParts(new Date(), this._tz);
    this._day = day;
    this._minute = minute;
  }
  _at(minute) {
    return zonedDate(this._day, minute, this._tz);
  }
  _when() {
    return this._at(this._minute);
  }

  _renderAll() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    if (!this._cfg || !this._meta) {
      for (const id of ["front", "side", "plan", "day"]) $(id).innerHTML = "";
      $("readout").innerHTML = "";
      return;
    }
    const { latitude: lat, longitude: lon } = this._meta.loc;
    const when = this._when();
    const sun = sunPosition(when, lat, lon);
    const acp = predict(this._cfg, sun.az, sun.el);
    // "Try a blind position" swaps in the chosen position for drawing; the
    // readout still reports what ACP itself would do.
    const tried = this._tryPct ?? null;
    const p =
      tried == null
        ? acp
        : {
            ...acp,
            pct: tried,
            drop: (tried / 100) * this._cfg.window_height,
            tried: true,
          };
    $("trytext").textContent = tried == null ? "" : `${tried}% open`;

    const pad = (n) => String(n).padStart(2, "0");
    const { y, mo, d } = this._day;
    $("date").value = `${y}-${pad(mo + 1)}-${pad(d)}`;
    $("minute").value = this._minute;
    $("clock").textContent =
      `${pad(Math.floor(this._minute / 60))}:${pad(this._minute % 60)}`;
    $("sunnote").textContent =
      p.el > 0 && Math.abs(p.gamma) > 1 && Math.cos(p.gamma * RAD) > 0
        ? `Sun ${f1(p.el)}° up but ${Math.round(Math.abs(p.gamma))}° off straight out, so in this slice it comes in at ${f1(Math.atan(Math.tan(p.el * RAD) / clampedCos(p.gamma)) / RAD)}°.`
        : "";

    const live = this._meta.live;
    $("readout").innerHTML = `
      <div><span class="k">Sun</span> ${f1(sun.el)}° up, bearing ${Math.round(sun.az)}°,
        ${Math.abs(p.gamma) < 0.5 ? "straight out" : `${Math.round(Math.abs(p.gamma))}° ${p.gamma > 0 ? "left" : "right"} of straight out`}</div>
      <div class="${acp.ok ? "on" : "off"}"><span class="k">${esc(acp.why)}</span>
        → ACP ${acp.ok ? `sets the blind to <b>${acp.pct}%</b> (${this._fmtLen(acp.drop)} of glass open from the bottom)` : `sends the blind to its default, <b>${acp.pct}%</b>`}</div>
      ${tried == null ? "" : `<div class="trying">Drawing the blind at <b>${tried}%</b> instead. This is a preview; the real blind doesn't move.</div>`}
      ${live ? `<div class="muted">HA right now: sun ${f1(live.el)}° / ${Math.round(live.az)}°, calculated ${live.pct}%</div>` : ""}`;

    $("frontsub").textContent =
      "the sky through the window, looking out: across is degrees from straight out, up is the sun's height";
    $("front").innerHTML = this._front(p, sun, lat, lon);
    $("side").innerHTML = this._side(p);
    $("side").setAttribute("viewBox", `0 0 640 ${this._sideH}`);
    $("plan").innerHTML = this._plan(when, sun, lat, lon);
    $("day").innerHTML = this._dayChart(lat, lon);
    if (this._focus) {
      const k = this._focus;
      this._focus = null;
      this._highlight(k);
    }
  }

  // The sky as seen through the window: across is the angle from straight out
  // (gamma, your left on the left), up is sun elevation. It needs no
  // measurements, so it shows exactly when and where the sun is on the glass.
  _front(p, sun, lat, lon) {
    const c = this._cfg;
    const W = 640,
      H = 380,
      padL = 44,
      padR = 44,
      padT = 26,
      padB = 58;
    const fx0 = padL,
      fx1 = W - padR,
      fy0 = padT,
      fy1 = H - padB;
    const cx = (fx0 + fx1) / 2,
      half = (fx1 - fx0) / 2;

    // Elevation scale: room for the day's highest sun and any limits.
    let dayMax = 0;
    const pts = [];
    for (let m = 0; m <= 1440; m += 4) {
      const sp = sunPosition(this._at(m), lat, lon);
      pts.push({
        m,
        sp,
        g: gammaOf(c.set_azimuth, sp.az),
        ok: sunState(c, sp.az, sp.el).ok,
      });
      dayMax = Math.max(dayMax, sp.el);
    }
    const lims = [
      c.min_elevation,
      c.max_elevation,
      c.blind_spot ? c.blind_spot_elevation : null,
    ].filter((v) => v != null);
    const elMax = Math.min(
      90,
      Math.ceil((Math.max(dayMax, ...lims, 20) + 8) / 15) * 15,
    );
    const X = (g) => cx - (g / 90) * half;
    const Y = (el) => fy1 - (el / elMax) * (fy1 - fy0);
    const within = (g, el) => el > 0 && Math.abs(g) < 90;

    let out = `<defs>
        <linearGradient id="fsky" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--sky1)"/><stop offset="1" stop-color="var(--sky2)"/></linearGradient>
        <clipPath id="fclip"><rect x="${fx0}" y="${fy0}" width="${fx1 - fx0}" height="${fy1 - fy0}"/></clipPath>
        <pattern id="slats" width="8" height="7" patternUnits="userSpaceOnUse"><rect width="8" height="7" fill="#6b7280" opacity=".55"/><line x1="0" y1="6.5" x2="8" y2="6.5" stroke="#4b5563" stroke-width="1"/></pattern>
      </defs>
      <rect x="${fx0}" y="${fy0}" width="${fx1 - fx0}" height="${fy1 - fy0}" fill="url(#fsky)" />`;

    // Regions ACP ignores: outside the accepted angle, beyond the elevation limits.
    let shade = "";
    if (c.fov_left < 90)
      shade += `<rect class="ignored" data-k="fov_left" x="${fx0}" y="${fy0}" width="${X(c.fov_left) - fx0}" height="${fy1 - fy0}" />`;
    if (c.fov_right < 90)
      shade += `<rect class="ignored" data-k="fov_right" x="${X(-c.fov_right)}" y="${fy0}" width="${fx1 - X(-c.fov_right)}" height="${fy1 - fy0}" />`;
    if (c.min_elevation != null)
      shade += `<rect class="ignored elev" data-k="min_elevation" x="${fx0}" y="${Y(c.min_elevation)}" width="${fx1 - fx0}" height="${fy1 - Y(c.min_elevation)}" />`;
    if (c.max_elevation != null)
      shade += `<rect class="ignored elev" data-k="max_elevation" x="${fx0}" y="${fy0}" width="${fx1 - fx0}" height="${Y(c.max_elevation) - fy0}" />`;
    if (
      c.blind_spot &&
      c.blind_spot_left_gamma + c.blind_spot_right_gamma > 0
    ) {
      const thr = c.blind_spot_elevation;
      const lo =
        thr == null || c.blind_spot_elevation_mode === "below" ? 0 : thr;
      const hi =
        thr == null || c.blind_spot_elevation_mode === "above" ? elMax : thr;
      const gl = Math.min(c.blind_spot_left_gamma, 90),
        gr = Math.max(-c.blind_spot_right_gamma, -90);
      shade += `<rect class="bspot" data-k="blind_spot" x="${X(gl)}" y="${Y(hi)}" width="${X(gr) - X(gl)}" height="${Y(lo) - Y(hi)}" />`;
    }

    // Elevation grid.
    let grid = "";
    for (let el = 15; el < elMax; el += 15)
      grid += `<line class="fgrid" x1="${fx0}" x2="${fx1}" y1="${Y(el)}" y2="${Y(el)}" /><text class="axis" x="${fx0 - 6}" y="${Y(el)}" text-anchor="end" dominant-baseline="middle">${el}°</text>`;
    // Edges of the accepted angle and the elevation limits as lines.
    let edges = "";
    for (const [k, g] of [
      ["fov_left", c.fov_left],
      ["fov_right", -c.fov_right],
    ])
      if (Math.abs(g) < 90)
        edges += `<line class="fovedge" data-k="${k}" x1="${X(g)}" x2="${X(g)}" y1="${fy0}" y2="${fy1}" />`;
    for (const k of ["min_elevation", "max_elevation"])
      if (c[k] != null)
        edges += `<line class="elevline" data-k="${k}" x1="${fx0}" x2="${fx1}" y1="${Y(c[k])}" y2="${Y(c[k])}" />`;
    edges += `<line class="normal" data-k="set_azimuth" x1="${cx}" x2="${cx}" y1="${fy0}" y2="${fy1}" stroke-dasharray="3 5" />`;

    // The day's sun path, solid amber where it moves the blind.
    let path = "",
      ticks = "",
      seg = [],
      segOk = null;
    const flush = () => {
      if (seg.length > 1)
        path += `<polyline class="path ${segOk ? "ok" : ""}" points="${seg.join(" ")}" />`;
    };
    for (const { m, sp, g, ok } of pts) {
      if (!within(g, sp.el)) {
        flush();
        seg = [];
        segOk = null;
        continue;
      }
      const xy = `${X(g).toFixed(1)},${Y(sp.el).toFixed(1)}`;
      if (segOk !== null && ok !== segOk) {
        seg.push(xy);
        flush();
        seg = [xy];
      } else seg.push(xy);
      segOk = ok;
      if (m % 60 === 0 && m < 1440)
        ticks += `<circle class="tick" cx="${X(g)}" cy="${Y(sp.el)}" r="2.5" /><text class="ticklabel" x="${X(g)}" y="${Y(sp.el) - 7}" text-anchor="middle">${m / 60}h</text>`;
    }
    flush();
    const sunDot = within(p.gamma, sun.el)
      ? `<circle class="sun ${p.ok ? "ok" : ""}" cx="${X(p.gamma)}" cy="${Y(sun.el)}" r="9" />`
      : "";

    // The blind, drawn over the glass at its position for the selected time.
    const coverH = ((100 - p.pct) / 100) * (fy1 - fy0);
    const blind =
      coverH > 0.5
        ? `<rect class="fblind" x="${fx0}" y="${fy0}" width="${fx1 - fx0}" height="${coverH}" fill="url(#slats)" />
         <line class="fblindedge" x1="${fx0}" x2="${fx1}" y1="${fy0 + coverH}" y2="${fy0 + coverH}" />`
        : "";

    // Frame, horizon and compass bearings along it.
    let compass = "";
    const names = {
      0: "N",
      45: "NE",
      90: "E",
      135: "SE",
      180: "S",
      225: "SW",
      270: "W",
      315: "NW",
    };
    for (let b = 0; b < 360; b += 15) {
      const g = gammaOf(c.set_azimuth, b);
      if (Math.abs(g) > 90) continue;
      const major = b % 45 === 0,
        x = X(g);
      compass += `<line class="ctick" x1="${x}" x2="${x}" y1="${fy1 + 6}" y2="${fy1 + (major ? 14 : 10)}" />`;
      if (major)
        compass += `<text class="compass" x="${x}" y="${fy1 + 28}" text-anchor="middle">${names[b]}</text>`;
    }
    const frame = `<rect class="fframe" data-k="window_height" x="${fx0}" y="${fy0}" width="${fx1 - fx0}" height="${fy1 - fy0}" />
      <line class="floor" x1="${fx0 - 8}" x2="${fx1 + 8}" y1="${fy1}" y2="${fy1}" />`;
    const labels = `
      <text class="normallabel" data-k="set_azimuth" x="${cx}" y="${fy0 - 8}" text-anchor="middle">straight out, ${Math.round(c.set_azimuth)}°</text>
      <text class="side-label" x="${fx0}" y="${H - 6}">← your left</text>
      <text class="side-label" x="${fx1}" y="${H - 6}" text-anchor="end">your right →</text>
      <text class="side-label" x="${cx}" y="${H - 6}" text-anchor="middle">horizon</text>`;

    return `${out}<g clip-path="url(#fclip)">${shade}${grid}${edges}${path}${ticks}${sunDot}${blind}</g>${frame}${compass}${labels}`;
  }

  // Section through the window: x into the room from the glass, y up from the floor.
  _side(p) {
    const c = this._cfg;
    const h = c.window_height,
      sill = c.sill_height,
      depth = c.window_depth,
      D = c.distance_shaded_area;
    const top = sill + h;
    const ceil = Math.max(top + 0.35, 2.4);
    const wallOut = Math.max(depth, 0.1);
    const xMin = -wallOut - 0.9;
    // Sun rays in the section plane use the profile angle tan(el)/cos(gamma).
    const sunUp = p.el > 0 && Math.cos(p.gamma * RAD) > 0;
    const slope = sunUp ? Math.tan(p.el * RAD) / clampedCos(p.gamma) : 1;
    const land = (y0) => y0 / slope; // where a ray entering at height y0 meets the floor
    // Wide enough to show where the sun lands, up to about 30 ft.
    const xMax = Math.max(
      D * 1.6,
      ceil * 1.1,
      2.2,
      sunUp ? Math.min(land(top) + 0.4, 9) : 0,
    );
    const W = 640,
      padL = 20,
      padR = 20,
      padT = 20,
      padB = 54;
    const s = Math.min(
      (W - padL - padR) / (xMax - xMin),
      (360 - padT - padB) / ceil,
    );
    // Trim the height to the drawing, so a wide room doesn't leave empty sky.
    const H = Math.round(padT + padB + ceil * s);
    this._sideH = H;
    const X = (x) => padL + (x - xMin) * s;
    const Y = (y) => H - padB - y * s;
    const fl = Y(0);

    const pos = p.ok ? p.drop : (p.pct / 100) * h; // exposed glass from the bottom
    const blindBottom = sill + pos;

    // The beam through the whole window: bright below the blind, where it gets
    // through, faint above it, where the blind stops it.
    let rays = "";
    if (sunUp) {
      const P = (x, y) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`;
      const atX = (y0, x) => y0 - x * slope; // height of the ray entering at y0, at x
      const beam = (y1, y2, cls) =>
        `<polygon class="beam ${cls}" points="${P(0, y2)} ${P(land(y2), 0)} ${P(land(y1), 0)} ${P(0, y1)}" />`;
      rays += `<polygon class="beam out" points="${P(xMin, atX(top, xMin))} ${P(0, top)} ${P(0, sill)} ${P(xMin, atX(sill, xMin))}" />`;
      if (blindBottom < top - 0.001) rays += beam(blindBottom, top, "blocked");
      if (blindBottom > sill + 0.001) rays += beam(sill, blindBottom, "lit");
      // Where it reaches the floor.
      const near = land(sill),
        far = land(top);
      rays += `<rect class="landing blocked" x="${X(near)}" y="${fl - 3}" width="${Math.max(X(far) - X(near), 2)}" height="6" />`;
      if (blindBottom > sill + 0.001)
        rays += `<rect class="litfloor" x="${X(near)}" y="${fl - 3}" width="${Math.max(X(land(blindBottom)) - X(near), 2)}" height="6" />`;
      const shut = blindBottom <= sill + 0.001;
      // How far the sun that gets past the blind reaches, against the
      // "sun may reach" line: this is the one thing the setting promises.
      const reach = land(blindBottom);
      const past = !shut && reach > D + 0.01;
      const label = shut
        ? "sun would land here if the blind opened"
        : past
          ? `sun reaches ${this._fmtLen(reach)} in, past the "sun may reach" line`
          : 'sun lands here, inside the "sun may reach" line';
      const mid = (X(near) + X(Math.min(far, xMax))) / 2,
        edge = mid > X(xMax) - 170;
      rays += `<text class="note strong ${past ? "warn" : ""}" x="${edge ? X(xMax) - 4 : mid}" y="${fl - 10}" text-anchor="${edge ? "end" : "middle"}">${esc(label)}${far > xMax ? " →" : ""}</text>`;
    } else {
      rays += `<text class="note" x="${X(0.08) + 6}" y="${padT + 12}">${esc(p.why)}</text>`;
    }

    // Floor zones: sun allowed up to D, shade protected beyond.
    const zones = `
      <rect class="zone ok" data-k="distance_shaded_area" x="${X(0)}" y="${fl}" width="${X(Math.min(D, xMax)) - X(0)}" height="10" />
      <rect class="zone keep" data-k="distance_shaded_area" x="${X(Math.min(D, xMax))}" y="${fl}" width="${Math.max(X(xMax) - X(Math.min(D, xMax)), 0)}" height="10" />
      <text class="zonelabel" x="${(X(Math.min(D, xMax)) + X(xMax)) / 2}" y="${fl + 22}" text-anchor="middle">kept in shade</text>
      <line class="dline" data-k="distance_shaded_area" style="--c:${C.distance_shaded_area}" x1="${X(D)}" y1="${Y(ceil)}" x2="${X(D)}" y2="${fl + 10}" />`;

    const wall = `
      <rect class="wall" x="${X(-wallOut)}" y="${Y(ceil)}" width="${X(0.08) - X(-wallOut)}" height="${Y(top) - Y(ceil)}" />
      <rect class="wall" x="${X(-wallOut)}" y="${Y(sill)}" width="${X(0.08) - X(-wallOut)}" height="${fl - Y(sill)}" />
      ${depth > 0 ? `<rect class="reveal" data-k="window_depth" x="${X(-depth)}" y="${Y(top) - 4}" width="${X(0) - X(-depth)}" height="4" />` : ""}
      <line class="glass" x1="${X(0)}" y1="${Y(sill)}" x2="${X(0)}" y2="${Y(top)}" data-k="window_height" />
      <rect class="blind" x="${X(0.015)}" y="${Y(top)}" width="${Math.max(X(0.06) - X(0.015), 3)}" height="${Math.max(Y(blindBottom) - Y(top), 0)}" />
      <text class="blindlabel" x="${X(0.08) + 6}" y="${(Y(top) + Y(blindBottom)) / 2}" dominant-baseline="middle">blind ${p.pct}% open</text>`;

    const dims = [
      dim(
        X(-wallOut) - 14,
        Y(sill),
        X(-wallOut) - 14,
        Y(top),
        `window ${this._fmtLen(h)}`,
        C.window_height,
        "window_height",
      ),
      dim(
        X(-wallOut) - 14,
        fl,
        X(-wallOut) - 14,
        Y(sill),
        `sill ${this._fmtLen(sill)}`,
        C.sill_height,
        "sill_height",
      ),
      dim(
        X(0),
        fl + 30,
        X(D),
        fl + 30,
        `sun may reach ${this._fmtLen(D)}`,
        C.distance_shaded_area,
        "distance_shaded_area",
      ),
      depth > 0
        ? dim(
            X(-depth),
            Y(top) - 18,
            X(0),
            Y(top) - 18,
            `reveal ${this._fmtLen(depth)}`,
            C.window_depth,
            "window_depth",
            -1,
          )
        : "",
    ].join("");

    return `<defs><linearGradient id="sky" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--sky1)"/><stop offset="1" stop-color="var(--sky2)"/></linearGradient>
        <clipPath id="clip"><rect x="0" y="0" width="${W}" height="${fl + 12}"/></clipPath></defs>
      <rect x="${X(xMin)}" y="${padT - 20}" width="${X(-wallOut) - X(xMin)}" height="${fl - padT + 20}" fill="url(#sky)" />
      <text class="side-label" x="${X(xMin) + 6}" y="${fl - 8}">outside</text>
      <text class="side-label" x="${X(xMax) - 6}" y="${Y(ceil) + 14}" text-anchor="end">room</text>
      <line class="floor" x1="${X(xMin)}" y1="${fl}" x2="${X(xMax)}" y2="${fl}" />
      <line class="ceil" x1="${X(0)}" y1="${Y(ceil)}" x2="${X(xMax)}" y2="${Y(ceil)}" />
      ${zones}
      <g clip-path="url(#clip)">${rays}</g>
      ${wall}
      ${dims}`;
  }

  // Polar sun chart: bearing around, elevation inward (rim = horizon).
  _plan(when, sun, lat, lon) {
    const c = this._cfg;
    const cx = 220,
      cy = 220,
      R = 170;
    const r = (el) => R * (1 - Math.max(0, Math.min(90, el)) / 90);
    const pt = (b, rr) => [
      cx + rr * Math.sin(b * RAD),
      cy - rr * Math.cos(b * RAD),
    ];
    const P = (b, rr) =>
      pt(b, rr)
        .map((n) => n.toFixed(1))
        .join(",");
    // Annular sector between bearings b1..b2 (clockwise) and radii r1 < r2.
    const sector = (b1, b2, r1, r2) => {
      let span = b2 - b1;
      if (span <= 0) return "";
      if (span >= 360) span = 359.99;
      const large = span > 180 ? 1 : 0;
      const e = b1 + span;
      return r1 > 0.5
        ? `M${P(b1, r2)} A${r2},${r2} 0 ${large} 1 ${P(e, r2)} L${P(e, r1)} A${r1},${r1} 0 ${large} 0 ${P(b1, r1)} Z`
        : `M${cx},${cy} L${P(b1, r2)} A${r2},${r2} 0 ${large} 1 ${P(e, r2)} Z`;
    };
    const azi = c.set_azimuth;
    let out = `<circle class="sky" cx="${cx}" cy="${cy}" r="${R}" />`;
    // Inside the house: the half of the sky behind the wall.
    out += `<path class="indoors" d="${sector(azi + 90, azi + 270, 0, R)}" />`;
    out += `<path class="fov" data-k="fov" d="${sector(azi - c.fov_left, azi + c.fov_right, 0, R)}" />`;
    for (const el of [30, 60])
      out += `<circle class="ring" cx="${cx}" cy="${cy}" r="${r(el)}" /><text class="ringlabel" x="${cx + 3}" y="${cy - r(el) + 11}">${el}°</text>`;
    if (c.min_elevation != null)
      out += `<path class="elev" data-k="min_elevation" d="${sector(0, 360, r(c.min_elevation), R)}" /><circle class="elevline" data-k="min_elevation" cx="${cx}" cy="${cy}" r="${r(c.min_elevation)}" />`;
    if (c.max_elevation != null)
      out += `<path class="elev" data-k="max_elevation" d="${sector(0, 360, 0, r(c.max_elevation))}" /><circle class="elevline" data-k="max_elevation" cx="${cx}" cy="${cy}" r="${r(c.max_elevation)}" />`;
    if (c.blind_spot) {
      const thr = c.blind_spot_elevation;
      const [r1, r2] =
        thr == null
          ? [0, R]
          : c.blind_spot_elevation_mode === "above"
            ? [0, r(thr)]
            : [r(thr), R];
      out += `<path class="bspot" data-k="blind_spot" d="${sector(azi - c.blind_spot_left_gamma, azi + c.blind_spot_right_gamma, r1, r2)}" />`;
    }
    // FOV edges, labelled from the occupant's point of view.
    const [lx, ly] = pt(azi - c.fov_left, R + 14),
      [rx, ry] = pt(azi + c.fov_right, R + 14);
    out += `<line class="fovedge" data-k="fov_left" x1="${cx}" y1="${cy}" x2="${pt(azi - c.fov_left, R)[0]}" y2="${pt(azi - c.fov_left, R)[1]}" />
      <line class="fovedge" data-k="fov_right" x1="${cx}" y1="${cy}" x2="${pt(azi + c.fov_right, R)[0]}" y2="${pt(azi + c.fov_right, R)[1]}" />
      <text class="fovlabel" data-k="fov_left" x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle">L ${Math.round(c.fov_left)}°</text>
      <text class="fovlabel" data-k="fov_right" x="${rx}" y="${ry}" text-anchor="middle" dominant-baseline="middle">R ${Math.round(c.fov_right)}°</text>`;
    // Compass.
    for (const [b, t] of [
      [0, "N"],
      [90, "E"],
      [180, "S"],
      [270, "W"],
    ]) {
      const [x, y] = pt(b, R + 30);
      out += `<text class="compass" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${t}</text>`;
    }
    // Sun path for the selected day, coloured where it would drive the blind.
    let seg = [],
      segOk = null,
      paths = "",
      ticks = "";
    const flush = () => {
      if (seg.length > 1)
        paths += `<polyline class="path ${segOk ? "ok" : ""}" points="${seg.join(" ")}" />`;
    };
    for (let m = 0; m <= 1440; m += 5) {
      const t = this._at(m);
      const sp = sunPosition(t, lat, lon);
      if (sp.el <= 0) {
        flush();
        seg = [];
        segOk = null;
        continue;
      }
      const ok = sunState(c, sp.az, sp.el).ok;
      const xy = P(sp.az, r(sp.el));
      if (segOk !== null && ok !== segOk) {
        seg.push(xy);
        flush();
        seg = [seg[seg.length - 1]];
      } else seg.push(xy);
      segOk = ok;
      if (m % 120 === 0 && m < 1440)
        ticks += `<circle class="tick" cx="${xy.split(",")[0]}" cy="${xy.split(",")[1]}" r="2.5" /><text class="ticklabel" x="${+xy.split(",")[0] + 5}" y="${+xy.split(",")[1] - 5}">${m / 60}h</text>`;
    }
    flush();
    out += paths + ticks;
    // Wall and window at the centre, the normal pointing out.
    const [w1x, w1y] = pt(azi - 90, 26),
      [w2x, w2y] = pt(azi + 90, 26);
    const [ax, ay] = pt(azi, R - 8);
    out += `<line class="wallplan" x1="${w1x}" y1="${w1y}" x2="${w2x}" y2="${w2y}" />
      <line class="normal" data-k="set_azimuth" x1="${cx}" y1="${cy}" x2="${ax}" y2="${ay}" marker-end="url(#arrow)" />
      <text class="normallabel" data-k="set_azimuth" x="${pt(azi, 60)[0]}" y="${pt(azi, 60)[1]}" dy="-6" text-anchor="middle">faces ${Math.round(azi)}°</text>
      <text class="indoorlabel" x="${pt(azi + 180, 112)[0]}" y="${pt(azi + 180, 112)[1]}" text-anchor="middle">room / sun behind the wall</text>`;
    if (sun.el > 0) {
      const [sx, sy] = pt(sun.az, r(sun.el));
      out += `<circle class="sun ${sunState(c, sun.az, sun.el).ok ? "ok" : ""}" cx="${sx}" cy="${sy}" r="9" />`;
    }
    return `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="${C.set_azimuth}" /></marker></defs>${out}`;
  }

  // Predicted position across the selected day.
  _dayChart(lat, lon) {
    const c = this._cfg;
    const W = 640,
      H = 120,
      l = 34,
      r = 10,
      t = 10,
      b = 22;
    const X = (m) => l + (m / 1440) * (W - l - r);
    const Y = (pct) => t + (1 - pct / 100) * (H - t - b);
    let pts = [],
      sunBands = "",
      bandStart = null;
    for (let m = 0; m <= 1440; m += 5) {
      const sp = sunPosition(this._at(m), lat, lon);
      const p = predict(c, sp.az, sp.el);
      pts.push(`${X(m).toFixed(1)},${Y(p.pct).toFixed(1)}`);
      if (p.ok && bandStart === null) bandStart = m;
      if ((!p.ok || m === 1440) && bandStart !== null) {
        sunBands += `<rect class="band" x="${X(bandStart)}" y="${t}" width="${X(m) - X(bandStart)}" height="${H - t - b}" />`;
        bandStart = null;
      }
    }
    let axis = "";
    for (let hr = 0; hr <= 24; hr += 3)
      axis += `<text class="axis" x="${X(hr * 60)}" y="${H - 6}" text-anchor="middle">${hr}h</text>`;
    for (const pct of [0, 50, 100])
      axis += `<text class="axis" x="${l - 4}" y="${Y(pct)}" text-anchor="end" dominant-baseline="middle">${pct}%</text><line class="grid" x1="${l}" x2="${W - r}" y1="${Y(pct)}" y2="${Y(pct)}" />`;
    return `${sunBands}${axis}<polyline class="pos" points="${pts.join(" ")}" />
      <line class="now" x1="${X(this._minute)}" x2="${X(this._minute)}" y1="${t}" y2="${H - b}" />`;
  }
}

const STYLE = `
/* Fits the viewport: the settings and the drawings scroll independently, so
   the settings stay beside whatever drawing is in view. Narrow screens fall
   back to one column that scrolls as a page (see the max-width query). */
:host { display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden;
  box-sizing: border-box; padding: 16px;
  --fg: var(--primary-text-color, #1f2328); --muted: var(--secondary-text-color, #6b7280);
  --bg: var(--primary-background-color, #f4f5f7); --card: var(--card-background-color, #fff);
  --line: var(--divider-color, #e3e5e8); --accent: var(--primary-color, #03a9f4);
  --sky1: #cfe6ff; --sky2: #eef6ff; --wall: #c9c3b8; --sun: #f5a623;
  background: var(--bg); color: var(--fg); font: 14px/1.4 var(--paper-font-body1_-_font-family, system-ui, sans-serif); }
@media (prefers-color-scheme: dark) { :host { --sky1: #1d3550; --sky2: #16263a; --wall: #57524a; } }
* { box-sizing: border-box; }
h1 { font-size: 20px; margin: 0; font-weight: 500; }
h2 { font-size: 15px; margin: 0; font-weight: 500; }
.top { flex: none; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  width: 100%; max-width: 1700px; margin: 0 auto 14px; }
.grow { flex: 1; }
#status { color: var(--muted); } #status.err { color: #d93025; }
select, input[type=number], input[type=date] { font: inherit; color: var(--fg); background: var(--card);
  border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; }
button { font: inherit; border: 0; border-radius: 6px; padding: 7px 14px; background: var(--accent); color: #fff; cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--line); }
.main { flex: 1; min-height: 0; width: 100%; max-width: 1700px; margin: 0 auto;
  display: grid; grid-template-columns: minmax(300px, 380px) minmax(0, 1fr); gap: 16px; }
form { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow-y: auto; padding-right: 4px; }
fieldset { border: 1px solid var(--line); border-radius: 10px; background: var(--card); margin: 0; padding: 6px 12px 10px; }
legend { padding: 0 6px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
.field { padding: 7px 8px; margin: 0 -8px; border-radius: 8px; transition: background .15s; }
.field.hl { background: color-mix(in srgb, var(--c) 12%, transparent); }
.field label { display: flex; align-items: center; gap: 7px; font-weight: 500; }
.field label i { width: 10px; height: 10px; border-radius: 3px; background: var(--c); flex: none; }
.field .dirty { color: var(--accent); font-size: 10px; visibility: hidden; }
.field.is-dirty .dirty { visibility: visible; }
.field .ctl { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.field input[type=number] { width: 92px; }
.field input[type=range] { flex: 1; accent-color: var(--c); }
.field .unit { color: var(--muted); min-width: 16px; }
.field p { margin: 3px 0 0; color: var(--muted); font-size: 12.5px; }
.field.bool { display: grid; grid-template-columns: 1fr auto; } .field.bool .ctl { margin: 0; grid-row: 1; grid-column: 2; }
.field.bool p { grid-column: 1 / 3; }
.views { min-height: 0; overflow-y: auto; display: grid; gap: 16px; align-content: start;
  grid-template-columns: repeat(auto-fit, minmax(480px, 1fr)); }
.views > .time, .views > .daycard { grid-column: 1 / -1; }
/* The time and preview controls stay put while the drawings scroll. */
.time { position: sticky; top: 0; z-index: 3; box-shadow: 0 6px 12px -10px rgba(0,0,0,.35); }
.trylabel { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.trying { color: var(--accent); }
.note.strong.warn { fill: #d93025; }
@media (max-width: 900px) {
  :host { display: block; height: auto; overflow: visible; }
  .main { grid-template-columns: 1fr; }
  form, .views { overflow: visible; }
  .views { grid-template-columns: minmax(0, 1fr); }
  .time { position: static; }
}
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.card header { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; margin-bottom: 6px; }
.sub { color: var(--muted); font-size: 12.5px; }
svg { width: 100%; height: auto; max-height: 60vh; display: block; font-size: 12px; }
#day { max-height: 180px; }
#plan { max-width: 480px; margin: 0 auto; }
.time .row { display: flex; gap: 10px; align-items: center; margin: 8px 0 4px; }
.time .row input[type=range] { flex: 1; }
.mono { font-variant-numeric: tabular-nums; min-width: 42px; }
.readout { display: flex; flex-direction: column; gap: 2px; }
.readout .k { font-weight: 500; }
.readout .on .k { color: #b7791f; } .readout .off .k { color: var(--muted); }
.muted { color: var(--muted); font-size: 12.5px; }

/* drawings */
[data-k] { cursor: pointer; transition: opacity .15s; }
.views.focusing svg [data-k]:not(.hl) { opacity: .35; }
.dim line { stroke: var(--c); stroke-width: 1.4; }
.dim text { fill: var(--c); font-weight: 600; }
.dim.hl line { stroke-width: 2.6; }
.floor { stroke: var(--fg); stroke-width: 2; }
.ceil { stroke: var(--line); stroke-dasharray: 4 4; }
.wall { fill: var(--wall); }
.reveal { fill: ${C.window_depth}; }
.glass { stroke: #7cc4ff; stroke-width: 4; }
.blind { fill: #6b7280; }
.blindlabel { fill: var(--fg); font-weight: 600; }
.ray { stroke: var(--sun); stroke-width: 1.6; opacity: .9; }
.ray.blocked { opacity: .35; stroke-dasharray: 3 3; }
.ray.idle { opacity: .25; }
.fblind { opacity: .6; }
.fblindedge { stroke: #4b5563; stroke-width: 3; }
.fframe { fill: none; stroke: var(--wall); stroke-width: 8; }
.fframe.hl { stroke: ${C.window_height}; }
.fgrid { stroke: color-mix(in srgb, var(--fg) 12%, transparent); }
.ignored { fill: color-mix(in srgb, var(--fg) 13%, transparent); }
.ctick { stroke: var(--muted); }
.beam { stroke: none; }
.beam.out { fill: color-mix(in srgb, var(--sun) 30%, transparent); }
.beam.lit { fill: color-mix(in srgb, var(--sun) 45%, transparent); stroke: var(--sun); stroke-width: 1; }
.beam.blocked { fill: color-mix(in srgb, var(--sun) 12%, transparent); stroke: var(--sun); stroke-width: 1; stroke-dasharray: 4 4; stroke-opacity: .6; }
.landing.blocked { fill: color-mix(in srgb, var(--sun) 35%, transparent); }
.ray.ghost { stroke-dasharray: 6 5; opacity: .7; stroke-width: 1.2; }
.note.strong { fill: #b7791f; font-weight: 600; }
.field.off { opacity: .45; }
.litfloor { fill: var(--sun); opacity: .8; }
.zone.ok { fill: color-mix(in srgb, ${C.distance_shaded_area} 22%, transparent); }
.zone.keep { fill: color-mix(in srgb, var(--fg) 8%, transparent); }
.zonelabel, .side-label, .note { fill: var(--muted); }
.dline { stroke: var(--c); stroke-dasharray: 5 4; stroke-width: 1.4; }
.dline.hl { stroke-width: 2.6; }
.sky { fill: color-mix(in srgb, var(--sky1) 55%, transparent); stroke: var(--line); }
.indoors { fill: var(--bg); stroke: var(--line); }
.indoorlabel { fill: var(--muted); }
.fov { fill: color-mix(in srgb, ${C.fov} 18%, transparent); }
.fov.hl { fill: color-mix(in srgb, ${C.fov} 32%, transparent); }
.fovedge { stroke: ${C.fov}; stroke-width: 1.5; }
.fovedge.hl { stroke-width: 3; }
.fovlabel { fill: ${C.fov}; font-weight: 600; }
.ring { fill: none; stroke: var(--line); }
.ringlabel, .ticklabel { fill: var(--muted); font-size: 10px; }
.elev { fill: color-mix(in srgb, ${C.elevation} 16%, transparent); }
.elevline { fill: none; stroke: ${C.elevation}; stroke-dasharray: 5 4; stroke-width: 1.5; }
.bspot { fill: color-mix(in srgb, ${C.blind_spot} 26%, transparent); stroke: ${C.blind_spot}; stroke-width: 1; }
.compass { fill: var(--muted); font-weight: 600; }
.path { fill: none; stroke: var(--muted); stroke-width: 2; stroke-dasharray: 2 3; }
.path.ok { stroke: var(--sun); stroke-width: 3.5; stroke-dasharray: none; }
.tick { fill: var(--muted); }
.wallplan { stroke: var(--wall); stroke-width: 7; stroke-linecap: round; }
.normal { stroke: ${C.set_azimuth}; stroke-width: 2.5; }
.normal.hl { stroke-width: 4; }
.normallabel { fill: ${C.set_azimuth}; font-weight: 600; }
.sun { fill: #d1d5db; stroke: #fff; stroke-width: 2; }
.sun.ok { fill: var(--sun); }
.band { fill: color-mix(in srgb, var(--sun) 14%, transparent); }
.axis { fill: var(--muted); font-size: 10.5px; }
.grid { stroke: var(--line); }
.pos { fill: none; stroke: var(--accent); stroke-width: 2.2; }
.now { stroke: var(--fg); stroke-width: 1.2; stroke-dasharray: 3 3; }
`;

customElements.define("acp-designer", AcpDesigner);
