#!/usr/bin/env node
/**
 * Shopify Sales Reporter — GitHub Actions standalone sender
 * Reads config from environment variables (GitHub Secrets)
 * Usage: node send-report.js --schedule all|dtc
 */

const nodemailer = require('nodemailer');
const Anthropic  = require('@anthropic-ai/sdk');

// ── Config from environment ───────────────────────────────────────────────────
const SCHEDULE = process.argv[2] === '--schedule' ? process.argv[3] : 'all';

const STORES = {
  dtc: {
    name:  'Lifelines - DTC',
    store: process.env.SHOPIFY_DTC_STORE,   // e.g. lifelines-dtc.myshopify.com
    token: process.env.SHOPIFY_DTC_TOKEN,
  },
  wholesale: {
    name:  'Lifelines - Wholesale',
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

// Which stores + recipients per schedule
const SCHEDULE_CONFIG = {
  all: {
    stores:     [STORES.dtc, STORES.wholesale],
    recipients: (process.env.RECIPIENTS_ALL || '').split(',').map(s => s.trim()).filter(Boolean),
  },
  dtc: {
    stores:     [STORES.dtc],
    recipients: (process.env.RECIPIENTS_DTC || '').split(',').map(s => s.trim()).filter(Boolean),
  },
};

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DATE_RANGE    = process.env.DATE_RANGE || 'yesterday'; // yesterday | 7days | 30days

// ── Date resolution (Eastern Time) ───────────────────────────────────────────
function resolveDates(dateRange) {
  const STORE_TZ = 'America/New_York';

  function toEasternDay(date, offsetDays) {
    const d = new Date(date.getTime() + (offsetDays || 0) * 86400000);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: STORE_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    const y  = parts.find(p => p.type === 'year').value;
    const mo = parts.find(p => p.type === 'month').value;
    const dy = parts.find(p => p.type === 'day').value;
    return { y, mo, dy };
  }

  const now = new Date();
  let startDate, endDate;

  if (dateRange === 'yesterday') {
    const { y, mo, dy } = toEasternDay(now, -1);
    startDate = new Date(`${y}-${mo}-${dy}T00:00:00-05:00`);
    endDate   = new Date(`${y}-${mo}-${dy}T23:59:59-05:00`);
  } else if (dateRange === '7days') {
    const s = toEasternDay(now, -7);
    const e = toEasternDay(now, 0);
    startDate = new Date(`${s.y}-${s.mo}-${s.dy}T00:00:00-05:00`);
    endDate   = new Date(`${e.y}-${e.mo}-${e.dy}T23:59:59-05:00`);
  } else if (dateRange === '30days') {
    const s = toEasternDay(now, -30);
    const e = toEasternDay(now, 0);
    startDate = new Date(`${s.y}-${s.mo}-${s.dy}T00:00:00-05:00`);
    endDate   = new Date(`${e.y}-${e.mo}-${e.dy}T23:59:59-05:00`);
  } else {
    // today
    const { y, mo, dy } = toEasternDay(now, 0);
    startDate = new Date(`${y}-${mo}-${dy}T00:00:00-05:00`);
    endDate   = new Date(`${y}-${mo}-${dy}T23:59:59-05:00`);
  }

  return { startDate, endDate };
}

// ── Shopify fetch with pagination ─────────────────────────────────────────────
async function fetchAllOrders(store, token, params) {
  let orders  = [];
  let nextUrl = `https://${store}/admin/api/2024-01/orders.json${params}`;
  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error(`Shopify API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    orders = orders.concat(data.orders || []);
    const link  = res.headers.get('link') || '';
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }
  return orders;
}

async function fetchStoreData(storeObj, dateRange) {
  const { store, token, name } = storeObj;
  const { startDate, endDate } = resolveDates(dateRange);

  const params = `?status=any&created_at_min=${startDate.toISOString()}&created_at_max=${endDate.toISOString()}&limit=250`;
  const orders = await fetchAllOrders(store, token, params);

  let totalRevenue = 0, totalItems = 0, totalShipping = 0, totalDiscounts = 0;
  const productMap = {};

  for (const order of orders) {
    totalRevenue    += parseFloat(order.total_price || 0);
    totalShipping   += parseFloat(order.total_shipping_price_set?.shop_money?.amount || 0);
    totalDiscounts  += parseFloat(order.total_discounts || 0);
    for (const item of (order.line_items || [])) {
      totalItems += item.quantity;
      const key = item.variant_id || item.product_id || item.title;
      if (!productMap[key]) productMap[key] = { name: item.title, variant: item.variant_title || '', qty: 0, revenue: 0 };
      productMap[key].qty     += item.quantity;
      productMap[key].revenue += parseFloat(item.price) * item.quantity;
    }
  }

  const topProducts = Object.values(productMap).sort((a, b) => b.revenue - a.revenue).slice(0, 15);

  // Previous period for comparison
  const dayMs    = 86400000;
  const rangeDays = Math.max(1, Math.round((endDate - startDate) / dayMs));
  const prevEnd   = new Date(startDate.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - rangeDays * dayMs + dayMs);
  prevStart.setHours(0, 0, 0, 0); prevEnd.setHours(23, 59, 59, 999);

  let prevRevenue = 0, prevOrders = 0;
  try {
    const prevParams = `?status=any&created_at_min=${prevStart.toISOString()}&created_at_max=${prevEnd.toISOString()}&limit=250`;
    const prevOrdersList = await fetchAllOrders(store, token, prevParams);
    for (const o of prevOrdersList) { prevRevenue += parseFloat(o.total_price || 0); prevOrders++; }
  } catch {}

  return {
    storeName: name, storeUrl: store, dateRange,
    startDate: startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    endDate:   endDate.toLocaleDateString('en-US',   { month: 'short', day: 'numeric', year: 'numeric' }),
    revenue: {
      total: totalRevenue, orders: orders.length,
      items: Math.round(totalItems), aov: orders.length ? totalRevenue / orders.length : 0,
      shipping: totalShipping, discounts: totalDiscounts,
    },
    comparison: { revenue: prevRevenue, orders: prevOrders },
    products: topProducts,
  };
}

// ── LLM blurb ─────────────────────────────────────────────────────────────────
async function generateBlurb(dataArr, dateRange) {
  if (!ANTHROPIC_KEY) return null;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const summary = dataArr.map(d => {
      const revChg = d.comparison.revenue ? (((d.revenue.total - d.comparison.revenue) / d.comparison.revenue) * 100).toFixed(1) : null;
      return `${d.storeName}: $${d.revenue.total.toFixed(2)} revenue, ${d.revenue.orders} orders, AOV $${d.revenue.aov.toFixed(2)}${revChg ? `, ${revChg}% vs prior period` : ''}. Top product: ${d.products[0]?.name || 'N/A'}.`;
    }).join(' ');

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: `Write a 2-3 sentence sales commentary for a daily email report. Be concise, insightful, and vary your tone and observations — avoid repeating the same sentence structures day over day. Focus on what's interesting or notable. Do not use bullet points or headers. Here is today's data: ${summary}`,
      }],
    });
    return msg.content[0]?.text || null;
  } catch (err) {
    console.warn('LLM blurb failed:', err.message);
    return null;
  }
}

// ── Email HTML ────────────────────────────────────────────────────────────────
function fmt(n)  { return '$' + (n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fmtN(n) { return (n || 0).toLocaleString(); }
function pct(a, b) { return !b ? null : (((a - b) / b) * 100).toFixed(1); }
function arrowHTML(v) {
  if (v === null) return '<span style="color:#999;">—</span>';
  return parseFloat(v) >= 0
    ? `<span style="color:#16a34a;">&#9650; ${v}%</span>`
    : `<span style="color:#dc2626;">&#9660; ${Math.abs(v)}%</span>`;
}

function buildStoreSection(data) {
  const accent = '#6366f1';
  const revC = pct(data.revenue.total, data.comparison.revenue);
  const ordC = pct(data.revenue.orders, data.comparison.orders);
  const prevAov = data.comparison.orders ? data.comparison.revenue / data.comparison.orders : 0;
  const aovC = pct(data.revenue.aov, prevAov);
  const labels = { today: 'Today', yesterday: 'Yesterday', '7days': 'Last 7 Days', '30days': 'Last 30 Days' };
  const dateLabel = labels[data.dateRange] || data.dateRange;
  const dateRange = data.startDate + (['7days','30days'].includes(data.dateRange) ? ' - ' + data.endDate : '');

  const statsRows = [
    { label: 'Revenue',         value: fmt(data.revenue.total),   color: accent,     chg: revC },
    { label: 'Orders',          value: fmtN(data.revenue.orders), color: '#ec4899',  chg: ordC },
    { label: 'Avg Order Value', value: fmt(data.revenue.aov),     color: '#0891b2',  chg: aovC },
  ].map(s =>
    `<tr><td style="padding:0 0 8px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
        <tr><td style="padding:12px 14px;">
          <div style="color:#64748b;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:4px;">${s.label}</div>
          <div style="color:${s.color};font-size:24px;font-weight:700;line-height:1;">${s.value}</div>
          <div style="font-size:11px;margin-top:5px;">${arrowHTML(s.chg)} <span style="color:#94a3b8;">vs prior period</span></div>
        </td></tr>
      </table>
    </td></tr>`
  ).join('');

  const productRows = data.products.map((p, i) =>
    `<tr style="border-bottom:1px solid #f1f5f9;">
      <td style="padding:10px 6px;color:#94a3b8;font-size:12px;width:24px;">${i+1}</td>
      <td style="padding:10px 6px;">
        <div style="color:#1e293b;font-size:13px;font-weight:600;">${p.name}</div>
        ${p.variant ? `<div style="color:#94a3b8;font-size:11px;">${p.variant}</div>` : ''}
      </td>
      <td style="padding:10px 6px;color:#64748b;font-size:12px;text-align:right;white-space:nowrap;">${Math.round(p.qty)} &times;</td>
      <td style="padding:10px 6px;color:${accent};font-weight:700;text-align:right;font-size:13px;white-space:nowrap;">$${Math.round(p.revenue).toLocaleString()}</td>
    </tr>`
  ).join('');

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr><td style="padding:0 0 14px;border-left:3px solid ${accent};padding-left:12px;">
        <div style="color:${accent};font-size:10px;letter-spacing:2px;text-transform:uppercase;font-family:monospace;">${dateLabel}</div>
        <div style="color:#0f172a;font-size:18px;font-weight:700;margin-top:2px;">${data.storeName}</div>
        <div style="color:#94a3b8;font-size:12px;margin-top:1px;">${dateRange}</div>
      </td></tr>
      ${statsRows}
      <tr><td style="padding:0 0 8px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;"><tr>
          <td style="padding:10px 12px;border-right:1px solid #e2e8f0;"><div style="color:#94a3b8;font-size:10px;font-family:monospace;text-transform:uppercase;letter-spacing:1px;">Shipping</div><div style="color:#475569;font-weight:600;margin-top:2px;">${fmt(data.revenue.shipping)}</div></td>
          <td style="padding:10px 12px;border-right:1px solid #e2e8f0;"><div style="color:#94a3b8;font-size:10px;font-family:monospace;text-transform:uppercase;letter-spacing:1px;">Discounts</div><div style="color:#ea580c;font-weight:600;margin-top:2px;">-${fmt(data.revenue.discounts)}</div></td>
          <td style="padding:10px 12px;"><div style="color:#94a3b8;font-size:10px;font-family:monospace;text-transform:uppercase;letter-spacing:1px;">Items</div><div style="color:#475569;font-weight:600;margin-top:2px;">${fmtN(data.revenue.items)}</div></td>
        </tr></table>
      </td></tr>
      ${productRows ? `<tr><td>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
          <tr><td style="padding:14px;">
            <div style="color:#94a3b8;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-family:monospace;margin-bottom:10px;">Top Products</div>
            <table width="100%" cellpadding="0" cellspacing="0">${productRows}</table>
          </td></tr>
        </table>
      </td></tr>` : ''}
    </table>`;
}

function buildEmailHTML(dataArr, blurb) {
  const accent      = '#6366f1';
  const isCombined  = dataArr.length > 1;
  const totalRev    = dataArr.reduce((s, d) => s + d.revenue.total, 0);
  const totalOrders = dataArr.reduce((s, d) => s + d.revenue.orders, 0);
  const dateStr     = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const divider     = '<tr><td style="padding:0 0 24px;"><div style="height:1px;background:#e2e8f0;"></div></td></tr>';

  const blurbHtml = blurb ? `
    <tr><td style="padding:0 0 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f1fe;border:1px solid #c7d2fe;border-radius:8px;">
        <tr><td style="padding:14px 16px;">
          <div style="color:#4338ca;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:6px;">✦ AI Insight</div>
          <div style="color:#1e293b;font-size:13px;line-height:1.6;">${blurb}</div>
        </td></tr>
      </table>
    </td></tr>` : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:16px 12px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
  <tr><td style="padding:0 0 12px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;">
      <tr><td style="padding:18px 20px;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="width:36px;"><div style="width:32px;height:32px;background:${accent};border-radius:8px;"></div></td>
          <td style="padding-left:10px;vertical-align:middle;">
            <div style="color:#0f172a;font-size:16px;font-weight:700;">Sales Report</div>
            <div style="color:#94a3b8;font-size:11px;margin-top:2px;">${dateStr}</div>
          </td>
          ${isCombined ? `<td align="right" style="vertical-align:middle;">
            <div style="color:${accent};font-size:18px;font-weight:700;">${fmt(totalRev)}</div>
            <div style="color:#94a3b8;font-size:11px;">${fmtN(totalOrders)} orders &middot; ${dataArr.length} stores</div>
          </td>` : ''}
        </tr></table>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px 16px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      ${blurbHtml}
      ${dataArr.map(buildStoreSection).join(divider)}
    </table>
  </td></tr>
  <tr><td style="text-align:center;color:#cbd5e1;font-size:10px;font-family:monospace;padding:14px 0;">Shopify Sales Reporter</td></tr>
</table></td></tr></table>
</body></html>`;
}

// ── Send email ────────────────────────────────────────────────────────────────
async function sendEmail(recipients, html, storeNames) {
  const transporter = nodemailer.createTransport({
    host: EMAIL.host, port: EMAIL.port,
    secure: false, requireTLS: true,
    auth: { user: EMAIL.user, pass: EMAIL.pass },
    tls: { rejectUnauthorized: false, minVersion: 'TLSv1.2' },
  });
  await transporter.sendMail({
    from: EMAIL.from ? `${EMAIL.from} <${EMAIL.user}>` : EMAIL.user,
    to:   recipients.join(', '),
    subject: `📊 Sales Report — ${storeNames}`,
    html,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const schedCfg = SCHEDULE_CONFIG[SCHEDULE];
  if (!schedCfg) { console.error(`Unknown schedule: ${SCHEDULE}`); process.exit(1); }
  if (!schedCfg.recipients.length) { console.error('No recipients configured.'); process.exit(1); }

  console.log(`Running schedule: ${SCHEDULE} | stores: ${schedCfg.stores.map(s => s.name).join(', ')} | range: ${DATE_RANGE}`);

  // Fetch data from all stores
  const dataArr = await Promise.all(schedCfg.stores.map(s => fetchStoreData(s, DATE_RANGE)));
  console.log(`Fetched data: ${dataArr.map(d => `${d.storeName} — ${d.revenue.orders} orders, ${fmt(d.revenue.total)}`).join(' | ')}`);

  // Generate LLM blurb
  const blurb = await generateBlurb(dataArr, DATE_RANGE);
  if (blurb) console.log(`AI blurb: ${blurb}`);

  // Build and send email
  const html       = buildEmailHTML(dataArr, blurb);
  const storeNames = dataArr.map(d => d.storeName).join(', ');
  await sendEmail(schedCfg.recipients, html, storeNames);

  console.log(`✓ Email sent to: ${schedCfg.recipients.join(', ')}`);
}

main().catch(err => { console.error('Fatal error:', err.message); process.exit(1); });
