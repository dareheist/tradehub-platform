const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.json());

// ================================
// ENVIRONMENT
// ================================

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

// Supabase server client
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

// Sandbox URL
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
// AUTHENTICATE SUPABASE USER
// ================================

async function getAuthenticatedUser(req) {

  const authorization =
    req.headers.authorization;

  if (!authorization ||
      !authorization.startsWith("Bearer ")) {
    return null;
  }

  const token =
    authorization.replace("Bearer ", "");

  const {
    data,
    error
  } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return null;
  }

  return data.user;
}

// ================================
// STK PUSH - DEPOSIT
// ================================

app.post(
  "/api/mpesa/deposit",
  async (req, res) => {

    try {

      // Authenticate TradeHub user
      const user =
        await getAuthenticatedUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required"
        });
      }

      const {
        phone,
        amount
      } = req.body;

      // Validate request
      if (!phone || !amount) {
        return res.status(400).json({
          success: false,
          message:
            "Phone number and amount are required"
        });
      }

      const numericAmount =
        Number(amount);

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

      const {
        data: transaction,
        error: transactionError
      } = await supabase
        .from("transactions")
        .insert({
          user_id: user.id,
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
          message:
            "Unable to create transaction"
        });
      }

      // ================================
      // GET M-PESA TOKEN
      // ================================

      const token =
        await getMpesaToken();

      // ================================
      // TIMESTAMP
      // ================================

      const timestamp =
        new Date()
          .toISOString()
          .replace(/[^0-9]/g, "")
          .slice(0, 14);

      // ================================
      // M-PESA PASSWORD
      // ================================

      const password =
        Buffer
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
          "TradeHub",

        TransactionDesc:
          "TradeHub account deposit"
      };

      // ================================
      // SEND STK PUSH
      // ================================

      const response =
        await axios.post(
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
      // SAVE M-PESA REQUEST IDS
      // ================================

      await supabase
        .from("transactions")
        .update({
          checkout_request_id:
            response.data.CheckoutRequestID || null,

          merchant_request_id:
            response.data.MerchantRequestID || null
        })
        .eq(
          "id",
          transaction.id
        );

      // ================================
      // RESPONSE
      // ================================

      res.json({

        success: true,

        message:
          "M-PESA payment request sent",

        transaction_id:
          transaction.id,

        checkout_request_id:
          response.data.CheckoutRequestID,

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
  }
);

// ================================
// M-PESA CALLBACK
// ================================

app.post(
  "/api/mpesa/callback",
  async (req, res) => {

    try {

      console.log(
        "M-PESA CALLBACK:",
        JSON.stringify(
          req.body,
          null,
          2
        )
      );

      const callback =
        req.body?.Body?.stkCallback;

      if (!callback) {

        return res.json({
          ResultCode: 0,
          ResultDesc: "Accepted"
        });
      }

      const checkoutRequestId =
        callback.CheckoutRequestID;

      const resultCode =
        callback.ResultCode;

      // ================================
      // FIND TRANSACTION
      // ================================

      const {
        data: transaction,
        error: findError
      } = await supabase
        .from("transactions")
        .select("*")
        .eq(
          "checkout_request_id",
          checkoutRequestId
        )
        .single();

      if (findError ||
          !transaction) {

        console.error(
          "TRANSACTION NOT FOUND:",
          checkoutRequestId
        );

        return res.json({
          ResultCode: 0,
          ResultDesc: "Accepted"
        });
      }

      // ================================
      // DUPLICATE CALLBACK PROTECTION
      // ================================

      if (
        transaction.status === "completed" ||
        transaction.status === "failed"
      ) {

        return res.json({
          ResultCode: 0,
          ResultDesc: "Accepted"
        });
      }

      // ================================
      // PAYMENT FAILED / CANCELLED
      // ================================

      if (resultCode !== 0) {

        await supabase
          .from("transactions")
          .update({
            status: "failed"
          })
          .eq(
            "id",
            transaction.id
          );

        console.log(
          "M-PESA PAYMENT FAILED:",
          checkoutRequestId
        );

        return res.json({
          ResultCode: 0,
          ResultDesc: "Accepted"
        });
      }

      // ================================
      // PAYMENT SUCCESS
      // ================================

      const metadata =
        callback.CallbackMetadata?.Item || [];

      let mpesaReceipt = null;

      for (const item of metadata) {

        if (
          item.Name ===
          "MpesaReceiptNumber"
        ) {
          mpesaReceipt =
            item.Value;
        }
      }

      // ================================
      // MARK TRANSACTION PROCESSING
      // ================================

      const {
        data: processingTransaction
      } = await supabase
        .from("transactions")
        .update({
          status: "processing"
        })
        .eq(
          "id",
          transaction.id
        )
        .eq(
          "status",
          "pending"
        )
        .select()
        .maybeSingle();

      // Another callback may already
      // be processing this transaction.
      if (!processingTransaction) {

        return res.json({
          ResultCode: 0,
          ResultDesc: "Accepted"
        });
      }

      // ================================
      // GET CURRENT WALLET
      // ================================

      const {
        data: wallet,
        error: walletError
      } = await supabase
        .from("wallets")
        .select("balance")
        .eq(
          "user_id",
          transaction.user_id
        )
        .maybeSingle();

      if (walletError) {

        console.error(
          "WALLET LOOKUP ERROR:",
          walletError
        );

        return res.json({
          ResultCode: 0,
          ResultDesc: "Accepted"
        });
      }

      // ================================
      // CREATE WALLET IF MISSING
      // ================================

      if (!wallet) {

        const {
          error: createWalletError
        } = await supabase
          .from("wallets")
          .insert({
            user_id:
              transaction.user_id,

            balance:
              transaction.amount,

            currency:
              "KES"
          });

        if (createWalletError) {

          console.error(
            "WALLET CREATE ERROR:",
            createWalletError
          );

          return res.json({
            ResultCode: 0,
            ResultDesc: "Accepted"
          });
        }

      } else {

        // ================================
        // CREDIT EXISTING WALLET
        // ================================

        const newBalance =
          Number(wallet.balance) +
          Number(transaction.amount);

        const {
          error: updateWalletError
        } = await supabase
          .from("wallets")
          .update({
            balance:
              newBalance,

            updated_at:
              new Date().toISOString()
          })
          .eq(
            "user_id",
            transaction.user_id
          );

        if (updateWalletError) {

          console.error(
            "WALLET UPDATE ERROR:",
            updateWalletError
          );

          return res.json({
            ResultCode: 0,
            ResultDesc: "Accepted"
          });
        }
      }

      // ================================
      // MARK TRANSACTION COMPLETED
      // ================================

      await supabase
        .from("transactions")
        .update({
          status: "completed",

          mpesa_receipt:
            mpesaReceipt
              ? String(mpesaReceipt)
              : null,

          updated_at:
            new Date().toISOString()
        })
        .eq(
          "id",
          transaction.id
        );

      console.log(
        "M-PESA PAYMENT COMPLETED:",
        transaction.id
      );

      // ================================
      // ACKNOWLEDGE M-PESA
      // ================================

      res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });

    } catch (error) {

      console.error(
        "CALLBACK ERROR:",
        error
      );

      res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }
  }
);

// ================================
// CHECK TRANSACTION STATUS
// ================================

app.get(
  "/api/transactions/:id",
  async (req, res) => {

    try {

      const user =
        await getAuthenticatedUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required"
        });
      }

      const {
        data,
        error
      } = await supabase
        .from("transactions")
        .select(
          "id, type, amount, status, mpesa_receipt, phone, created_at, updated_at"
        )
        .eq(
          "id",
          req.params.id
        )
        .eq(
          "user_id",
          user.id
        )
        .single();

      if (error || !data) {

        return res.status(404).json({
          success: false,
          message: "Transaction not found"
        });
      }

      res.json({
        success: true,
        transaction: data
      });

    } catch (error) {

      console.error(
        "TRANSACTION STATUS ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to retrieve transaction"
      });
    }
  }
);

// ================================
// START SERVER
// ================================

app.listen(PORT, () => {

  console.log(
    `TradeHub backend running on port ${PORT}`
  );

});
