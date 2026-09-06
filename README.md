# BTC 5M Predictor — iPhone PWA

A free, read-only/paper-trading web app for Polymarket's BTC Up/Down 5-minute markets.

## What it does
- Connects to Polymarket RTDS Chainlink BTC/USD over WebSocket.
- Detects the current 5-minute cycle.
- Uses the first 90 seconds only.
- Locks a UP/DOWN signal at +90s.
- Shows a confidence score and diagnostics.
- Finds the current BTC 5m Polymarket event from the public Gamma API.
- Sends a browser notification if permission is granted.
- Saves decisions locally for later calibration.
- NEVER places trades and NEVER asks for a private key.

## Important
Polymarket's current 5-minute crypto markets resolve using a 60-second Chainlink TWAP (per the Aug 14, 2026 Polymarket changelog). The model uses the Polymarket RTDS Chainlink reference feed, but its prediction formula is a transparent heuristic, not a proven profitable strategy. Paper trade and collect a meaningful sample before risking money.

## iPhone deployment
1. Create a public GitHub repository, e.g. `btc-5m-predictor`.
2. Upload `index.html`, `app.js`, `manifest.webmanifest`, and `sw.js`.
3. Enable GitHub Pages for the repository.
4. Open the Pages URL in Safari.
5. Share → Add to Home Screen.
6. Open the installed app and tap "Enable 90s alerts".
7. Keep the app open/active during the 5-minute cycles. iOS may suspend web apps in the background; this version does not promise background execution.

## Next upgrade
For true background alerts, move the prediction engine to a continuously running backend and send Telegram/push notifications. A free Cloudflare Worker can handle lightweight HTTP jobs, but a 90-second recurring signal should not rely on a 1-minute Cron Trigger for exact timing.
