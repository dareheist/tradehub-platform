const missingMpesaConfig = [];

if (!MPESA_SHORTCODE) missingMpesaConfig.push("MPESA_SHORTCODE");
if (!MPESA_PASSKEY) missingMpesaConfig.push("MPESA_PASSKEY");
if (!CALLBACK_URL) missingMpesaConfig.push("CALLBACK_URL");

if (missingMpesaConfig.length > 0) {
  console.error("Missing M-PESA configuration:", missingMpesaConfig);

  return res.status(500).json({
    success: false,
    message: "M-PESA configuration is incomplete",
    missing: missingMpesaConfig
  });
}
