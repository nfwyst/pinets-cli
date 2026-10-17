import { CommanderError, program } from "commander";
import packageJson from "../package.json";
import { runCommand } from "./run";
import { checkForUpdate } from "./update";

const VERSION = packageJson.version;
const PACKAGE_NAME = packageJson.name;
const COPYRIGHT = "Copyright (c) 2026 QuantForge.org";
const VERSION_TEXT = `pinets cli v${VERSION}\n${COPYRIGHT}`;
const SUCCESSFUL_COMMANDER_CODES: ReadonlySet<string> = new Set([
  "commander.version",
  "commander.helpDisplayed",
  "commander.help",
]);

async function main(): Promise<void> {
  const updateCheck = checkForUpdate(VERSION, PACKAGE_NAME);

  async function showUpdateNotice(): Promise<void> {
    const notice = await updateCheck;
    const quiet = run.opts<{ quiet?: boolean }>().quiet === true;
    if (notice && !quiet) {
      console.error(notice);
    }
  }

  async function showUpdateAndExit(code = 0): Promise<never> {
    await showUpdateNotice();
    process.exit(code);
  }

  program
    .name("pinets")
    .description("CLI for running Pine Script indicators via PineTS")
    .version(VERSION_TEXT, "-v, --version")
    .addHelpText("after", `\n${VERSION_TEXT}`)
    .showHelpAfterError()
    .exitOverride();

  const run = program
    .command("run")
    .description("Execute a Pine Script indicator")
    .argument("[file]", "Path to indicator file (.pine or any text file)")
    .option(
      "-s, --symbol <ticker>",
      "Symbol to query (e.g., BTCUSDT, ETHUSDT.P)",
    )
    .option(
      "-t, --timeframe <tf>",
      "Timeframe: 1, 3, 5, 15, 30, 45, 60, 120, 180, 240, D, W, M, 3M, 6M, 12M",
      "60",
    )
    .option(
      "-d, --data <path>",
      "Path to JSON data file (alternative to --symbol)",
    )
    .option("-o, --output <path>", "Write output to file (default: stdout)")
    .option("-f, --format <type>", "Output format: default | full", "default")
    .option("--pretty", "Pretty-print JSON output")
    .option(
      "--clean",
      "Filter out null, false, and empty values from plot data",
    )
    .option(
      "--plots <names>",
      'Comma-separated list of plot names to include, e.g. --plots "Buy,Sell"',
    )
    .option("-n, --candles <count>", "Number of output candles", "500")
    .option(
      "-w, --warmup <count>",
      "Extra warmup candles for indicator init",
      "0",
    )
    .option(
      "--request-timeout <milliseconds>",
      "Maximum duration of each market-data request",
      "30000",
    )
    .option("--debug", "Show transpiled code")
    .option("-q, --quiet", "Suppress informational messages")
    .action(runCommand);

  try {
    await program.parseAsync();
  } catch (error) {
    if (error instanceof CommanderError) {
      const exitCode = SUCCESSFUL_COMMANDER_CODES.has(error.code)
        ? 0
        : error.exitCode;
      await showUpdateAndExit(exitCode);
    }
    throw error;
  }

  await showUpdateNotice();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
