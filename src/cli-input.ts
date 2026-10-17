const OUTPUT_FORMATS = ["default", "full"] as const;
const BINANCE_TIMEFRAMES = [
  "1",
  "3",
  "5",
  "15",
  "30",
  "45",
  "60",
  "120",
  "180",
  "240",
  "D",
  "W",
  "M",
  "3M",
  "6M",
  "12M",
] as const;
const BINANCE_TIMEFRAME_SET: ReadonlySet<string> = new Set(BINANCE_TIMEFRAMES);

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type CandleData = {
  readonly [key: string]: unknown;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly openTime?: number;
  readonly closeTime?: number;
};

export class CliInputError extends Error {
  readonly name = "CliInputError";

  constructor(
    message: string,
    readonly hint?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function parsePositiveInteger(value: string, option: string): number {
  return parseInteger(value, option, 1);
}

export function parseNonNegativeInteger(value: string, option: string): number {
  return parseInteger(value, option, 0);
}

function parseInteger(value: string, option: string, minimum: number): number {
  if (!/^\d+$/.test(value)) {
    throw new CliInputError(`${option} must be an integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    const requirement = minimum === 0 ? "a non-negative" : "a positive";
    throw new CliInputError(`${option} must be ${requirement} safe integer.`);
  }
  return parsed;
}

export function parseOutputFormat(value: string): OutputFormat {
  switch (value) {
    case "default":
    case "full":
      return value;
    default:
      throw new CliInputError("--format must be either default or full.");
  }
}

export function parseTimeframe(value: string): string {
  if (/^\d+m$/.test(value)) {
    throw unsupportedTimeframe(value);
  }
  const upper = value.toUpperCase();
  const normalized = normalizeTimeframeAlias(upper);
  if (!BINANCE_TIMEFRAME_SET.has(normalized)) {
    throw unsupportedTimeframe(value);
  }
  return normalized;
}

function unsupportedTimeframe(value: string): CliInputError {
  return new CliInputError(
    `Unsupported timeframe: ${value}`,
    `Supported values: ${BINANCE_TIMEFRAMES.join(", ")}, 1D, 1W, 1M`,
  );
}

function normalizeTimeframeAlias(value: string): string {
  switch (value) {
    case "1D":
      return "D";
    case "1W":
      return "W";
    case "1M":
      return "M";
    default:
      return value;
  }
}

export function parseCandleData(raw: string): CandleData[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliInputError(
        `Failed to parse JSON data file: ${error.message}`,
        undefined,
        { cause: error },
      );
    }
    throw error;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new CliInputError(
      "JSON data must be a non-empty array of candle objects.",
      "Expected: [{ openTime, open, high, low, close, volume, closeTime }, ...]",
    );
  }

  const candles: CandleData[] = [];
  let previousOpenTime: number | undefined;
  for (const [index, value] of parsed.entries()) {
    const candle = parseCandle(value, index);
    if (
      previousOpenTime !== undefined &&
      candle.openTime !== undefined &&
      candle.openTime <= previousOpenTime
    ) {
      throw new CliInputError(
        `JSON candle at index ${index} is not in chronological order.`,
      );
    }
    previousOpenTime = candle.openTime ?? previousOpenTime;
    candles.push(candle);
  }
  return candles;
}

function parseCandle(value: unknown, index: number): CandleData {
  if (!isRecord(value)) {
    throw new CliInputError(`JSON candle at index ${index} must be an object.`);
  }

  const openTime =
    "openTime" in value
      ? { openTime: readFiniteNumber(value, "openTime", index) }
      : {};
  const closeTime =
    "closeTime" in value
      ? { closeTime: readFiniteNumber(value, "closeTime", index) }
      : {};

  return {
    ...value,
    ...openTime,
    ...closeTime,
    open: readFiniteNumber(value, "open", index),
    high: readFiniteNumber(value, "high", index),
    low: readFiniteNumber(value, "low", index),
    close: readFiniteNumber(value, "close", index),
    volume: readFiniteNumber(value, "volume", index),
  };
}

function readFiniteNumber(
  record: Readonly<Record<string, unknown>>,
  field: string,
  index: number,
): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CliInputError(
      `JSON candle at index ${index} has invalid ${field}; expected a finite number.`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
