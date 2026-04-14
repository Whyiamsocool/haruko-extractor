#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

function usage() {
  console.log(`Haruko extractor

Usage:
  node fetch-haruko.mjs --token <token> --type <data-type> [options]

Required:
  --token <token>         Bearer token from sessionStorage.haruko_token
  --type <data-type>      wallet_transactions | trades | transfers |
                          balance_adjustments | balance | position |
                          equity_timeseries

Optional:
  --base-url <url>        Default: https://sgp10.haruko.io
  --accounts <ids>        Comma-separated venueAccountIds
  --group <name>          Group name for equity_timeseries
  --latest <n>            Latest N records for aggregate endpoints
  --start-date <YYYY-MM-DD>
  --end-date <YYYY-MM-DD>
  --detail <mode>         collapse | expand_asset | expand_account
  --format <fmt>          json | csv (default: csv)
  --out <path>            Write output to file instead of stdout

Examples:
  node fetch-haruko.mjs --token "$HARUKO_TOKEN" --type trades --accounts 123,456 --latest 1000 --out trades.csv
  node fetch-haruko.mjs --token "$HARUKO_TOKEN" --type equity_timeseries --group "Open Eden Vault" --start-date 2026-01-01 --end-date 2026-03-27 --detail expand_asset --out equity.csv
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function requireArg(args, key, message) {
  if (!args[key]) {
    throw new Error(message);
  }
  return args[key];
}

function isoDateToStartMs(value) {
  return new Date(`${value}T00:00:00Z`).getTime();
}

function isoDateToEndMs(value) {
  return new Date(`${value}T23:59:59Z`).getTime();
}

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function apiFetch(baseUrl, token, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: buildHeaders(token),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} for ${path}: ${text.slice(0, 300)}`);
  }

  return response.json();
}

function getEndpoint(dataType) {
  const map = {
    wallet_transactions: 'wallet_transactions',
    trades: 'trades',
    transfers: 'transfers',
    balance_adjustments: 'balance_adjustments',
  };
  return map[dataType] || dataType;
}

function flattenTx(tx) {
  const { transactions, additionalDataFields, ...rest } = tx;
  return rest;
}

function extractEntries(data, dataType) {
  const result = data.result || data;

  if (result.entries && Array.isArray(result.entries)) {
    return result.entries;
  }

  if (dataType === 'wallet_transactions' && result.wallets) {
    const all = [];
    for (const wallet of result.wallets) {
      if (!wallet.walletTransactions) {
        continue;
      }
      for (const tx of wallet.walletTransactions) {
        if (Array.isArray(tx.transactions)) {
          for (const subTx of tx.transactions) {
            all.push({
              ...flattenTx(tx),
              ...subTx,
            });
          }
          continue;
        }
        all.push(flattenTx(tx));
      }
    }
    return all;
  }

  if (dataType === 'balance' && result.balances) {
    const all = [];
    for (const venueAccount of result.balances) {
      for (const balance of venueAccount.balances || []) {
        const { referencePrice, assetMetadata, additionalData, ...rest } = balance;
        all.push({
          venueAccountId: venueAccount.venueAccountId,
          ...rest,
          markPrice: referencePrice?.referencePrice || null,
          priceType: referencePrice?.referencePriceType || null,
          priceSymbol: referencePrice?.symbol || null,
          priceVenue: referencePrice?.venue || null,
        });
      }
    }
    return all;
  }

  if (dataType === 'position' && result.positions) {
    const all = [];
    const positionTypes = [
      'futuresPositions',
      'optionsPositions',
      'assetBackedTokenPositions',
      'marginPositions',
    ];
    for (const venueAccount of result.positions) {
      for (const positionType of positionTypes) {
        for (const position of venueAccount[positionType] || []) {
          const { staticData, ...rest } = position;
          all.push({
            venueAccountId: venueAccount.venueAccountId,
            positionType: positionType.replace('Positions', ''),
            ...rest,
            instrumentType: staticData?.instrumentType || null,
            baseAsset: staticData?.baseAsset || null,
            termAsset: staticData?.termAsset || null,
            contractSize: staticData?.contractSize || null,
            perpetual: staticData?.perpetual || null,
          });
        }
      }
    }
    return all;
  }

  if (result.venueAccounts && Array.isArray(result.venueAccounts)) {
    if (typeof result.venueAccounts[0] === 'string' && result.entries) {
      return result.entries;
    }

    const all = [];
    for (const venueAccount of result.venueAccounts) {
      if (typeof venueAccount !== 'object') {
        continue;
      }
      const items =
        venueAccount.transfers ||
        venueAccount.balanceAdjustments ||
        venueAccount.entries ||
        [];
      for (const item of items) {
        all.push({
          venueAccount: venueAccount.venueAccount || venueAccount.name,
          ...item,
        });
      }
    }
    if (all.length > 0) {
      return all;
    }
  }

  for (const value of Object.values(result)) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      return value;
    }
  }

  return [];
}

