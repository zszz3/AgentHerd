"""Offline fixture: fake pinned API methods, real requests on loopback only."""

import importlib.util
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest import TestCase, main

import requests

spec = importlib.util.spec_from_file_location("worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

URN = "urn:miot-spec-v2:device:light:0000A001:fixture:1"
HOME = "/v2/homeroom/gethome_merged"
CHECK = "/v2/message/v2/check_new_msg"
TARGET = {"did": "light-a", "siid": 2, "piid": 3}
RAW = "raw-sentinel"
# JavaScript JSON.stringify(1e20) uses integer notation.
LARGE_FLOAT_JSON = "100000000000000000000"
LARGE_FLOAT = json.loads(LARGE_FLOAT_JSON)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.writes.append((self.path, data, self.headers["X-Fake-Generation"]))
        if self.path in {HOME, CHECK}:
            result = {"homelist": [{"id": "home-a", "uid": 17}]} if self.path == HOME else {}
        else:
            status, result = self.server.outcome
            if status is None:
                # A lost connection after the provider accepted the POST body.
                self.close_connection = True
                return
            if status != 200:
                self.send_response(status)
                self.send_header("Location", "/redirected")
                self.end_headers()
                self.wfile.write(json.dumps({"result": [{**TARGET, "code": 0}]}).encode())
                return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({"result": result}).encode())

    def log_message(self, *args):
        pass


class FakeAPI:
    def __init__(self, url):
        self.api_base_url = url
        self.auth_data = {}
        self.refuse_refresh = False
        self.generation = 0
        self.session = requests.Session()
        self.session.trust_env = False
        self.session.headers["X-Fake-Generation"] = "0"
        self.calls = []
        self.try_replay = False

    def _refresh_token(self):
        self._request(CHECK, {}, refresh_token=False)
        if self.refuse_refresh:
            raise RuntimeError(RAW)
        self.generation += 1
        self.session.close()
        self.session = requests.Session()
        self.session.trust_env = False
        self.session.headers["X-Fake-Generation"] = str(self.generation)
        # Simulate a replacement session that is configured to retry POST failures.
        retries = requests.adapters.Retry(total=2, allowed_methods=None, status_forcelist=[503])
        self.session.mount("http://", requests.adapters.HTTPAdapter(max_retries=retries))
        self.auth_data = {"generation": self.generation}

    def _request(self, uri, data, refresh_token=True):
        if refresh_token:
            self._refresh_token()
        if uri not in {HOME, CHECK}:
            assert self.auth_data["generation"] == int(self.session.headers["X-Fake-Generation"])
        response = self.session.post(self.api_base_url + uri, json=data)
        return response.json()["result"]

    def set_devices_prop(self, data):
        self.calls.append(("set_devices_prop", data))
        result = self._request(worker.SET_URI, {"params": [data]})
        if self.try_replay:
            self._request(worker.SET_URI, {"params": [data]})
        return result[0] if isinstance(result, list) and len(result) == 1 else result

    def run_action(self, data):
        self.calls.append(("run_action", data))
        return self._request(worker.ACTION_URI, {"params": data})

    def run_scene(self, scene_id, home_id):
        self.calls.append(("run_scene", scene_id, home_id))
        homes = self._request(HOME, {})["homelist"]
        owner = next(home["uid"] for home in homes if home["id"] == home_id)
        return self._request(worker.SCENE_URI, {"scene_id": scene_id, "home_id": home_id, "owner_uid": owner})

    def get_devices_prop(self, data):
        self.calls.append(("get_devices_prop", data))
        return self.read_result

    def get_homes_list(self):
        return [{"id": "home-a", "name": "  " + "e\u0301" * 162 + " ", "roomlist": [{"name": "Kitchen", "dids": ["light-a"]}], "token": RAW}]

    def get_devices_list(self, home_id):
        return [{"home_id": home_id, "did": "light-a", "name": "Lamp", "spec_type": URN, "token": RAW},
                {"home_id": home_id, "did": "light-a", "name": None, "spec_type": RAW}]

    def get_shared_devices_list(self):
        return [{"did": "shared-a", "name": "Shared", "spec_type": URN, "token": RAW}]

    def get_scenes_list(self, home_id):
        return [{"scene_id": "scene-a", "home_id": home_id, "name": "Scene", "token": RAW}]


