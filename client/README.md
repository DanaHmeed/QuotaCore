# DocuFlow – QuotaCore example client

A small example application that shows how a real product uses QuotaCore. DocuFlow "processes documents" (the work is simulated; one page costs one unit). Before doing any work it asks QuotaCore whether the user may consume the units, and it only does the work when the answer is yes.

## What it demonstrates

- Two users under the same account on **different plans** (Ahmad on Basic, Sara on Premium).
- An **accepted** action.
- A rejection caused by a **user limit** (Ahmad's maximum units per request).
- A rejection caused by the **shared account limit** (Sara has plenty of her own allowance, but the account does not).
- **Changing plans** (switching a user, switching the account, editing a plan) and seeing the effect on the very next request, **without changing or redeploying the client code**.
- **Safe retries**: failed calls are retried with the same `requestId`, and the page can resend the last request to show that QuotaCore answers with the original decision instead of counting it twice.

## How it is built

| File | Role |
|---|---|
| `src/quotacore.ts` | The only code that knows how QuotaCore is called (typed HTTP wrapper) |
| `src/demo.ts` | Creates the demo account, plans and users |
| `src/server.ts` | The application backend: processes documents and serves the page |
| `public/index.html` | The web page |

The account's API key stays on the server (`src/server.ts`). The browser only talks to this server and never sees the key, which is how a real integration should work.

The admin bootstrap key is used once, to create the demo account. Every other call uses the account's own API key.

## Demo setup

| Who | Plan | Monthly allowance | Max per request |
|---|---|---|---|
| Account (shared) | Demo Account Small | 60 | 30 |
| Account (alternative) | Demo Account Large | 200 | 100 |
| Ahmad | Demo Basic | 40 | 10 |
| Sara | Demo Premium | 200 | 30 |

Sara's plan allows more than the whole account does. A larger user allowance never enlarges the account's shared allowance.

## Run it locally

Start QuotaCore first (from the project root):

```
docker compose up -d db
npm run dev
```

Then, in a second terminal (PowerShell):

```
cd client
npm install
$env:QUOTACORE_ADMIN_KEY = (Select-String -Path ..\.env -Pattern '^ADMIN_BOOTSTRAP_KEY=(.*)$').Matches.Groups[1].Value
npm start
```

Open http://localhost:4000 and press **Run all steps**.

| Variable | Default | Meaning |
|---|---|---|
| `QUOTACORE_URL` | `http://localhost:3000` | Where QuotaCore is running |
| `QUOTACORE_ADMIN_KEY` | none (required on first run) | Used once to create the demo account |
| `PORT` | `4000` | Port of this application |
| `STATE_FILE` | `.demo-state.json` | Remembers the demo account between runs |

The first start creates a demo account and saves its key in `.demo-state.json` (do not commit it). Later starts reuse it. **Reset demo** creates a brand-new account, which is the way to replay the demo from zero, because usage only resets at the start of a UTC month.