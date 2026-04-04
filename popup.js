let authToken = null;
let baseUrl = null;
let venueAccounts = [];

// ── Init ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.includes('haruko.io')) {
    setStatus('err', 'Not on a Haruko page. Navigate to Haruko first.');
    return;
  }

  // Get auth token from content script
  chrome.tabs.sendMessage(tab.id, { action: 'getAuth' }, async (resp) => {
    if (chrome.runtime.lastError || !resp?.token) {
      setStatus('err', 'Cannot read auth token. Refresh the Haruko page and try again.');
      return;
    }
    authToken = resp.token;
    baseUrl = resp.baseUrl;
    setStatus('ok', `Connected to ${baseUrl}`);
    document.getElementById('downloadBtn').disabled = false;

    // Detect group from URL
    chrome.tabs.sendMessage(tab.id, { action: 'getGroups' }, (gResp) => {
      if (gResp?.currentGroup) {
        document.getElementById('groupName').value = gResp.currentGroup;
      }
    });

    await loadAccounts();
  });

  // Event listeners
  document.getElementById('mode').addEventListener('change', toggleMode);
  document.getElementById('dataType').addEventListener('change', onDataTypeChange);
  onDataTypeChange();
  document.getElementById('downloadBtn').addEventListener('click', downloadData);
  document.getElementById('selectAll').addEventListener('click', () => toggleAllAccounts(true));
  document.getElementById('clearAll').addEventListener('click', () => toggleAllAccounts(false));

  // Set default dates
  const now = new Date();
  const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  document.getElementById('endDate').value = now.toISOString().slice(0, 10);
  document.getElementById('startDate').value = monthAgo.toISOString().slice(0, 10);

  // Set default EOD dates
  document.getElementById('eodEndDate').value = now.toISOString().slice(0, 10);
  document.getElementById('eodStartDate').value = monthAgo.toISOString().slice(0, 10);
});

// ── UI Helpers ────────────────────────────────────────
function setStatus(type, msg) {
  const el = document.getElementById('statusBar');
  el.className = `status ${type}`;
  el.textContent = msg;
}

function setProgress(pct, text) {
  document.getElementById('progressSection').classList.remove('hidden');
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = text;
}

function hideProgress() {
  document.getElementById('progressSection').classList.add('hidden');
}

function toggleMode() {
  const mode = document.getElementById('mode').value;
  document.getElementById('latestCount').classList.toggle('hidden', mode !== 'latest');
  document.getElementById('dateRange').classList.toggle('hidden', mode !== 'historical');
}

function onDataTypeChange() {
  const type = document.getElementById('dataType').value;
  const isSnapshot = type === 'balance' || type === 'position';
  const isTimeseries = type === 'equity_timeseries';
  document.getElementById('dateSection').classList.toggle('hidden', isSnapshot || isTimeseries);
  document.getElementById('groupSection').classList.toggle('hidden', !isTimeseries);
  document.getElementById('accountSection').classList.toggle('hidden', isTimeseries);
}

function toggleAllAccounts(checked) {
  document.querySelectorAll('#accountList input[type="checkbox"]').forEach(cb => {
    cb.checked = checked;
  });
}

// ── Load Accounts ─────────────────────────────────────
async function loadAccounts() {
  try {
    const statusResp = await apiFetch('/cefi/api/account_status');
    const statusData = await statusResp.json();
    const statuses = statusData.result?.statuses || [];

    // Extract active accounts (not ARCHIVED)
    const accounts = statuses
      .filter(s => s.accountStatus !== 'ARCHIVED')
      .map(s => ({
        venueAccountId: s.result?.id,
        venueAccount: s.result?.venueAccount
      }))
      .filter(a => a.venueAccountId);

    if (accounts.length > 0) {
      venueAccounts = accounts;
      renderAccounts(accounts);
    } else {
      await loadAccountsFallback();
    }
  } catch (e) {
    console.error('Failed to load accounts:', e);
    await loadAccountsFallback();
  }
}