class Tools:
    def __init__(self):
        self.functions = {}

    def tool(self, fn):
        self.functions[fn.__name__] = fn
        return fn


def exercise_worker(http, subtest):
    api = FakeAPI(f"http://127.0.0.1:{http.server_port}")
    mcp = Tools()
    acquired = []

    def get_api():
        acquired.append(True)
        return api

    worker.register(SimpleNamespace(mcp=mcp, _get_api=get_api), requests)
    assert not acquired
    assert set(mcp.functions) == {"agentherd_" + name for name in (
        "inventory", "set_property", "run_action", "run_scene", "read_property")}

    def call(name, **kwargs):
        reply = mcp.functions["agentherd_" + name](**kwargs)
        assert RAW not in reply
        return json.loads(reply)

    def set_property(result, expected, status=200, writes=1, value=40):
        http.outcome = (status, result)
        http.writes.clear()
        api.calls.clear()
        actual = call("set_property", **TARGET, value=value)
        assert actual == expected, (actual, expected)
        data = {**TARGET, "value": value}
        assert api.calls == [("set_devices_prop", data)]
        expected_writes = [(worker.SET_URI, {"params": [data]}, str(api.generation))] * writes
        assert json.dumps([w for w in http.writes if w[0] != CHECK]) == json.dumps(expected_writes)

    set_property([{**TARGET, "code": 0, "token": RAW}], "acknowledged")
    with subtest(case="property accepts 1e20 in JavaScript JSON integer notation"):
        set_property([{**TARGET, "code": 0}], "acknowledged", value=LARGE_FLOAT)
    for status in (307, 308, 503, None):
        set_property(None, "unknown", status=status)
    for result, expected in [
        ([{**TARGET, "code": -704030023}], "rejected"),
        ([{**TARGET, "code": -704083036}], "unknown"),
        ([{**TARGET, "code": -999999}], "unknown"),
        ([{**TARGET, "code": 1, "piid": 4}], "unknown"),
        ([{**TARGET, "code": True}], "unknown"),
        ([{**TARGET, "code": False}], "unknown"),
        ([{**TARGET, "code": "1"}], "unknown"),
        ([{**TARGET, "code": "0"}], "unknown"),
        ([{**TARGET, "code": 0, "did": "mismatch"}], "unknown"),
        ([{**TARGET, "code": 0, "siid": 2.0}], "unknown"),
        ([{**TARGET, "code": 0, "piid": 4}], "unknown"),
        ([{**TARGET, "message": "success"}], "unknown"),
        ([{**TARGET, "code": 0}, {**TARGET, "code": 0}], "unknown"),
    ]:
        set_property(result, expected)
    with subtest(case="property code 1 is acknowledgement only"):
        set_property([{**TARGET, "code": 1}], "acknowledged")
    for code in (-705201023, -706012023, -706012043):
        set_property([{**TARGET, "piid": 4, "code": code}], "unknown")
        with subtest(case="matched property refusal", code=code):
            set_property([{**TARGET, "code": code, "message": RAW}], "rejected")
    for code in (-705004000, -706012000, -704053036, -704222034, -705201015, -706012015):
        set_property([{**TARGET, "code": code}], "unknown")
    api.refuse_refresh = True
    set_property(None, "rejected", writes=0)
    api.refuse_refresh = False
    api.try_replay = True
    set_property([{**TARGET, "code": 0}], "unknown")
    api.try_replay = False

    action = {"did": "light-a", "siid": 2, "aiid": 4}

    def run_action(result, expected, inputs=None, status=200):
        if inputs is None:
            inputs = [False, "typed"]
        http.outcome = (status, result)
        http.writes.clear()
        api.calls.clear()
        actual = call("run_action", **action, inputs=inputs)
        assert actual == expected, (actual, expected)
        data = {**action, "value": inputs}
        assert api.calls == [("run_action", data)]
        assert json.dumps([w for w in http.writes if w[0] != CHECK]) == json.dumps([
            (worker.ACTION_URI, {"params": data}, str(api.generation))])

    run_action({**action, "code": 0, "out": [RAW]}, "acknowledged")
    with subtest(case="action accepts 1e20 in JavaScript JSON integer notation"):
        run_action({**action, "code": 0}, "acknowledged", inputs=[False, 1, LARGE_FLOAT])
    with subtest(case="action code 1 is acknowledgement only"):
        run_action({**action, "code": 1, "out": [RAW]}, "acknowledged")
    for result in ({**action, "aiid": 5, "code": 1}, {**action, "code": True},
                   {**action, "code": "1"}, {**action, "code": -704222034},
                   [{**action, "code": 1}]):
        run_action(result, "unknown")
    run_action(None, "unknown", status=None)

    api.calls.clear()
    http.writes.clear()
    for invalid_id in (True, 2.0, LARGE_FLOAT):
        assert call("set_property", **{**TARGET, "piid": invalid_id}, value=40) == "unknown"
        assert call("run_action", **{**action, "siid": invalid_id}, inputs=[]) == "unknown"
    assert api.calls == [] and http.writes == []

    for status, result, expected in [(307, None, "unknown"), (308, None, "unknown"),
                                     (503, None, "unknown"), (200, True, "acknowledged"),
                                     (200, False, "rejected"), (200, 1, "unknown"),
                                     (200, "rejected", "unknown"),
                                     (200, {"code": 0, "token": RAW}, "unknown")]:
        http.outcome = (status, result)
        http.writes.clear()
        generation = api.generation
        assert call("run_scene", scene_id="scene-a", home_id="home-a") == expected
        assert api.calls[-1] == ("run_scene", "scene-a", "home-a")
        assert http.writes == [(CHECK, {}, str(generation)), (HOME, {}, str(generation + 1)),
                               (CHECK, {}, str(generation + 1)), (worker.SCENE_URI,
                                {"scene_id": "scene-a", "home_id": "home-a", "owner_uid": 17}, str(generation + 2))]

    api.refuse_refresh = True
    http.writes.clear()
    assert call("run_scene", scene_id="scene-a", home_id="home-a") == "rejected"
    assert http.writes == [(CHECK, {}, str(api.generation))]
    api.refuse_refresh = False

    for row, expected in [({**TARGET, "code": 0, "value": False, "token": RAW}, False),
                          ({**TARGET, "code": 1, "value": True}, None),
                          ({**TARGET, "value": True}, None),
                          ({**TARGET, "piid": 4, "code": 0, "value": 40}, None),
                          ({**TARGET, "code": 0, "value": {"token": RAW}}, None)]:
        api.read_result = row
        assert call("read_property", **TARGET) is expected
        assert api.calls[-1] == ("get_devices_prop", TARGET)

    inventory = call("inventory")
    assert inventory == {"devices": [
        {"homeId": "home-a", "deviceId": "light-a", "urn": URN, "home": "é" * 160, "room": "Kitchen", "name": "Lamp", "sharedOnly": False},
        {"homeId": "home-a", "deviceId": "light-a", "urn": "", "home": "é" * 160, "room": "Kitchen", "name": "", "sharedOnly": False},
        {"homeId": "shared", "deviceId": "shared-a", "urn": URN, "home": "共享设备", "name": "Shared", "sharedOnly": True}],
        "scenes": [{"homeId": "home-a", "sceneId": "scene-a", "home": "é" * 160, "name": "Scene"}]}


class WorkerTest(TestCase):
    def test_offline_worker(self):
        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as http:
            http.writes = []
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                exercise_worker(http, self.subTest)
            finally:
                http.shutdown()
                thread.join()


main(argv=sys.argv[:1])
