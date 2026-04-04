import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import dotenv from "dotenv";
import { calculateDistribution } from "./agent.js";

dotenv.config();

const PORT = 3001;
const NETWORK = process.env.NETWORK;
const FACILITATOR_URL = "https://channels.openzeppelin.com/x402/testnet";
const PAY_TO = process.env.AGENT_PUBLIC_KEY;

const app = express();
app.use(express.json());

// Facilitator acts as intermediary between the server and Stellar network.
// It handles payment verification and on-chain settlement —
// the server never builds raw transactions directly.
const facilitator = new HTTPFacilitatorClient({
  url: FACILITATOR_URL,
  createAuthHeaders: async () => {
    const headers = { Authorization: `Bearer ${process.env.OZ_API_KEY}` };
    return { verify: headers, settle: headers, supported: headers };
  },
});

// Payment middleware intercepts every incoming request to /analyze-cashflow.
// If the request has no valid payment header, it responds with 402 Payment Required
// and the instructions for how to pay (amount, network, recipient address).
// Only requests with verified payment reach the route handler below.
app.use(
  paymentMiddlewareFromConfig(
    {
      "POST /analyze-cashflow": {
        accepts: {
          scheme: "exact",
          price: "$0.01",
          network: NETWORK,
          payTo: PAY_TO,
        },
      },
    },
    facilitator,
    [{ network: NETWORK, server: new ExactStellarScheme() }],
  ),
);

// This handler only executes after payment has been verified and settled on-chain.
// Delegates distribution logic to the agent module — server only handles transport and payment.
app.post("/analyze-cashflow", (req, res) => {
  console.log(`[Xioma] Payment verified - processing cashflow request`);

  const { amount, currency, obligations } = req.body;

  try {
    const result = calculateDistribution(amount, currency, obligations);
    res.json({ status: "success", result });
  } catch (err) {
    console.error(`[Xioma] Distribution error: ${err.message}`);
    res.status(400).json({ status: "error", message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Xioma] Server listening on http://localhost:${PORT}`);
});
