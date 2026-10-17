/**
 * Read all data from piped stdin.
 *
 * Works cross-platform (Windows, Linux, macOS) via process.stdin in Bun.
 * The timeout is an inactivity window, so slow producers can keep the stream
 * alive as long as they continue writing data.
 */
class StdinTimeoutError extends Error {
    readonly name = 'StdinTimeoutError';

    constructor(timeoutMs: number) {
        super(`Timeout: stdin was inactive for ${timeoutMs}ms.`);
    }
}

export function readStdin(timeoutMs = 10_000): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        let settled = false;

        const onData = (chunk: string | Buffer): void => {
            data += chunk.toString();
            timer.refresh();
        };
        const onEnd = (): void => {
            settle(() => resolve(data));
        };
        const onError = (error: Error): void => {
            settle(() => reject(error));
        };
        const cleanup = (): void => {
            clearTimeout(timer);
            process.stdin.off('data', onData);
            process.stdin.off('end', onEnd);
            process.stdin.off('error', onError);
        };
        const settle = (complete: () => void): void => {
            if (settled) return;
            settled = true;
            cleanup();
            complete();
        };
        const timer = setTimeout(() => {
            settle(() => {
                process.stdin.destroy();
                reject(new StdinTimeoutError(timeoutMs));
            });
        }, timeoutMs);

        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', onData);
        process.stdin.on('end', onEnd);
        process.stdin.on('error', onError);
    });
}
