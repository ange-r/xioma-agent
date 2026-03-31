import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import dotenv from "dotenv";

console.log("imports ok, arrancando servidor...");

dotenv.config();

const PORT = 3001;
const NETWORK = process.env.NETWORK;
const FACILITATOR_URL = "https://channels.openzeppelin.com/x402/testnet";
const PAY_TO = process.env.AGENT_PUBLIC_KEY;

const app = express();
app.use(express.json());

const facilitator = new HTTPFacilitatorClient({
  url: FACILITATOR_URL,
  createAuthHeaders: async () => {
    const headers = { Authorization: `Bearer ${process.env.OZ_API_KEY}` };
    return { verify: headers, settle: headers, supported: headers };
  },
});

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

app.post("/analyze-cashflow", (req, res) => {
    console.log(`[Xioma] Payment verified - processing request`);
    res.json({
      status: "payment verified",
      message: "Xioma agent ready",
      received: req.body,
    });
});

console.log("llegando al listen...");

app.listen(PORT, () => {
  console.log(`Xioma server listening on http://localhost:${PORT}`);
});