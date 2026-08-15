const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "TradeHub backend"
  });
});

// Check account balance
app.get("/api/account/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // Database lookup will go here
    res.json({
      success: true,
      userId,
      balance: 0
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Unable to load account"
    });
  }
});

// Deposit request
app.post("/api/deposit", async (req, res) => {
  try {
    const { userId, amount, phone } = req.body;

    if (!userId || !amount || !phone) {
      return res.status(400).json({
        success: false,
        message: "userId, amount and phone are required"
      });
    }

    /*
      PAYMENT PROVIDER GOES HERE.

      Do NOT put payment API keys in index.html.
      They must be stored as server environment variables.
    */

    res.json({
      success: true,
      status: "pending",
      message: "Deposit request received"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Deposit request failed"
    });
  }
});

// Withdrawal request
app.post("/api/withdraw", async (req, res) => {
  try {
    const { userId, amount, phone } = req.body;

    if (!userId || !amount || !phone) {
      return res.status(400).json({
        success: false,
        message: "userId, amount and phone are required"
      });
    }

    /*
      WITHDRAWAL PROVIDER GOES HERE.

      The server must verify:
      - authenticated user
      - available balance
      - withdrawal limits
      - transaction status

      Never trust the balance supplied by the browser.
    */

    res.json({
      success: true,
      status: "pending",
      message: "Withdrawal request received"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Withdrawal request failed"
    });
  }
});

// Payment webhook
app.post("/api/payment/webhook", async (req, res) => {
  try {
    /*
      The real payment provider will notify this endpoint
      when a payment succeeds or fails.

      Verify the provider's webhook signature before
      updating any user's balance.
    */

    console.log("Payment webhook received");

    res.json({
      received: true
    });
  } catch (error) {
    res.status(500).json({
      received: false
    });
  }
});

app.listen(PORT, () => {
  console.log(`TradeHub backend running on port ${PORT}`);
});
