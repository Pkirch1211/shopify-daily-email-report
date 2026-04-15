#!/usr/bin/env node
/**
 * Shopify Sales Reporter — GitHub Actions standalone sender
 * Reads config from environment variables (GitHub Secrets)
 * Usage: node send-report.js --schedule all|dtc
 */

const nodemailer = require('nodemailer');
const Anthropic = require('@anthropic-ai/sdk');

// ── Config from environment ───────────────────────────────────────────────────
const SCHEDULE = process.argv[2] === '--schedule' ? process.argv[3] : 'all';
const STORE_TZ = 'America/New_York';
const DAY_MS = 86400000;

const STORES = {
  dtc: {
    name: 'Lifelines - DTC',
    store: process.env.SHOPIFY_DTC_STORE,
    token: process.env.SHOPIFY_DTC_TOKEN,
  },
  wholesale: {
    name: 'Lifelines - Wholesale',
    store: process.env.SHOPIFY_WHOLESALE_STORE,
    token: process.env.SHOPIFY_WHOLESALE_TOKEN,
  },
};

const EMAIL = {
  host: 'smtp.gmail.com',
  port: 587,
  user: process.env.GMAIL_USER,
  pass: process.env.GMAIL_PASS,
  from: process.env.GMAIL_FROM || process.env.GMAIL_USER,
};

const SCHEDULE_CONFIG = {
  all: {
    stores: [STORES.dtc, STORES.wholesale],
    recipients: (process.env.RECIPIENTS_ALL || '').split(',').map(s => s.trim()).filter(Boolean),
  },
  dtc: {
    stores: [STORES.dtc],
    recipients: (process.env.RECIPIENTS_DTC || '').split(',').map(s => s.trim()).filter(Boolean),
  },
};

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DATE_RANGE = process.env.DATE_RANGE || 'yesterday'; // yesterday | 7days | 30days | today

// ── Time / date helpers (Eastern Time, consistent windows) ───────────────────
function getEasternTodayKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const y = parts.find(p => p.type === 'year')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  const d = parts.find(p => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function dayKeyToUtcNoonMs(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 12, 0, 0, 0);
}

