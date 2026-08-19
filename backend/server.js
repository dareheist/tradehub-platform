require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();app.use((req, res, next) => {
  const allowedOrigin = process.env.FRONTEND_URL || "*";

  res.header("Access-Control-Allow-Origin", allowedOrigin);
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const MPESA_BASE_URL =
  process.env.MPESA_BASE_URL || "https://sandbox.safaricom.co.ke";

const {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  CALLBACK_URL
} = process.env;

function normalizePhone(phone) {
  if (!phone) return null;
  let value = String(phone).replace(/\s+/g, "").replace(/^\+/, "");
  if (value.startsWith("0")) value = "254" + value.slice(1);
  if (value.startsWith("7") || value.startsWith("1")) value = "254" + value;
  return /^254\d{9}$/.test(value) ? value : null;
}

const nowIso = () => new Date().toISOString();

async function getMpesaToken() {
  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) {
    throw new Error("M-PESA consumer credentials are missing");
  }

  const credentials = Buffer.from(
    `${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  const response = await axios.get(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${credentials}` },
      timeout: 15000
    }
  );

  return response.data.access_token;
}

function makeTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function makePassword(timestamp) {
  return Buffer.from(
    `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
  ).toString("base64");
}

async function getAuthenticatedUser(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;

  const token = header.substring(7).trim();
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  return error || !data?.user ? null : data.user;
}

/* HEALTH */
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "TradeHub Payment Backend"
  });
});

/* START M-PESA STK PUSH */
app.post("/api/payments/mpesa/stkpush", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    const amount = Number(req.body.amount);
    const phone = normalizePhone(req.body.phone);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount"
      });
    }

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Invalid Kenyan phone number"
      });
    }

    if (!MPESA_SHORTCODE || !MPESA_PASSKEY || !CALLBACK_URL) {
      return res.status(500).json({
        success: false,
        message: "M-PESA configuration is incomplete"
      });
    }

    /* Create pending transaction before calling M-PESA. */
    const { data: transaction, error: transactionError } = await supabase
      .from("transactions")
      .insert({
        user_id: user.id,
        type: "deposit",
        amount,
        status: "pending",
        phone
      })
      .select()
      .single();

    if (transactionError || !transaction) {
      console.error("TRANSACTION CREATE ERROR:", transactionError);
      return res.status(500).json({
        success: false,
        message: "Unable to create transaction"
      });
    }

    try {
      const token = await getMpesaToken();
      const timestamp = makeTimestamp();
      const password = makePassword(timestamp);

      const response = await axios.post(
        `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
        {
          BusinessShortCode: MPESA_SHORTCODE,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: Math.round(amount),
          PartyA: phone,
          PartyB: MPESA_SHORTCODE,
          PhoneNumber: phone,
          CallBackURL: CALLBACK_URL,
          AccountReference: `TRADEHUB-${transaction.id}`,
          TransactionDesc: "TradeHub wallet deposit"
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          timeout: 20000
        }
      );

      const checkoutRequestId = response.data.CheckoutRequestID || null;

      await supabase
        .from("transactions")
        .update({
          checkout_request_id: checkoutRequestId,
          updated_at: nowIso()
        })
        .eq("id", transaction.id);

      return res.json({
        success: true,
        message: response.data.CustomerMessage || "STK push sent",
        transaction_id: transaction.id,
        checkout_request_id: checkoutRequestId
      });
    } catch (mpesaError) {
      console.error(
        "M-PESA STK ERROR:",
        mpesaError.response?.data || mpesaError.message
      );

      await supabase
        .from("transactions")
        .update({
          status: "failed",
          updated_at: nowIso()
        })
        .eq("id", transaction.id);

      return res.status(502).json({
        success: false,
        message: "M-PESA request failed"
      });
    }
  } catch (error) {
    console.error("STK PUSH ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to start payment"
    });
  }
});

