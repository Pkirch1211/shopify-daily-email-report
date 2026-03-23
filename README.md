# Shopify Sales Reporter — GitHub Actions

Sends daily Shopify sales reports via email, with an optional AI-generated insight blurb powered by Claude.

## Setup

### 1. Create the repo
Create a new **private** GitHub repo and push this folder to it.

### 2. Add GitHub Secrets
Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**

Add each of these:

| Secret Name | Value |
|---|---|
| `SHOPIFY_DTC_STORE` | `lifelines-dtc.myshopify.com` |
| `SHOPIFY_DTC_TOKEN` | Your DTC Admin API token (`shpat_...`) |
| `SHOPIFY_WHOLESALE_STORE` | `lifelines-wholesale.myshopify.com` |
| `SHOPIFY_WHOLESALE_TOKEN` | Your Wholesale Admin API token (`shpat_...`) |
| `GMAIL_USER` | `paul.kirchner0@gmail.com` |
| `GMAIL_PASS` | Your Gmail App Password |
| `GMAIL_FROM` | `sales@lifelines.com` (display name) |
| `RECIPIENTS_ALL` | Comma-separated emails for the All Stores report |
| `RECIPIENTS_DTC` | Comma-separated emails for the DTC-only report |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (for AI insight blurb) |

### 3. Enable Actions
Go to **Actions** tab in your repo and enable workflows if prompted.

### 4. Test it manually
Go to **Actions → Daily Sales Report → Run workflow** and pick:
- Schedule: `all` or `dtc`
- Date range: `yesterday`, `7days`, or `30days`

Hit **Run workflow** and watch the logs.

## Schedule
Runs automatically every day at **00:30 EST** (05:30 UTC).

Both jobs run in parallel — All Stores and DTC-only send at the same time.

## How it works
1. Fetches orders from Shopify with full pagination (no 250 order cap)
2. Calculates revenue, orders, AOV, shipping, discounts, top products
3. Compares to prior period
4. Generates a 2-3 sentence AI insight via Claude API
5. Sends a formatted HTML email via Gmail SMTP

## Disabling the AI blurb
Remove `ANTHROPIC_API_KEY` from secrets — the script will skip the blurb gracefully.
# shopify-daily-email-report
