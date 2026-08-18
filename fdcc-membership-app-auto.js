// FDCC Lions Membership — PlayHQ API (daily) → Assign LION numbers → Sync to Mailchimp → Log to Google Sheet
// Runs automatically once per day
// Deploy on Railway.app (free tier)
// Requires: PlayHQ API token, Mailchimp API key, Google Sheets API

import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import cron from "node-cron";
import { GoogleSpreadsheet } from "google-spreadsheet";

const app = express();

const PLAYHQ_API_KEY = process.env.PLAYHQ_API_KEY; // x-api-key
const PLAYHQ_ORG_ID = process.env.PLAYHQ_ORG_ID; // Organisation ID
const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY;
const MAILCHIMP_AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID;
const MAILCHIMP_SERVER = process.env.MAILCHIMP_SERVER || "us22";
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || "{}");
const PORT = process.env.PORT || 3000;

// Track processed order IDs to avoid duplicates
let processedOrders = new Set();

// Hash email for Mailchimp subscriber ID
function emailToSubscriberId(email) {
  return crypto.createHash("md5").update(email.toLowerCase()).digest("hex");
}

// Fetch new orders from PlayHQ API
async function getPlayHQOrders() {
  try {
    // Extract the UUID from the org ID (remove /org/ prefix and trailing /)
    const orgUuid = PLAYHQ_ORG_ID.replace(/^\/org\//, "").replace(/\/$/, "");
    const res = await fetch(`https://api.playhq.com/v2/shop/orders?org=${orgUuid}`, {
      headers: {
        "x-api-key": PLAYHQ_API_KEY,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`PlayHQ API error: ${res.status}`);
    const data = await res.json();
    return data.data || [];
  } catch (e) {
    console.error("PlayHQ API error:", e);
    return [];
  }
}

// Sync member number to Mailchimp
async function syncToMailchimp(email, memberNo) {
  const subscriberId = emailToSubscriberId(email);
  const url = `https://${MAILCHIMP_SERVER}.api.mailchimp.com/3.0/lists/${MAILCHIMP_AUDIENCE_ID}/members/${subscriberId}`;

  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Authorization": `Basic ${Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        merge_fields: {
          MEMBER_NO: memberNo,
        },
      }),
    });
    return res.ok;
  } catch (e) {
    console.error("Mailchimp sync error:", e);
    return false;
  }
}

// Log to Google Sheet
async function logToSheet(data) {
  try {
    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["Members"] || doc.sheetsByIndex[0];
    await sheet.addRow(data);
  } catch (e) {
    console.error("Sheet logging error:", e);
  }
}

// Main processing function
async function processNewMemberships() {
  console.log(`[${new Date().toISOString()}] Checking PlayHQ for new memberships...`);

  const orders = await getPlayHQOrders();
  if (!orders.length) {
    console.log("No orders found");
    return;
  }

  // Filter to the Lions Membership product (you'll need to identify the product ID from PlayHQ)
  // For now, we'll process all orders and filter by custom field or order name
  const lionOrders = orders.filter(
    (o) =>
      !processedOrders.has(o.id) &&
      (o.name?.includes("Lions") || o.name?.includes("LION") || o.product_name?.includes("Lions"))
  );

  if (!lionOrders.length) {
    console.log("No new Lions memberships");
    return;
  }

  console.log(`Found ${lionOrders.length} new membership(s)`);

  // Get next member number from sheet (count existing entries)
  let nextMemberNo = processedOrders.size + 1; // Simple counter; ideally fetch from sheet

  for (const order of lionOrders) {
    // Extract name and email from order
    // PlayHQ order format includes buyer info and custom fields
    const name = order.buyer_name || order.contact_name || "Member";
    const email = order.buyer_email || order.contact_email;

    if (!email) {
      console.warn(`Order ${order.id} missing email, skipping`);
      continue;
    }

    const memberNo = `LION ${String(nextMemberNo).padStart(3, "0")}`;
    const paidDate = order.created_at || new Date().toISOString().split("T")[0];

    console.log(`Processing: ${name} (${email}) → ${memberNo}`);

    // Sync to Mailchimp
    const synced = await syncToMailchimp(email, memberNo);

    if (synced) {
      // Log to sheet
      await logToSheet({
        "Date": paidDate,
        "Member No": memberNo,
        "Name": name,
        "Email": email,
        "Status": "Auto-synced",
        "Timestamp": new Date().toISOString(),
      });

      processedOrders.add(order.id);
      console.log(`✅ ${memberNo} synced to Mailchimp and logged`);
    } else {
      console.error(`❌ Failed to sync ${memberNo}`);
    }

    nextMemberNo++;
  }

  console.log(`[${new Date().toISOString()}] Check complete`);
}

// Schedule: run every day at 8 AM (UTC)
cron.schedule("0 8 * * *", () => {
  processNewMemberships();
});

