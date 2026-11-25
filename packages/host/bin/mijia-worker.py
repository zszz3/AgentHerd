"""Private adapter for AgentHerd's pinned, owner-supplied Mi Home runtime."""

import json
import math
import re
import sys
import unicodedata
from copy import copy
from importlib.metadata import version
from pathlib import Path

from pydantic import StrictInt

EXPECTED_VERSION = "5.0.0"
REPLY_BYTES = 256 * 1024
ID = re.compile(r"[a-zA-Z0-9._:-]{1,128}")
URN = re.compile(r"urn:miot-spec-v2:device:[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+(?::[a-zA-Z0-9_.-]+){0,3}")
SET_URI = "/miotspec/prop/set"
ACTION_URI = "/miotspec/action"
SCENE_URI = "/appgateway/miot/appsceneservice/AppSceneService/NewRunScene"
MAX_SAFE_IID = 9007199254740991
FLOAT_MAX = 3.4028234663852886e38
# Explicit declines listed in pinned errors.py, not transport, timeout or pending codes.
DECLINED = {-10005, -704030023, -704040002, -704040003, -704040005,
            -704053100, -704220008, -704220025, -704220035, -704220043,
            -705201023, -706012023, -706012043}
NOT_SENT = object()


def valid_id(value):
    return isinstance(value, str) and ID.fullmatch(value) is not None


def valid_urn(value):
    return isinstance(value, str) and len(value) <= 256 and URN.fullmatch(value) is not None


def iid(value):
    return type(value) is int and 0 < value <= MAX_SAFE_IID


def scalar(value):
    return (
        type(value) is bool
        # JS can serialize a float-format value such as 1e20 as a JSON integer.
        or (type(value) is int and -FLOAT_MAX <= value <= FLOAT_MAX)
        or (type(value) is float and math.isfinite(value))
        or (type(value) is str and len(value) <= 160)
    )


def label(value):
    if not isinstance(value, str):
        return ""
    text = "".join(" " if unicodedata.category(c) in {"Cc", "Cf", "Cs"} else c for c in value)
    return unicodedata.normalize("NFC", " ".join(text.split()))[:160].rstrip()


def rows(values):
    if isinstance(values, list):
        return (value for value in values if isinstance(value, dict))
    return iter(())


def inventory(api):
    homes = {}
    for home in rows(api.get_homes_list()):
        home_id = home.get("id")
        if valid_id(home_id) and home_id != "shared":
            if home_id in homes:
                raise ValueError("Ambiguous home")
            homes[home_id] = home

    devices, scenes = [], []
    for home_id, home in homes.items():
        home_name = label(home.get("name"))
        if not home_name:
            continue
        rooms = {}
        for room in rows(home.get("roomlist")):
            members = room.get("dids")
            if isinstance(members, list):
                for did in members:
                    if valid_id(did):
                        rooms[did] = None if did in rooms else label(room.get("name"))
        for device in rows(api.get_devices_list(home_id)):
            if device.get("home_id") == home_id:
                add_device(devices, device, home_id, home_name, rooms, False)
        for scene in rows(api.get_scenes_list(home_id)):
            scene_id, name = scene.get("scene_id"), label(scene.get("name"))
            if scene.get("home_id") == home_id and valid_id(scene_id):
                scenes.append(dict(homeId=home_id, sceneId=scene_id, home=home_name, name=name))

    for device in rows(api.get_shared_devices_list()):
        add_device(devices, device, "shared", "共享设备", {}, True)
    return dict(devices=devices, scenes=scenes)


def add_device(devices, device, home_id, home_name, rooms, shared):
    did, urn, name = device.get("did"), device.get("spec_type"), label(device.get("name"))
    if not valid_id(did):
        return
    # Keep an identified row even without a usable spec/label so a duplicate
    # cannot disappear and leave an apparently unambiguous control target.
    row = dict(homeId=home_id, deviceId=did, urn=urn if valid_urn(urn) else "",
               home=home_name, name=name, sharedOnly=shared)
    if rooms.get(did):
        row["room"] = rooms[did]
    devices.append(row)


def value_or_null(value):
    return value if scalar(value) else None


def tuple_code(reply, target):
    # 5.0.0 unwraps a single result to a dict for a dict input. A list or a
    # successful-looking message alone is not an understood receipt.
    if not isinstance(reply, dict) or any(
        type(reply.get(key)) is not type(value) or reply[key] != value
        for key, value in target.items()
    ):
        return None
    code = reply.get("code")
    return code if type(code) is int else None


def receipt(result, target):
    code = tuple_code(result, target)
    # Pinned devices.py treats 1 as gateway acceptance with unknown effect.
    if code in (0, 1):
        return "acknowledged"
    return "rejected" if code in DECLINED else "unknown"


