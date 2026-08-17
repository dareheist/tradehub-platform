const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

// ================================
// SUPABASE
// ================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("WARNING: Supabase environment variables are missing");
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

// ================================
// M-PESA CONFIGURATION
// ================================

const MPESA_CONSUMER_KEY =
  process.env.MPESA_CONSUMER_KEY;

const MPESA_CONSUMER_SECRET =
  process.env.MPESA_CONSUMER_SECRET;

const MPESA_SHORTCODE =
  process.env.MPESA_SHORTCODE;

const MPESA_PASSKEY =
  process.env.MPESA_PASSKEY;

const CALLBACK_URL =
  process.env.MPESA_CALLBACK_URL;

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

    const { user_id, phone, amount } = req.body;

    if (!user_id || !phone || !amount) {
      return res.status(400).json({
        success: false,
        message:
          "user_id, phone and amount are required"
      });
    }

    const numericAmount = Number(amount);

    if (
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount"
      });
    }

    // ================================
    // CREATE PENDING TRANSACTION
    // ================================

    const { data: transaction, error: transactionError } =
      await supabase
        .from("transactions")
        .insert({
          user_id: user_id,
          type: "deposit",
          amount: numericAmount,
          status: "pending",
          phone: phone
        })
        .select()
        .single();

    if (transactionError) {
      console.error(
        "TRANSACTION CREATE ERROR:",
        transactionError
      );

      return res.status(500).json({
        success: false,
        message: "Unable to create transaction"
      });
    }

    // ================================
    // GET M-PESA TOKEN
    // ================================

    const token = await getMpesaToken();

    // ================================
    // TIMESTAMP
    // ================================

    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);

    // ================================
    // PASSWORD
    // ================================

    const password = Buffer
      .from(
        `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
      )
      .toString("base64");

    // ================================
    // STK PAYLOAD
    // ================================

    const payload = {

      BusinessShortCode:
        MPESA_SHORTCODE,

      Password:
        password,

      Timestamp:
        timestamp,

      TransactionType:
        "CustomerPayBillOnline",

      Amount:
        numericAmount,

      PartyA:
        phone,

      PartyB:
        MPESA_SHORTCODE,

      PhoneNumber:
        phone,

      CallBackURL:
        CALLBACK_URL,

      AccountReference:
        `TradeHub-${transaction.id}`,

      TransactionDesc:
        "TradeHub account deposit"
    };

    // ================================
    // SEND STK PUSH
    // ================================

    const response = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/json"
        }
      }
    );

    // ================================
    // SAVE M-PESA REQUEST IDs
    // ================================

    if (response.data?.CheckoutRequestID) {

      await supabase
        .from("transactions")
        .update({
          checkout_request_id:
            response.data.CheckoutRequestID,

          merchant_request_id:
            response.data.MerchantRequestID,

          updated_at: new Date().toISOString()
        })
        .eq("id", transaction.id);

    }

    res.json({
      success: true,
      message:
        "M-PESA payment request sent",

      transaction_id:
        transaction.id,

      data:
        response.data
    });

  } catch (error) {

    console.error(
      "M-PESA ERROR:",
      error.response?.data ||
      error.message
    );

    res.status(500).json({
      success: false,
      message:
        "Unable to start M-PESA payment"
    });
  }
});

// ================================
// M-PESA CALLBACK
// ================================

app.post("/api/mpesa/callback", async (req, res) => {

  try {

    console.log(
      "M-PESA CALLBACK:",
      JSON.stringify(
        req.body,
        null,
        2
      )
    );

    const stkCallback =
      req.body?.Body?.stkCallback;

    if (!stkCallback) {

      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    const {
      ResultCode,
      ResultDesc,
      CheckoutRequestID
    } = stkCallback;

    // ================================
    // FIND TRANSACTION
    // ================================

    const { data: transaction, error } =
      await supabase
        .from("transactions")
        .select("*")
        .eq(
          "checkout_request_id",
          CheckoutRequestID
        )
        .single();

    if (error || !transaction) {

      console.error(
        "Transaction not found:",
        CheckoutRequestID
      );

      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    // ================================
    // PAYMENT FAILED / CANCELLED
    // ================================

    if (ResultCode !== 0) {

      await supabase
        .from("transactions")
        .update({
          status: "failed",
          updated_at:
            new Date().toISOString()
        })
        .eq("id", transaction.id)
        .eq("status", "pending");

      console.log(
        "M-PESA payment failed:",
        ResultDesc
      );

      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    // ================================
    // EXTRACT CALLBACK METADATA
    // ================================

    const metadata =
      stkCallback.CallbackMetadata?.Item || [];

    const receiptItem =
      metadata.find(
        item =>
          item.Name ===
          "MpesaReceiptNumber"
      );

    const amountItem =
      metadata.find(
        item =>
          item.Name === "Amount"
      );

    const phoneItem =
      metadata.find(
        item =>
          item.Name === "PhoneNumber"
      );

    const mpesaReceipt =
      receiptItem?.Value;

    const paidAmount =
      Number(amountItem?.Value);

    const paidPhone =
      String(phoneItem?.Value || "");

    // ================================
    // VALIDATE CALLBACK DATA
    // ================================

    if (
      !mpesaReceipt ||
      !Number.isFinite(paidAmount)
    ) {

      console.error(
        "Invalid successful M-PESA callback"
      );

      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    // ================================
    // VERIFY AMOUNT
    // ================================

    if (
      Number(transaction.amount) !==
      paidAmount
    ) {

      console.error(
        "Amount mismatch:",
        transaction.amount,
        paidAmount
      );

      await supabase
        .from("transactions")
        .update({
          status: "failed",
          updated_at:
            new Date().toISOString()
        })
        .eq("id", transaction.id)
        .eq("status", "pending");

      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    // ================================
    // COMPLETE DEPOSIT
    // ================================

    const { data: completed, error: completeError } =
      await supabase.rpc(
        "complete_deposit",
        {
          p_transaction_id:
            transaction.id,

          p_mpesa_receipt:
            String(mpesaReceipt)
        }
      );

    if (completeError) {

      console.error(
        "DEPOSIT COMPLETION ERROR:",
        completeError
      );

      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    console.log(
      "Deposit completed:",
      completed
    );

    console.log(
      "M-PESA phone:",
      paidPhone
    );

    return res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });

  } catch (error) {

    console.error(
      "CALLBACK ERROR:",
      error
    );

    return res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });
  }
});

// ================================
// START SERVER
// ================================

app.listen(PORT, () => {

  console.log(
    `TradeHub backend running on port ${PORT}`
  );

});