// Also run on app start to catch any overnight orders
processNewMemberships();

// Dashboard endpoint
app.get("/dashboard", async (req, res) => {
  try {
    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["Members"] || doc.sheetsByIndex[0];

    // Count rows where status is "Auto-synced"
    const rows = await sheet.getRows();
    const synced = rows.filter((r) => r.get("Status") === "Auto-synced");

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>FDCC Lions Dashboard</title>
        <style>
          body { font-family: 'Source Sans Pro', sans-serif; background: #17090d; color: #fff8ea; padding: 30px; }
          .container { max-width: 900px; margin: 0 auto; }
          h1 { color: #ffc61b; margin-bottom: 20px; }
          .counter { font-size: 48px; font-weight: 900; color: #ffc61b; text-align: center; margin: 30px 0; }
          table { width: 100%; border-collapse: collapse; background: #7d0422; border-radius: 8px; overflow: hidden; }
          th, td { padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
          th { background: #4d0114; font-weight: 700; }
          tr:last-child td { border-bottom: none; }
          .note { font-size: 14px; opacity: 0.8; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🦁 FDCC Lions Membership Dashboard</h1>
          <div class="counter">🦁 LIONS SIGNED: ${synced.length} / 100</div>
          <p class="note">Automatically updated daily. New PlayHQ purchases are processed at 8 AM UTC.</p>
          <h2>Recent members:</h2>
          <table>
            <tr><th>Member No</th><th>Name</th><th>Email</th><th>Date</th></tr>
            ${synced
              .reverse()
              .slice(0, 20)
              .map((r) => `<tr><td><strong>${r.get("Member No")}</strong></td><td>${r.get("Name")}</td><td>${r.get("Email")}</td><td>${r.get("Date")}</td></tr>`)
              .join("")}
          </table>
        </div>
      </body>
      </html>
    `;
    res.send(html);
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`);
  }
});

// Card landing page (personalized)
app.get("/card/:memberNo", (req, res) => {
  const memberNo = req.params.memberNo;
  const barcode = `FDCC-${memberNo}`;
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FDCC Lions Membership - ${memberNo}</title>
  <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Source Sans 3', sans-serif; background: #17090d; color: #fff8ea; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; }
    .card { background: linear-gradient(160deg, #7d0422 0%, #4d0114 100%); border-radius: 20px; padding: 30px; max-width: 500px; text-align: center; box-shadow: 0 18px 40px rgba(0,0,0,0.45); }
    .logo { width: 100px; height: 100px; margin: 0 auto 16px; }
    .logo img { width: 100%; height: 100%; object-fit: contain; }
    h1 { font-size: 18px; margin-bottom: 6px; color: #ffc61b; font-weight: 700; letter-spacing: 0.05em; }
    .member-no { font-size: 32px; font-weight: 900; color: #ffc61b; margin: 16px 0; }
    .divider { height: 1px; background: rgba(255,255,255,0.2); margin: 14px 0; }
    .qr { margin: 14px 0; background: white; padding: 12px; border-radius: 8px; display: inline-block; }
    .qr img { display: block; width: 140px; height: 140px; }
    .benefits { font-size: 12px; margin: 14px 0; text-align: left; background: rgba(255,255,255,0.05); padding: 10px; border-radius: 6px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='48' fill='%237d0422'/%3E%3Ctext x='50' y='55' font-family='Arial,sans-serif' font-size='28' font-weight='bold' fill='%23ffc61b' text-anchor='middle'%3EFDCC%3C/text%3E%3C/svg%3E" alt="FDCC Lions">
    </div>
    
    <h1><strong style="font-weight: 900;">Fitzroy Doncaster</strong><br/><span style="font-weight: 600;">Cricket Club</span></h1>
    <div style="font-size: 12px; color: #ffc61b; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 8px;">Member Number</div>
    <div class="member-no">${memberNo}</div>
    
    <div class="divider"></div>
    
    <div class="benefits">
      ✓ 10% off all FDCC merchandise<br/>
      ✓ Member offers at Skinny Dog Hotel<br/>
      ✓ Entry in member draws at home T20s
    </div>

    <p style="margin: 12px 0 8px; font-size: 11px; color: #ffc61b; letter-spacing: 0.1em; text-transform: uppercase;">Your Barcode</p>
    <div class="qr">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(barcode)}" alt="Member Barcode">
    </div>
    
    <p style="font-size: 11px; margin-top: 12px; opacity: 0.8; line-height: 1.4;">Show this page at Skinny Dog Hotel or the merch desk. Screenshot to save it.</p>
  </div>
</body>
</html>`;
  res.send(html);
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    processedOrders: processedOrders.size,
    lastCheck: new Date().toISOString(),
  });
});

app.listen(PORT, () => console.log(`FDCC Membership app running on port ${PORT}`));