async function loadAccountsFallback() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: 'getGroups' }, async (resp) => {
      const group = resp?.currentGroup || 'Open Eden Vault';
      const summaryResp = await apiFetch(
        `/cefi/api/summary?group=${encodeURIComponent(group)}&equitySummaryIncludeVenueAccounts=true&equitySummaryStartTs=90000000000000`
      );
      const summaryData = await summaryResp.json();
      const result = summaryData.result || summaryData;

      if (result.venueAccounts) {
        venueAccounts = result.venueAccounts;
        renderAccounts(result.venueAccounts);
      } else if (result.equitySummary?.venueAccounts) {
        venueAccounts = result.equitySummary.venueAccounts;
        renderAccounts(result.equitySummary.venueAccounts);
      } else {
        const allAccounts = extractAccounts(result);
        venueAccounts = allAccounts;
        renderAccounts(allAccounts);
      }
    });
  } catch (e) {
    const container = document.getElementById('accountList');
    container.textContent = 'Could not load accounts. Make sure you are on a Group Summary page.';
  }
}

function extractAccounts(obj) {
  const accounts = [];
  const seen = new Set();
  JSON.stringify(obj, (key, value) => {
    if (key === 'venueAccountId' && !seen.has(value)) {
      seen.add(value);
      accounts.push({ venueAccountId: value, name: '' });
    }
    if (key === 'venueAccount' && typeof value === 'string') {
      const last = accounts[accounts.length - 1];
      if (last && !last.name) last.name = value;
    }
    return value;
  });
  return accounts;
}

function renderAccounts(accounts) {
  const container = document.getElementById('accountList');
  // Clear existing content safely
  while (container.firstChild) container.removeChild(container.firstChild);

  if (!accounts || accounts.length === 0) {
    container.textContent = 'No accounts found.';
    return;
  }

  for (const acc of accounts) {
    const id = acc.venueAccountId || acc.id;
    const name = acc.venueAccount || acc.name || acc.venueAccountName || `Account ${id}`;

    const row = document.createElement('div');
    row.className = 'checkbox-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `acc_${id}`;
    checkbox.value = id;
    checkbox.checked = true;

    const label = document.createElement('label');
    label.htmlFor = `acc_${id}`;
    label.textContent = name;

    row.appendChild(checkbox);
    row.appendChild(label);
    container.appendChild(row);
  }
}

// ── API Fetch ─────────────────────────────────────────
function apiFetch(path) {
  const url = path.startsWith('http') ? path : baseUrl + path;
  return fetch(url, {
    headers: { 'Authorization': 'Bearer ' + authToken }
  });
}

// ── Download ──────────────────────────────────────────
async function downloadData() {
  const dataType = document.getElementById('dataType').value;
  const mode = document.getElementById('mode').value;
  const count = parseInt(document.getElementById('count').value) || 1000;

  // Get selected account IDs (not needed for timeseries)
  const isTimeseries = dataType === 'equity_timeseries' || dataType === 'position_timeseries';
  const selectedIds = Array.from(
    document.querySelectorAll('#accountList input[type="checkbox"]:checked')
  ).map(cb => cb.value);

  if (!isTimeseries && selectedIds.length === 0) {
    setStatus('err', 'Select at least one account.');
    return;
  }

  const idsParam = selectedIds.join(',');
  document.getElementById('downloadBtn').disabled = true;
  setProgress(10, 'Fetching data...');

  try {
    let allData = [];

    if (dataType === 'equity_timeseries' || dataType === 'position_timeseries') {
      const group = document.getElementById('groupName').value.trim();
      if (!group) {
        setStatus('err', 'Please enter a group name.');
        document.getElementById('downloadBtn').disabled = false;
        hideProgress();
        return;
      }
      allData = await fetchTimeseries(dataType, group);
    } else if (dataType === 'balance' || dataType === 'position') {
      allData = await fetchSnapshot(dataType, idsParam);
    } else if (mode === 'latest') {
      allData = await fetchLatest(dataType, idsParam, count);
    } else {
      const start = new Date(document.getElementById('startDate').value + 'T00:00:00Z').getTime();
      const end = new Date(document.getElementById('endDate').value + 'T23:59:59Z').getTime();
      if (!start || !end) {
        setStatus('err', 'Please set both start and end dates.');
        document.getElementById('downloadBtn').disabled = false;
        hideProgress();
        return;
      }
      allData = await fetchHistorical(dataType, idsParam, start, end);
    }

    setProgress(80, `Processing ${allData.length} records...`);

    if (allData.length === 0) {
      setStatus('info', 'No data found for the selected criteria.');
      document.getElementById('downloadBtn').disabled = false;
      hideProgress();
      return;
    }

    const csv = toCSV(allData, dataType);
    const filename = `haruko_${dataType}_${new Date().toISOString().slice(0, 10)}.csv`;
    downloadFile(csv, filename);

    setProgress(100, `Done! ${allData.length} records exported.`);
    setStatus('ok', `Exported ${allData.length} records to ${filename}`);
  } catch (e) {
    console.error('Download error:', e);
    setStatus('err', `Error: ${e.message}`);
  }

  document.getElementById('downloadBtn').disabled = false;
}

