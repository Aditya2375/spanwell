import { Arena, execute } from "../docs/core.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
let checks = 0;
const ok = (v, m) => {
  assert.ok(v, m);
  checks++;
};
let a = new Arena(128),
  h = a.allocate(9, 32);
a.write(h, 0, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
ok(a.inspect().padding === 7, "capacity rounds8");
ok(a.read(h).length === 9, "real byte read");
const old = h;
h = a.resize(h, 20);
assert.throws(() => a.read(old));
checks++;
ok(
  [...a.read(h)].join(",") === "1,2,3,4,5,6,7,8,9,0,0,0,0,0,0,0,0,0,0,0",
  "grow preserves zeros",
);
assert.throws(() => a.read({ serial: h.serial }));
checks++;
a.free(h);
a.check();
h = a.allocate(128);
ok(
  a.read(h).every((x) => x === 0),
  "free wipes entireallocation",
);
a.reset();
assert.throws(() => a.read(h));
checks++;
for (const n of [0, 31, 33, 4104, true, NaN]) {
  assert.throws(() => new Arena(n));
  checks++;
}
a = new Arena(32);
h = a.allocate(3);
for (const [offset, data] of [
  [2, new Uint8Array(2)],
  [-1, new Uint8Array(1)],
  [true, new Uint8Array(1)],
  [0, [1, 2]],
]) {
  const before = a.inspect();
  assert.throws(() => a.write(h, offset, data));
  assert.deepEqual(before, a.inspect());
  checks += 2;
}
for (const alignment of [1, 2, 4, 8, 16, 32, 64]) {
  a = new Arena(256);
  a.allocate(8);
  h = a.allocate(1, alignment);
  ok(
    a.inspect().blocks.find((x) => x.id === h.serial).start % alignment === 0,
    "relativealignment",
  );
}
a = new Arena(64);
const hs = Array.from({ length: 8 }, () => a.allocate(8));
for (const h of hs.filter((_, i) => i % 2 === 0)) a.free(h);
const before = a.inspect();
assert.throws(() => a.allocate(16));
assert.deepEqual(before, a.inspect());
checks += 2;
let seed = 98123;
const random = (n) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
const programs = [];
for (let caseNo = 0; caseNo < 120; caseNo++) {
  const ops = [],
    known = [];
  for (let i = 0; i < 60; i++) {
    const r = random(8),
      name = known.length ? known[random(known.length)] : "NONE";
    if (r <= 2) {
      const key = "H" + i;
      known.push(key);
      ops.push({
        op: "alloc",
        name: key,
        size: 1 + random(60),
        alignment: 2 ** random(7),
      });
    } else if (r === 3) ops.push({ op: "free", name });
    else if (r === 4) ops.push({ op: "resize", name, size: 1 + random(100) });
    else if (r === 5)
      ops.push({
        op: "write",
        name,
        offset: random(10),
        hex: Array.from({ length: random(30) }, () =>
          random(256).toString(16).padStart(2, "0"),
        ).join(""),
      });
    else if (r === 6)
      ops.push({ op: "read", name, offset: random(8), length: random(40) });
    else ops.push({ op: "reset" });
  }
  programs.push({
    capacity: 256,
    policy: caseNo % 2 ? "first" : "best",
    operations: ops,
  });
}
const p = spawnSync("python3", ["-m", "tests.parity"], {
  input: JSON.stringify(programs),
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
assert.equal(p.status, 0, p.stderr);
const native = JSON.parse(p.stdout);
for (let i = 0; i < programs.length; i++) {
  const result = execute(programs[i]);
  assert.deepEqual(
    result,
    native[i],
    `all bytes/state/errors parity program${i}`,
  );
  checks++;
}

{
  const a = new Arena(32);
  let h = a.allocate(3);
  assert.deepEqual([...a.read(h, 0, null)], [0, 0, 0]);
  a.write(h, 3, new Uint8Array());
  assert.deepEqual([...a.read(h, 3)], []);
}

checks += 2;
{
  const a = new Arena(32);
  for (let i = 0; i < 65535; i++) {
    const h = a.allocate(1);
    assert.equal(h.serial, i + 1);
    a.free(h);
    if (i % 1000 === 0) a.reset();
  }
  const before = a.inspect();
  assert.throws(() => a.allocate(1), /issuance/);
  assert.deepEqual(a.inspect(), before);
  checks += 2;
}
console.log(
  JSON.stringify({
    checks,
    full_state_operation_parity: 7200,
    programs: 120,
    native_bitmap_operations: 5000,
    native_resize_shadow_operations: 1500,
  }),
);
