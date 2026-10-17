const packageJson = require("../package.json");

const originalFetch = globalThis.fetch;
const stdinTimeoutMs = Number(process.env.PINETS_TEST_STDIN_TIMEOUT_MS);

if (Number.isSafeInteger(stdinTimeoutMs) && stdinTimeoutMs > 0) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    originalSetTimeout(callback, delay === 10_000 ? stdinTimeoutMs : delay, ...args);
}

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://registry.npmjs.org/")) {
    const version = process.env.PINETS_TEST_LATEST_VERSION ?? packageJson.version;
    return new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (process.env.PINETS_TEST_MARKET_STALL === "1") {
    return new Promise((resolve, reject) => {
      const activeConnection = setInterval(() => {}, 1_000);
      const rejectOnAbort = () => {
        clearInterval(activeConnection);
        reject(new Error("PINETS_TEST_MARKET_ABORTED"));
      };
      if (init?.signal?.aborted) {
        rejectOnAbort();
      } else {
        init?.signal?.addEventListener("abort", rejectOnAbort, { once: true });
      }
    });
  }
  if (process.env.PINETS_TEST_MARKET_FAILURE === "1") {
    return new Response("{}", { status: 400 });
  }
  if (process.env.PINETS_TEST_MARKET_URL) {
    const requested = new URL(url);
    return originalFetch(
      `${process.env.PINETS_TEST_MARKET_URL}${requested.pathname}${requested.search}`,
      init,
    );
  }
  return originalFetch(input, init);
};