// ── Fetch Functions ───────────────────────────────────
async function fetchLatest(dataType, idsParam, count) {
  const endpoint = getEndpoint(dataType);
  const extraParams = dataType === 'trades' ? '&includeStaticData=true' : '';
  const url = `/cefi/api/aggregate/${endpoint}?venueAccountIds=${idsParam}&latest=${count}&orderByDirection=DESC${extraParams}`;

  const resp = await apiFetch(url);
  const data = await resp.json();
  return extractEntries(data, dataType);
}

async function fetchHistorical(dataType, idsParam, startTs, endTs) {
  const endpoint = getEndpoint(dataType);
  const extraParams = dataType === 'trades' ? '&includeStaticData=true' : '';
  const url = `/cefi/api/aggregate/${endpoint}?venueAccountIds=${idsParam}&startTimestamp=${startTs}&endTimestamp=${endTs}&orderByDirection=DESC${extraParams}`;

  const resp = await apiFetch(url);
  const data = await resp.json();
  return extractEntries(data, dataType);
}

async function fetchSnapshot(dataType, idsParam) {
  let url;
  if (dataType === 'balance') {
    url = `/cefi/api/aggregate/balance?zeroBalances=false&venueAccountIds=${idsParam}`;
  } else {
    url = `/cefi/api/aggregate/position?venueAccountIds=${idsParam}&optionsPricingSource=VENUE`;
  }

  const resp = await apiFetch(url);
  const data = await resp.json();
  return extractEntries(data, dataType);
}

// Detect margin collateral by comparing live balances vs latest timeseries snapshot
async function detectMarginCollateral(timeSeries) {
  const latest = timeSeries[timeSeries.length - 1];
  if (!latest) return [];

  const accounts = latest.accountEquity || [];
  if (accounts.length === 0) return [];

  // Build map of timeseries balances per account per asset
  const tsBalances = {};
  for (const acct of accounts) {
    tsBalances[acct.id] = {};
    for (const asset of (acct.assets || [])) {
      tsBalances[acct.id][asset.asset] = asset.eqUsd;
    }
  }

  // Fetch live balances for all accounts
  const accountIds = accounts.map(a => a.id).join(',');
  const resp = await apiFetch(`/cefi/api/aggregate/balance?zeroBalances=false&venueAccountIds=${accountIds}`);
  const data = await resp.json();
  const liveBalances = data.result?.balances || [];

  // Find gaps: live balance has equity but timeseries shows 0 or much less
  const marginItems = [];
  for (const va of liveBalances) {
    const vaId = va.venueAccountId;
    const tsAcct = tsBalances[vaId] || {};

    for (const bal of (va.balances || [])) {
      const liveUsd = bal.equityUsd || (bal.equity * (bal.refPx || 0));
      const tsUsd = tsAcct[bal.asset] || 0;
      const gap = liveUsd - tsUsd;

      // If the gap is significant (>$100) — this is margin collateral
      if (gap > 100) {
        // Find which derivative position this margin supports
        const positions = latest.equitySummary?.positions || [];
        const relatedPos = positions.find(p =>
          p.symbol.startsWith(bal.asset) || p.symbol.startsWith(bal.asset + '-')
        );

        marginItems.push({
          accountId: vaId,
          asset: bal.asset,
          marginQty: bal.equity - (findTsQty(accounts, vaId, bal.asset)),
          marginUsd: gap,
          markPx: bal.refPx || 0,
          symbol: relatedPos?.symbol || bal.asset + '-PERP',
          positionQty: relatedPos?.position || 0,
        });
      }
    }
  }

  return marginItems;
}

