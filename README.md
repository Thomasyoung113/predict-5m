# predict-5m

Autonomous 5-Minute Bitcoin Up/Down Event Predictor & Paper Trading Engine.
Modeled after `event-predictor`, specialized for Polymarket's continuous 24/7 `btc-updown-5m` contracts.

## How It Works
1. **Real-time Velocity:** Monitors spot price movements across live oracles.
2. **Orderbook Inefficiencies:** Exploits pricing lag on Polymarket CLOB books.
3. **Paper Simulation:** Records entry positions in `positions.json`.
4. **Resolution:** Verifies Chainlink TWAP outcomes and tracks PnL & win rate metrics.

## Running Locally
```bash
node predictor.js scan      # Run single scan
node predictor.js resolve   # Resolve ended contracts
node predictor.js report    # View performance metrics
node predictor.js watch     # Run 30s continuous background loop
```
