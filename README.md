# Spanwell

An original byte arena suballocator, in Python and JavaScript. It places actual payloads inside a bounded bytearray / Uint8Array and supports allocation, checked byte reads and writes, freeing, resize, relative alignment, splitting and immediate two-sided coalescing. The interactive browser lab makes its address-ordered partition visible.

**A managed suballocator, not a native malloc replacement.** Offsets are relative to byte 0 of the managed arena, never host pointers. Metadata lives outside the arena. This is trusted, single-threaded educational code, not a sandbox, OS memory manager or memory safety guarantee.

## Run

Python 3.10+ and its standard library are enough. No runtime dependencies or installation:

```python
from spanwell import Arena

arena = Arena(128, policy="best")
handle = arena.allocate(11, alignment=16)
arena.write(handle, 0, b"Hello bytes")
assert arena.read(handle) == b"Hello bytes"
old = handle
handle = arena.resize(handle, 24)  # fresh handle, old is now stale
assert arena.read(handle) == b"Hello bytes" + bytes(13)
arena.free(handle)               # zero reservation, merge free neighbors
assert arena.inspect()["largest"] == 128
```

The browser is a standalone static app, not a Python backend:

```sh
python3 -m http.server 8000 --directory docs --bind 127.0.0.1
```

Open `http://127.0.0.1:8000`. Select an arena and policy, then Create/reset. Allocate, write hexadecimal bytes and read them back. Resize always selects the fresh handle. The fragmentation preset resets to 256 bytes and leaves four 32-byte free gaps. A 64-byte allocation fails despite 128 total free bytes. Free neighboring live spans to observe coalescing and regain contiguous space. Changing configuration disables old operations until reset. Tab close or reset loses all state. The hero arena is an illustration, not live state. Payload readback clears on edits, mutations or selection changes; it is only a view.

## Exact contract

- Arena capacity: integer 32..4096, multiple of 8. The UI offers 128, 256, 512 and 1024. Python booleans and all fractional numbers are rejected.
- Requested bytes: integer 1..arena capacity. Reservation capacity rounds up to the next multiple of 8. Padding is inaccessible through read/write.
- Alignment: power of two 1..64, relative to offset 0. All span starts and sizes are multiples of 8 because reservations are rounded to 8, even when a smaller alignment is requested. There is no host-address alignment guarantee.
- First fit: lowest-address free span fitting the aligned reservation. Best fit: smallest **whole free span** fitting it, lower aligned start breaks ties. It does not score only the aligned suffix or promise optimal fragmentation.
- Alignment prefixes and suffixes stay free. Free immediately merges both free neighbors. No adjacent free blocks remain.
- `allocate(size, alignment=8)` zeroes the full reserved span and returns an opaque handle. Out of contiguous aligned space raises Python MemoryError / JS Error without mutation.
- `write(handle, offset, data)` copies bytes into the requested region. Python accepts exact bytes/bytearray; JS accepts Uint8Array. Source mutation after the call does not change the arena. Empty writes at the requested end are valid.
- `read(handle, offset=0, length=None)` returns a detached bytes copy (Uint8Array in JS). A missing/None length (JS undefined/null) means the remaining requested bytes. Empty reads at the requested end are valid. Negative, boolean, fractional, excessive and nonnumeric bounds are rejected before mutation.
- `free(handle)` zeroes the full reservation, then coalesces. Double free and every operation on stale, foreign or reconstructed handles fail. Exact object identity matters, not a serial number. These handles enforce API correctness, not security capabilities. Do not access or mutate implementation attributes, reflect into private state, detach JS buffers, subclass inputs or pass hostile proxy objects. Such access is outside the contract.
- Every successful `resize(handle, size)` returns a **fresh handle**, even for the same size or offset. All old aliases go stale. Shrink/equal-capacity resize retains the offset, discards truncated bytes and zeroes padding. Expansion consumes adjacent right free space when possible. Otherwise it allocates while the old span is still live, copies the common requested prefix, then frees the old span. Newly exposed bytes are zero. A move can fail even when freeing the old span first would make enough room: this is intentional to preserve atomic failure.
- Checked semantic failures leave layout, bytes, serial and handle validity unchanged. This excludes host memory exhaustion, runtime termination, implementation mutation and hardware faults; no transactional fault isolation is claimed.
- `reset()` zeroes the arena, invalidates all handles and keeps the serial counter. Maximum 65535 issued handles per arena, including resize; reset does not renew that budget. Create a new Arena after exhaustion. The UI reset creates a new Arena with its own counter.
- `inspect()` returns detached layout, requested payload hex and free/reserved/requested/padding totals. Free is total free bytes, largest is the largest single free span, neither accounts for future alignment or guarantees a fit. `check()` verifies partition, alignment, handle uniqueness, coalescing and free/padding zeroing. It remains active under Python `-O`.

