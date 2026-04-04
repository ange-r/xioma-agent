import pkg from "@stellar/stellar-sdk";
const {
  Keypair,
  Asset,
  TransactionBuilder,
  Networks,
  Operation,
  Memo,
} = pkg;
import { rpc as StellarRpc } from "@stellar/stellar-sdk";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);
const NETWORK_PASSPHRASE = Networks.TESTNET;
const BASE_FEE = "100";

// Verifies that a destination account exists on the network.
// Called for all destinations before building the transaction —
// if any account is invalid, the entire earmarking is aborted.
async function verifyDestination(server, address, category) {
  try {
    await server.getAccount(address);
    console.log(`[Xioma Wallets] ${category}: ${address} ✓`);
  } catch (err) {
    throw new Error(
      `Destination account for "${category}" is invalid or does not exist: ${address}`
    );
  }
}

// Executes the full earmarking plan as a single multi-operation transaction.
// Source account is the CLIENT — the agent signs using multisig authorization.
// The client never shares their private key — they authorized the agent once via Set Options.
// All transfers succeed or none do — no partial state possible.
// One fee covers all operations.
export async function executeEarmarking(
  distributionPlan,
  destinationWallets,
  agentPrivateKey,
  clientPublicKey,
  rpcUrl
) {
  console.log("[Xioma Wallets] Starting on-chain earmarking...");

  // Validate inputs
  if (!agentPrivateKey) {
    throw new Error("Missing agent private key");
  }
  if (!clientPublicKey) {
    throw new Error("Missing client public key");
  }
  if (!destinationWallets || Object.keys(destinationWallets).length === 0) {
    throw new Error("Missing destination wallets");
  }

  let server;
  let agentKeypair;

  try {
    server = new StellarRpc.Server(rpcUrl);
    agentKeypair = Keypair.fromSecret(agentPrivateKey);
    console.log(`[Xioma Wallets] Agent signer: ${agentKeypair.publicKey()}`);
    console.log(`[Xioma Wallets] Client source account: ${clientPublicKey}`);
  } catch (err) {
    throw new Error(`Failed to initialize Stellar connection: ${err.message}`);
  }

  // Verify all destination accounts before building the transaction.
  // If any account is invalid, abort before touching any funds.
  console.log("[Xioma Wallets] Verifying destination accounts...");
  for (const [category, wallet] of Object.entries(destinationWallets)) {
    await verifyDestination(server, wallet, category);
  }

  // Filter categories that have a destination wallet and a non-zero amount
  const transfers = Object.entries(distributionPlan).filter(
    ([category, { amount }]) => {
      if (!destinationWallets[category]) {
        console.warn(
          `[Xioma Wallets] No destination wallet for "${category}" — skipping`
        );
        return false;
      }
      if (amount <= 0) {
        console.warn(
          `[Xioma Wallets] Zero amount for "${category}" — skipping`
        );
        return false;
      }
      return true;
    }
  );

  if (transfers.length === 0) {
    throw new Error("No valid transfers to execute");
  }

  // Build a single transaction sourced from the CLIENT account.
  // The agent signs it using the multisig authorization configured by the client.
  let transaction;
  try {
    // Load the CLIENT account — this is the source of funds
    const clientAccount = await server.getAccount(clientPublicKey);

    const builder = new TransactionBuilder(clientAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    }).addMemo(Memo.text("xioma:earmarking"));

    for (const [category, { amount }] of transfers) {
      builder.addOperation(
        Operation.payment({
          destination: destinationWallets[category],
          asset: USDC,
          amount: amount.toFixed(7),
        })
      );
      console.log(
        `[Xioma Wallets] Adding operation: ${category} → ${amount} USDC to ${destinationWallets[category]}`
      );
    }

    transaction = builder.setTimeout(30).build();

    // Agent signs the transaction — authorized via client's multisig setup
    transaction.sign(agentKeypair);
    console.log("[Xioma Wallets] Transaction signed by agent via multisig");
  } catch (err) {
    throw new Error(`Failed to build transaction: ${err.message}`);
  }

  // Submit the transaction — all operations execute atomically
  let result;
  try {
    console.log("[Xioma Wallets] Submitting transaction...");
    result = await server.submitTransaction(transaction);
    console.log(
      `[Xioma Wallets] Transaction confirmed — txHash: ${result.hash}`
    );
    console.log(
      `[Xioma Wallets] Explorer: https://stellar.expert/explorer/testnet/tx/${result.hash}`
    );
  } catch (err) {
    const detail =
      err.response?.data?.extras?.result_codes ?? err.message;
    throw new Error(`Transaction failed: ${JSON.stringify(detail)}`);
  }

  // Build results map with explorer links for each category
  const earmarkingResults = {};
  for (const [category, { amount }] of transfers) {
    earmarkingResults[category] = {
      amount,
      destination: destinationWallets[category],
      txHash: result.hash,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${result.hash}`,
    };
  }

  console.log("[Xioma Wallets] Earmarking complete.");
  return earmarkingResults;
}