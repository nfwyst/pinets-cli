import fs from 'fs';
import path from 'path';
import type { Context } from '@nfwyst/pinets';
import { CliInputError } from './cli-input';
import type { OutputFormat } from './cli-input';

const INTERNAL_PLOT_TITLES: ReadonlySet<string> = new Set([
    '__labels__',
    '__lines__',
    '__boxes__',
    '__linefills__',
    '__polylines__',
    '__tables__',
]);

export type OutputOptions = {
    readonly format: OutputFormat;
    readonly candles: number;
    readonly clean: boolean;
    readonly plotFilter: string | undefined;
};

export type WriteOutputOptions = {
    readonly outputPath: string | undefined;
    readonly pretty: boolean;
    readonly quiet: boolean;
};

class OutputShapeError extends Error {
    readonly name = 'OutputShapeError';
}

export function formatOutput(
    context: Context,
    options: OutputOptions,
): Readonly<Record<string, unknown>> {
    switch (options.format) {
        case 'default':
            return formatDefault(context, options);
        case 'full':
            return formatFull(context, options);
        default:
            return assertNever(options.format);
    }
}

export function writeOutput(
    data: unknown,
    options: WriteOutputOptions,
): void {
    const json = options.pretty
        ? JSON.stringify(data, null, 2)
        : JSON.stringify(data);
    if (json === undefined) {
        throw new OutputShapeError('Formatted output is not JSON serializable.');
    }

    if (options.outputPath) {
        const resolved = path.resolve(options.outputPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, json, 'utf-8');
        if (!options.quiet) {
            console.error(`Output written to: ${resolved}`);
        }
    } else {
        process.stdout.write(`${json}\n`);
    }
}

function formatDefault(
    context: Context,
    options: OutputOptions,
): Readonly<Record<string, unknown>> {
    const rawPlots: unknown = context.plots;
    if (!isRecord(rawPlots)) {
        throw new OutputShapeError('PineTS returned an invalid plots object.');
    }

    const plots: Record<string, unknown> = {};
    const includePlots =
        options.plotFilter === undefined
            ? undefined
            : new Set(
                  options.plotFilter
                      .split(',')
                      .map((name) => name.trim())
                      .filter((name) => name.length > 0),
              );
    const availablePlots = Object.keys(rawPlots).filter(
        (title) => !INTERNAL_PLOT_TITLES.has(title),
    );
    const availablePlotsHint =
        availablePlots.length > 0
            ? `Available plots: ${availablePlots.join(', ')}`
            : 'The indicator did not produce any selectable plots.';
    if (includePlots?.size === 0) {
        throw new CliInputError(
            '--plots must name at least one plot.',
            availablePlotsHint,
        );
    }

    if (includePlots) {
        const availablePlotSet = new Set(availablePlots);
        const missingPlots = [...includePlots].filter(
            (title) => !availablePlotSet.has(title),
        );
        if (missingPlots.length > 0) {
            throw new CliInputError(
                `Unknown plot name${missingPlots.length === 1 ? '' : 's'}: ${missingPlots.join(', ')}.`,
                availablePlotsHint,
            );
        }
    }

    for (const [title, value] of Object.entries(rawPlots)) {
        const explicitlyIncluded = includePlots?.has(title) === true;
        if (
            INTERNAL_PLOT_TITLES.has(title) ||
            (includePlots && !explicitlyIncluded)
        ) {
            continue;
        }
        if (!isRecord(value) || !Array.isArray(value['data'])) {
            throw new OutputShapeError(`PineTS returned invalid data for plot ${title}.`);
        }

        const rawData = value['data'];
        const trimmed =
            rawData.length > options.candles
                ? rawData.slice(-options.candles)
                : rawData;
        const data = options.clean
            ? trimmed.filter(isMeaningfulPlotEntry)
            : trimmed;

        plots[title] = {
            title: value['title'],
            options: value['options'],
            data,
        };
    }

    const indicator: unknown = context.indicator;
    return {
        indicator: indicator ?? {},
        plots,
        ...(compileWarningsEntry(context)),
    };
}

/** Non-blocking compile diagnostics (CW10011 …); omitted entirely when empty. */
function compileWarningsEntry(context: Context): Record<string, unknown> {
    const warnings = (context as unknown as { compileWarnings?: unknown }).compileWarnings;
    return Array.isArray(warnings) && warnings.length > 0 ? { warnings } : {};
}

function formatFull(
    context: Context,
    options: OutputOptions,
): Readonly<Record<string, unknown>> {
    const defaultOutput = formatDefault(context, options);
    const rawMarketData: unknown = context.marketData;
    if (!Array.isArray(rawMarketData)) {
        throw new OutputShapeError('PineTS returned invalid market data.');
    }
    const marketData =
        rawMarketData.length > options.candles
            ? rawMarketData.slice(-options.candles)
            : rawMarketData;
    const result: unknown = context.result;

    return {
        ...defaultOutput,
        result: trimResult(result, options.candles),
        marketData,
    };
}

function trimResult(result: unknown, candles: number): unknown {
    if (Array.isArray(result)) {
        return result.length > candles ? result.slice(-candles) : result;
    }
    if (!isRecord(result)) {
        return result;
    }

    const trimmed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result)) {
        trimmed[key] =
            Array.isArray(value) && value.length > candles
                ? value.slice(-candles)
                : value;
    }
    return trimmed;
}

function isMeaningfulPlotEntry(entry: unknown): boolean {
    const value = isRecord(entry) ? entry['value'] : entry;
    if (
        value === null ||
        value === undefined ||
        value === false ||
        value === ''
    ) {
        return false;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return false;
    }
    return !Array.isArray(value) || value.length > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
    throw new OutputShapeError(`Unsupported output format: ${String(value)}`);
}
