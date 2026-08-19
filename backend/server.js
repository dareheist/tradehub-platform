require("dotenv").config();
const express=require("express");
const axios=require("axios");
const {createClient}=require("@supabase/supabase-js");

const app=express();
app.use((req,res,next)=>{
  res.header("Access-Control-Allow-Origin",process.env.FRONTEND_URL||"*");
  res.header("Access-Control-Allow-Headers","Origin, Content-Type, Accept, Authorization");
  res.header("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  if(req.method==="OPTIONS")return res.sendStatus(204);
  next();
});
app.use(express.json());

const PORT=process.env.PORT||3000;
const {
  SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,
  MPESA_CONSUMER_KEY,MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,MPESA_PASSKEY,CALLBACK_URL
}=process.env;

if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY){
  console.error("Missing Supabase configuration");
  process.exit(1);
}

const supabase=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{
  auth:{autoRefreshToken:false,persistSession:false}
});

const BASE=process.env.MPESA_BASE_URL||"https://sandbox.safaricom.co.ke";

app.get("/",(req,res)=>res.json({
  status:"online",
  service:"TradeHub Payment Backend"
}));

app.get("/api/diagnostics/mpesa-config",(req,res)=>{
  const missing=[];
  if(!MPESA_CONSUMER_KEY)missing.push("MPESA_CONSUMER_KEY");
  if(!MPESA_CONSUMER_SECRET)missing.push("MPESA_CONSUMER_SECRET");
  if(!MPESA_SHORTCODE)missing.push("MPESA_SHORTCODE");
  if(!MPESA_PASSKEY)missing.push("MPESA_PASSKEY");
  if(!CALLBACK_URL)missing.push("CALLBACK_URL");
  res.json({success:!missing.length,missing,mpesa_base_url:BASE});
});

async function user(req){
  const h=req.headers.authorization||"";
  if(!h.startsWith("Bearer "))return null;
  const {data,error}=await supabase.auth.getUser(h.slice(7));
  if(error||!data?.user)return null;
  return data.user;
}

function phone(p){
  let n=String(p||"").replace(/\s/g,"").replace(/^\+/,"");
  if(n.startsWith("0"))n="254"+n.slice(1);
  if(n.startsWith("7")||n.startsWith("1"))n="254"+n;
  return /^254\d{9}$/.test(n)?n:null;
}

function timestamp(){
  const d=new Date(),p=n=>String(n).padStart(2,"0");
  return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+
    p(d.getHours())+p(d.getMinutes())+p(d.getSeconds());
}

