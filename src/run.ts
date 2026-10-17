import fs from 'fs';
import path from 'path';
import { PineTS, Provider } from '@nfwyst/pinets';
import type { IProvider } from '@nfwyst/pinets';
import {
    CliInputError,
    parseCandleData,
    parseNonNegativeInteger,
    parseOutputFormat,
    parsePositiveInteger,
    parseTimeframe,
} from './cli-input';
import type { CandleData } from './cli-input';
import { formatOutput, writeOutput } from './output';
import { readStdin } from './stdin';

export type RunOptions = {
    readonly symbol?: string;
    readonly timeframe: string;
    readonly data?: string;
    readonly output?: string;
    readonly format: string;
    readonly pretty?: boolean;
    readonly clean?: boolean;
    readonly plots?: string;
    readonly candles: string;
    readonly warmup: string;
    readonly requestTimeout: string;
    readonly debug?: boolean;
    readonly quiet?: boolean;
};

class RuntimeExecutionError extends Error {
    readonly name = 'RuntimeExecutionError';
}

function log(quiet: boolean, ...args: readonly unknown[]): void {
    if (!quiet) console.error(...args);
}

export async function runCommand(
    file: string | undefined,
    options: RunOptions,
): Promise<void> {
    try {
        await executeRun(file, options);
    } catch (error) {
        if (error instanceof CliInputError) {
            console.error(`Error: ${error.message}`);
            if (error.hint) console.error(error.hint);
        } else {
            console.error(`Execution failed: ${errorMessage(error)}`);
            if (options.debug && error instanceof Error && error.stack) {
                console.error(error.stack);
            }
        }
        process.exitCode = 1;
    }
}

async function executeRun(
    file: string | undefined,
    options: RunOptions,
): Promise<void> {
    const candles = parsePositiveInteger(options.candles, '--candles');
    const warmup = parseNonNegativeInteger(options.warmup, '--warmup');
    const requestTimeout = parsePositiveInteger(
        options.requestTimeout,
        '--request-timeout',
    );
    const totalCandles = candles + warmup;
    if (!Number.isSafeInteger(totalCandles)) {
        throw new CliInputError('--candles plus --warmup exceeds the safe integer range.');
    }

    const format = parseOutputFormat(options.format);
    const quiet = options.quiet === true;
    const indicatorCode = await readIndicatorCode(file, quiet);
    const source = readDataSource(options, totalCandles, quiet);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
        async (
            input: Parameters<typeof globalThis.fetch>[0],
            init?: Parameters<typeof globalThis.fetch>[1],
        ): Promise<Response> => {
            const timeoutSignal = AbortSignal.timeout(requestTimeout);
            const providerSignal = init?.signal;
            if (!providerSignal) {
                return originalFetch(input, { ...init, signal: timeoutSignal });
            }

            const controller = new AbortController();
            let requestTimedOut = false;
            const abortFromProvider = (): void => {
                if (!controller.signal.aborted) {
                    controller.abort(providerSignal.reason);
                }
            };
            const abortFromTimeout = (): void => {
                if (!controller.signal.aborted) {
                    requestTimedOut = true;
                    controller.abort(timeoutSignal.reason);
                }
            };
            providerSignal.addEventListener('abort', abortFromProvider, { once: true });
            timeoutSignal.addEventListener('abort', abortFromTimeout, { once: true });
            if (providerSignal.aborted) abortFromProvider();
            if (timeoutSignal.aborted) abortFromTimeout();

            try {
                const response = await originalFetch(input, {
                    ...init,
                    signal: controller.signal,
                });
                // Keep cancellation active until the provider can consume the full body.
                if (response.body !== null) await response.clone().arrayBuffer();
                return response;
            } catch (error) {
                if (requestTimedOut) {
                    throw new RuntimeExecutionError(
                        `Market data request timed out after ${requestTimeout}ms.`,
                        { cause: error },
                    );
                }
                throw error;
            } finally {
                providerSignal.removeEventListener('abort', abortFromProvider);
                timeoutSignal.removeEventListener('abort', abortFromTimeout);
            }
        },
        { preconnect: originalFetch.preconnect },
    );
    const [pineTS, context] = await (async () => {
        try {
            const runtime = new PineTS(
                source.data,
                source.tickerId,
                source.timeframe,
                source.limit,
            );
            if (options.debug) {
                runtime.setDebugSettings({ ln: false, debug: true });
            }

            log(quiet, 'Executing...');
            return [runtime, await runtime.run(indicatorCode)] as const;
        } finally {
            globalThis.fetch = originalFetch;
        }
    })();
    const marketData: unknown = context.marketData;
    if (!Array.isArray(marketData) || marketData.length === 0) {
        throw new RuntimeExecutionError('The data provider returned no market data.');
    }
    if (source.limit !== undefined) {
        log(
            quiet,
            `Market data: ${source.limit} candles requested | ${marketData.length} returned`,
        );
    }

    if (options.debug) {
        console.error(String(pineTS.transpiledCode));
    }
    const compileWarnings = (context as unknown as { compileWarnings?: unknown }).compileWarnings;
    if (Array.isArray(compileWarnings)) {
        for (const warning of compileWarnings) {
            const w = warning as { code?: string; message?: string; line?: number; column?: number };
            console.error(`Warning ${w.code ?? ''} at line ${w.line ?? '?'}:${w.column ?? '?'}: ${w.message ?? ''}`);
        }
    }
    const runtimeWarnings = context.warnings;
    if (Array.isArray(runtimeWarnings)) {
        for (const warning of runtimeWarnings) {
            console.error(`Warning (bar ${warning.bar}): ${warning.message}${warning.method ? ` [${warning.method}]` : ''}`);
        }
    }
    log(quiet, 'Done.');

    const output = formatOutput(context, {
        format,
        candles,
        clean: options.clean === true,
        plotFilter: options.plots,
    });
    const pretty =
        options.pretty === true ||
        (options.output === undefined && process.stdout.isTTY === true);

    writeOutput(output, {
        outputPath: options.output,
        pretty,
        quiet,
    });
}