function shiftDayKey(dayKey, deltaDays) {
  const shifted = new Date(dayKeyToUtcNoonMs(dayKey) + deltaDays * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

function diffDaysInclusive(startKey, endKey) {
  const diff = Math.round((dayKeyToUtcNoonMs(endKey) - dayKeyToUtcNoonMs(startKey)) / DAY_MS);
  return diff + 1;
}

function easternOffsetForDay(dayKey) {
  // Use noon UTC on the target day to determine the ET offset for that calendar day.
  const probe = new Date(dayKeyToUtcNoonMs(dayKey));
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: STORE_TZ,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
  }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value || 'GMT-5';

  const match = tzPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return '-05:00';

  const sign = match[1] === '-' ? '-' : '+';
  const hours = String(parseInt(match[2], 10)).padStart(2, '0');
  const mins = String(parseInt(match[3] || '0', 10)).padStart(2, '0');
  return `${sign}${hours}:${mins}`;
}

function buildEasternIso(dayKey, endOfDay = false) {
  const offset = easternOffsetForDay(dayKey);
  const time = endOfDay ? '23:59:59' : '00:00:00';
  return `${dayKey}T${time}${offset}`;
}

function labelForRange(dateRange) {
  return {
    today: 'Today',
    yesterday: 'Yesterday',
    '7days': 'Last 7 Days',
    '30days': 'Last 30 Days',
  }[dateRange] || dateRange;
}

function formatDayKeyForDisplay(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function makeRange(startKey, endKey, dateRange) {
  return {
    dateRange,
    label: labelForRange(dateRange),
    startKey,
    endKey,
    startIso: buildEasternIso(startKey, false),
    endIso: buildEasternIso(endKey, true),
    startDateDisplay: formatDayKeyForDisplay(startKey),
    endDateDisplay: formatDayKeyForDisplay(endKey),
  };
}

function resolveCurrentRange(dateRange) {
  const todayKey = getEasternTodayKey();

  if (dateRange === 'yesterday') {
    const key = shiftDayKey(todayKey, -1);
    return makeRange(key, key, 'yesterday');
  }

  if (dateRange === '7days') {
    return makeRange(shiftDayKey(todayKey, -6), todayKey, '7days');
  }

  if (dateRange === '30days') {
    return makeRange(shiftDayKey(todayKey, -29), todayKey, '30days');
  }

  return makeRange(todayKey, todayKey, 'today');
}

function derivePreviousRange(currentRange) {
  const span = diffDaysInclusive(currentRange.startKey, currentRange.endKey);
  const prevEndKey = shiftDayKey(currentRange.startKey, -1);
  const prevStartKey = shiftDayKey(prevEndKey, -(span - 1));
  return makeRange(prevStartKey, prevEndKey, `prior_${currentRange.dateRange}`);
}

function getYesterdayRange() {
  const todayKey = getEasternTodayKey();
  const yKey = shiftDayKey(todayKey, -1);
  return makeRange(yKey, yKey, 'yesterday');
}

function getYtdRange() {
  const todayKey = getEasternTodayKey();
  const year = todayKey.slice(0, 4);
  return makeRange(`${year}-01-01`, todayKey, 'ytd');
}

// ── Shopify fetch with pagination ─────────────────────────────────────────────
async function fetchAllOrders(store, token, params) {
  let orders = [];
  let nextUrl = `https://${store}/admin/api/2024-01/orders.json${params}`;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Shopify API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const data = await res.json();
    orders = orders.concat(data.orders || []);

    const link = res.headers.get('link') || '';
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }

  return orders;
}

function buildCreatedAtParams(range) {
  const qs = new URLSearchParams({
    status: 'any',
    created_at_min: range.startIso,
    created_at_max: range.endIso,
    limit: '250',
  });
  return `?${qs.toString()}`;
}

async function fetchOrdersForRange(store, token, range) {
  return fetchAllOrders(store, token, buildCreatedAtParams(range));
}

// ── Aggregation helpers ───────────────────────────────────────────────────────
function makeProductKey(item) {
  return String(item.variant_id || item.product_id || `${item.title}__${item.variant_title || ''}`);
}

function aggregateRevenueMetrics(orders) {
  let totalRevenue = 0;
  let totalItems = 0;
  let totalShipping = 0;
  let totalDiscounts = 0;

  for (const order of orders) {
    totalRevenue += parseFloat(order.total_price || 0);
    totalShipping += parseFloat(order.total_shipping_price_set?.shop_money?.amount || 0);
    totalDiscounts += parseFloat(order.total_discounts || 0);

    for (const item of order.line_items || []) {
      totalItems += Number(item.quantity || 0);
    }
  }

  return {
    total: totalRevenue,
    orders: orders.length,
    items: Math.round(totalItems),
    aov: orders.length ? totalRevenue / orders.length : 0,
    shipping: totalShipping,
    discounts: totalDiscounts,
  };
}

function aggregateProducts(orders) {
  const map = new Map();

  for (const order of orders) {
    for (const item of order.line_items || []) {
      const key = makeProductKey(item);
      const qty = Number(item.quantity || 0);
      const revenue = parseFloat(item.price || 0) * qty;

      if (!map.has(key)) {
        map.set(key, {
          key,
          name: item.title || 'Untitled Product',
          variant: item.variant_title && item.variant_title !== 'Default Title' ? item.variant_title : '',
          qty: 0,
          revenue: 0,
        });
      }

      const row = map.get(key);
      row.qty += qty;
      row.revenue += revenue;
    }
  }

  return map;
}

function mergeProductWindows(yesterdayMap, ytdMap, limit = 18) {
  const keys = new Set([...yesterdayMap.keys(), ...ytdMap.keys()]);
  const merged = [];

  for (const key of keys) {
    const y = yesterdayMap.get(key);
    const ytd = ytdMap.get(key);

    merged.push({
      key,
      name: y?.name || ytd?.name || 'Untitled Product',
      variant: y?.variant || ytd?.variant || '',
      yesterdayQty: y?.qty || 0,
      yesterdayRevenue: y?.revenue || 0,
      ytdQty: ytd?.qty || 0,
      ytdRevenue: ytd?.revenue || 0,
    });
  }

  return merged
    .sort((a, b) => {
      const byYesterday = b.yesterdayRevenue - a.yesterdayRevenue;
      if (byYesterday !== 0) return byYesterday;
      const byYtd = b.ytdRevenue - a.ytdRevenue;
      if (byYtd !== 0) return byYtd;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

// ── Store data fetch ──────────────────────────────────────────────────────────
async function fetchStoreData(storeObj, dateRange) {
  const { store, token, name } = storeObj;

  const currentRange = resolveCurrentRange(dateRange);
  const previousRange = derivePreviousRange(currentRange);
  const yesterdayRange = getYesterdayRange();
  const ytdRange = getYtdRange();

  const [currentOrders, previousOrders, ytdOrders] = await Promise.all([
    fetchOrdersForRange(store, token, currentRange),
    fetchOrdersForRange(store, token, previousRange),
    currentRange.startKey === yesterdayRange.startKey && currentRange.endKey === yesterdayRange.endKey
      ? Promise.resolve(null)
      : fetchOrdersForRange(store, token, ytdRange),
  ]);

  const yesterdayOrders =
    currentRange.startKey === yesterdayRange.startKey && currentRange.endKey === yesterdayRange.endKey
      ? currentOrders
      : await fetchOrdersForRange(store, token, yesterdayRange);

  const resolvedYtdOrders = ytdOrders || await fetchOrdersForRange(store, token, ytdRange);

  const revenue = aggregateRevenueMetrics(currentOrders);
  const comparisonMetrics = aggregateRevenueMetrics(previousOrders);

  const yesterdayProducts = aggregateProducts(yesterdayOrders);
  const ytdProducts = aggregateProducts(resolvedYtdOrders);
  const mergedProducts = mergeProductWindows(yesterdayProducts, ytdProducts);

  return {
    storeName: name,
    storeUrl: store,
    dateRange,
    rangeLabel: currentRange.label,
    startDate: currentRange.startDateDisplay,
    endDate: currentRange.endDateDisplay,
    revenue,
    comparison: {
      revenue: comparisonMetrics.total,
      orders: comparisonMetrics.orders,
    },
    productsMerged: mergedProducts,
  };
}

// ── LLM blurb ─────────────────────────────────────────────────────────────────
async function generateBlurb(dataArr) {
  if (!ANTHROPIC_KEY) return null;

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

    const summary = dataArr.map(d => {
      const revChg = d.comparison.revenue
        ? (((d.revenue.total - d.comparison.revenue) / d.comparison.revenue) * 100).toFixed(1)
        : null;

      const topYesterday = d.productsMerged.find(p => p.yesterdayRevenue > 0);
      const topYtd = [...d.productsMerged].sort((a, b) => b.ytdRevenue - a.ytdRevenue)[0];

      return `${d.storeName}: $${d.revenue.total.toFixed(2)} revenue, ${d.revenue.orders} orders, AOV $${d.revenue.aov.toFixed(2)}${revChg ? `, ${revChg}% vs prior period` : ''}. Top yesterday product: ${topYesterday?.name || 'N/A'}. Top YTD product: ${topYtd?.name || 'N/A'}.`;
    }).join(' ');

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: `Write a 2-3 sentence sales commentary for a daily email report. Be concise, insightful, and vary your tone and observations. Avoid bullet points and headers. Here is today's data: ${summary}`,
      }],
    });

    return msg.content?.[0]?.text || null;
  } catch (err) {
    console.warn('LLM blurb failed:', err.message);
    return null;
  }
}

