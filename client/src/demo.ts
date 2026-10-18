import { QuotaCoreClient } from "./quotacore.js";

export interface DemoState {
  apiKey: string;
  accountId: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// QuotaCore may still be starting (for example under Docker Compose).
export async function waitForQuotaCore(
  baseUrl: string,
  attempts = 60
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // not reachable yet
    }

    if (attempt === 1) {
      console.log(`Waiting for QuotaCore at ${baseUrl} ...`);
    }
    await sleep(1000);
  }

  throw new Error(`QuotaCore did not become reachable at ${baseUrl}`);
}

// Creates a fresh demo account with two account plans and two user plans,
// and registers two users on different plans:
//
//   Account  "Demo Account Small"  60 units/month, 30 per request   (shared)
//   Ahmad    "Demo Basic"          40 units/month, 10 per request
//   Sara     "Demo Premium"       200 units/month, 30 per request
//
// Sara's plan allows far more than the account does. That is on purpose: a
// larger user allowance does not enlarge the account's shared allowance.
//
// The admin key is used only here, to create the account. Every later call
// uses the account's own API key, which stays on this server.
export async function bootstrapDemo(
  baseUrl: string,
  adminKey: string
): Promise<DemoState> {
  const response = await fetch(`${baseUrl}/accounts`, {
    method: "POST",
    headers: {
      "X-Admin-Key": adminKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: `DocuFlow Demo ${new Date().toISOString().slice(0, 19)}`,
      planName: "Starter",
    }),
  });

  const body = (await response.json()) as {
    apiKey?: string;
    account?: { id: string };
  };

  if (!response.ok || !body.apiKey || !body.account) {
    throw new Error(
      `Could not create the demo account (${response.status}): ${JSON.stringify(body)}`
    );
  }

  const client = new QuotaCoreClient(baseUrl, body.apiKey);

  const small = await client.createPlan("Demo Account Small", "account", 60, 30);
  await client.createPlan("Demo Account Large", "account", 200, 100);
  await client.switchAccountPlan(small.id);

  const basic = await client.createPlan("Demo Basic", "user", 40, 10);
  const premium = await client.createPlan("Demo Premium", "user", 200, 30);

  await client.createUser("ahmad", basic.id);
  await client.createUser("sara", premium.id);

  return { apiKey: body.apiKey, accountId: body.account.id };
}