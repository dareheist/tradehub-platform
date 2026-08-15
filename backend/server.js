const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

// ================================
// M-PESA CONFIGURATION
// ================================

const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;

const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;

const CALLBACK_URL = process.env.MPESA_CALLBACK_URL;

// Sandbox URLs
const MPESA_BASE_URL =
  "https://sandbox.safaricom.co.ke";

// ================================
// HEALTH CHECK
// ================================

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "TradeHub Payment Backend"
  });
});

// ================================
// GET M-PESA ACCESS TOKEN
// ================================

async function getMpesaToken() {

  const credentials = Buffer
    .from(
      `${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`
    )
    .toString("base64");

  const response = await axios.get(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${credentials}`
      }
    }
  );

  return response.data.access_token;
}

// ================================
// STK PUSH - DEPOSIT
// ================================

app.post("/api/mpesa/deposit", async (req, res) => {

  try {

    const { phone, amount } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({
        success: false,
        message: "Phone number and amount are required"
      });
    }

    const token = await getMpesaToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);

    const password = Buffer
      .from(
        `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
      )
      .toString("base64");

    const payload = {

      BusinessShortCode: MPESA_SHORTCODE,

      Password: password,

      Timestamp: timestamp,

      TransactionType:
        "CustomerPayBillOnline",

      Amount: Number(amount),

      PartyA: phone,

      PartyB: MPESA_SHORTCODE,

      PhoneNumber: phone,

      CallBackURL: CALLBACK_URL,

      AccountReference: "TradeHub",

      TransactionDesc:
        "TradeHub account deposit"
    };

    const response = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({
      success: true,
      message:
        "M-PESA payment request sent",
      data: response.data
    });

  } catch (error) {

    console.error(
      "M-PESA ERROR:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      message: "Unable to start M-PESA payment"
    });
  }
});

// ================================
// M-PESA CALLBACK
// ================================

app.post("/api/mpesa/callback", (req, res) => {

  console.log(
    "M-PESA CALLBACK:",
    JSON.stringify(req.body, null, 2)
  );

  // IMPORTANT:
  // Later we will verify the transaction
  // and update the user's TradeHub balance
  // in the database.

  res.json({
    ResultCode: 0,
    ResultDesc: "Accepted"
  });
});

// ================================
// START SERVER
// ================================

app.listen(PORT, () => {

  console.log(
    `TradeHub backend running on port ${PORT}`
  );

});