/* M-PESA CALLBACK */
app.post("/api/payments/mpesa/callback", async (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;

    if (!callback) {
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const checkoutRequestId = callback.CheckoutRequestID;
    const resultCode = Number(callback.ResultCode);

    if (!checkoutRequestId) {
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const { data: transaction, error: findError } = await supabase
      .from("transactions")
      .select("*")
      .eq("checkout_request_id", checkoutRequestId)
      .maybeSingle();

    if (findError || !transaction) {
      console.error("TRANSACTION NOT FOUND:", checkoutRequestId);
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    /* Duplicate // Complete transaction and credit wallet safely
const { data: walletResult, error: walletError } = await supabase
  .rpc("complete_transaction", {
    p_transaction_id: transaction.id
  });

if (walletError) {
  console.error("WALLET CREDIT ERROR:", walletError);

  return res.json({
    ResultCode: 1,
    ResultDesc: "Wallet update failed"
  });
}

console.log("WALLET CREDIT SUCCESS:", walletResult); callback protection. */
    if (
      transaction.status === "completed" ||
      transaction.status === "failed"
    ) {
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    /* Payment failed/cancelled. */
    if (resultCode !== 0) {
      await supabase
        .from("transactions")
        .update({
          status: "failed",
          updated_at: nowIso()
        })
        .eq("id", transaction.id)
        .eq("status", "pending");

      console.log("M-PESA PAYMENT FAILED:", checkoutRequestId, resultCode);
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    /* Payment succeeded: read M-PESA metadata. */
    const metadata = callback.CallbackMetadata?.Item || [];
    let mpesaReceipt = null;
    let callbackAmount = null;
    let callbackPhone = null;

    for (const item of metadata) {
      if (item.Name === "MpesaReceiptNumber") mpesaReceipt = item.Value;
      if (item.Name === "Amount") callbackAmount = Number(item.Value);
      if (item.Name === "PhoneNumber") callbackPhone = String(item.Value);
    }

    /* Amount verification. */
    if (
      callbackAmount !== null &&
      Number(callbackAmount) !== Number(transaction.amount)
    ) {
      console.error(
        "AMOUNT MISMATCH:",
        transaction.id,
        transaction.amount,
        callbackAmount
      );

      await supabase
        .from("transactions")
        .update({
          status: "failed",
          updated_at: nowIso()
        })
        .eq("id", transaction.id)
        .eq("status", "pending");

      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    /*
      Atomic credit: the Supabase function locks the transaction/wallet
      and refuses to credit an already-completed transaction.
    */
    const { data: creditResult, error: creditError } = await supabase.rpc(
      "credit_wallet",
      { p_transaction_id: transaction.id }
    );

    if (creditError) {
      console.error("WALLET CREDIT ERROR:", creditError);
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    await supabase
      .from("transactions")
      .update({
        mpesa_receipt: mpesaReceipt ? String(mpesaReceipt) : null,
        phone: callbackPhone || transaction.phone,
        updated_at: nowIso()
      })
      .eq("id", transaction.id);

    console.log(
      "M-PESA PAYMENT COMPLETED:",
      transaction.id,
      "receipt:",
      mpesaReceipt
    );

    return res.json({
      ResultCode: 0,
      ResultDesc: "Accepted",
      credit: creditResult || null
    });
  } catch (error) {
    console.error("CALLBACK ERROR:", error);
    return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

/* TRANSACTION STATUS */
app.get("/api/transactions/:id", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    const { data, error } = await supabase
      .from("transactions")
      .select(
        "id, type, amount, status, mpesa_receipt, phone, checkout_request_id, created_at, updated_at"
      )
      .eq("id", req.params.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found"
      });
    }

    res.json({ success: true, transaction: data });
  } catch (error) {
    console.error("TRANSACTION STATUS ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Unable to retrieve transaction"
    });
  }
});

/* CURRENT WALLET */
app.get("/api/wallet", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    const { data: wallet, error } = await supabase
      .from("wallets")
      .select("id, user_id, balance, currency, created_at, updated_at")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error("WALLET LOOKUP ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Unable to retrieve wallet"
      });
    }

    if (!wallet) {
      const { data: newWallet, error: createError } = await supabase
        .from("wallets")
        .insert({
          user_id: user.id,
          balance: 0,
          currency: "KES"
        })
        .select()
        .single();

      if (createError) {
        console.error("WALLET CREATE ERROR:", createError);
        return res.status(500).json({
          success: false,
          message: "Unable to create wallet"
        });
      }

      return res.json({ success: true, wallet: newWallet });
    }

    res.json({ success: true, wallet });
  } catch (error) {
    console.error("WALLET ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Unable to retrieve wallet"
    });
  }
});

/* START SERVER */
app.listen(PORT, () => {
  console.log(`TradeHub backend running on port ${PORT}`);
});