def dispatch(api, requests, uri, invoke):
    # _request refreshes *before* accessing self.session in 5.0.0. Run that
    # refresh on the live API, then use a private session for the one POST.
    # Do not patch the live singleton: other tools may be running. The scene's
    # earlier owner lookup and refresh availability reads use the original API.
    adapter = copy(api)
    request = adapter._request
    entered = sent = preflight_failed = False

    def once(path, data, refresh_token=True):
        nonlocal entered, sent, preflight_failed
        if path == "/v2/homeroom/gethome_merged" and uri == SCENE_URI and not entered:
            try:
                return api._request(path, data, refresh_token=refresh_token)
            except Exception:
                preflight_failed = True
                raise
        if path != uri or entered:
            raise RuntimeError("Unexpected mutation request")
        entered = True
        if refresh_token:
            try:
                api._refresh_token()
            except Exception:
                preflight_failed = True
                raise
        current = api.session
        adapter.auth_data = api.auth_data
        with requests.Session() as session:
            session.trust_env = False
            session.headers = current.headers.copy()
            session.cookies = current.cookies.copy()
            session.mount("https://", requests.adapters.HTTPAdapter(max_retries=0))
            session.mount("http://", requests.adapters.HTTPAdapter(max_retries=0))
            post = session.post

            def post_once(url, **kwargs):
                nonlocal sent
                if sent or url != api.api_base_url + uri:
                    raise RuntimeError("Unexpected mutation POST")
                sent = True
                response = post(url, **kwargs, allow_redirects=False, timeout=(4, 8))
                if response.status_code != 200:
                    response.close()
                    raise RuntimeError("Mutation receipt unavailable")
                return response

            session.post = post_once
            adapter.session = session
            return request(path, data, refresh_token=False)

    adapter._request = once
    try:
        result = invoke(adapter)
        return result if sent else None
    except Exception:
        return NOT_SENT if preflight_failed and not sent else None


def register(server, requests):
    def reply(work, fallback=None):
        try:
            data = json.dumps(work(), ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            if len(data.encode("utf8")) <= REPLY_BYTES:
                return data
        except Exception:
            pass
        return json.dumps(fallback)

    def target(did, siid, member_key, member_id):
        if not valid_id(did) or not iid(siid) or not iid(member_id):
            raise ValueError("Invalid control target")
        return {"did": did, "siid": siid, member_key: member_id}

    def mutate(uri, invoke, fields):
        result = dispatch(server._get_api(), requests, uri, invoke)
        if result is NOT_SENT or (uri == SCENE_URI and result is False):
            return "rejected"
        if uri == SCENE_URI:
            return "acknowledged" if result is True else "unknown"
        return receipt(result, fields)

    @server.mcp.tool
    def agentherd_inventory() -> str:
        return reply(lambda: inventory(server._get_api()))

    # Plain int lets FastMCP coerce IDs before target() can validate them.
    @server.mcp.tool
    def agentherd_set_property(did: str, siid: StrictInt, piid: StrictInt, value: object) -> str:
        def write():
            fields = target(did, siid, "piid", piid)
            if not scalar(value):
                return "rejected"
            return mutate(SET_URI, lambda api: api.set_devices_prop(dict(fields, value=value)), fields)
        return reply(write, "unknown")

    @server.mcp.tool
    def agentherd_run_action(did: str, siid: StrictInt, aiid: StrictInt, inputs: list) -> str:
        def write():
            fields = target(did, siid, "aiid", aiid)
            if not all(scalar(value) for value in inputs):
                return "rejected"
            return mutate(ACTION_URI, lambda api: api.run_action(dict(fields, value=inputs)), fields)
        return reply(write, "unknown")

    @server.mcp.tool
    def agentherd_run_scene(scene_id: str, home_id: str) -> str:
        def write():
            if not valid_id(scene_id) or not valid_id(home_id) or home_id == "shared":
                return "rejected"
            return mutate(SCENE_URI, lambda api: api.run_scene(scene_id, home_id), {})
        return reply(write, "unknown")

    @server.mcp.tool
    def agentherd_read_property(did: str, siid: StrictInt, piid: StrictInt) -> str:
        def read():
            fields = target(did, siid, "piid", piid)
            result = server._get_api().get_devices_prop(fields)
            return value_or_null(result.get("value")) if tuple_code(result, fields) == 0 else None
        return reply(read)


def main():
    if version("mijiaAPI") != EXPECTED_VERSION:
        raise SystemExit("Unsupported Mi Home runtime")
    import requests
    from mijiaAPI import mcp_server

    register(mcp_server, requests)
    mcp_server.run(Path(sys.argv[1]))


if __name__ == "__main__":
    main()
