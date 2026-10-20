## Load test results: baseline

- Date: 2026-10-20T08:17:20.958Z
- Machine: 12th Gen Intel(R) Core(TM) i7-1255U, 12 logical cores, 16 GB RAM, win32
- Node.js: v22.15.0
- Target: http://localhost:3000 (docker compose stack)
- 15 s per scenario, 50 connections (scenario D: at most 20 connections and 5 s)

| Scenario | Connections | Requests | Requests/s | Latency p50 / p99 (ms) | Failed | Correctness check |
|---|---|---|---|---|---|---|
| A. 20 accounts x 10 users | 50 | 6658 | 444 | 104 / 250 | 0 | pass: 6708 units counted, every account total equals the sum of its users: true |
| B. 1 hot account x 50 users | 50 | 2740 | 183 | 264 / 399 | 0 | pass: 2790 units counted, account total equals the sum of users: true |
| C. Limits under load (account 1000, users 150) | 50 | 3269 | 218 | 219 / 345 | 0 | pass: accepted 1000 of 1000 allowed, busiest user 128 of 150, 3269 requests sent |
| D. Retry storm (one request id) | 20 | 1299 | 260 | 74 / 105 | 0 | pass: 1299 identical requests, counted once: true |
