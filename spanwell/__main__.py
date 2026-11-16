"""Finite operation runner. No file access, imports or user code execution."""

import json, sys
from .core import Arena


def execute(program):
    if type(program) is not dict or set(program) != {
        "capacity",
        "policy",
        "operations",
    }:
        raise ValueError("Expected capacity, policy, operations")
    operations = program["operations"]
    if type(operations) is not list or len(operations) > 256:
        raise ValueError("At most 256 operations")
    arena = Arena(program["capacity"], program["policy"])
    handles = {}
    results = []
    shapes = {
        "alloc": {"op", "name", "size", "alignment"},
        "resize": {"op", "name", "size"},
        "free": {"op", "name"},
        "read": {"op", "name", "offset", "length"},
        "write": {"op", "name", "offset", "hex"},
        "reset": {"op"},
    }
    for row in operations:
        try:
            if (
                type(row) is not dict
                or type(row.get("op")) is not str
                or row["op"] not in shapes
                or set(row) != shapes[row["op"]]
            ):
                raise ValueError("Invalid operation shape")
            op = row["op"]
            name = row.get("name")
            if op != "reset" and (
                type(name) is not str
                or not 1 <= len(name) <= 8
                or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" for c in name)
            ):
                raise ValueError("Use a short uppercase handle name")
            result = None
            if op == "alloc":
                if name in handles:
                    raise ValueError("Handle name already used")
                handles[name] = arena.allocate(row["size"], row["alignment"])
                result = handles[name].serial
            elif op == "reset":
                arena.reset()
            else:
                if name not in handles:
                    raise ValueError("Unknown handle name")
                handle = handles[name]
                if op == "resize":
                    handles[name] = arena.resize(handle, row["size"])
                    result = handles[name].serial
                elif op == "free":
                    arena.free(handle)
                elif op == "read":
                    result = arena.read(handle, row["offset"], row["length"]).hex()
                elif op == "write":
                    text = row["hex"]
                    if (
                        type(text) is not str
                        or len(text) > 8192
                        or len(text) % 2
                        or any(c not in "0123456789abcdefABCDEF" for c in text)
                    ):
                        raise ValueError(
                            "Write needs even hex digits, at most 4096 bytes"
                        )
                    arena.write(handle, row["offset"], bytes.fromhex(text))
            arena.check()
            results.append({"ok": True, "result": result, "state": arena.inspect()})
        except (ValueError, MemoryError, RuntimeError) as error:
            results.append({"ok": False, "error": str(error), "state": arena.inspect()})
    return results


def main():
    try:
        raw = sys.stdin.buffer.read(131073)
        if len(raw) > 131072:
            raise ValueError("Program exceeds 128 KiB")
        result = execute(json.loads(raw.decode("utf8")))
    except (ValueError, UnicodeError, RecursionError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 2
    print(json.dumps(result, separators=(",", ":"), ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
