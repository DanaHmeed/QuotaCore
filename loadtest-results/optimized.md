## Load test results: optimized

- Date: 2026-10-20T08:33:07.567Z
- Machine: 12th Gen Intel(R) Core(TM) i7-1255U, 12 logical cores, 16 GB RAM, win32
- Node.js: v22.15.0
- Target: http://localhost:3000 (docker compose stack)
- 15 s per scenario, 50 connections (scenario D: at most 20 connections and 5 s)

| Scenario | Connections | Requests | Requests/s | Latency p50 / p99 (ms) | Failed | Correctness check |
|---|---|---|---|---|---|---|
| A. 20 accounts x 10 users | 50 | 6561 | 437 | 108 / 200 | 0 | pass: 6611 units counted, every account total equals the sum of its users: true |
| B. 1 hot account x 50 users | 50 | 2723 | 182 | 261 / 411 | 0 | pass: 2773 units counted, account total equals the sum of users: true |
| C. Limits under load (account 1000, users 150) | 50 | 3437 | 229 | 212 / 297 | 0 | pass: accepted 1000 of 1000 allowed, busiest user 122 of 150, 3437 requests sent |
| D. Retry storm (one request id) | 20 | 1247 | 249 | 76 / 130 | 0 | pass: 1247 identical requests, counted once: true |