async function readIndicatorCode(
    file: string | undefined,
    quiet: boolean,
): Promise<string> {
    let indicatorCode: string;
    if (file) {
        const filePath = path.resolve(file);
        if (!fs.existsSync(filePath)) {
            throw new CliInputError(`File not found: ${filePath}`);
        }
        indicatorCode = fs.readFileSync(filePath, 'utf-8');
        log(quiet, `Indicator: ${path.basename(filePath)}`);
    } else if (!process.stdin.isTTY) {
        log(quiet, 'Reading indicator from stdin...');
        indicatorCode = await readStdin();
        log(quiet, `Indicator: <stdin> (${indicatorCode.length} chars)`);
    } else {
        throw new CliInputError(
            'No indicator provided. Pass a file argument or pipe via stdin.',
            '\n  Examples:\n' +
                '    pinets run my_indicator.pine --symbol BTCUSDT\n' +
                '    cat my_indicator.pine | pinets run --symbol BTCUSDT',
        );
    }

    if (!indicatorCode.trim()) {
        throw new CliInputError('Indicator input must not be empty.');
    }
    return indicatorCode;
}

type DataSource = {
    readonly data: IProvider | CandleData[];
    readonly tickerId: string | undefined;
    readonly timeframe: string | undefined;
    readonly limit: number | undefined;
};

function readDataSource(
    options: RunOptions,
    totalCandles: number,
    quiet: boolean,
): DataSource {
    if (options.data) {
        const dataPath = path.resolve(options.data);
        if (!fs.existsSync(dataPath)) {
            throw new CliInputError(`Data file not found: ${dataPath}`);
        }

        const candles = parseCandleData(fs.readFileSync(dataPath, 'utf-8'));
        // A raw OHLCV array has no provider to derive a timeframe from. Pass
        // the CLI's normalized timeframe through so request.security() /
        // time("") resolve the same-period value accurately; PineTS leaves
        // context.timeframe undefined for raw arrays otherwise.
        const dataTimeframe = parseTimeframe(options.timeframe);
        log(quiet, `Data source: JSON file (${candles.length} candles) | ${dataTimeframe}`);
        return {
            data: candles,
            tickerId: options.symbol?.toUpperCase(),
            timeframe: dataTimeframe,
            limit: undefined,
        };
    }

    if (options.symbol) {
        const provider = Provider['Binance'];
        if (!provider) {
            throw new RuntimeExecutionError('The Binance provider is unavailable.');
        }
        const tickerId = options.symbol.toUpperCase();
        const timeframe = parseTimeframe(options.timeframe);
        log(
            quiet,
            `Data source: Binance | ${tickerId} | ${timeframe}`,
        );
        return {
            data: provider,
            tickerId,
            timeframe,
            limit: totalCandles,
        };
    }

    throw new CliInputError(
        'No data source provided.',
        'Use --symbol <ticker> for live data or --data <file.json> for a JSON file.',
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
