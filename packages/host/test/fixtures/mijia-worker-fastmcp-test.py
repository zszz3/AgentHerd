"""Exercise the worker's real FastMCP argument boundary entirely in memory."""

import importlib.util
import json
import sys
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, main
from unittest.mock import patch

from fastmcp import Client, FastMCP

spec = importlib.util.spec_from_file_location("worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

# JavaScript JSON.stringify(1e20) uses integer notation.
LARGE_SCALAR = json.loads("100000000000000000000")
MAX_IID = 9007199254740991
COMMANDS = (
    ("agentherd_set_property", "piid", {"value": LARGE_SCALAR}, "acknowledged"),
    ("agentherd_run_action", "aiid", {"inputs": [False, LARGE_SCALAR]}, "acknowledged"),
    ("agentherd_read_property", "piid", {}, LARGE_SCALAR),
)


class WorkerFastMCPTest(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []

        def receive(payload):
            self.calls.append(payload)
            return dict(payload, code=0)

        api = SimpleNamespace(
            set_devices_prop=receive,
            run_action=receive,
            get_devices_prop=lambda target: receive(dict(target, value=LARGE_SCALAR)),
        )
        self.dispatch = self.enterContext(patch.object(
            worker, "dispatch", side_effect=lambda api, _requests, _uri, invoke: invoke(api),
        ))
        server = SimpleNamespace(mcp=FastMCP("mi-home-fixture"), _get_api=lambda: api)
        worker.register(server, None)
        self.client = await self.enterAsyncContext(Client(server.mcp))

    async def test_rejects_invalid_ids_before_dispatch_or_read(self):
        for tool, member, extra, _ in COMMANDS:
            for field in ("siid", member):
                for invalid in (True, "2", 3.0, 0, -1, MAX_IID + 1):
                    with self.subTest(tool=tool, field=field, invalid=invalid):
                        self.calls.clear()
                        self.dispatch.reset_mock()
                        args = {"did": "light-a", "siid": 2, member: 3, **extra, field: invalid}
                        result = await self.client.call_tool(tool, args, raise_on_error=False)
                        self.assertEqual(self.calls, [])
                        self.dispatch.assert_not_called()
                        if not result.is_error:
                            fallback = None if tool == "agentherd_read_property" else "unknown"
                            self.assertEqual(json.loads(result.structured_content["result"]), fallback)

    async def test_preserves_valid_ids_and_large_scalar(self):
        for tool, member, extra, expected in COMMANDS:
            for siid, member_id in ((2, 3), (1, MAX_IID), (MAX_IID, 1)):
                with self.subTest(tool=tool, siid=siid, member_id=member_id):
                    self.calls.clear()
                    target = {"did": "light-a", "siid": siid, member: member_id}
                    result = await self.client.call_tool(tool, {**target, **extra})
                    self.assertEqual(json.loads(result.structured_content["result"]), expected)
                    payload = dict(target, value=extra.get("inputs", LARGE_SCALAR))
                    # JSON comparison distinguishes bool, int and float.
                    self.assertEqual(json.dumps(self.calls, sort_keys=True),
                                     json.dumps([payload], sort_keys=True))


main(argv=sys.argv[:1])
