import { Arena } from "./core.js";
const $ = (s) => document.querySelector(s),
  colors = [
    "#c1d3ac",
    "#e4d69e",
    "#b8cbd6",
    "#d7c2ad",
    "#c9bfdb",
    "#b8d4c3",
    "#e0c2b7",
    "#bdc99d",
  ];
let arena = null,
  handles = new Map(),
  selection = null,
  dirty = false,
  journal = [],
  opCount = 0;
function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function number(value) {
  if (!/^\d+$/.test(value))
    throw Error(
      "Use whole decimal numbers, not blank, signed or fractional values.",
    );
  return Number(value);
}
function hexBytes(text) {
  const clean = text.replaceAll(" ", "");
  if (clean.length % 2 || /[^0-9a-fA-F]/.test(clean) || clean.length > 8192)
    throw Error("Use pairs of hex digits, up to 4096 bytes.");
  return Uint8Array.from(clean.match(/../g) || [], (x) => parseInt(x, 16));
}
function clearRead() {
  $("#readback").textContent = "No read yet.";
}
function record(text, failure = false) {
  journal.unshift({ n: ++opCount, text, failure });
  journal = journal.slice(0, 40);
  $("#journal").replaceChildren(
    ...journal.map((row) =>
      el(
        "li",
        `${String(row.n).padStart(2, "0")} / ${row.text}`,
        row.failure ? "failure" : "",
      ),
    ),
  );
}
function action(work) {
  if (dirty) return;
  try {
    work();
    arena.check();
    $("#error").textContent = "";
    render();
  } catch (error) {
    $("#error").textContent = error.message;
    record(error.message, true);
    render();
  }
}
function selectedHandle() {
  const id = Number($("#handle").value);
  if (!handles.has(id)) throw Error("Select a live allocation.");
  return handles.get(id);
}
function inspect(block) {
  selection =
    block.id === null ? { start: block.start, id: null } : { id: block.id };
  $("#selection-title").textContent =
    block.id === null
      ? `FREE / [${block.start}, ${block.start + block.capacity})`
      : `H${block.id} / [${block.start}, ${block.start + block.capacity})`;
  $("#selection-detail").textContent =
    block.id === null
      ? `${block.capacity} contiguous free bytes. Alignment may reduce the usable span.`
      : `${block.requested} requested, ${block.capacity} reserved, ${block.capacity - block.requested} padding bytes. Relative alignment ${block.alignment}.`;
  if (block.id !== null) {
    const changed = $("#handle").value !== String(block.id);
    $("#handle").value = String(block.id);
    if (changed) clearRead();
  }
  for (const button of document.querySelectorAll(".span"))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.start === String(block.start)),
    );
}
function render() {
  if (!arena) return;
  const state = arena.inspect();
  $("#status").textContent =
    `${state.capacity} bytes / ${handles.size} live spans`;
  $("#range").textContent = `0 → ${state.capacity} bytes`;
  for (const [id, value] of [
    ["requested", state.requested],
    ["free", state.free],
    ["largest", state.largest],
    ["padding", state.padding],
  ])
    $("#" + id).replaceChildren(
      document.createTextNode(value + " "),
      el("small", "B"),
    );
  $("#invariants").textContent = arena.check()
    ? "Partition checked"
    : "Invariant failed";
  const old = $("#handle").value;
  $("#handle").replaceChildren();
  for (const [id] of handles) {
    const b = state.blocks.find((x) => x.id === id);
    if (!b) continue;
    const option = el(
      "option",
      `H${id} · ${b.requested} B at offset ${b.start}`,
    );
    option.value = String(id);
    $("#handle").append(option);
  }
  if ([...$("#handle").options].some((o) => o.value === old))
    $("#handle").value = old;
  const map = $("#arena");
  map.replaceChildren();
  const freeCount = state.blocks.length;
  for (const block of state.blocks) {
    const button = el(
      "button",
      undefined,
      "span" + (block.id === null ? " free" : ""),
    );
    button.type = "button";
    button.style.width = `calc((100% - ${(freeCount - 1) * 2}px) * ${block.capacity / state.capacity})`;
    button.style.setProperty(
      "--task",
      block.id === null ? "#edf2e7" : colors[(block.id - 1) % colors.length],
    );
    button.dataset.start = block.start;
    button.setAttribute(
      "aria-label",
      block.id === null
        ? `Free span offset ${block.start}, ${block.capacity} bytes`
        : `H${block.id}, offset ${block.start}, ${block.requested} requested, ${block.capacity} capacity`,
    );
    button.setAttribute("aria-pressed", "false");
    button.append(
      el("b", block.id === null ? "free" : `H${block.id}`),
      el("span", `${block.capacity} B`),
    );
    if (block.id !== null && block.capacity > block.requested) {
      const pad = el("span", undefined, "pad-mark");
      pad.style.width =
        ((block.capacity - block.requested) / block.capacity) * 100 + "%";
      button.append(pad);
    }
    button.addEventListener("click", () => inspect(block));
    map.append(button);
  }
  const ledger = $("#ledger");
  ledger.replaceChildren();
  for (const block of state.blocks) {
    const card = el("div", undefined, "ledger-card"),
      identity = el("div", undefined, "identity"),
      badge = el("span", block.id === null ? "·" : String(block.id), "badge");
    badge.style.setProperty(
      "--task",
      block.id === null ? "#e7ecdf" : colors[(block.id - 1) % colors.length],
    );
    const desc = el("div");
    desc.append(
      el("strong", block.id === null ? "Free" : `H${block.id} live`),
      el("small", `[${block.start}, ${block.start + block.capacity})`),
    );
    identity.append(badge, desc);
    const size = el("div");
    size.append(
      el("strong", `${block.capacity} B reserved`),
      el(
        "small",
        block.id === null
          ? "available for reuse"
          : `${block.requested} B payload`,
      ),
    );
    const meta = el("div");
    meta.append(
      el(
        "strong",
        block.id === null
          ? "No handle"
          : `${block.capacity - block.requested} B padding`,
      ),
      el(
        "small",
        block.id === null
          ? "zeroed bytes"
          : `relative align ${block.alignment}`,
      ),
    );
    card.append(identity, size, meta);
    ledger.append(card);
  }
  if (selection) {
    const found = state.blocks.find((b) =>
      selection.id === null
        ? b.id === null && b.start === selection.start
        : b.id === selection.id,
    );
    if (found) inspect(found);
    else {
      selection = null;
      $("#selection-title").textContent = "Selection no longer exists";
      $("#selection-detail").textContent =
        "The span was freed, moved or merged. Select another span.";
    }
  }
  for (const id of [
    "allocate",
    "example",
    "write",
    "read",
    "resize",
    "free-span",
  ])
    $("#" + id).disabled =
      dirty || (!handles.size && !["allocate", "example"].includes(id));
  $("#handle").disabled = dirty || !handles.size;
}
function reset(
  capacity = Number($("#capacity").value),
  policy = $("#policy").value,
) {
  if (arena) arena.reset();
  arena = new Arena(capacity, policy);
  handles = new Map();
  selection = null;
  dirty = false;
  $("#dirty").hidden = true;
  $("#capacity").value = String(capacity);
  $("#policy").value = policy;
  $("#error").textContent = "";
  $("#selection-title").textContent = "No live span selected";
  $("#selection-detail").textContent =
    "Allocate a block, or select an address span.";
  clearRead();
  record(
    `Created ${capacity}-byte ${policy}-fit arena. Previous handles invalidated.`,
  );
  render();
}
$("#reset").addEventListener("click", () => reset());
for (const id of ["capacity", "policy"])
  $("#" + id).addEventListener("change", () => {
    dirty = true;
    $("#dirty").hidden = false;
    clearRead();
    render();
  });
