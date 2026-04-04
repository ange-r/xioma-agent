import dotenv from "dotenv";
import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { createEd25519Signer, getNetworkPassphrase } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import pkg from '@stellar/stellar-sdk';
const { rpc, Contract, scValToNative, Address } = pkg;

dotenv.config();

// Validate required environment variables at startup.
// Fail fast with a clear message instead of a cryptic error later.
const REQUIRED_ENV = [
  "NETWORK",
  "STELLAR_RPC_URL",
  "CLIENT_PRIVATE_KEY",
  "USDC_CONTRACT_ID",
];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`[Xioma Client] Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const NETWORK = process.env.NETWORK;
const STELLAR_RPC_URL = process.env.STELLAR_RPC_URL;
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY;
const USDC_CONTRACT_ID = process.env.USDC_CONTRACT_ID;
const SERVER_URL = "http://localhost:3001";
const ENDPOINT = "/analyze-cashflow";
const SERVICE_PRICE_USDC = 0.01;

// Check USDC balance before attempting any payment.
// Prevents sending a transaction that will fail due to insufficient funds.
async function checkUsdcBalance(rpcUrl, walletAddress, contractId) {
  const server = new rpc.Server(rpcUrl);
  const contract = new Contract(contractId);

  try {
    const account = await server.getAccount(walletAddress);
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: getNetworkPassphrase(NETWORK),
    })
      .addOperation(
        contract.call(
          "balance",
          // Pass the address as a Soroban ScVal
          Address.fromString(walletAddress).toScVal()
        )
      )
      .setTimeout(30)
      .build();

    const result = await server.simulateTransaction(tx);
    if ("result" in result && result.result?.retval) {
      const balance = scValToNative(result.result.retval);
      // USDC has 7 decimals on Stellar
      return Number(balance) / 10_000_000;
    }
    return null;
  } catch (err) {
    console.warn(`[Xioma Client] Could not fetch USDC balance: ${err.message}`, err);
    return null;
  }
}

async function main() {
  console.log("[Xioma Client] Starting...");

  const signer = createEd25519Signer(CLIENT_PRIVATE_KEY, NETWORK);
  console.log(`[Xioma Client] Wallet address: ${signer.address}`);

  const rpcConfig = { url: STELLAR_RPC_URL };

  // Check balance before attempting payment
  console.log("[Xioma Client] Checking USDC balance...");
  const balance = await checkUsdcBalance(STELLAR_RPC_URL, signer.address, USDC_CONTRACT_ID);
  if (balance !== null) {
    console.log(`[Xioma Client] USDC balance: ${balance}`);
    if (balance < SERVICE_PRICE_USDC) {
      console.error(`[Xioma Client] Insufficient balance. Required: ${SERVICE_PRICE_USDC} USDC, available: ${balance} USDC`);
      process.exit(1);
    }
  }

  const client = new x402Client().register(
    "stellar:*",
    new ExactStellarScheme(signer, rpcConfig),
  );
  const httpClient = new x402HTTPClient(client);
  const url = new URL(ENDPOINT, SERVER_URL).toString();

  // First request without payment — expected to receive 402
  console.log("[Xioma Client] Sending unpaid request...");
  let firstTry;
  try {
    firstTry = await fetch(url, { method: "POST" });
    console.log(`[Xioma Client] Server responded with status: ${firstTry.status}`);
  } catch (err) {
    console.error(`[Xioma Client] Could not reach server at ${SERVER_URL}: ${err.message}`);
    process.exit(1);
  }

  // Read payment instructions from the 402 response header
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => firstTry.headers.get(name),
  );
  console.log(`[Xioma Client] Payment required — amount: ${paymentRequired?.accepts?.[0]?.price ?? "see header"} to ${paymentRequired?.accepts?.[0]?.payTo ?? "see header"}`);

  // Build and sign the payment payload
  let paymentPayload;
  try {
    console.log("[Xioma Client] Building and signing payment payload...");
    paymentPayload = await client.createPaymentPayload(paymentRequired);

    // Testnet workaround: set fee to 1 stroop to avoid facilitator limit issues.
    // Do not remove — transactions may fail on testnet without this.
    const networkPassphrase = getNetworkPassphrase(NETWORK);
    const tx = new Transaction(
      paymentPayload.payload.transaction,
      networkPassphrase,
    );
    const sorobanData = tx.toEnvelope().v1()?.tx()?.ext()?.sorobanData();
    if (sorobanData) {
      paymentPayload = {
        ...paymentPayload,
        payload: {
          ...paymentPayload.payload,
          transaction: TransactionBuilder.cloneFrom(tx, {
            fee: "1",
            sorobanData,
            networkPassphrase,
          })
            .build()
            .toXDR(),
        },
      };
    }
  } catch (err) {
    console.error(`[Xioma Client] Failed to build payment payload: ${err.message}`);
    process.exit(1);
  }

  // Send paid request with business payload
  let paidResponse;
  try {
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
    console.log("[Xioma Client] Sending paid request with cashflow data...");

    paidResponse = await fetch(url, {
      method: "POST",
      headers: {
        ...paymentHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: 1000,
        currency: "USDC",
        obligations: {
          salaries: 0.4,
          suppliers: 0.35,
          taxes: 0.25,
        },
      }),
    });
  } catch (err) {
    console.error(`[Xioma Client] Paid request failed: ${err.message}`);
    process.exit(1);
  }

  // Settlement confirmation with on-chain transaction hash
  const paymentResponse = httpClient.getPaymentSettleResponse(
    (name) => paidResponse.headers.get(name),
  );
  console.log("[Xioma Client] Settlement confirmed:", paymentResponse);

  const data = await paidResponse.json();
  console.log("[Xioma Client] Agent response:", data);
}

main().catch((err) => {
  console.error("[Xioma Client] Unexpected error:", err.message);
  process.exit(1);
});