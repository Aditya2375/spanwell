import copy, json, random, subprocess, sys, unittest
from spanwell import Arena, Handle


class ActualBytes(unittest.TestCase):
    def test_zero_align_and_requested_bounds(self):
        a = Arena(128)
        h = a.allocate(9, 32)
        self.assertEqual(a.read(h), bytes(9))
        a.write(h, 0, b"abcdefghi")
        self.assertEqual(a.read(h, 2, 3), b"cde")
        self.assertEqual(a.inspect()["padding"], 7)
        self.assertTrue(a.check())
        for off, n in [(9, 1), (10, 0), (-1, 1), (0, 10), (True, 1), (0, True)]:
            with self.assertRaises(ValueError):
                a.read(h, off, n)
        self.assertEqual(a.read(h, 9, 0), b"")
        self.assertTrue(a.check())

    def test_no_host_buffer_exposure(self):
        a = Arena()
        h = a.allocate(4)
        source = bytearray(b"abcd")
        a.write(h, 0, source)
        source[0] = 0
        self.assertEqual(a.read(h), b"abcd")
        view = a.inspect()
        view["blocks"][0]["requested"] = 999
        self.assertEqual(a.inspect()["requested"], 4)

    def test_reject_writes_unchanged(self):
        a = Arena(32)
        h = a.allocate(3)
        a.write(h, 0, b"abc")
        before = a.inspect()
        for off, data in [(2, b"xx"), (-1, b"x"), (True, b"x"), (0, [1, 2]), (0, "hi")]:
            with self.assertRaises(ValueError):
                a.write(h, off, data)
            self.assertEqual(a.inspect(), before)

    def test_free_zeroes_and_coalesces_both_sides(self):
        a = Arena(64)
        x, y, z = [a.allocate(8) for _ in range(3)]
        a.write(y, 0, b"12345678")
        a.free(x)
        a.free(z)
        a.free(y)
        self.assertEqual(
            a.inspect()["blocks"],
            [
                {
                    "start": 0,
                    "capacity": 64,
                    "id": None,
                    "requested": 0,
                    "alignment": 1,
                    "hex": None,
                }
            ],
        )
        new = a.allocate(64)
        self.assertEqual(a.read(new), bytes(64))
        self.assertTrue(a.check())

    def test_stale_double_foreign_forged_handles(self):
        a = Arena(32)
        b = Arena(32)
        h = a.allocate(8)
        other = b.allocate(8)
        for bad in [other, Handle(h.serial), h.serial, None, True]:
            with self.assertRaises(ValueError):
                a.free(bad)
        a.free(h)
        new = a.allocate(8)
        self.assertNotEqual(new.serial, h.serial)
        for f in [
            lambda: a.free(h),
            lambda: a.read(h),
            lambda: a.write(h, 0, b"x"),
            lambda: a.resize(h, 8),
        ]:
            with self.assertRaises(ValueError):
                f()
        self.assertTrue(a.check())

    def test_resize_shrink_equal_and_grow_zero(self):
        a = Arena(64)
        h = a.allocate(15)
        a.write(h, 0, b"ABCDEFGHIJKLMNO")
        alias = h
        h = a.resize(h, 9)
        self.assertIsNot(h, alias)
        self.assertEqual(a.read(h), b"ABCDEFGHI")
        with self.assertRaises(ValueError):
            a.read(alias)
        h = a.resize(h, 12)
        self.assertEqual(a.read(h), b"ABCDEFGHI" + bytes(3))
        h = a.resize(h, 4)
        self.assertEqual(a.read(h), b"ABCD")
        h = a.resize(h, 20)
        self.assertEqual(a.read(h), b"ABCD" + bytes(16))
        self.assertTrue(a.check())

    def test_resize_moves_preserves_zeros_and_alignment(self):
        a = Arena(128)
        h = a.allocate(8, 32)
        a.write(h, 0, b"abcdefgh")
        block = a.allocate(24)
        new = a.resize(h, 40)
        self.assertEqual(a.read(new), b"abcdefgh" + bytes(32))
        r = next(b for b in a.inspect()["blocks"] if b["id"] == new.serial)
        self.assertEqual(r["start"], 32)
        self.assertEqual(r["start"] % 32, 0)
        self.assertEqual(a.read(block), bytes(24))
        self.assertTrue(a.check())

    def test_failed_resize_atomic(self):
        a = Arena(32)
        h = a.allocate(8)
        a.write(h, 0, b"abcdefgh")
        a.allocate(24)
        before = a.inspect()
        for size in [16, 0, 33, True]:
            with self.assertRaises((MemoryError, ValueError)):
                a.resize(h, size)
            self.assertEqual(a.inspect(), before)
            self.assertEqual(a.read(h), b"abcdefgh")

    def test_alignment_prefix_split_reclaimed(self):
        a = Arena(128)
        x = a.allocate(8)
        y = a.allocate(8, 64)
        self.assertEqual(
            [b["start"] for b in a.inspect()["blocks"] if b["id"]], [0, 64]
        )
        self.assertEqual(a.inspect()["free"], 112)
        self.assertTrue(a.check())
        a.free(x)
        a.free(y)
        self.assertEqual(a.inspect()["largest"], 128)

    def test_first_best_differ(self):
        starts = []
        for policy in ["first", "best"]:
            a = Arena(128, policy)
            one = a.allocate(32)
            a.allocate(8)
            two = a.allocate(16)
            a.allocate(8)
            a.free(one)
            a.free(two)
            h = a.allocate(9)
            starts.append(
                next(b["start"] for b in a.inspect()["blocks"] if b["id"] == h.serial)
            )
            self.assertTrue(a.check())
        self.assertEqual(starts, [0, 40])

    def test_fragmentation_oom_not_total_free(self):
        a = Arena(64)
        hs = [a.allocate(8) for _ in range(8)]
        for h in hs[::2]:
            a.free(h)
        self.assertEqual(a.inspect()["free"], 32)
        self.assertEqual(a.inspect()["largest"], 8)
        before = a.inspect()
        with self.assertRaises(MemoryError):
            a.allocate(16)
        self.assertEqual(a.inspect(), before)

    def test_reset_invalidates_but_never_reuses_serials(self):
        a = Arena()
        h = a.allocate(8)
        a.write(h, 0, b"12345678")
        a.reset()
        new = a.allocate(8)
        self.assertGreater(new.serial, h.serial)
        self.assertEqual(a.read(new), bytes(8))
        with self.assertRaises(ValueError):
            a.read(h)

    def test_issuance_limit_is_atomic(self):
        a = Arena(32)
        h = a.allocate(8)
        a._serial = 65535
        before = a.inspect()
        for f in [lambda: a.allocate(8), lambda: a.resize(h, 4)]:
            with self.assertRaises(RuntimeError):
                f()
            self.assertEqual(a.inspect(), before)
        a.free(h)
        a.reset()
        with self.assertRaises(RuntimeError):
            a.allocate(8)

    def test_validation(self):
        for cap in [0, 31, 33, 4104, True, 32.0]:
            with self.assertRaises(ValueError):
                Arena(cap)
        for policy in ["x", None, 1]:
            with self.assertRaises(ValueError):
                Arena(policy=policy)
        a = Arena(128)
        for size, align in [(0, 8), (129, 8), (1, 3), (1, 128), (True, 8), (1, True)]:
            before = a.inspect()
            with self.assertRaises(ValueError):
                a.allocate(size, align)
            self.assertEqual(before, a.inspect())

    def test_empty_read_write_and_length_default(self):
        a = Arena(32)
        h = a.allocate(3)
        a.write(h, 3, b"")
        self.assertEqual(a.read(h, 3), b"")
        self.assertEqual(a.read(h, 0, None), bytes(3))
        before = a.inspect()
        for offset in [None, "0", 1.0, True]:
            with self.assertRaises(ValueError):
                a.read(h, offset)
            self.assertEqual(before, a.inspect())

    def test_real_issuance_limit_and_reset(self):
        a = Arena(32)
        for i in range(65535):
            h = a.allocate(1)
            self.assertEqual(h.serial, i + 1)
            a.free(h)
            if i % 1000 == 0:
                a.reset()
        before = a.inspect()
        with self.assertRaises(RuntimeError):
            a.allocate(1)
        self.assertEqual(a.inspect(), before)

    def test_invariants_run_in_optimized_python(self):
        p = subprocess.run(
            [
                sys.executable,
                "-O",
                "-c",
                "from spanwell import Arena; a=Arena(); a._blocks[0].start=8; a.check()",
            ],
            capture_output=True,
        )
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(b"Arena invariant failed", p.stderr)

    def test_move_left_and_repeated_stale_resize(self):
        a = Arena(128)
        left = a.allocate(40)
        h = a.allocate(8)
        a.allocate(8)
        a.write(h, 0, b"abcdefgh")
        a.free(left)
        fresh = a.resize(h, 32)
        self.assertEqual(a.inspect()["blocks"][0]["id"], fresh.serial)
        self.assertEqual(a.read(fresh), b"abcdefgh" + bytes(24))
        for bad in [h, Handle(fresh.serial)]:
            with self.assertRaises(ValueError):
                a.resize(bad, 8)
        self.assertTrue(a.check())

    def test_alignment_all_powers(self):
        for align in [1, 2, 4, 8, 16, 32, 64]:
            a = Arena(256)
            a.allocate(8)
            h = a.allocate(1, align)
            b = next(x for x in a.inspect()["blocks"] if x["id"] == h.serial)
            self.assertEqual(b["start"] % align, 0)
            self.assertTrue(a.check())