function findTsQty(accounts, vaId, asset) {
  const acct = accounts.find(a => a.id === vaId);
  if (!acct || !acct.assets) return 0;
  const a = acct.assets.find(x => x.asset === asset);
  return a ? a.eq : 0;
}

async function fetchTimeseries(dataType, group) {
  const url = `/cefi/api/group_summary_curve?group=${encodeURIComponent(group)}&includeAccountBreakdown=true&notionalType=DEFAULT&includePositions=true&refreshLiveBalances=false&includeEquity=true&pnlSource=DEFAULT`;

  setProgress(20, 'Fetching timeseries data...');
  const resp = await apiFetch(url);
  const data = await resp.json();
  let timeSeries = data.result?.timeSeries || [];
  const detailLevel = document.getElementById('detailLevel').value;

  // Filter by selected date range
  const eodStart = document.getElementById('eodStartDate').value;
  const eodEnd = document.getElementById('eodEndDate').value;
  if (eodStart) {
    const startMs = new Date(eodStart).getTime();
    timeSeries = timeSeries.filter(e => e.timestamp >= startMs);
  }
  if (eodEnd) {
    const endMs = new Date(eodEnd).getTime() + 86400000;
    timeSeries = timeSeries.filter(e => e.timestamp < endMs);
  }

  // Fetch live balances to detect margin collateral gaps
  setProgress(40, 'Fetching live balances for margin detection...');
  const marginData = await detectMarginCollateral(timeSeries);

  setProgress(60, `Processing ${timeSeries.length} daily snapshots...`);

  if (dataType === 'equity_timeseries') {
    const all = [];

    for (const entry of timeSeries) {
      const date = new Date(entry.timestamp).toISOString();
      const summary = entry.equitySummary;
      if (!summary) continue;

      const accounts = entry.accountEquity || [];
      const snapshotEquity = accounts.length > 0
        ? accounts.reduce((sum, a) => sum + (a.totalEquityUsd || 0), 0)
        : summary.totalEquityUsd;

      // Calculate margin collateral for this entry using position data
      // Margin collateral scales with position size × mark price per day
      let marginCollateralUsd = 0;
      for (const mg of marginData) {
        // Find matching position in this entry's positions to scale historically
        const pos = (summary.positions || []).find(p => p.symbol === mg.symbol);
        if (pos) {
          // Scale margin proportionally: (current margin / current position) × historical position
          const ratio = mg.positionQty !== 0 ? mg.marginUsd / Math.abs(mg.positionQty * mg.markPx) : 0;
          marginCollateralUsd += Math.abs(pos.position * pos.mark) * ratio;
        } else {
          // Position didn't exist at this date — no margin needed
        }
      }
      marginCollateralUsd = Math.round(marginCollateralUsd * 100) / 100;

      const adjustedEquityUsd = Math.round((snapshotEquity + marginCollateralUsd) * 100) / 100;

      if (detailLevel === 'collapse') {
        all.push({
          date,
          totalEquityUsd: adjustedEquityUsd,
          snapshotEquityUsd: snapshotEquity,
          marginCollateralUsd,
          changeUsd: summary.chgEqUsd,
          totalExposure: summary.totalExposure,
          leverage: summary.leverage,
          notional: summary.notional,
        });
      } else if (detailLevel === 'expand_asset') {
        if (summary.assets) {
          for (const asset of summary.assets) {
            const pct = adjustedEquityUsd ? (asset.eqUsd / adjustedEquityUsd * 100) : 0;
            all.push({
              date,
              totalEquityUsd: adjustedEquityUsd,
              type: 'spot',
              asset: asset.asset,
              quantity: asset.eq,
              refPx: asset.refPx,
              equityUsd: asset.eqUsd,
              equityPct: Math.round(pct * 100) / 100,
              notionalUsd: '',
              changeQuantity: asset.chgEq,
              changeUsd: asset.chgEqUsd,
            });
          }
        }
        if (marginCollateralUsd > 0) {
          const pct = adjustedEquityUsd ? (marginCollateralUsd / adjustedEquityUsd * 100) : 0;
          all.push({
            date,
            totalEquityUsd: adjustedEquityUsd,
            type: 'margin_collateral',
            asset: 'Margin Collateral (est.)',
            quantity: '',
            refPx: '',
            equityUsd: marginCollateralUsd,
            equityPct: Math.round(pct * 100) / 100,
            notionalUsd: '',
            changeQuantity: '',
            changeUsd: '',
          });
        }
        if (summary.positions) {
          for (const pos of summary.positions) {
            all.push({
              date,
              totalEquityUsd: adjustedEquityUsd,
              type: 'derivative_exposure',
              asset: pos.symbol,
              quantity: pos.position,
              refPx: pos.mark,
              equityUsd: '',
              equityPct: '',
              notionalUsd: pos.positionUsd,
              changeQuantity: '',
              changeUsd: '',
            });
          }
        }
      } else if (detailLevel === 'expand_account') {
        for (const acct of accounts) {
          if (!acct.assets) continue;
          const acctMargin = marginData
            .filter(m => m.accountId === acct.id)
            .reduce((s, m) => {
              const pos = (summary.positions || []).find(p => p.symbol === m.symbol);
              if (!pos || m.positionQty === 0) return s;
              const ratio = m.marginUsd / Math.abs(m.positionQty * m.markPx);
              return s + Math.abs(pos.position * pos.mark) * ratio;
            }, 0);
          const adjAcctEquity = acct.totalEquityUsd + Math.round(acctMargin * 100) / 100;

          for (const asset of acct.assets) {
            const pct = adjAcctEquity ? (asset.eqUsd / adjAcctEquity * 100) : 0;
            all.push({
              date,
              accountId: acct.id,
              accountName: acct.name,
              venue: acct.venue,
              accountEquityUsd: adjAcctEquity,
              totalEquityUsd: adjustedEquityUsd,
              type: 'spot',
              asset: asset.asset,
              quantity: asset.eq,
              refPx: asset.refPx,
              equityUsd: asset.eqUsd,
              equityPct: Math.round(pct * 100) / 100,
              notionalUsd: '',
              changeQuantity: asset.chgEq,
              changeUsd: asset.chgEqUsd,
            });
          }
          if (acctMargin > 0) {
            const pct = adjAcctEquity ? (acctMargin / adjAcctEquity * 100) : 0;
            all.push({
              date,
              accountId: acct.id,
              accountName: acct.name,
              venue: acct.venue,
              accountEquityUsd: adjAcctEquity,
              totalEquityUsd: adjustedEquityUsd,
              type: 'margin_collateral',
              asset: 'Margin Collateral (est.)',
              quantity: '',
              refPx: '',
              equityUsd: Math.round(acctMargin * 100) / 100,
              equityPct: Math.round(pct * 100) / 100,
              notionalUsd: '',
              changeQuantity: '',
              changeUsd: '',
            });
          }
        }
        if (summary.positions) {
          for (const pos of summary.positions) {
            const parts = (pos.agg || '').split('-');
            const acctName = parts.length >= 3 ? parts[2] : '';
            const acctId = parts.length >= 4 ? parts[3] : '';
            all.push({
              date,
              accountId: acctId,
              accountName: acctName,
              venue: pos.venue,
              accountEquityUsd: '',
              totalEquityUsd: adjustedEquityUsd,
              type: 'derivative_exposure',
              asset: pos.symbol,
              quantity: pos.position,
              refPx: pos.mark,
              equityUsd: '',
              equityPct: '',
              notionalUsd: pos.positionUsd,
              changeQuantity: '',
              changeUsd: '',
            });
          }
        }
      }
    }
    return all;
  }

  return [];
}