async function fetchAggregate(baseUrl, token, args) {
  const dataType = requireArg(args, 'type', 'Missing --type');
  const accounts = requireArg(args, 'accounts', `Missing --accounts for ${dataType}`);
  const endpoint = getEndpoint(dataType);
  const isTrades = dataType === 'trades';
  const params = new URLSearchParams({
    venueAccountIds: accounts,
    orderByDirection: 'DESC',
  });

  if (args.latest) {
    params.set('latest', args.latest);
  } else if (args['start-date'] || args['end-date']) {
    if (!args['start-date'] || !args['end-date']) {
      throw new Error('Use both --start-date and --end-date together');
    }
    params.set('startTimestamp', String(isoDateToStartMs(args['start-date'])));
    params.set('endTimestamp', String(isoDateToEndMs(args['end-date'])));
  } else {
    params.set('latest', '1000');
  }

  if (isTrades) {
    params.set('includeStaticData', 'true');
  }

  const payload = await apiFetch(
    baseUrl,
    token,
    `/cefi/api/aggregate/${endpoint}?${params.toString()}`
  );
  return extractEntries(payload, dataType);
}

async function fetchSnapshot(baseUrl, token, args) {
  const dataType = requireArg(args, 'type', 'Missing --type');
  const accounts = requireArg(args, 'accounts', `Missing --accounts for ${dataType}`);

  const path =
    dataType === 'balance'
      ? `/cefi/api/aggregate/balance?zeroBalances=false&venueAccountIds=${encodeURIComponent(accounts)}`
      : `/cefi/api/aggregate/position?venueAccountIds=${encodeURIComponent(accounts)}&optionsPricingSource=VENUE`;

  const payload = await apiFetch(baseUrl, token, path);
  return extractEntries(payload, dataType);
}

function round6(v) { return Math.round(v * 1e6) / 1e6; }

function filterTimeSeries(timeSeries, startDate, endDate) {
  return timeSeries.filter((entry) => {
    if (startDate && entry.timestamp < new Date(startDate).getTime()) {
      return false;
    }
    if (endDate && entry.timestamp >= new Date(endDate).getTime() + 86400000) {
      return false;
    }
    return true;
  });
}

