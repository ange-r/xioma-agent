import dotenv from "dotenv";
import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { createEd25519Signer, getNetworkPassphrase } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

dotenv.config();

const NETWORK = process.env.NETWORK;
const STELLAR_RPC_URL = process.env.STELLAR_RPC_URL;
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY;
const SERVER_URL = "http://localhost:3001";
const ENDPOINT = "/analyze-cashflow";

async function main() {
  console.log("[Xioma Client] Starting...");

  // Signer takes the private key and builds the Soroban authorization
  // that cryptographically authorizes the on-chain payment.
  // The private key never leaves this process — only the signature is transmitted.
  const signer = createEd25519Signer(CLIENT_PRIVATE_KEY, NETWORK);
  console.log(`[Xioma Client] Wallet address: ${signer.address}`);

  // RPC config points to the Stellar node used to query account state
  // (sequence number, balance) and simulate transactions before signing.
  const rpcConfig = { url: STELLAR_RPC_URL };

  // x402Client registers the Stellar payment scheme and handles
  // the full protocol automatically: receives 402, builds payload, signs, retries.
  const client = new x402Client().register(
    "stellar:*",
    new ExactStellarScheme(signer, rpcConfig),
  );
  const httpClient = new x402HTTPClient(client);

  const url = new URL(ENDPOINT, SERVER_URL).toString();

  // First request without payment — expected to receive 402
  console.log("[Xioma Client] Sending unpaid request...");
  const firstTry = await fetch(url, { method: "POST" });
  console.log(`[Xioma Client] Server responded with status: ${firstTry.status}`);

  // Read payment instructions from the 402 response header.
  // Contains: amount required, network, recipient address, facilitator URL.
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => firstTry.headers.get(name),
  );
  console.log(`[Xioma Client] Payment required — amount: ${paymentRequired?.accepts?.[0]?.price ?? "see header"} to ${paymentRequired?.accepts?.[0]?.payTo ?? "see header"}`);

  // Build the payment payload: constructs the Stellar transaction
  // with the Soroban authorization entry signed by the client wallet.
  console.log("[Xioma Client] Building and signing payment payload...");
  let paymentPayload = await client.createPaymentPayload(paymentRequired);

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

  // Encode the signed payment into the request header and retry with business payload.
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
  console.log("[Xioma Client] Sending paid request with cashflow data...");

  const paidResponse = await fetch(url, {
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

  // Settlement response confirms the transaction was settled on-chain.
  // Contains the transaction hash that can be verified on Stellar explorer.
  const paymentResponse = httpClient.getPaymentSettleResponse(
    (name) => paidResponse.headers.get(name),
  );
  console.log("[Xioma Client] Settlement confirmed:", paymentResponse);

  const data = await paidResponse.json();
  console.log("[Xioma Client] Agent response:", data);
}

main().catch((err) => {
  console.error("[Xioma Client] Error:", err.message);
  process.exit(1);
});