// ── Email HTML ────────────────────────────────────────────────────────────────
function fmt(n) {
  return '$' + (n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmt0(n) {
  return '$' + Math.round(n || 0).toLocaleString();
}

function fmtN(n) {
  return (n || 0).toLocaleString();
}

function pct(a, b) {
  return !b ? null : (((a - b) / b) * 100).toFixed(1);
}

function arrowHTML(v) {
  if (v === null) return '<span style="color:#a8a29e;">No prior period</span>';
  return parseFloat(v) >= 0
    ? `<span style="color:#3f7a5d;font-weight:700;">▲ ${v}%</span>`
    : `<span style="color:#b26a3c;font-weight:700;">▼ ${Math.abs(v)}%</span>`;
}

function buildMetricCard(label, value, change) {
  return `
    <td width="33.33%" style="padding:0 6px 12px 6px;vertical-align:top;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffdf9;border:1px solid #eadfd6;border-radius:18px;">
        <tr>
          <td style="padding:16px 16px 14px 16px;">
            <div style="color:#a07f6a;font-size:10px;letter-spacing:1.7px;text-transform:uppercase;font-family:Arial,sans-serif;margin-bottom:8px;">
              ${label}
            </div>
            <div style="color:#2f2a27;font-size:25px;line-height:1.12;font-weight:700;">
              ${value}
            </div>
            <div style="font-size:12px;line-height:1.45;margin-top:8px;color:#7c6f67;">
              ${arrowHTML(change)} <span style="color:#a1958d;">vs prior period</span>
            </div>
          </td>
        </tr>
      </table>
    </td>`;
}

function buildMiniStat(label, value) {
  return `
    <td style="padding:0 8px 0 0;vertical-align:top;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f1ea;border:1px solid #eadfd6;border-radius:14px;">
        <tr>
          <td style="padding:12px 14px;">
            <div style="color:#a07f6a;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;margin-bottom:4px;">
              ${label}
            </div>
            <div style="color:#473d37;font-size:15px;font-weight:600;">
              ${value}
            </div>
          </td>
        </tr>
      </table>
    </td>`;
}

function buildMergedProductsSection(products) {
  if (!products || !products.length) return '';

  const rows = products.map((p, i) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #efe7df;width:24px;color:#b29a8a;font-size:12px;vertical-align:top;">
        ${i + 1}
      </td>
      <td style="padding:12px 10px 12px 0;border-bottom:1px solid #efe7df;vertical-align:top;">
        <div style="color:#2f2a27;font-size:13px;font-weight:600;line-height:1.45;">${p.name}</div>
        ${p.variant ? `<div style="color:#9b8b80;font-size:11px;line-height:1.4;margin-top:2px;">${p.variant}</div>` : ''}
      </td>
      <td style="padding:12px 8px;border-bottom:1px solid #efe7df;text-align:right;vertical-align:top;white-space:nowrap;">
        <div style="color:#7b6d64;font-size:12px;line-height:1.4;">${fmtN(Math.round(p.yesterdayQty))} units</div>
        <div style="color:#7a5c49;font-size:12px;font-weight:700;line-height:1.4;">${fmt0(p.yesterdayRevenue)}</div>
      </td>
      <td style="padding:12px 0 12px 8px;border-bottom:1px solid #efe7df;text-align:right;vertical-align:top;white-space:nowrap;">
        <div style="color:#7b6d64;font-size:12px;line-height:1.4;">${fmtN(Math.round(p.ytdQty))} units</div>
        <div style="color:#7a5c49;font-size:12px;font-weight:700;line-height:1.4;">${fmt0(p.ytdRevenue)}</div>
      </td>
    </tr>
  `).join('');

  return `
    <tr>
      <td colspan="3">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #eadfd6;border-radius:18px;">
          <tr>
            <td style="padding:16px 18px;">
              <div style="color:#a07f6a;font-size:10px;letter-spacing:1.8px;text-transform:uppercase;margin-bottom:10px;">
                Product Performance
              </div>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:0 0 8px 0;color:#b29a8a;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;"></td>
                  <td style="padding:0 10px 8px 0;color:#b29a8a;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;">Product</td>
                  <td style="padding:0 8px 8px 8px;color:#b29a8a;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;text-align:right;">Yesterday</td>
                  <td style="padding:0 0 8px 8px;color:#b29a8a;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;text-align:right;">Year to Date</td>
                </tr>
                ${rows}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function buildStoreSection(data) {
  const revC = pct(data.revenue.total, data.comparison.revenue);
  const ordC = pct(data.revenue.orders, data.comparison.orders);
  const prevAov = data.comparison.orders ? data.comparison.revenue / data.comparison.orders : 0;
  const aovC = pct(data.revenue.aov, prevAov);

  const dateRangeDisplay =
    data.startDate === data.endDate ? data.startDate : `${data.startDate} – ${data.endDate}`;

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px 0;">
      <tr>
        <td style="padding:0 0 16px 0;">
          <div style="color:#a8846a;font-size:10px;letter-spacing:1.8px;text-transform:uppercase;margin-bottom:6px;">
            ${data.rangeLabel}
          </div>
          <div style="color:#2f2a27;font-size:22px;line-height:1.2;font-weight:700;">
            ${data.storeName}
          </div>
          <div style="color:#9b8b80;font-size:12px;line-height:1.5;margin-top:4px;">
            ${dateRangeDisplay}
          </div>
        </td>
      </tr>

      <tr>
        ${buildMetricCard('Revenue', fmt(data.revenue.total), revC)}
        ${buildMetricCard('Orders', fmtN(data.revenue.orders), ordC)}
        ${buildMetricCard('Avg Order Value', fmt(data.revenue.aov), aovC)}
      </tr>

      <tr>
        <td colspan="3" style="padding:0 0 14px 0;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              ${buildMiniStat('Shipping', fmt(data.revenue.shipping))}
              ${buildMiniStat('Discounts', '-' + fmt(data.revenue.discounts))}
              ${buildMiniStat('Items', fmtN(data.revenue.items))}
            </tr>
          </table>
        </td>
      </tr>

      ${buildMergedProductsSection(data.productsMerged)}
    </table>`;
}

function buildEmailHTML(dataArr, blurb) {
  const isCombined = dataArr.length > 1;
  const totalRev = dataArr.reduce((s, d) => s + d.revenue.total, 0);
  const totalOrders = dataArr.reduce((s, d) => s + d.revenue.orders, 0);

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const divider = `
    <tr>
      <td style="padding:0 0 28px 0;">
        <div style="height:1px;background:#ece3db;"></div>
      </td>
    </tr>`;

  const blurbHtml = blurb ? `
    <tr>
      <td style="padding:0 0 24px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6efe8;border:1px solid #eadfd6;border-radius:18px;">
          <tr>
            <td style="padding:16px 18px;">
              <div style="color:#a8846a;font-size:10px;letter-spacing:1.8px;text-transform:uppercase;margin-bottom:8px;">
                Daily Insight
              </div>
              <div style="color:#473d37;font-size:14px;line-height:1.7;">
                ${blurb}
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Lifelines Sales Report</title>
</head>
<body style="margin:0;padding:0;background:#f7f1eb;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f1eb;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;">

          <tr>
            <td style="padding:0 0 14px 0;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8efe6;border:1px solid #eadfd6;border-radius:24px;">
                <tr>
                  <td style="padding:22px 22px 20px 22px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="vertical-align:top;">
                          <div style="color:#a8846a;font-size:10px;letter-spacing:1.8px;text-transform:uppercase;margin-bottom:8px;">
                            Lifelines Daily Flow
                          </div>
                          <div style="color:#2f2a27;font-size:28px;line-height:1.15;font-weight:700;">
                            Sales Report
                          </div>
                          <div style="color:#7e7068;font-size:13px;line-height:1.6;margin-top:6px;">
                            ${dateStr}
                          </div>
                        </td>
                        ${isCombined ? `
                        <td align="right" style="vertical-align:top;">
                          <div style="color:#7a5c49;font-size:28px;line-height:1;font-weight:700;">
                            ${fmt(totalRev)}
                          </div>
                          <div style="color:#8d7d72;font-size:12px;line-height:1.5;margin-top:8px;">
                            ${fmtN(totalOrders)} orders across ${dataArr.length} stores
                          </div>
                        </td>` : ''}
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:0;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffaf6;border:1px solid #eadfd6;border-radius:24px;">
                <tr>
                  <td style="padding:24px 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      ${blurbHtml}
                      ${dataArr.map(buildStoreSection).join(divider)}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="text-align:center;padding:14px 0 0 0;color:#b5a59a;font-size:11px;line-height:1.5;">
              Lifelines Shopify Sales Reporter
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Send email ────────────────────────────────────────────────────────────────
async function sendEmail(recipients, html, storeNames) {
  const transporter = nodemailer.createTransport({
    host: EMAIL.host,
    port: EMAIL.port,
    secure: false,
    requireTLS: true,
    auth: { user: EMAIL.user, pass: EMAIL.pass },
    tls: { rejectUnauthorized: false, minVersion: 'TLSv1.2' },
  });

  await transporter.sendMail({
    from: EMAIL.from ? `${EMAIL.from} <${EMAIL.user}>` : EMAIL.user,
    to: recipients.join(', '),
    subject: `📊 Sales Report — ${storeNames}`,
    html,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const schedCfg = SCHEDULE_CONFIG[SCHEDULE];
  if (!schedCfg) {
    console.error(`Unknown schedule: ${SCHEDULE}`);
    process.exit(1);
  }

  if (!schedCfg.recipients.length) {
    console.error('No recipients configured.');
    process.exit(1);
  }

  console.log(`Running schedule: ${SCHEDULE} | stores: ${schedCfg.stores.map(s => s.name).join(', ')} | range: ${DATE_RANGE}`);

  const dataArr = await Promise.all(
    schedCfg.stores.map(s => fetchStoreData(s, DATE_RANGE))
  );

  console.log(
    `Fetched data: ${dataArr.map(d => `${d.storeName} — ${d.revenue.orders} orders, ${fmt(d.revenue.total)}`).join(' | ')}`
  );

  const blurb = await generateBlurb(dataArr);
  if (blurb) console.log(`AI blurb: ${blurb}`);

  const html = buildEmailHTML(dataArr, blurb);
  const storeNames = dataArr.map(d => d.storeName).join(', ');

  await sendEmail(schedCfg.recipients, html, storeNames);

  console.log(`✓ Email sent to: ${schedCfg.recipients.join(', ')}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