$("#allocate-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(() => {
    const size = number($("#size").value.trim()),
      alignment = number($("#alignment").value),
      h = arena.allocate(size, alignment);
    handles.set(h.serial, h);
    selection = { id: h.serial };
    clearRead();
    record(`Allocated H${h.serial}: ${size} bytes, alignment ${alignment}.`);
  });
});
$("#handle").addEventListener("change", () => {
  clearRead();
  selection = { id: Number($("#handle").value) };
  render();
});
$("#write").addEventListener("click", () =>
  action(() => {
    const h = selectedHandle(),
      data = hexBytes($("#hex").value);
    arena.write(h, number($("#offset").value.trim()), data);
    clearRead();
    record(`Wrote ${data.length} bytes to H${h.serial}.`);
  }),
);
$("#read").addEventListener("click", () =>
  action(() => {
    const h = selectedHandle(),
      data = arena.read(h);
    $("#readback").textContent = Array.from(data, (v) =>
      v.toString(16).padStart(2, "0"),
    ).join(" ");
    record(`Read ${data.length} requested bytes from H${h.serial}.`);
  }),
);
$("#free-span").addEventListener("click", () =>
  action(() => {
    const h = selectedHandle();
    arena.free(h);
    handles.delete(h.serial);
    clearRead();
    record(`Freed H${h.serial}; span zeroed and free neighbors merged.`);
  }),
);
$("#resize").addEventListener("click", () =>
  action(() => {
    const old = selectedHandle(),
      size = number($("#resize-size").value.trim()),
      fresh = arena.resize(old, size);
    handles.delete(old.serial);
    handles.set(fresh.serial, fresh);
    selection = { id: fresh.serial };
    clearRead();
    record(
      `Resized H${old.serial} → H${fresh.serial}: ${size} bytes. Old handle invalid.`,
    );
  }),
);
$("#example").addEventListener("click", () => {
  if (dirty) return;
  const policy = $("#policy").value;
  reset(256, policy);
  const hs = Array.from({ length: 8 }, () => arena.allocate(32));
  for (let i = 0; i < hs.length; i++) {
    if (i % 2 === 0) arena.free(hs[i]);
    else handles.set(hs[i].serial, hs[i]);
  }
  selection = null;
  clearRead();
  record("Fragmented: four free 32-byte gaps; total free 128, largest 32.");
  render();
});
$("#offset").addEventListener("input", clearRead);
$("#hex").addEventListener("input", clearRead);
reset();
