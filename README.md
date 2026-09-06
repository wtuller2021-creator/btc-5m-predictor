# BTC 5M Pro

A read-only Progressive Web App for researching Polymarket's BTC Up/Down 5-minute markets.

## What is improved

- Professional responsive mobile-first dashboard.
- Live Chainlink BTC/USD feed from Polymarket RTDS.
- One locked UP/DOWN prediction at +90 seconds.
- Prediction ledger stored in localStorage.
- Resolution verification uses Polymarket's resolved market state rather than guessing the result from a live quote.
- Pending results remain pending until the resolution is available.
- Accuracy, correct count, verified count, average confidence, and current win streak.
- Export prediction history as JSON.
- Browser notification support.
- Connection and market-status diagnostics.
- Read-only: no wallet, private key, or automatic trading.

## Important

The prediction formula is a transparent heuristic, not a proven profitable strategy. Use the ledger to evaluate it over a large sample before risking money.
