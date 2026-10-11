# Live Arbitrage Radar — Render/GitHub build

A single Node.js service that serves the mobile browser UI and its live scanner API. It is designed for deployment on Render or any Node/Docker host that provides HTTPS.

## Deploy on Render (recommended)

1. Create a GitHub repository and upload the contents of this folder.
2. In Render, choose **New → Blueprint** and select that repository.
3. Render will read `render.yaml` and create the web service.
4. After deployment, Render provides a public HTTPS address such as `https://your-service-name.onrender.com`.
5. Open that URL in Android Chrome.

No exchange API keys are required for public market data.

## Local

```bash
npm install
npm start
```

Open `http://localhost:8787`.

Plumbing smoke test:

```bash
MOCK_MODE=true npm run smoke
```

## Configuration

`render.yaml` sets:
- `MOCK_MODE=false` — live public exchange data
- `POLL_MS=5000` — scan interval
- `TRADE_USDT=50` — quote size used for VWAP estimates

You can change these in Render environment variables.

## Scanner notes

- Spot/spot, spot/futures and futures/futures modes.
- Order-book VWAP is used instead of top-of-book prices.
- Trading fees are estimated from CCXT taker fees when available.
- Transfer fees are only deducted when a compatible deposit/withdraw network and withdrawal fee are actually exposed by both exchanges; otherwise the row is marked `TRANSFER_UNVERIFIED`/UNKNOWN rather than inventing a cost.
- Network status is collected where an exchange exposes currency/network metadata.
- A disappeared spread is **not** proof that another trader executed or exploited it.
- Public REST polling can be rate-limited and is not equivalent to colocated execution. This scanner is an opportunity detector, not an execution guarantee.

## GitHub

This project is intentionally simple: push the repository contents as-is. Do not commit exchange API keys, private keys, seed phrases, or wallet secrets.
