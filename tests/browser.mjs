import { chromium } from "playwright";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
const base = process.env.BASE_URL || "http://127.0.0.1:8349/";
let server;
if (!process.env.BASE_URL) {
  server = spawn(
    "python3",
    ["-m", "http.server", "8349", "--bind", "127.0.0.1", "--directory", "docs"],
    { stdio: "ignore" },
  );
  await new Promise((r) => setTimeout(r, 700));
}
const browser = await chromium.launch({ headless: true });
let checks = 0;
const ok = (v, msg) => {
  assert.ok(v, msg);
  checks++;
};
await mkdir("/tmp/spanwell-shots", { recursive: true });
try {
  for (const width of [1440, 1024, 768, 390, 320]) {
    const page = await browser.newPage({
      viewport: { width, height: 1000 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    const failures = [];
    page.on("requestfailed", (r) => failures.push(r.url()));
    const thirdParty = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(base)) thirdParty.push(r.url());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(base);
    await page.waitForSelector("#status");
    await page.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("live"),
    );
    ok((await page.locator("#free").innerText()) === "256 B", "initial free");
    ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "no horizontal page overflow " + width,
    );
    await page.screenshot({
      path: `/tmp/spanwell-shots/hero-${width}.png`,
      fullPage: false,
    });
    await page.locator("#allocate").click();
    ok(
      (await page.locator("#status").innerText()).includes("1 live"),
      "allocate actual",
    );
    ok(
      (await page.locator("#requested").innerText()).includes("24"),
      "request metric",
    );
    await page.locator("#write").click();
    await page.locator("#read").click();
    ok(
      (await page.locator("#readback").innerText()).startsWith(
        "48 65 6c 6c 6f 20 62 79 74 65 73",
      ),
      "byte roundtrip",
    );
    ok(
      (await page.locator("#readback").innerText()).endsWith("00 00"),
      "zero initialized remainder",
    );
    await page.locator("#hex").fill("ff");
    ok(
      (await page.locator("#readback").innerText()) === "No read yet.",
      "clear readback on edit",
    );
    await page.locator("#offset").fill("24");
    await page.locator("#write").click();
    ok(
      (await page.locator("#error").innerText()).includes("exceeds"),
      "requested boundary",
    );
    await page.locator("#read").click();
    ok(
      (await page.locator("#readback").innerText()).startsWith("48 65"),
      "failed write atomic",
    );
    await page.locator("#resize-size").fill("40");
    await page.locator("#resize").click();
    ok(
      (await page.locator("#handle").innerText()).includes("H2"),
      "fresh resize handle",
    );
    await page.locator("#read").click();
    ok(
      (await page.locator("#readback").innerText()).startsWith("48 65"),
      "resize preserves bytes",
    );
    ok(
      (await page.locator("#readback").innerText()).split(" ").length === 40,
      "new requested length",
    );
    await page.locator("#free-span").click();
    ok((await page.locator("#free").innerText()) === "256 B", "coalesces");
    ok(await page.locator("#read").isDisabled(), "no stale UI handle");
    await page.locator("#size").fill("5");
    await page.locator("#allocate").click();
    await page.locator("#read").click();
    ok(
      (await page.locator("#readback").innerText()) === "00 00 00 00 00",
      "zero reuse",
    );
    ok(
      (await page.locator("#padding").innerText()) === "3 B",
      "rounded padding",
    );
    await page.locator("#example").click();
    ok(
      (await page.locator("#free").innerText()) === "128 B",
      "fragmented total",
    );
    ok(
      (await page.locator("#largest").innerText()) === "32 B",
      "fragmented largest",
    );
    await page.locator("#size").fill("64");
    await page.locator("#allocate").click();
    ok(
      (await page.locator("#error").innerText()).includes("No aligned"),
      "fragmented OOM",
    );
    ok((await page.locator("#free").innerText()) === "128 B", "OOM atomic");
    ok(
      (await page.locator("#handle option").count()) === 4,
      "OOM handles unchanged",
    );
    const before = await page.locator("#status").innerText();
    await page.locator("#policy").selectOption("best");
    ok(
      await page.locator("#dirty").isVisible(),
      "pending configuration warning",
    );
    ok(
      await page.locator("#allocate").isDisabled(),
      "configuration blocks alloc",
    );
    ok(
      await page.locator("#read").isDisabled(),
      "configuration blocks stale reads",
    );
    ok(
      (await page.locator("#status").innerText()) === before,
      "configuration nonmutating",
    );
    await page.locator("#reset").click();
    ok((await page.locator("#free").innerText()) === "256 B", "reset");
    await page.locator("#size").fill("9");
    await page.locator("#alignment").selectOption("64");
    await page.locator("#allocate").click();
    await page.locator("#arena button").first().click();
    ok(
      (await page.locator("#selection-detail").innerText()).includes(
        "alignment 64",
      ),
      "alignment detail",
    );
    ok(
      (await page.locator("#padding").innerText()) === "7 B",
      "padding metric",
    );
    await page.locator("#size").fill("1e2");
    await page.locator("#allocate").click();
    ok(
      (await page.locator("#error").innerText()).includes("whole decimal"),
      "strict number",
    );
    await page.locator("#size").fill("16");
    await page.locator("#allocate").click();
    ok((await page.locator("#handle option").count()) === 2, "two blocks");
    await page.locator("#arena button").last().click();
    ok(
      (await page.locator("#selection-title").innerText()).includes("FREE"),
      "free inspection",
    );
    await page.locator("#lab").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/spanwell-shots/lab-${width}.png`,
      fullPage: true,
    });
    ok(failures.length === 0, "no failed requests");
    ok(thirdParty.length === 0, "no third-party requests");
    ok(
      await page.evaluate(
        () =>
          localStorage.length === 0 &&
          sessionStorage.length === 0 &&
          document.cookie === "",
      ),
      "no storage or cookies",
    );
    ok(errors.length === 0, "no console/page errors " + errors.join(";"));
    await page.close();
  }
  console.log(`${checks} browser checks across 5 widths PASS`);
} finally {
  await browser.close();
  if (server) server.kill();
}