app.post("/api/payments/mpesa/stkpush",async(req,res)=>{
  try{
    const u=await user(req);
    if(!u)return res.status(401).json({success:false,message:"Authentication required"});

    const amount=Number(req.body.amount);
    const p=phone(req.body.phone);

    if(!amount||amount<=0)return res.status(400).json({success:false,message:"Invalid amount"});
    if(!p)return res.status(400).json({success:false,message:"Invalid Kenyan phone number"});

    const missing=[];
    if(!MPESA_SHORTCODE)missing.push("MPESA_SHORTCODE");
    if(!MPESA_PASSKEY)missing.push("MPESA_PASSKEY");
    if(!CALLBACK_URL)missing.push("CALLBACK_URL");

    if(missing.length)return res.status(500).json({
      success:false,
      message:"M-PESA configuration is incomplete",
      missing
    });

    const {data:t,error}=await supabase.from("transactions").insert({
      user_id:u.id,type:"deposit",amount,status:"pending",phone:p
    }).select().single();

    if(error||!t)return res.status(500).json({
      success:false,message:"Unable to create transaction"
    });

    try{
      const auth=Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString("base64");

      const token=(await axios.get(
        `${BASE}/oauth/v1/generate?grant_type=client_credentials`,
        {headers:{Authorization:`Basic ${auth}`}}
      )).data.access_token;

      const ts=timestamp();
      const pass=Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${ts}`).toString("base64");

      const r=await axios.post(
        `${BASE}/mpesa/stkpush/v1/processrequest`,
        {
          BusinessShortCode:MPESA_SHORTCODE,
          Password:pass,
          Timestamp:ts,
          TransactionType:"CustomerPayBillOnline",
          Amount:Math.round(amount),
          PartyA:p,
          PartyB:MPESA_SHORTCODE,
          PhoneNumber:p,
          CallBackURL:CALLBACK_URL,
          AccountReference:`TRADEHUB-${t.id}`,
          TransactionDesc:"TradeHub wallet deposit"
        },
        {headers:{Authorization:`Bearer ${token}`}}
      );

      await supabase.from("transactions").update({
        checkout_request_id:r.data.CheckoutRequestID||null
      }).eq("id",t.id);

      res.json({
        success:true,
        message:r.data.CustomerMessage||"STK push sent",
        transaction_id:t.id,
        checkout_request_id:r.data.CheckoutRequestID||null
      });

    }catch(e){
      console.error("M-PESA ERROR:",e.response?.data||e.message);
      await supabase.from("transactions").update({status:"failed"}).eq("id",t.id);
      res.status(502).json({success:false,message:"M-PESA request failed"});
    }

  }catch(e){
    console.error(e);
    res.status(500).json({success:false,message:"Unable to start payment"});
  }
});

app.post("/api/payments/mpesa/callback",async(req,res)=>{
  try{
    const c=req.body?.Body?.stkCallback;
    if(!c)return res.json({ResultCode:0,ResultDesc:"Accepted"});

    const {data:t}=await supabase.from("transactions")
      .select("*")
      .eq("checkout_request_id",c.CheckoutRequestID)
      .maybeSingle();

    if(!t)return res.json({ResultCode:0,ResultDesc:"Accepted"});

    if(c.ResultCode!==0){
      await supabase.from("transactions").update({status:"failed"})
        .eq("id",t.id).eq("status","pending");
      return res.json({ResultCode:0,ResultDesc:"Accepted"});
    }

    const items=c.CallbackMetadata?.Item||[];
    let receipt=null,amount=null,mpesaPhone=null;

    for(const x of items){
      if(x.Name==="MpesaReceiptNumber")receipt=String(x.Value);
      if(x.Name==="Amount")amount=Number(x.Value);
      if(x.Name==="PhoneNumber")mpesaPhone=String(x.Value);
    }

    if(amount!==null&&amount!==Number(t.amount)){
      await supabase.from("transactions").update({status:"failed"})
        .eq("id",t.id).eq("status","pending");
      return res.json({ResultCode:0,ResultDesc:"Accepted"});
    }

    const {error}=await supabase.rpc("credit_wallet",{
      p_transaction_id:t.id
    });

    if(!error){
      await supabase.from("transactions").update({
        mpesa_receipt:receipt,
        phone:mpesaPhone||t.phone
      }).eq("id",t.id);
    }

    res.json({ResultCode:0,ResultDesc:"Accepted"});
  }catch(e){
    console.error("CALLBACK ERROR:",e);
    res.json({ResultCode:0,ResultDesc:"Accepted"});
  }
});

app.get("/api/wallet",async(req,res)=>{
  const u=await user(req);
  if(!u)return res.status(401).json({success:false,message:"Authentication required"});

  let {data,error}=await supabase.from("wallets")
    .select("*").eq("user_id",u.id).maybeSingle();

  if(error)return res.status(500).json({success:false,message:"Unable to retrieve wallet"});

  if(!data){
    const r=await supabase.from("wallets").insert({
      user_id:u.id,balance:0,currency:"KES"
    }).select().single();
    if(r.error)return res.status(500).json({success:false,message:"Unable to create wallet"});
    data=r.data;
  }

  res.json({success:true,wallet:data});
});

app.get("/api/transactions/:id",async(req,res)=>{
  const u=await user(req);
  if(!u)return res.status(401).json({success:false,message:"Authentication required"});

  const {data,error}=await supabase.from("transactions")
    .select("id,type,amount,status,mpesa_receipt,phone,checkout_request_id,created_at,updated_at")
    .eq("id",req.params.id).eq("user_id",u.id).maybeSingle();

  if(error||!data)return res.status(404).json({success:false,message:"Transaction not found"});
  res.json({success:true,transaction:data});
});

app.listen(PORT,()=>console.log(`TradeHub backend running on port ${PORT}`));
