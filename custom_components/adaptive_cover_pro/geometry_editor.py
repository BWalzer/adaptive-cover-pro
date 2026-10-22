"""Visual geometry editor: a sidebar panel plus the websocket API it uses.

The options flow can only render schema forms, so window geometry (heights,
distances, angles) is entered as bare numbers with no picture of what each one
measures. This module ships a frontend panel that draws the window, the sun
path and the predicted position from the entry's options, and edits them in
place.

The panel talks to three admin-only websocket commands:

- ``adaptive_cover_pro/editor/entries`` lists the cover entries.
- ``adaptive_cover_pro/editor/get`` returns one entry's editable options. It
  reads ``entry.options`` directly, so it answers while the entry is reloading.
- ``adaptive_cover_pro/editor/update`` validates a patch with the same
  ``validate_options_patch`` the ``set_*`` services use and applies it with ONE
  ``apply_options_patch``, so a save causes at most one reload. Chaining
  ``set_geometry`` / ``set_sun_tracking`` / ``set_blind_spot`` from a client
  instead lets the second call land mid-reload and resolve to no entry.

Only vertical blinds are editable for now: the panel's drawings and its
position preview model the vertical engine only.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ServiceValidationError

from .const import (
    CONF_AZIMUTH,
    CONF_BLIND_SPOT_ELEVATION,
    CONF_BLIND_SPOT_ELEVATION_MODE,
    CONF_BLIND_SPOT_LEFT,
    CONF_BLIND_SPOT_LEFT_GAMMA,
    CONF_BLIND_SPOT_RIGHT,
    CONF_BLIND_SPOT_RIGHT_GAMMA,
    CONF_DEFAULT_HEIGHT,
    CONF_DISTANCE,
    CONF_ENABLE_BLIND_SPOT,
    CONF_ENTITIES,
    CONF_FOV_LEFT,
    CONF_FOV_RIGHT,
    CONF_HEIGHT_WIN,
    CONF_MAX_ELEVATION,
    CONF_MIN_ELEVATION,
    CONF_SENSOR_TYPE,
    CONF_SILL_HEIGHT,
    CONF_WINDOW_DEPTH,
    CONF_WINDOW_WIDTH,
    DOMAIN,
    CoverType,
    blind_spot_legacy_to_gamma,
)

_LOGGER = logging.getLogger(__name__)

#: Sidebar URL of the panel (``/cover-geometry``). The options-flow step links
#: here with ``?entry=<entry_id>`` to open a specific cover.
PANEL_URL_PATH = "cover-geometry"
PANEL_COMPONENT = "acp-designer"
STATIC_URL = f"/{DOMAIN}_frontend"
FRONTEND_DIR = Path(__file__).parent / "frontend"

#: Cover types the panel can draw and preview.
EDITABLE_COVER_TYPES: frozenset[str] = frozenset({CoverType.BLIND})

#: Options the panel may write. Everything else is rejected, so the editor can
#: never touch identity keys, entity lists or behaviour it doesn't display.
EDITABLE_KEYS: frozenset[str] = frozenset(
    {
        CONF_HEIGHT_WIN,
        CONF_WINDOW_WIDTH,
        CONF_WINDOW_DEPTH,
        CONF_SILL_HEIGHT,
        CONF_DISTANCE,
        CONF_AZIMUTH,
        CONF_FOV_LEFT,
        CONF_FOV_RIGHT,
        CONF_MIN_ELEVATION,
        CONF_MAX_ELEVATION,
        CONF_ENABLE_BLIND_SPOT,
        CONF_BLIND_SPOT_LEFT_GAMMA,
        CONF_BLIND_SPOT_RIGHT_GAMMA,
        CONF_BLIND_SPOT_ELEVATION,
        CONF_BLIND_SPOT_ELEVATION_MODE,
    }
)

#: Read-only context the panel needs alongside the editable keys.
_READ_ONLY_KEYS: tuple[str, ...] = (CONF_DEFAULT_HEIGHT,)

_DATA_KEY = f"{DOMAIN}_geometry_editor"


def editor_url(entry_id: str) -> str:
    """Return the panel URL that opens *entry_id*."""
    return f"/{PANEL_URL_PATH}?entry={entry_id}"


async def async_setup_geometry_editor(hass: HomeAssistant) -> None:
    """Register the panel and websocket commands (idempotent, once per HA run).

    The panel is deliberately never removed on entry unload: saving from the
    panel reloads the entry, and with a single ACP entry an unload-time removal
    would tear the panel down under the user mid-save.
    """
    state = hass.data.setdefault(_DATA_KEY, {"ws": False, "panel": False})

    if not state["ws"]:
        websocket_api.async_register_command(hass, ws_entries)
        websocket_api.async_register_command(hass, ws_get)
        websocket_api.async_register_command(hass, ws_update)
        state["ws"] = True

    # No frontend in headless setups (and most tests): the websocket API still
    # works, there is just nothing to show it in.
    if state["panel"] or "frontend" not in hass.config.components:
        return
    if getattr(hass, "http", None) is None:
        return

    # Claim the registration BEFORE the first await. Entries set up
    # concurrently at boot; a flag set only after registering lets a second
    # entry pass the check while the first is still awaiting, and its
    # registration then raises "Overwriting panel".
    state["panel"] = True
    try:
        await _async_register_panel(hass)
    except Exception:  # noqa: BLE001
        # The editor is optional: a frontend failure must never take the
        # cover's own setup down with it.
        _LOGGER.warning("Could not register the Cover Geometry panel", exc_info=True)


def _frontend_digest() -> str:
    """Return a short hash of the panel script, for its cache-busting URL.

    The integration version is not enough: it only changes on release, and an
    install whose files carry an old mtime (a Nix store, a restored backup)
    lets browsers heuristically cache the script for years.
    """
    script = FRONTEND_DIR / f"{PANEL_COMPONENT}.js"
    return hashlib.sha256(script.read_bytes()).hexdigest()[:12]


async def _async_register_panel(hass: HomeAssistant) -> None:
    from homeassistant.components import panel_custom  # noqa: PLC0415
    from homeassistant.components.http import StaticPathConfig  # noqa: PLC0415

    digest = await hass.async_add_executor_job(_frontend_digest)
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL, str(FRONTEND_DIR), cache_headers=False)]
    )
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_COMPONENT,
        sidebar_title="Cover Geometry",
        sidebar_icon="mdi:sun-angle-outline",
        # Changes whenever the script does, so browsers never keep a stale copy.
        module_url=f"{STATIC_URL}/{PANEL_COMPONENT}.js?v={digest}",
        require_admin=True,
        config={},
    )


def _cover_type(entry) -> str | None:
    return entry.data.get(CONF_SENSOR_TYPE) or entry.options.get(CONF_SENSOR_TYPE)


def _editable_entries(hass: HomeAssistant) -> list:
    from .cover_types import get_policy  # noqa: PLC0415

    entries = []
    for entry in hass.config_entries.async_entries(DOMAIN):
        cover_type = _cover_type(entry)
        if cover_type is None:
            continue
        policy = get_policy(cover_type)
        # Cover groups and Building Profiles have no geometry of their own.
        if not policy.controls_cover or policy.is_orchestrator:
            continue
        entries.append(entry)
    return entries


def editor_options(options: dict[str, Any]) -> dict[str, Any]:
    """Project an entry's options onto what the panel reads.

    Entries that predate the signed-gamma migration (#247) store only the
    legacy blind-spot edges; convert them so the panel always gets the gamma
    frame it draws in.
    """
    out = {key: options.get(key) for key in (*EDITABLE_KEYS, *_READ_ONLY_KEYS)}
    if (
        out[CONF_BLIND_SPOT_LEFT_GAMMA] is None
        and options.get(CONF_BLIND_SPOT_LEFT) is not None
        and options.get(CONF_BLIND_SPOT_RIGHT) is not None
        and options.get(CONF_FOV_LEFT) is not None
    ):
        left, right = blind_spot_legacy_to_gamma(
            options[CONF_FOV_LEFT],
            options[CONF_BLIND_SPOT_LEFT],
            options[CONF_BLIND_SPOT_RIGHT],
        )
        out[CONF_BLIND_SPOT_LEFT_GAMMA] = left
        out[CONF_BLIND_SPOT_RIGHT_GAMMA] = right
    return out


def _live(entry) -> dict[str, Any] | None:
    """Return the current sun and calculated position, when the entry is running."""
    from .helpers import usable_coordinator  # noqa: PLC0415

    coordinator = usable_coordinator(entry)
    data = getattr(coordinator, "data", None)
    diagnostics = getattr(data, "diagnostics", None)
    if not diagnostics:
        return None
    return {
        "sun_azimuth": diagnostics.get("sun_azimuth"),
        "sun_elevation": diagnostics.get("sun_elevation"),
        "calculated_position": diagnostics.get("calculated_position"),
    }


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/editor/entries"})
@callback
def ws_entries(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """List the cover entries and whether the panel can edit each one."""
    connection.send_result(
        msg["id"],
        [
            {
                "entry_id": entry.entry_id,
                "title": entry.title,
                "cover_type": _cover_type(entry),
                "editable": _cover_type(entry) in EDITABLE_COVER_TYPES,
            }
            for entry in _editable_entries(hass)
        ],
    )


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/editor/get",
        vol.Required("entry_id"): str,
    }
)
@callback
def ws_get(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Return one entry's editable options, covers and live sun state."""
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if entry is None or entry.domain != DOMAIN:
        connection.send_error(
            msg["id"], "not_found", "No such Adaptive Cover Pro entry."
        )
        return
    connection.send_result(
        msg["id"],
        {
            "entry_id": entry.entry_id,
            "title": entry.title,
            "cover_type": _cover_type(entry),
            "editable": _cover_type(entry) in EDITABLE_COVER_TYPES,
            "loaded": entry.state is ConfigEntryState.LOADED,
            "covers": list(entry.options.get(CONF_ENTITIES) or []),
            "options": editor_options(dict(entry.options)),
            "location": {
                "latitude": hass.config.latitude,
                "longitude": hass.config.longitude,
                "time_zone": hass.config.time_zone,
            },
            "live": _live(entry),
        },
    )


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/editor/update",
        vol.Required("entry_id"): str,
        vol.Required("changes"): dict,
    }
)
@websocket_api.async_response
async def ws_update(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Validate and apply a patch of editable options in one options update."""
    from .services import cover_coordinators  # noqa: PLC0415
    from .services.options_service import (  # noqa: PLC0415
        apply_options_patch,
        validate_options_patch,
    )

    entry_id = msg["entry_id"]
    changes: dict[str, Any] = msg["changes"]

    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None or entry.domain != DOMAIN:
        connection.send_error(
            msg["id"], "not_found", "No such Adaptive Cover Pro entry."
        )
        return
    cover_type = _cover_type(entry)
    if cover_type not in EDITABLE_COVER_TYPES:
        connection.send_error(
            msg["id"],
            "not_supported",
            f"The geometry editor can't edit '{cover_type}' covers yet.",
        )
        return
    unknown = sorted(set(changes) - EDITABLE_KEYS)
    if unknown:
        connection.send_error(
            msg["id"], "invalid_format", f"Not editable here: {', '.join(unknown)}."
        )
        return
    # Applying needs the running coordinator. Refusing while the entry is
    # unloaded or mid-reload (e.g. a double-clicked Save) beats writing options
    # that the in-flight reload may not pick up.
    coordinator = cover_coordinators(hass).get(entry_id)
    if coordinator is None:
        connection.send_error(
            msg["id"],
            "not_loaded",
            f"'{entry.title}' isn't loaded right now. Wait for it to finish reloading and save again.",
        )
        return
    try:
        validate_options_patch(dict(changes), dict(entry.options), cover_type)
    except ServiceValidationError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return

    new_options = await apply_options_patch(hass, coordinator, dict(changes))
    _LOGGER.debug("geometry editor updated entry %s: %s", entry_id, sorted(changes))
    connection.send_result(msg["id"], {"options": editor_options(new_options)})