function expandTimeSeries(timeSeries, detail) {
  const rows = [];

  for (const entry of timeSeries) {
    const date = new Date(entry.timestamp).toISOString();
    const summary = entry.equitySummary;
    if (!summary) {
      continue;
    }

    const accounts = entry.accountEquity || [];
    const totalEquityUsd =
      accounts.length > 0
        ? accounts.reduce((sum, account) => sum + (account.totalEquityUsd || 0), 0)
        : summary.totalEquityUsd;

    if (detail === 'collapse') {
      rows.push({
        date,
        totalEquityUsd,
        changeUsd: summary.chgEqUsd,
        totalExposure: summary.totalExposure,
        leverage: summary.leverage,
        notional: summary.notional,
      });
      continue;
    }

    if (detail === 'expand_asset') {
      for (const asset of summary.assets || []) {
        rows.push({
          date,
          totalEquityUsd,
          type: 'spot',
          asset: asset.asset,
          quantity: asset.eq,
          refPx: asset.refPx,
          equityUsd: asset.eqUsd,
          equityPct: totalEquityUsd ? round6((asset.eqUsd / totalEquityUsd) * 100) : 0,
          changeQuantity: asset.chgEq,
          changeUsd: asset.chgEqUsd,
        });
      }
      for (const position of summary.positions || []) {
        rows.push({
          date,
          totalEquityUsd,
          type: 'derivative_exposure',
          asset: position.symbol,
          quantity: position.position,
          refPx: position.mark,
          notionalUsd: position.positionUsd,
        });
      }
      continue;
    }

    for (const account of accounts) {
      for (const asset of account.assets || []) {
        rows.push({
          date,
          accountId: account.id,
          accountName: account.name,
          venue: account.venue,
          accountEquityUsd: account.totalEquityUsd,
          totalEquityUsd,
          type: 'spot',
          asset: asset.asset,
          quantity: asset.eq,
          refPx: asset.refPx,
          equityUsd: asset.eqUsd,
          equityPct: account.totalEquityUsd
            ? round6((asset.eqUsd / account.totalEquityUsd) * 100)
            : 0,
          changeQuantity: asset.chgEq,
          changeUsd: asset.chgEqUsd,
        });
      }
    }

    for (const position of summary.positions || []) {
      rows.push({
        date,
        venue: position.venue,
        totalEquityUsd,
        type: 'derivative_exposure',
        asset: position.symbol,
        quantity: position.position,
        refPx: position.mark,
        notionalUsd: position.positionUsd,
      });
    }
  }

  return rows;
}

async function fetchEquityTimeSeries(baseUrl, token, args) {
  const group = requireArg(args, 'group', 'Missing --group for equity_timeseries');
  const detail = args.detail || 'collapse';
  const payload = await apiFetch(
    baseUrl,
    token,
    `/cefi/api/group_summary_curve?group=${encodeURIComponent(group)}&includeAccountBreakdown=true&notionalType=DEFAULT&includePositions=true&refreshLiveBalances=false&includeEquity=true&pnlSource=DEFAULT`
  );
  const rawTimeSeries = payload.result?.timeSeries || [];
  const timeSeries = filterTimeSeries(rawTimeSeries, args['start-date'], args['end-date']);
  return expandTimeSeries(timeSeries, detail);
}

function toCsv(rows) {
  if (rows.length === 0) {
    return '';
  }

  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escapeCell = (value) => {
    if (value === null || value === undefined) {
      return '';
    }
    const stringValue =
      typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (
      stringValue.includes(',') ||
      stringValue.includes('"') ||
      stringValue.includes('\n')
    ) {
      return `"${stringValue.replaceAll('"', '""')}"`;
    }
    return stringValue;
  };

  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => escapeCell(row[header])).join(',')),
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }

  const token = requireArg(args, 'token', 'Missing --token');
  const dataType = requireArg(args, 'type', 'Missing --type');
  const baseUrl = args['base-url'] || 'https://sgp10.haruko.io';
  const format = args.format || 'csv';

  let rows;
  if (dataType === 'equity_timeseries') {
    rows = await fetchEquityTimeSeries(baseUrl, token, args);
  } else if (dataType === 'balance' || dataType === 'position') {
    rows = await fetchSnapshot(baseUrl, token, args);
  } else {
    rows = await fetchAggregate(baseUrl, token, args);
  }

  const output = format === 'json' ? JSON.stringify(rows, null, 2) : toCsv(rows);

  if (args.out) {
    await writeFile(args.out, output, 'utf8');
    console.error(`Wrote ${rows.length} rows to ${args.out}`);
    return;
  }

  process.stdout.write(output);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
