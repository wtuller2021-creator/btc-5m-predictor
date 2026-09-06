# BTC EDGE AI v4

Professional read-only PWA for Polymarket BTC Up/Down 5-minute markets.

## What is new
- AI-style adaptive prediction engine combining quantitative ensemble signals with an online logistic classifier.
- Model trains only from **verified** WIN/LOSS records.
- One prediction is frozen at exactly +90 seconds using the Polymarket event clock.
- Resolution is not inferred from the model. A record becomes WIN/LOSS only after the market is closed, UMA resolution status is `resolved`, and a decisive resolved outcome is present.
- Persistent local prediction ledger with export.
- Live Chainlink RTDS BTC/USD feed.
- Model diagnostics, agreement, training count, confidence, and quality display.
- No wallet, private keys, or automatic trading.

## Important
No model can honestly guarantee extremely high accuracy. The adaptive model is designed to improve from verified outcomes and expose its measured performance rather than fabricate confidence.
