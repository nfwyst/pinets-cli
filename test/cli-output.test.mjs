import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createFixture, runCli } from "./cli-fixture.mjs";

test("clean output removes non-values and hides internal plots", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = runCli([
    "run",
    fixture.indicatorPath,
    "--data",
    fixture.candlesPath,
    "--candles",
    "6",
    "--clean",
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output.plots), ["SMA", "Up", "Zero"]);
  assert.equal(output.plots.SMA.data.length, 4);
  assert.ok(output.plots.SMA.data.every((entry) => Number.isFinite(entry.value)));
  assert.deepEqual(
    output.plots.Up.data.map((entry) => entry.value),
    [true, true, true],
  );
  assert.equal(output.plots.Zero.data.length, 6);
});

test("default output hides PineTS internal plots", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = runCli([
    "run",
    fixture.indicatorPath,
    "--data",
    fixture.candlesPath,
    "--candles",
    "1",
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output.plots), ["SMA", "Up", "Zero"]);
});

test("default output preserves user plots with double-underscore titles", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);
  const indicatorPath = path.join(fixture.directory, "custom-title.pine");
  writeFileSync(
    indicatorPath,
    [
      "//@version=5",
      'indicator("Custom Title")',
      'plot(close, "__custom")',
      'plot(open, "Open")',
      "",
    ].join("\n"),
  );

  // When
  const result = runCli([
    "run",
    indicatorPath,
    "--data",
    fixture.candlesPath,
    "--candles",
    "1",
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output.plots), ["__custom", "Open"]);
});

test("debug mode emits transpiled code without corrupting JSON stdout", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = runCli([
    "run",
    fixture.indicatorPath,
    "--data",
    fixture.candlesPath,
    "--candles",
    "1",
    "--debug",
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 0);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.ok(result.stderr.length > 0);
});

test("full output keeps the requested market-data window", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = runCli([
    "run",
    fixture.indicatorPath,
    "--data",
    fixture.candlesPath,
    "--candles",
    "2",
    "--format",
    "full",
    "--plots",
    "SMA",
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.marketData.length, 2);
  assert.deepEqual(Object.keys(output.plots), ["SMA"]);
});

test("unknown plot filters fail instead of returning empty success", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = runCli([
    "run",
    fixture.indicatorPath,
    "--data",
    fixture.candlesPath,
    "--plots",
    "Missing",
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("empty plot filters fail with selectable plot names", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = runCli([
    "run",
    fixture.indicatorPath,
    "--data",
    fixture.candlesPath,
    "--plots",
    "",
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  for (const plotName of ["SMA", "Up", "Zero"]) {
    assert.ok(result.stderr.includes(plotName), plotName);
  }
});
