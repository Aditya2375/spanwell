// Original managed byte arena. Relative offsets are never host pointers.
function integer(v, lo, hi, label) {
  if (!Number.isInteger(v) || v < lo || v > hi)
    throw Error(`${label} must be an integer in ${lo}..${hi}`);
  return v;
}
export class Arena {
  constructor(capacity = 256, policy = "first") {
    this.capacity = integer(capacity, 32, 4096, "arena capacity");
    if (capacity % 8) throw Error("Arena capacity must be a multiple of 8");
    if (!["first", "best"].includes(policy))
      throw Error("Unknown placement policy");
    this.policy = policy;
    this.bytes = new Uint8Array(capacity);
    this.blocks = [this.block(0, capacity)];
    this.serial = 0;
  }
  block(start, capacity, handle = null, requested = 0, alignment = 1) {
    return { start, capacity, handle, requested, alignment };
  }
  shape(size, alignment) {
    integer(size, 1, this.capacity, "requested size");
    integer(alignment, 1, 64, "alignment");
    if (alignment & (alignment - 1))
      throw Error("Alignment must be a power of two");
    return Math.ceil(size / 8) * 8;
  }
  slot(capacity, alignment) {
    const candidates = [];
    this.blocks.some((b, i) => {
      if (b.handle !== null) return false;
      const start = Math.ceil(b.start / alignment) * alignment;
      if (start + capacity <= b.start + b.capacity) {
        candidates.push([b.capacity, i, start]);
        return this.policy === "first";
      }
      return false;
    });
    if (!candidates.length) throw Error("No aligned contiguous span fits");
    candidates.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    return [candidates[0][1], candidates[0][2]];
  }
  newHandle() {
    if (this.serial >= 65535)
      throw Error("Handle issuance limit reached; create a new arena");
    return Object.freeze({ serial: ++this.serial });
  }
  find(handle) {
    const i = this.blocks.findIndex(
      (b) => b.handle !== null && b.handle === handle,
    );
    if (i < 0) throw Error("Invalid or stale handle");
    return [i, this.blocks[i]];
  }
  coalesce() {
    const merged = [];
    for (const b of this.blocks) {
      if (merged.length && merged.at(-1).handle === null && b.handle === null)
        merged.at(-1).capacity += b.capacity;
      else merged.push(b);
    }
    this.blocks = merged;
  }
  place(index, start, capacity, size, alignment, handle) {
    const free = this.blocks[index],
      parts = [];
    if (start > free.start)
      parts.push(this.block(free.start, start - free.start));
    parts.push(this.block(start, capacity, handle, size, alignment));
    const end = start + capacity,
      limit = free.start + free.capacity;
    if (end < limit) parts.push(this.block(end, limit - end));
    this.blocks.splice(index, 1, ...parts);
    this.bytes.fill(0, start, end);
  }
  allocate(size, alignment = 8) {
    const cap = this.shape(size, alignment),
      [i, start] = this.slot(cap, alignment),
      h = this.newHandle();
    this.place(i, start, cap, size, alignment, h);
    return h;
  }
  range(b, offset, length) {
    integer(offset, 0, b.requested, "offset");
    integer(length, 0, b.requested, "length");
    if (length > b.requested - offset)
      throw Error("Access exceeds requested bytes");
    return [b.start + offset, b.start + offset + length];
  }
  write(handle, offset, data) {
    const [, b] = this.find(handle);
    if (!(data instanceof Uint8Array)) throw Error("Write needs Uint8Array");
    const [start] = this.range(b, offset, data.length);
    this.bytes.set(data, start);
  }
  read(handle, offset = 0, length = undefined) {
    const [, b] = this.find(handle);
    if (length === undefined || length === null) length = b.requested - offset;
    const [start, end] = this.range(b, offset, length);
    return this.bytes.slice(start, end);
  }
  free(handle) {
    const [, b] = this.find(handle);
    this.bytes.fill(0, b.start, b.start + b.capacity);
    b.handle = null;
    b.requested = 0;
    b.alignment = 1;
    this.coalesce();
  }
  resize(handle, size) {
    const [index, b] = this.find(handle),
      capacity = this.shape(size, b.alignment);
    if (this.serial >= 65535)
      throw Error("Handle issuance limit reached; create a new arena");
    if (capacity <= b.capacity) {
      const oldEnd = b.start + b.capacity,
        newEnd = b.start + capacity;
      this.bytes.fill(0, b.start + Math.min(size, b.requested), oldEnd);
      const old = b.capacity;
      b.capacity = capacity;
      b.requested = size;
      b.handle = this.newHandle();
      if (capacity < old) {
        this.blocks.splice(index + 1, 0, this.block(newEnd, old - capacity));
        this.coalesce();
      }
      return b.handle;
    }
    if (index + 1 < this.blocks.length) {
      const right = this.blocks[index + 1],
        extra = capacity - b.capacity;
      if (right.handle === null && right.capacity >= extra) {
        this.bytes.fill(0, b.start + b.requested, b.start + capacity);
        right.start += extra;
        right.capacity -= extra;
        if (!right.capacity) this.blocks.splice(index + 1, 1);
        b.capacity = capacity;
        b.requested = size;
        b.handle = this.newHandle();
        return b.handle;
      }
    }
    const [target, start] = this.slot(capacity, b.alignment),
      data = this.bytes.slice(b.start, b.start + Math.min(b.requested, size)),
      fresh = this.newHandle();
    this.place(target, start, capacity, size, b.alignment, fresh);
    this.write(fresh, 0, data);
    this.free(handle);
    return fresh;
  }
  reset() {
    this.bytes.fill(0);
    this.blocks = [this.block(0, this.capacity)];
  }
  inspect() {
    const blocks = this.blocks.map((b) => ({
      start: b.start,
      capacity: b.capacity,
      id: b.handle === null ? null : b.handle.serial,
      requested: b.requested,
      alignment: b.alignment,
      hex:
        b.handle === null
          ? null
          : Array.from(this.bytes.slice(b.start, b.start + b.requested), (v) =>
              v.toString(16).padStart(2, "0"),
            ).join(""),
    }));
    const free = this.blocks
        .filter((b) => b.handle === null)
        .map((b) => b.capacity),
      reserved = this.blocks.reduce(
        (n, b) => n + (b.handle === null ? 0 : b.capacity),
        0,
      ),
      requested = this.blocks.reduce((n, b) => n + b.requested, 0);
    return {
      capacity: this.capacity,
      policy: this.policy,
      issued: this.serial,
      blocks,
      free: free.reduce((a, b) => a + b, 0),
      largest: Math.max(0, ...free),
      reserved,
      requested,
      padding: reserved - requested,
    };
  }
  check() {
    let cursor = 0,
      previousFree = false;
    const seen = new Set();
    for (const b of this.blocks) {
      if (b.start !== cursor || b.capacity <= 0 || b.capacity % 8)
        throw Error("Arena invariant failed");
      cursor += b.capacity;
      if (b.handle === null) {
        if (
          previousFree ||
          b.requested !== 0 ||
          this.bytes.slice(b.start, cursor).some((x) => x !== 0)
        )
          throw Error("Free span invariant failed");
        previousFree = true;
      } else {
        if (
          seen.has(b.handle.serial) ||
          b.start % b.alignment ||
          b.requested < 1 ||
          b.requested > b.capacity ||
          this.bytes.slice(b.start + b.requested, cursor).some((x) => x !== 0)
        )
          throw Error("Live span invariant failed");
        seen.add(b.handle.serial);
        previousFree = false;
      }
    }
    if (cursor !== this.capacity || this.bytes.length !== this.capacity)
      throw Error("Partition invariant failed");
    return true;
  }
}
export function execute(program) {
  if (
    !program ||
    typeof program !== "object" ||
    Array.isArray(program) ||
    Object.keys(program).sort().join(",") !== "capacity,operations,policy"
  )
    throw Error("Expected capacity, policy, operations");
  if (!Array.isArray(program.operations) || program.operations.length > 256)
    throw Error("At most 256 operations");
  const a = new Arena(program.capacity, program.policy),
    handles = new Map(),
    results = [],
    shapes = {
      alloc: ["op", "name", "size", "alignment"],
      resize: ["op", "name", "size"],
      free: ["op", "name"],
      read: ["op", "name", "offset", "length"],
      write: ["op", "name", "offset", "hex"],
      reset: ["op"],
    };
  for (const row of Array.from(program.operations)) {
    try {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        !Object.hasOwn(shapes, row.op) ||
        Object.keys(row).sort().join(",") !==
          [...shapes[row.op]].sort().join(",")
      )
        throw Error("Invalid operation shape");
      const op = row.op,
        name = row.name;
      if (
        op !== "reset" &&
        (typeof name !== "string" ||
          name.length < 1 ||
          name.length > 8 ||
          /[^A-Z0-9]/.test(name))
      )
        throw Error("Use a short uppercase handle name");
      let result = null;
      if (op === "alloc") {
        if (handles.has(name)) throw Error("Handle name already used");
        const h = a.allocate(row.size, row.alignment);
        handles.set(name, h);
        result = h.serial;
      } else if (op === "reset") a.reset();
      else {
        if (!handles.has(name)) throw Error("Unknown handle name");
        const h = handles.get(name);
        if (op === "resize") {
          const fresh = a.resize(h, row.size);
          handles.set(name, fresh);
          result = fresh.serial;
        } else if (op === "free") a.free(h);
        else if (op === "read")
          result = Array.from(a.read(h, row.offset, row.length), (v) =>
            v.toString(16).padStart(2, "0"),
          ).join("");
        else if (op === "write") {
          const text = row.hex;
          if (
            typeof text !== "string" ||
            text.length > 8192 ||
            text.length % 2 ||
            /[^0-9a-fA-F]/.test(text)
          )
            throw Error("Write needs even hex digits, at most 4096 bytes");
          a.write(
            h,
            row.offset,
            Uint8Array.from(text.match(/../g) || [], (x) => parseInt(x, 16)),
          );
        }
      }
      a.check();
      results.push({ ok: true, result, state: a.inspect() });
    } catch (error) {
      results.push({ ok: false, error: error.message, state: a.inspect() });
    }
  }
  return results;
}