class BitmapOracle(unittest.TestCase):
    def test_random_first_best_against_byte_occupancy(self):
        rng = random.Random(481516)
        operations = 0
        for policy in ["first", "best"]:
            a = Arena(256, policy)
            live = {}
            bitmap = [None] * 256
            values = {}
            for _ in range(2500):
                if not live or rng.randrange(3):
                    size = rng.randrange(1, 57)
                    align = 2 ** rng.randrange(7)
                    cap = (size + 7) // 8 * 8
                    runs = []
                    i = 0
                    while i < 256:
                        if bitmap[i] is not None:
                            i += 1
                            continue
                        start = i
                        while i < 256 and bitmap[i] is None:
                            i += 1
                        aligned = ((start + align - 1) // align) * align
                        if aligned + cap <= i:
                            runs.append((i - start, aligned))
                    before = a.inspect()
                    if not runs:
                        with self.assertRaises(MemoryError):
                            a.allocate(size, align)
                        self.assertEqual(before, a.inspect())
                        continue
                    expected = (
                        runs[0][1]
                        if policy == "first"
                        else min(runs, key=lambda x: (x[0], x[1]))[1]
                    )
                    h = a.allocate(size, align)
                    block = next(
                        b for b in a.inspect()["blocks"] if b["id"] == h.serial
                    )
                    self.assertEqual(block["start"], expected)
                    payload = bytes(rng.randrange(256) for _ in range(size))
                    a.write(h, 0, payload)
                    live[h.serial] = h
                    values[h.serial] = payload
                    bitmap[expected : expected + cap] = [h.serial] * cap
                else:
                    serial = rng.choice(list(live))
                    a.free(live.pop(serial))
                    del values[serial]
                    bitmap = [None if x == serial else x for x in bitmap]
                for serial, h in live.items():
                    self.assertEqual(a.read(h), values[serial])
                self.assertEqual(a.inspect()["free"], bitmap.count(None))
                self.assertTrue(a.check())
                operations += 1
        self.assertGreater(operations, 2000)

    def test_resize_random_shadow_bytes(self):
        rng = random.Random(90)
        a = Arena(128)
        live = {}
        for _ in range(1500):
            action = rng.randrange(4)
            if not live or action == 0:
                n = rng.randrange(1, 40)
                try:
                    h = a.allocate(n)
                except MemoryError:
                    continue
                payload = bytes(rng.randrange(256) for _ in range(n))
                a.write(h, 0, payload)
                live[h.serial] = (h, payload)
            else:
                serial = rng.choice(list(live))
                h, payload = live[serial]
                if action == 1:
                    n = rng.randrange(1, 65)
                    before = a.inspect()
                    try:
                        new = a.resize(h, n)
                    except MemoryError:
                        self.assertEqual(a.inspect(), before)
                        continue
                    expected = (payload + bytes(n))[:n]
                    del live[serial]
                    live[new.serial] = (new, expected)
                    with self.assertRaises(ValueError):
                        a.read(h)
                elif action == 2:
                    a.free(h)
                    del live[serial]
                else:
                    data = bytes([rng.randrange(256)]) * len(payload)
                    a.write(h, 0, data)
                    live[serial] = (h, data)
            for h, payload in live.values():
                self.assertEqual(a.read(h), payload)
            self.assertTrue(a.check())


class Cli(unittest.TestCase):
    def test_operations_and_rejections(self):
        from spanwell.__main__ import execute

        p = {
            "capacity": 32,
            "policy": "first",
            "operations": [
                {"op": "alloc", "name": "A", "size": 4, "alignment": 8},
                {"op": "write", "name": "A", "offset": 0, "hex": "01020304"},
                {"op": "read", "name": "A", "offset": 0, "length": 4},
                {"op": "free", "name": "A"},
                {"op": "read", "name": "A", "offset": 0, "length": 1},
                {"op": "reset"},
                {"op": "alloc", "name": "B", "size": 32, "alignment": 8},
            ],
        }
        out = execute(p)
        self.assertEqual(out[2]["result"], "01020304")
        self.assertFalse(out[4]["ok"])
        self.assertTrue(out[6]["ok"])
        proc = subprocess.run(
            [sys.executable, "-m", "spanwell"],
            input=json.dumps(p).encode(),
            capture_output=True,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout), out)

    def test_invalid_programs(self):
        for raw in [b"x", b"\xff", b"x" * 131073, b"[" * 2000, b"{}"]:
            p = subprocess.run(
                [sys.executable, "-m", "spanwell"], input=raw, capture_output=True
            )
            self.assertEqual(p.returncode, 2)
            self.assertIn("error", json.loads(p.stderr))
            self.assertEqual(p.stdout, b"")


if __name__ == "__main__":
    unittest.main()
