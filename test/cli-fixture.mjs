import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, "..");
const CLI_PATH = path.join(REPOSITORY_ROOT, "dist", "pinets-cli.min.cjs");
const PRELOAD_PATH = path.join(TEST_DIRECTORY, "preload.cjs");

function childEnvironment(overrides = {}) {
  return {
    ...process.env,
    ...overrides,
  };
}

export function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "pinets-cli-test-"));
  const indicatorPath = path.join(directory, "indicator.pine");
  const emptyIndicatorPath = path.join(directory, "empty.pine");
  const candlesPath = path.join(directory, "candles.json");
  const missingFieldPath = path.join(directory, "missing-field.json");
  const wrongTypePath = path.join(directory, "wrong-type.json");
  const candles = Array.from({ length: 6 }, (_, index) => {
    const open = 100 + index;
    return {
      openTime: 1_700_000_000_000 + index * 60_000,
      open,
      high: open + 2,
      low: open - 2,
      close: open + (index % 2 === 0 ? 1 : -1),
      volume: 10 + index,
      closeTime: 1_700_000_059_999 + index * 60_000,
    };
  });

  writeFileSync(
    indicatorPath,
    [
      "//@version=5",
      'indicator("QA", overlay=false)',
      "sma3 = ta.sma(close, 3)",
      'plot(sma3, "SMA")',
      'plot(close > open, "Up")',
      'plot(0, "Zero")',
      "",
    ].join("\n"),
  );
  writeFileSync(emptyIndicatorPath, "");
  writeFileSync(candlesPath, JSON.stringify(candles));
  writeFileSync(
    missingFieldPath,
    JSON.stringify([candles[0], { ...candles[1], volume: undefined }]),
  );
  writeFileSync(
    wrongTypePath,
    JSON.stringify([{ ...candles[0], close: "not-a-number" }]),
  );

  return {
    directory,
    indicatorPath,
    emptyIndicatorPath,
    candlesPath,
    missingFieldPath,
    wrongTypePath,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function runCli(args, options = {}) {
  return spawnSync(process.execPath, ["--preload", PRELOAD_PATH, CLI_PATH, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: childEnvironment(options.env),
    input: options.input,
    timeout: options.timeoutMs ?? 15_000,
  });
}

export function runCliWithStdin(args, chunks, options = {}) {
  const child = spawn(process.execPath, ["--preload", PRELOAD_PATH, CLI_PATH, ...args], {
    cwd: REPOSITORY_ROOT,
    env: childEnvironment(options.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stdin.on("error", () => {});

  let chunkIndex = 0;
  let chunkTimer;
  let started = false;
  const writeNextChunk = () => {
    const chunk = chunks[chunkIndex];
    if (chunk === undefined) return;
    child.stdin.write(chunk);
    chunkIndex += 1;
    if (chunkIndex === chunks.length && options.closeStdin) {
      child.stdin.end();
    }
  };
  const startWriting = () => {
    if (started) return;
    started = true;
    writeNextChunk();
    if (chunks.length > 1) {
      chunkTimer = setInterval(() => {
        writeNextChunk();
        if (chunkIndex === chunks.length) clearInterval(chunkTimer);
      }, options.chunkIntervalMs ?? 0);
    }
  };
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (options.waitForStdinReady) startWriting();
  });
  if (!options.waitForStdinReady) startWriting();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit within ${options.timeoutMs ?? 12_000}ms`));
    }, options.timeoutMs ?? 12_000);

    child.once("close", (status) => {
      clearTimeout(timer);
      if (chunkTimer !== undefined) clearInterval(chunkTimer);
      resolve({ status, stdout, stderr });
    });
  });
}
