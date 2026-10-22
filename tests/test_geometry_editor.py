"""Visual geometry editor: websocket API, panel registration and options-flow link.

Concerns:
- ``editor/get`` reads ``entry.options`` (including ``window_width``, which no
  service exports) and converts legacy blind-spot edges to the gamma frame.
- ``editor/update`` validates with the ``set_*`` services' rules and applies
  the whole patch in ONE options update, so a save causes at most one reload.
  It rejects keys outside the editor's whitelist, cover types it can't draw,
  invalid values, entries that aren't loaded, and non-admin users.
- The panel is registered once, admin-only, and only when the frontend runs.
- The options menu links to the editor for vertical blinds only, and every
  language carries the label and the step text with the ``{editor_url}``
  placeholder.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from homeassistant.core import HomeAssistant

from custom_components.adaptive_cover_pro.config_flow import OptionsFlowHandler
from custom_components.adaptive_cover_pro.const import (
    CONF_BLIND_SPOT_LEFT,
    CONF_BLIND_SPOT_LEFT_GAMMA,
    CONF_BLIND_SPOT_RIGHT,
    CONF_BLIND_SPOT_RIGHT_GAMMA,
    CONF_DISTANCE,
    CONF_FOV_LEFT,
    CONF_HEIGHT_WIN,
    CONF_SENSOR_TYPE,
    CONF_SILL_HEIGHT,
    CONF_WINDOW_WIDTH,
    DOMAIN,
    CoverType,
)
from custom_components.adaptive_cover_pro.geometry_editor import (
    PANEL_URL_PATH,
    async_setup_geometry_editor,
    editor_options,
    editor_url,
)

from .ha_helpers import VERTICAL_OPTIONS, _patch_coordinator_refresh, setup_integration

pytestmark = pytest.mark.integration

_TRANSLATIONS = (
    Path(__file__).parent.parent
    / "custom_components"
    / "adaptive_cover_pro"
    / "translations"
)


async def _ws(hass_ws_client, hass, token=None):
    return await (hass_ws_client(hass, token) if token else hass_ws_client(hass))


async def _call(client, **msg):
    await client.send_json_auto_id(msg)
    return await client.receive_json()


# ---------------------------------------------------------------------------
# editor/entries and editor/get
# ---------------------------------------------------------------------------


async def test_entries_lists_blind_as_editable(hass: HomeAssistant, hass_ws_client):
    entry = await setup_integration(hass)
    client = await _ws(hass_ws_client, hass)

    msg = await _call(client, type=f"{DOMAIN}/editor/entries")

    assert msg["success"]
    assert msg["result"] == [
        {
            "entry_id": entry.entry_id,
            "title": entry.title,
            "cover_type": CoverType.BLIND,
            "editable": True,
        }
    ]


async def test_entries_marks_awning_not_editable(hass: HomeAssistant, hass_ws_client):
    await setup_integration(hass, cover_type=CoverType.AWNING)
    client = await _ws(hass_ws_client, hass)

    msg = await _call(client, type=f"{DOMAIN}/editor/entries")

    assert [e["editable"] for e in msg["result"]] == [False]


async def test_get_returns_options_covers_and_location(
    hass: HomeAssistant, hass_ws_client
):
    entry = await setup_integration(
        hass, options={**VERTICAL_OPTIONS, CONF_WINDOW_WIDTH: 1.2}
    )
    client = await _ws(hass_ws_client, hass)

    msg = await _call(client, type=f"{DOMAIN}/editor/get", entry_id=entry.entry_id)

    assert msg["success"]
    result = msg["result"]
    assert result["editable"] is True
    assert result["loaded"] is True
    assert result["covers"] == ["cover.test_blind"]
    # window_width is the key no service exports.
    assert result["options"][CONF_WINDOW_WIDTH] == 1.2
    assert result["options"][CONF_HEIGHT_WIN] == VERTICAL_OPTIONS[CONF_HEIGHT_WIN]
    assert result["location"]["latitude"] == hass.config.latitude
    assert result["location"]["time_zone"] == hass.config.time_zone


async def test_get_unknown_entry_is_not_found(hass: HomeAssistant, hass_ws_client):
    await setup_integration(hass)
    client = await _ws(hass_ws_client, hass)

    msg = await _call(client, type=f"{DOMAIN}/editor/get", entry_id="nope")

    assert not msg["success"]
    assert msg["error"]["code"] == "not_found"


def test_editor_options_converts_legacy_blind_spot():
    options = {
        CONF_FOV_LEFT: 60,
        CONF_BLIND_SPOT_LEFT: 10,
        CONF_BLIND_SPOT_RIGHT: 40,
    }

    out = editor_options(options)

    # Legacy wedge: fov_left - right <= gamma <= fov_left - left → [20, 50];
    # signed gamma: -right_gamma <= gamma <= left_gamma.
    assert out[CONF_BLIND_SPOT_LEFT_GAMMA] == 50
    assert out[CONF_BLIND_SPOT_RIGHT_GAMMA] == -20


def test_editor_options_prefers_stored_gamma():
    options = {
        CONF_FOV_LEFT: 60,
        CONF_BLIND_SPOT_LEFT: 10,
        CONF_BLIND_SPOT_RIGHT: 40,
        CONF_BLIND_SPOT_LEFT_GAMMA: 5,
        CONF_BLIND_SPOT_RIGHT_GAMMA: 7,
    }

    out = editor_options(options)

    assert (out[CONF_BLIND_SPOT_LEFT_GAMMA], out[CONF_BLIND_SPOT_RIGHT_GAMMA]) == (5, 7)


# ---------------------------------------------------------------------------
# editor/update
# ---------------------------------------------------------------------------


async def test_update_applies_patch_in_one_options_update(
    hass: HomeAssistant, hass_ws_client
):
    entry = await setup_integration(hass)
    client = await _ws(hass_ws_client, hass)
    changes = {CONF_SILL_HEIGHT: 0.8, CONF_DISTANCE: 1.5, CONF_WINDOW_WIDTH: 1.1}

    real_update = hass.config_entries.async_update_entry
    with (
        _patch_coordinator_refresh(),
        patch.object(
            hass.config_entries, "async_update_entry", side_effect=real_update
        ) as update_entry,
    ):
        msg = await _call(
            client,
            type=f"{DOMAIN}/editor/update",
            entry_id=entry.entry_id,
            changes=changes,
        )
        await hass.async_block_till_done()

    assert msg["success"], msg
    options_updates = [c for c in update_entry.call_args_list if "options" in c.kwargs]
    assert len(options_updates) == 1
    for key, value in changes.items():
        assert entry.options[key] == value
        assert msg["result"]["options"][key] == value


async def test_update_rejects_keys_outside_whitelist(
    hass: HomeAssistant, hass_ws_client
):
    entry = await setup_integration(hass)
    client = await _ws(hass_ws_client, hass)
    before = dict(entry.options)

    msg = await _call(
        client,
        type=f"{DOMAIN}/editor/update",
        entry_id=entry.entry_id,
        changes={CONF_SILL_HEIGHT: 0.8, "group": ["cover.other"]},
    )

    assert not msg["success"]
    assert msg["error"]["code"] == "invalid_format"
    assert dict(entry.options) == before


async def test_update_rejects_invalid_value(hass: HomeAssistant, hass_ws_client):
    entry = await setup_integration(hass)
    client = await _ws(hass_ws_client, hass)
    before = dict(entry.options)

    msg = await _call(
        client,
        type=f"{DOMAIN}/editor/update",
        entry_id=entry.entry_id,
        changes={CONF_HEIGHT_WIN: 0},
    )

    assert not msg["success"]
    assert msg["error"]["code"] == "invalid"
    assert dict(entry.options) == before


async def test_update_rejects_cover_type_it_cannot_draw(
    hass: HomeAssistant, hass_ws_client
):
    entry = await setup_integration(hass, cover_type=CoverType.AWNING)
    client = await _ws(hass_ws_client, hass)

    msg = await _call(
        client,
        type=f"{DOMAIN}/editor/update",
        entry_id=entry.entry_id,
        changes={CONF_DISTANCE: 1.0},
    )

    assert not msg["success"]
    assert msg["error"]["code"] == "not_supported"


async def test_update_refuses_unloaded_entry(hass: HomeAssistant, hass_ws_client):
    entry = await setup_integration(hass)
    client = await _ws(hass_ws_client, hass)
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    before = dict(entry.options)

    msg = await _call(
        client,
        type=f"{DOMAIN}/editor/update",
        entry_id=entry.entry_id,
        changes={CONF_SILL_HEIGHT: 0.8},
    )

    assert not msg["success"]
    assert msg["error"]["code"] == "not_loaded"
    assert dict(entry.options) == before


@pytest.mark.parametrize(
    "command",
    [
        {"type": f"{DOMAIN}/editor/entries"},
        {"type": f"{DOMAIN}/editor/get", "entry_id": "x"},
        {"type": f"{DOMAIN}/editor/update", "entry_id": "x", "changes": {}},
    ],
)
async def test_commands_require_admin(
    hass: HomeAssistant, hass_ws_client, hass_read_only_access_token, command
):
    await setup_integration(hass)
    client = await _ws(hass_ws_client, hass, hass_read_only_access_token)

    msg = await _call(client, **command)

    assert not msg["success"]
    assert msg["error"]["code"] == "unauthorized"


# ---------------------------------------------------------------------------
# Panel registration
# ---------------------------------------------------------------------------


async def test_panel_registered_once_admin_only(hass: HomeAssistant):
    hass.config.components.add("frontend")
    hass.http = MagicMock(async_register_static_paths=AsyncMock())
    with patch(
        "homeassistant.components.panel_custom.async_register_panel",
        new_callable=AsyncMock,
    ) as register_panel:
        await async_setup_geometry_editor(hass)
        await async_setup_geometry_editor(hass)

    register_panel.assert_awaited_once()
    kwargs = register_panel.await_args.kwargs
    assert kwargs["frontend_url_path"] == PANEL_URL_PATH
    assert kwargs["require_admin"] is True
    hass.http.async_register_static_paths.assert_awaited_once()


async def test_concurrent_setups_register_panel_once(hass: HomeAssistant):
    """Entries set up concurrently at boot must not both register the panel.

    Regression: the flag was set only after the awaits, so a second entry's
    setup passed the check mid-registration and HA raised "Overwriting panel",
    failing that entry's setup.
    """
    hass.config.components.add("frontend")
    hass.http = MagicMock(async_register_static_paths=AsyncMock())

    async def slow_register(*args, **kwargs):
        await asyncio.sleep(0)

    with patch(
        "homeassistant.components.panel_custom.async_register_panel",
        side_effect=slow_register,
    ) as register_panel:
        await asyncio.gather(
            async_setup_geometry_editor(hass), async_setup_geometry_editor(hass)
        )

    assert register_panel.call_count == 1


async def test_panel_failure_does_not_fail_setup(hass: HomeAssistant, caplog):
    hass.config.components.add("frontend")
    hass.http = MagicMock(async_register_static_paths=AsyncMock())
    with patch(
        "homeassistant.components.panel_custom.async_register_panel",
        side_effect=ValueError("Overwriting panel cover-geometry"),
    ):
        await async_setup_geometry_editor(hass)

    assert "Could not register the Cover Geometry panel" in caplog.text


async def test_no_panel_without_frontend(hass: HomeAssistant):
    assert "frontend" not in hass.config.components
    with patch(
        "homeassistant.components.panel_custom.async_register_panel",
        new_callable=AsyncMock,
    ) as register_panel:
        await async_setup_geometry_editor(hass)

    register_panel.assert_not_awaited()


# ---------------------------------------------------------------------------
# Options-flow link
# ---------------------------------------------------------------------------


def _flow(hass, cover_type: str, entry_id: str = "cover_1") -> OptionsFlowHandler:
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"name": entry_id, CONF_SENSOR_TYPE: cover_type},
        options={"group": []},
        entry_id=entry_id,
        title="Kitchen Blind",
    )
    entry.add_to_hass(hass)
    flow = OptionsFlowHandler(entry)
    flow.hass = hass
    flow.context = {}
    flow.handler = entry.entry_id
    return flow


async def test_menu_offers_editor_for_vertical_blind(hass: HomeAssistant):
    menu = (await _flow(hass, CoverType.BLIND).async_step_init())["menu_options"]

    assert "geometry_editor" in menu
    assert menu.index("geometry_editor") == menu.index("sun_tracking") + 1


async def test_menu_hides_editor_for_awning(hass: HomeAssistant):
    menu = (await _flow(hass, CoverType.AWNING).async_step_init())["menu_options"]

    assert "geometry_editor" not in menu


async def test_editor_step_links_to_this_entry_and_returns_to_menu(
    hass: HomeAssistant,
):
    flow = _flow(hass, CoverType.BLIND, entry_id="blind_42")

    shown = await flow.async_step_geometry_editor()
    assert shown["type"] == "form"
    assert shown["description_placeholders"]["editor_url"] == editor_url("blind_42")
    assert editor_url("blind_42") == f"/{PANEL_URL_PATH}?entry=blind_42"

    back = await flow.async_step_geometry_editor({})
    assert back["step_id"] == "init"


@pytest.mark.parametrize("language", ["en", "de", "fr"])
def test_translations_cover_menu_label_and_step(language: str):
    steps = json.loads(
        (_TRANSLATIONS / f"{language}.json").read_text(encoding="utf-8")
    )["options"]["step"]

    assert steps["init"]["menu_options"]["geometry_editor"]
    step = steps["geometry_editor"]
    assert step["title"]
    assert "{editor_url}" in step["description"]
