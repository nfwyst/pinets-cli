import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import packageJson from "../package.json";

import {
  createFixture,
  runCli,
  runCliWithStdin,
} from "./cli-fixture.mjs";

function nextForkRevision(version) {
  const match = /^(?<base>\d+\.\d+\.\d+-nfwyst\.)(?<revision>\d+)$/.exec(
    version,
  );
  assert.ok(match?.groups);
  return `${match.groups.base}${Number(match.groups.revision) + 1}`;
}

test("partial stdin times out instead of hanging forever", async (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);

  // When
  const result = await runCliWithStdin(
    ["run", "--data", fixture.candlesPath],
    ['//@version=5\nindicator("Partial")\n'],
    {
      env: { PINETS_TEST_STDIN_TIMEOUT_MS: "100" },
      timeoutMs: 2_000,
      waitForStdinReady: true,
    },
  );

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("active stdin stays open while data keeps arriving", async (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);
  const chunks = [
    "//@version=5\n",
    'indicator("Streaming")\n',
    "value = close\n",
    'plot(value, "Close")\n',
    "// producer heartbeat 1\n",
    "// producer heartbeat 2\n",
  ];

  // When
  const result = await runCliWithStdin(
    ["run", "--data", fixture.candlesPath],
    chunks,
    {
      chunkIntervalMs: 30,
      closeStdin: true,
      env: { PINETS_TEST_STDIN_TIMEOUT_MS: "100" },
      timeoutMs: 2_000,
      waitForStdinReady: true,
    },
  );

  // Then
  assert.equal(result.status, 0);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
});

test("stalled market requests honor the configured timeout", (context) => {
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
      "--request-timeout",
      "50",
      "--quiet",
    ],
    {
      env: {
        PINETS_TEST_MARKET_STALL: "1",
      },
      timeoutMs: 2_000,
    },
  );

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Market data request timed out after 50ms/);
});

test("stalled market response bodies honor the configured timeout", async (context) => {
  // Given
  const fixture = createFixture();
  context.after(fixture.cleanup);
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url.endsWith("/ping")) {
      response.end("{}");
    } else {
      response.write("[");
    }
  });
  context.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  // When
  const result = await runCliWithStdin(
    ["run", fixture.indicatorPath, "--symbol", "BTCUSDT", "--request-timeout", "50", "--quiet"],
    [""],
    {
      closeStdin: true,
      env: { PINETS_TEST_MARKET_URL: `http://127.0.0.1:${server.address().port}` },
      timeoutMs: 2_000,
    },
  );

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Market data request timed out after 50ms/);
});

test("the updater does not advertise a downgrade", () => {
  // Given
  const latestVersion = "0.1.14";

  // When
  const result = runCli(["--version"], {
    env: { PINETS_TEST_LATEST_VERSION: latestVersion },
  });

  // Then
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("the updater advertises a newer prerelease", () => {
  // Given
  const latestVersion = nextForkRevision(packageJson.version);

  // When
  const result = runCli(["--version"], {
    env: { PINETS_TEST_LATEST_VERSION: latestVersion },
  });

  // Then
  assert.equal(result.status, 0);
  assert.ok(result.stderr.includes(latestVersion));
});

for (const quietOptions of [["--quiet"], ["-qn", "1"], ["-qf", "full"]]) {
  test(`quiet mode suppresses update notices with ${quietOptions.join(" ")}`, (context) => {
    // Given
    const fixture = createFixture();
    context.after(fixture.cleanup);

    // When
    const result = runCli(
      [
        "run",
        fixture.indicatorPath,
        "--data",
        fixture.candlesPath,
        "--candles",
        "1",
        ...quietOptions,
      ],
      { env: { PINETS_TEST_LATEST_VERSION: "9.0.0" } },
    );

    // Then
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });
}

test("commander errors are written once", () => {
  // Given
  const invalidOption = "--definitely-invalid";

  // When
  const result = runCli([invalidOption]);

  // Then
  assert.equal(result.status, 1);
  assert.equal(result.stderr.split(invalidOption).length - 1, 1);
});
