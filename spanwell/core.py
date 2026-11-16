"""A real byte arena suballocator. Offsets are relative, never host pointers."""

from dataclasses import dataclass


def integer(value, lo, hi, label):
    if type(value) is not int or not lo <= value <= hi:
        raise ValueError(f"{label} must be an integer in {lo}..{hi}")
    return value


@dataclass(frozen=True, eq=False)
class Handle:
    """Opaque live-allocation identity. Exact object identity, not a pointer/capability."""

    serial: int


@dataclass
class Block:
    start: int
    capacity: int
    handle: object = None
    requested: int = 0
    alignment: int = 1


class Arena:
    """Trusted single-threaded managed byte arena; metadata lives outside the arena.

    Public operations check exact handle identity and requested-byte bounds. Direct
    attribute access/reflection is outside the contract; not an isolation boundary.
    """

    def __init__(self, capacity=256, policy="first"):
        self.capacity = integer(capacity, 32, 4096, "arena capacity")
        if self.capacity % 8:
            raise ValueError("Arena capacity must be a multiple of 8")
        if type(policy) is not str or policy not in ("first", "best"):
            raise ValueError("Unknown placement policy")
        self.policy = policy
        self._bytes = bytearray(self.capacity)
        self._blocks = [Block(0, self.capacity)]
        self._serial = 0

    def _shape(self, size, alignment):
        integer(size, 1, self.capacity, "requested size")
        integer(alignment, 1, 64, "alignment")
        if alignment & (alignment - 1):
            raise ValueError("Alignment must be a power of two")
        return (size + 7) // 8 * 8

    def _slot(self, capacity, alignment):
        candidates = []
        for i, b in enumerate(self._blocks):
            if b.handle is not None:
                continue
            start = (b.start + alignment - 1) // alignment * alignment
            if start + capacity <= b.start + b.capacity:
                candidates.append((b.capacity, i, start))
                if self.policy == "first":
                    break
        if not candidates:
            raise MemoryError("No aligned contiguous span fits")
        _, index, start = min(candidates, key=lambda x: (x[0], x[2]))
        return index, start

    def _new_handle(self):
        if self._serial >= 65535:
            raise RuntimeError("Handle issuance limit reached; create a new arena")
        self._serial += 1
        return Handle(self._serial)

    def _find(self, handle):
        if type(handle) is not Handle:
            raise ValueError("Invalid or stale handle")
        for i, b in enumerate(self._blocks):
            if b.handle is handle:
                return i, b
        raise ValueError("Invalid or stale handle")

    def _coalesce(self):
        merged = []
        for b in self._blocks:
            if merged and merged[-1].handle is None and b.handle is None:
                merged[-1].capacity += b.capacity
            else:
                merged.append(b)
        self._blocks = merged

    def _place(self, index, start, capacity, size, alignment, handle):
        free = self._blocks[index]
        parts = []
        if start > free.start:
            parts.append(Block(free.start, start - free.start))
        parts.append(Block(start, capacity, handle, size, alignment))
        end = start + capacity
        limit = free.start + free.capacity
        if end < limit:
            parts.append(Block(end, limit - end))
        self._blocks[index : index + 1] = parts
        self._bytes[start:end] = bytes(capacity)

    def allocate(self, size, alignment=8):
        capacity = self._shape(size, alignment)
        index, start = self._slot(capacity, alignment)
        handle = self._new_handle()
        self._place(index, start, capacity, size, alignment, handle)
        return handle

    def _range(self, b, offset, length):
        integer(offset, 0, b.requested, "offset")
        integer(length, 0, b.requested, "length")
        if length > b.requested - offset:
            raise ValueError("Access exceeds requested bytes")
        return b.start + offset, b.start + offset + length

    def write(self, handle, offset, data):
        _, b = self._find(handle)
        if type(data) not in (bytes, bytearray):
            raise ValueError("Write needs bytes or bytearray")
        # Check source length before copying; no full-arena/raw buffer exposure.
        start, end = self._range(b, offset, len(data))
        self._bytes[start:end] = data

    def read(self, handle, offset=0, length=None):
        _, b = self._find(handle)
        length = (
            b.requested - offset if length is None and type(offset) is int else length
        )
        start, end = self._range(b, offset, length)
        return bytes(self._bytes[start:end])

    def free(self, handle):
        _, b = self._find(handle)
        self._bytes[b.start : b.start + b.capacity] = bytes(b.capacity)
        b.handle = None
        b.requested = 0
        b.alignment = 1
        self._coalesce()

    def resize(self, handle, size):
        """Success always returns a fresh handle; all aliases of the old one go stale.

        Shrink/equal/in-place expansion retain offset. Otherwise allocate while old
        stays live, copy min(old,new) requested bytes, then free old. Failure leaves
        bytes, layout, serial and handle validity unchanged.
        """
        index, b = self._find(handle)
        capacity = self._shape(size, b.alignment)
        if self._serial >= 65535:
            raise RuntimeError("Handle issuance limit reached; create a new arena")
        if capacity <= b.capacity:
            old_end = b.start + b.capacity
            new_end = b.start + capacity
            self._bytes[b.start + min(size, b.requested) : old_end] = bytes(
                old_end - b.start - min(size, b.requested)
            )
            old = b.capacity
            b.capacity = capacity
            b.requested = size
            b.handle = self._new_handle()
            if capacity < old:
                self._blocks.insert(index + 1, Block(new_end, old - capacity))
                self._coalesce()
            return b.handle
        if index + 1 < len(self._blocks):
            right = self._blocks[index + 1]
            extra = capacity - b.capacity
            if right.handle is None and right.capacity >= extra:
                self._bytes[b.start + b.requested : b.start + capacity] = bytes(
                    capacity - b.requested
                )
                right.start += extra
                right.capacity -= extra
                if not right.capacity:
                    self._blocks.pop(index + 1)
                b.capacity = capacity
                b.requested = size
                b.handle = self._new_handle()
                return b.handle
        target, start = self._slot(capacity, b.alignment)
        # All fallible semantic checks happen before any effect.
        data = bytes(self._bytes[b.start : b.start + min(b.requested, size)])
        new = self._new_handle()
        self._place(target, start, capacity, size, b.alignment, new)
        self.write(new, 0, data)
        self.free(handle)
        return new

    def reset(self):
        """Zero bytes and invalidate live handles without reusing serials."""
        self._bytes[:] = bytes(self.capacity)
        self._blocks = [Block(0, self.capacity)]

    def inspect(self):
        blocks = []
        for b in self._blocks:
            blocks.append(
                {
                    "start": b.start,
                    "capacity": b.capacity,
                    "id": None if b.handle is None else b.handle.serial,
                    "requested": b.requested,
                    "alignment": b.alignment,
                    "hex": (
                        None
                        if b.handle is None
                        else self._bytes[b.start : b.start + b.requested].hex()
                    ),
                }
            )
        free = [b.capacity for b in self._blocks if b.handle is None]
        reserved = sum(b.capacity for b in self._blocks if b.handle is not None)
        requested = sum(b.requested for b in self._blocks)
        return {
            "capacity": self.capacity,
            "policy": self.policy,
            "issued": self._serial,
            "blocks": blocks,
            "free": sum(free),
            "largest": max(free, default=0),
            "reserved": reserved,
            "requested": requested,
            "padding": reserved - requested,
        }

    def check(self):
        """Independent structural and byte invariants, raises on internal corruption."""
        cursor = 0
        previous_free = False
        seen = set()
        for b in self._blocks:
            if not (b.start == cursor and b.capacity > 0 and b.capacity % 8 == 0):
                raise RuntimeError("Arena invariant failed")
            cursor += b.capacity
            if b.handle is None:
                if (
                    previous_free
                    or b.requested != 0
                    or any(self._bytes[b.start : cursor])
                ):
                    raise RuntimeError("Free span invariant failed")
                previous_free = True
            else:
                if (
                    b.handle.serial in seen
                    or b.start % b.alignment
                    or not 1 <= b.requested <= b.capacity
                ):
                    raise RuntimeError("Live span invariant failed")
                if any(self._bytes[b.start + b.requested : cursor]):
                    raise RuntimeError("Live span invariant failed")
                seen.add(b.handle.serial)
                previous_free = False
        if cursor != self.capacity or len(self._bytes) != self.capacity:
            raise RuntimeError("Partition invariant failed")
        return True