function getEndpoint(dataType) {
  const map = {
    wallet_transactions: 'wallet_transactions',
    trades: 'trades',
    transfers: 'transfers',
    balance_adjustments: 'balance_adjustments'
  };
  return map[dataType] || dataType;
}

function extractEntries(data, dataType) {
  const result = data.result || data;

  // Trades: entries are in result.entries
  if (result.entries && Array.isArray(result.entries)) {
    return result.entries;
  }

  // Wallet transactions: nested in wallets[].walletTransactions[]
  if (dataType === 'wallet_transactions' && result.wallets) {
    const all = [];
    for (const wallet of result.wallets) {
      if (wallet.walletTransactions) {
        for (const tx of wallet.walletTransactions) {
          if (tx.transactions && Array.isArray(tx.transactions)) {
            for (const subTx of tx.transactions) {
              all.push({
                ...flattenTx(tx),
                ...subTx
              });
            }
          } else {
            all.push(flattenTx(tx));
          }
        }
      }
    }
    return all;
  }

  // Balances: result.balances[] → each has venueAccountId + balances[]
  if (dataType === 'balance' && result.balances) {
    const all = [];
    for (const va of result.balances) {
      const vaId = va.venueAccountId;
      if (va.balances) {
        for (const b of va.balances) {
          const { referencePrice, assetMetadata, additionalData, ...rest } = b;
          all.push({
            venueAccountId: vaId,
            ...rest,
            markPrice: referencePrice?.referencePrice || null,
            priceType: referencePrice?.referencePriceType || null,
            priceSymbol: referencePrice?.symbol || null,
            priceVenue: referencePrice?.venue || null,
          });
        }
      }
    }
    return all;
  }

  // Positions: result.positions[] → each has venueAccountId + futuresPositions/optionsPositions/etc
  if (dataType === 'position' && result.positions) {
    const all = [];
    for (const va of result.positions) {
      const vaId = va.venueAccountId;
      const posTypes = ['futuresPositions', 'optionsPositions', 'assetBackedTokenPositions', 'marginPositions'];
      for (const posType of posTypes) {
        if (va[posType]) {
          for (const p of va[posType]) {
            const { staticData, ...rest } = p;
            all.push({
              venueAccountId: vaId,
              positionType: posType.replace('Positions', ''),
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
    }
    return all;
  }

  // Transfers/balance_adjustments: try entries or nested
  if (result.venueAccounts && Array.isArray(result.venueAccounts)) {
    if (typeof result.venueAccounts[0] === 'string' && result.entries) {
      return result.entries;
    }
    const all = [];
    for (const va of result.venueAccounts) {
      if (typeof va === 'object') {
        const items = va.transfers || va.balanceAdjustments || va.entries || [];
        const vaName = va.venueAccount || va.name;
        for (const item of items) {
          all.push({ venueAccount: vaName, ...item });
        }
      }
    }
    if (all.length > 0) return all;
  }

  // Fallback: try to find any array
  for (const key of Object.keys(result)) {
    if (Array.isArray(result[key]) && result[key].length > 0 && typeof result[key][0] === 'object') {
      return result[key];
    }
  }

  return [];
}

function flattenTx(tx) {
  const { transactions, additionalDataFields, ...rest } = tx;
  return rest;
}

// ── CSV Conversion ────────────────────────────────────
function toCSV(data, dataType) {
  if (data.length === 0) return '';

  const keySet = new Set();
  for (const row of data) {
    for (const key of Object.keys(row)) {
      if (key !== 'additionalDataFields' && key !== 'staticData') {
        keySet.add(key);
      }
    }
  }

  const staticKeys = new Set();
  for (const row of data) {
    if (row.staticData && typeof row.staticData === 'object') {
      for (const k of Object.keys(row.staticData)) {
        staticKeys.add(k);
      }
    }
  }

  const headers = [...keySet, ...[...staticKeys].map(k => `static_${k}`)];

  const formatValue = (val, key) => {
    if (val === null || val === undefined) return '';
    if (key === 'timestamp' || key === 'settlementDate') {
      if (typeof val === 'number' && val > 1e12) {
        return new Date(val).toISOString();
      }
    }
    if (typeof val === 'object') return JSON.stringify(val);
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const rows = [headers.join(',')];
  for (const row of data) {
    const values = headers.map(h => {
      if (h.startsWith('static_')) {
        const realKey = h.replace('static_', '');
        return formatValue(row.staticData?.[realKey], realKey);
      }
      return formatValue(row[h], h);
    });
    rows.push(values.join(','));
  }

  return rows.join('\n');
}

// ── File Download ─────────────────────────────────────
function downloadFile(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
