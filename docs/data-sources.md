# Data Sources

pinets-cli supports two data sources: **live market data from Binance** and **local JSON files**.

---

## Binance (Live Data)

Use `--symbol` and `--timeframe` to fetch live candle data from the Binance exchange.

```bash
pinets run rsi.pine --symbol BTCUSDT --timeframe 60
```

### Supported symbols

Any symbol available on Binance:

- **Spot**: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `BNBUSDT`, etc.
- **Perpetual futures**: `BTCUSDT.P`, `ETHUSDT.P` (append `.P` to the symbol)

The symbol is automatically uppercased, so `btcusdt` and `BTCUSDT` are equivalent.

### How it works

1. The CLI connects to the Binance public API (no API key required)
2. It requests the selected number of candles (`--candles` + `--warmup`)
3. If the default Binance endpoint is unavailable, it automatically falls back to the Binance US endpoint

Each market-data request is cancelled after 30 seconds by default. Use
`--request-timeout <milliseconds>` to choose a different positive timeout.

### Timeframes

| Value | Period | Value | Period |
|-------|--------|-------|--------|
| `1` | 1 minute | `120` | 2 hours |
| `3` | 3 minutes | `180` | 3 hours |
| `5` | 5 minutes | `240` | 4 hours |
| `15` | 15 minutes | `1D` / `D` | 1 day |
| `30` | 30 minutes | `1W` / `W` | 1 week |
| `45` | 45 minutes | `1M` / `M` | 1 month |
| `60` | 1 hour | `3M` | 3 months |
| | | `6M` | 6 months |
| | | `12M` | 12 months |

Multi-month values use uppercase `M`. In non-quiet mode, the CLI reports both the requested and returned candle counts on stderr because aggregation or limited history can return fewer candles than requested.

### Limits

Binance allows up to 1000 candles per API request. For larger counts, pinets-cli automatically paginates by making multiple requests.

---

## JSON Files (Custom Data)

Use `--data` to load candle data from a local JSON file. This is useful for:

- Offline analysis
- Custom data sources (other exchanges, CSV converted to JSON, etc.)
- Backtesting with historical datasets
- Reproducible results (same data every run)

```bash
pinets run my_indicator.pine --data ./candles.json
```

### Format

The JSON file must contain an **array of candle objects** in chronological order (oldest first):

```json
[
  {
    "openTime": 1704067200000,
    "open": 42000.50,
    "high": 42500.00,
    "low": 41800.00,
    "close": 42300.00,
    "volume": 1234.56,
    "closeTime": 1704070799999
  },
  {
    "openTime": 1704070800000,
    "open": 42300.00,
    "high": 42600.00,
    "low": 42100.00,
    "close": 42450.00,
    "volume": 987.65,
    "closeTime": 1704074399999
  }
]
```

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `open` | number | Opening price |
| `high` | number | Highest price |
| `low` | number | Lowest price |
| `close` | number | Closing price |
| `volume` | number | Trading volume |

### Recommended fields

| Field | Type | Description |
|-------|------|-------------|
| `openTime` | number | Candle open timestamp in milliseconds |
| `closeTime` | number | Candle close timestamp in milliseconds |

If `openTime` is not provided, the `time` values in the output will be `undefined`.

### Validation

pinets-cli validates the JSON data on load:

- The file must parse as valid JSON
- The root element must be a non-empty array
- Every candle must contain finite numeric `open`, `high`, `low`, `close`, and `volume` fields
- Optional `openTime` and `closeTime` values must be finite numbers
- Candles with `openTime` must be in chronological order

If validation fails, a clear error message is shown:

```
Error: JSON candle at index 1 has invalid volume; expected a finite number.
```

### Candle control with JSON data

When using JSON data:
- `--candles` controls how many entries appear in the **output** (taken from the end)
- `--warmup` is effectively automatic - all candles before the output window serve as warmup
- If the file has fewer candles than `--candles`, all candles are included

```bash
# File has 1000 candles, output the last 100
pinets run rsi.pine --data big_dataset.json --candles 100
```

---

## Data Source Priority

- If `--data` is provided, it is always used (even if `--symbol` is also specified)
- `--timeframe` is only relevant with `--symbol` and is ignored with `--data`