The byte buffer is real; the model is bounded. It has no OS allocation calls, virtual memory, page tables, raw address dereference, thread synchronization, garbage collection, live compaction, persistence, file writes or networking. Metadata objects, handle objects and returned copies consume host memory outside the reported arena. Library inspect intentionally exposes payload bytes to its caller. Zeroing here is not secure erasure: host copies may remain. Do not enter secrets. There is no timing benchmark or performance claim.

Placement/free/resize scan at most the finite span count, bounded by capacity/8. Byte copies and inspection additionally scale with byte count. The implementation favors auditability over a production allocator's performance.

## CLI

```sh
python3 -m spanwell <<'JSON'
{"capacity":64,"policy":"first","operations":[{"op":"alloc","name":"A","size":4,"alignment":8},{"op":"write","name":"A","offset":0,"hex":"deadbeef"},{"op":"read","name":"A","offset":0,"length":4},{"op":"free","name":"A"}]}
JSON
```

Top-level object must contain exactly `capacity`, `policy`, `operations`. At most 256 operations and 128 KiB UTF-8 JSON stdin. Each operation has exactly its listed fields:

| op     | Additional fields     |
| ------ | --------------------- |
| alloc  | name, size, alignment |
| resize | name, size            |
| read   | name, offset, length  |
| write  | name, offset, hex     |
| free   | name                  |
| reset  | none                  |

Names are 1..8 uppercase ASCII letters/digits. A name is never reused, even after free/reset, so stale operations remain testable. Successful resize updates that name to the fresh handle. CLI hex is even pairs of ASCII hex, no spaces, at most 8192 characters. UI hex additionally allows literal spaces. Each operation result includes ok, result or error, and full post-operation state. Per-operation errors continue with unchanged state; malformed top-level input emits JSON stderr and exit 2. Stdin must reach EOF. The runner never opens user files or evaluates code. JSON decoding uses the host standard parser, including its last-key-wins duplicate-key behavior. JS execute accepts already-parsed plain JSON-like objects, not raw input strings.

## Verification

```sh
make test
npm ci --ignore-scripts
npx playwright install chromium
npm test
npm run test:browser
```

Native tests include analytic placement/coalescing/fragmentation/zeroing/resize cases, 5,000 allocation/free attempts against an independent per-byte occupancy oracle, 1,500 resize shadow-byte attempts, and a real 65,535-handle exhaustion run. Random attempts include expected allocation failures, not 5,000 successful allocations. Browser-core tests include 120 seeded programs × 60 operations, comparing full Python/JS state, errors and payload hex after each operation (7,200 comparisons). Parity alone is not an independent oracle. Real browser checks cover actual byte roundtrip, failed-write atomicity, rounding, resize, zero reuse, fragmentation OOM, configuration invalidation, strict parsing and layout at 1440/1024/768/390/320 px. Neither finite testing nor static analysis proves absence of bugs. CI pins actions, checks three Python versions, browser behavior, secrets and no-network/DOM/native rules. Dev-only Playwright dependencies are locked; no runtime packages or remote fonts/assets.

The app runs wholly locally with no runtime network calls, telemetry, storage or uploads. The static host can log normal asset requests; source links leave the app. CSP blocks scripts/styles except same-origin assets and blocks connections, object embedding, forms and workers. It does not claim to prevent all same-origin hosting risks.

## Reading

Terminology and background, not copied implementation:

- [Memory Management Reference: allocation techniques](https://www.memorymanagement.org/mmref/alloc.html), first fit, address-order coalescence and suballocators.
- [CS 208 free lists](https://awb.fyi/courses/cs208/s22/notes/free-lists.html), placement tradeoffs and immediate coalescing.
- [Python bytearray](https://docs.python.org/3/library/stdtypes.html#bytearray), mutable byte storage.
- [MDN Uint8Array](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array), typed-byte storage.

MIT. Original code and design by Aditya Kulkarni.
