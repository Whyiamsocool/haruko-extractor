# Haruko Extractor

This folder now has two extraction paths:

1. `popup.html` + extension files for browser-based CSV export
2. `fetch-haruko.mjs` for direct API export from a terminal

## What the site uses

The Haruko PMS app redirects to login, then reads a bearer token from:

- `sessionStorage.haruko_token`

Authenticated data is then fetched from endpoints under:

- `/cefi/api/aggregate/...`
- `/cefi/api/group_summary_curve`
- `/cefi/api/account_status`

## Fastest path

1. Log into `https://sgp10.haruko.io/pms/prod/app` in your browser.
2. Open DevTools on the Haruko tab.
3. Run:

```js
sessionStorage.getItem('haruko_token')
```

4. Remove the surrounding quotes if needed.
5. Run the CLI:

```bash
node fetch-haruko.mjs --token "$HARUKO_TOKEN" --type trades --accounts 123,456 --latest 1000 --out trades.csv
```

## Supported data types

- `wallet_transactions`
- `trades`
- `transfers`
- `balance_adjustments`
- `balance`
- `position`
- `equity_timeseries`

## Examples

Latest trades:

```bash
node fetch-haruko.mjs \
  --token "$HARUKO_TOKEN" \
  --type trades \
  --accounts 123,456 \
  --latest 1000 \
  --out trades.csv
```

Historical transfers:

```bash
node fetch-haruko.mjs \
  --token "$HARUKO_TOKEN" \
  --type transfers \
  --accounts 123,456 \
  --start-date 2026-01-01 \
  --end-date 2026-03-27 \
  --out transfers.csv
```

Daily group equity:

```bash
node fetch-haruko.mjs \
  --token "$HARUKO_TOKEN" \
  --type equity_timeseries \
  --group "Open Eden Vault" \
  --start-date 2026-01-01 \
  --end-date 2026-03-27 \
  --detail expand_asset \
  --out equity.csv
```

## Notes

- `balance` and `position` require `--accounts`.
- `equity_timeseries` requires `--group`.
- The CLI uses Node's built-in `fetch`, so no dependencies are needed.
