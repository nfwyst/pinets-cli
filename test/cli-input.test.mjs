import assert from "node:assert/strict";
import test from "node:test";

import { createFixture, runCli } from "./cli-fixture.mjs";

test("rejects malformed integer options", (context) => {
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
    "2x",
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("rejects unsupported output formats", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = runCli([
    "run",
    fixture.indicatorPath,
    "--data",
    fixture.candlesPath,
    "--format",
    "yaml",
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("rejects empty indicator files", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = runCli([
    "run",
    fixture.emptyIndicatorPath,
    "--data",
    fixture.candlesPath,
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("rejects missing fields on every candle", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = runCli([
    "run",
    fixture.indicatorPath,
    "--data",
    fixture.missingFieldPath,
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("rejects non-numeric candle fields", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = runCli([
    "run",
    fixture.indicatorPath,
    "--data",
    fixture.wrongTypePath,
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("rejects unsupported timeframes before requesting market data", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = runCli([
    "run",
    fixture.indicatorPath,
    "--symbol",
    "BTCUSDT",
    "--timeframe",
    "definitely-not-a-timeframe",
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("rejects Binance seconds timeframes before requesting market data", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = runCli([
    "run",
    fixture.indicatorPath,
    "--symbol",
    "BTCUSDT",
    "--timeframe",
    "1S",
    "--quiet",
  ]);

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unsupported timeframe: 1S/);
  assert.doesNotMatch(result.stderr, /data provider returned no market data/);
});

for (const timeframe of ["3M", "6M", "12M"]) {
  test(`accepts documented ${timeframe} timeframe before requesting market data`, (context) => {
    // Given
    const fixture = createFixture();
    context.after(fixture.cleanup);

    // When
    const result = runCli(
      [
        "run",
        fixture.indicatorPath,
        "--symbol",
        "BTCUSDT",
        "--timeframe",
        timeframe,
        "--quiet",
      ],
      { env: { PINETS_TEST_MARKET_FAILURE: "1" } },
    );

    // Then
    assert.equal(result.status, 1, timeframe);
    assert.equal(result.stdout, "", timeframe);
    assert.doesNotMatch(result.stderr, /Unsupported timeframe:/, timeframe);
    assert.match(result.stderr, /HTTP error! status: 400/, timeframe);
  });
}

for (const timeframe of ["12m", "13M"]) {
  test(`rejects unsupported ${timeframe} timeframe before requesting market data`, (context) => {
    // Given
    const fixture = createFixture();
    context.after(fixture.cleanup);

    // When
    const result = runCli([
      "run",
      fixture.indicatorPath,
      "--symbol",
      "BTCUSDT",
      "--timeframe",
      timeframe,
      "--quiet",
    ]);

    // Then
    assert.equal(result.status, 1, timeframe);
    assert.equal(result.stdout, "", timeframe);
    assert.match(result.stderr, new RegExp(`Unsupported timeframe: ${timeframe}`));
    assert.doesNotMatch(result.stderr, /data provider returned no market data/, timeframe);
  });
}

test("returns a failure exit code when the market provider fails", (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = runCli(
    [
      "run",
      fixture.indicatorPath,
      "--symbol",
      "NOTAREALSYMBOL",
      "--timeframe",
      "60",
      "--quiet",
    ],
    { env: { PINETS_TEST_MARKET_FAILURE: "1" } },
  );

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});
