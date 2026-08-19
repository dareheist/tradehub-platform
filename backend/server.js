require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();

/* =========================
   CORS
========================= */

app.use((req, res, next) => {
  const allowedOrigin = process.env.FRONTEND_URL || "*";

  res.header("Access-Control-Allow-Origin", allowedOrigin);
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "1mb" }));

/* =========================
   BASIC CONFIG
========================= */

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

/* =========================
   M-PESA CONFIG
========================= */

const MPESA_BASE_URL =
  process.env.MPESA_BASE_URL ||
  "https://sandbox.safaricom.co.ke";

const {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  CALLBACK_URL
} = process.env;

/* =========================
   HELPERS
========================= */

function normalizePhone(phone) {
  if (!phone) return null;

  let value = String(phone)
    .replace(/\s+/g, "")
    .replace(/^\+/, "");

  if (value.startsWith("0")) {
    value = "254" + value.slice(1);
  }

  if (
    value.startsWith("7") ||
    value.startsWith("1")
  ) {
    value = "254" + value;
  }

  return /^254\d{9}$/.test(value)
    ? value
    : null;
}

const nowIso = () => new Date().toISOString();

/* =========================
   M-PESA ACCESS TOKEN
========================= */

async function getMpesaToken() {
  if (
    !MPESA_CONSUMER_KEY ||
    !MPESA_CONSUMER_SECRET
  ) {
    throw new Error(
      "M-PESA consumer credentials are missing"
    );
  }

  const credentials = Buffer.from(
    `${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  const response = await axios.get(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${credentials}`
      },
      timeout: 15000
    }
  );

  return response.data.access_token;
}

/* =========================
   TIMESTAMP
========================= */

function makeTimestamp() {
  const d = new Date();

  const pad = n =>
    String(n).padStart(2, "0");

  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/* =========================
   M-PESA PASSWORD
========================= */

function makePassword(timestamp) {
  return Buffer.from(
    `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
  ).toString("base64");
}

/* =========================
   AUTHENTICATED USER
========================= */

async function getAuthenticatedUser(req) {
  const header =
    req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const token =
    header.substring(7).trim();

  if (!token) {
    return null;
  }

  const { data, error } =
    await supabase.auth.getUser(token);

  if (error || !data?.user) {
    console.error(
      "AUTHENTICATION ERROR:",
      error?.message || "Invalid user"
    );

    return null;
  }

  return data.user;
}

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "TradeHub Payment Backend"
  });
});

/* =========================
   M-PESA CONFIG DIAGNOSTIC
=========================

   IMPORTANT:
   This does NOT expose your
   secret values.
========================= */

app.get(
  "/api/diagnostics/mpesa-config",
  (req, res) => {
    const missing = [];

    if (!MPESA_CONSUMER_KEY) {
      missing.push(
        "MPESA_CONSUMER_KEY"
      );
