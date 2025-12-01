import express from "express";
import cors from "cors";
import ical from "node-ical";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

// ---- Load pricing table ----
const prices = JSON.parse(fs.readFileSync("./prices.json", "utf8"));

// ---- iCal feed URL ----
const ICAL_URL =
 "https://api.bookalet.co.uk/v1/16295/bookalet-723489/26085.ics";

// Convert date string to comparable number
function toDateNum(d) {
 return new Date(d).getTime();
}

// Find weekly price band
function getPriceForDate(dateStr) {
 const target = toDateNum(dateStr);

 for (const p of prices) {
   const start = toDateNum(p.start);
   const end = toDateNum(p.end);

   if (target >= start && target < end) {
     return p.price;
   }
 }
 return null; // no price found
}

// --------------------------------------
// SHARED FUNCTION → checks availability + price
// --------------------------------------
async function checkAvailability(date) {
 // Parse iCal
 const data = await ical.async.fromURL(ICAL_URL);

 let booked = false;

 for (let event of Object.values(data)) {
   if (event.type === "VEVENT") {
     const start = event.start;
     const end = event.end;

     if (new Date(date) >= start && new Date(date) < end) {
       booked = true;
       break;
     }
   }
 }

 const weeklyPrice = getPriceForDate(date);

 if (booked) {
   return {
     date,
     booked: true,
     price: weeklyPrice,
     message: `Sorry – that date is booked.`,
   };
 }

 return {
   date,
   booked: false,
   price: weeklyPrice,
   message:
     weeklyPrice !== null
       ? `Great news — that week is £${weeklyPrice}. Short stays available on request.`
       : `That date is available.`,
 };
}

// --------------------------------------
// ROUTE 1 → /check-date  (your original)
// --------------------------------------
app.post("/check-date", async (req, res) => {
 try {
   const { date } = req.body;
   if (!date) return res.status(400).json({ error: "Missing date" });

   const result = await checkAvailability(date);
   res.json(result);
 } catch (err) {
   console.error("Error:", err);
   res.status(500).json({ error: "Server error" });
 }
});

// --------------------------------------
// ROUTE 2 → /check  (ALIAS for Typebot)
// --------------------------------------
app.post("/check", async (req, res) => {
 try {
   const { date } = req.body;
   if (!date) return res.status(400).json({ error: "Missing date" });

   const result = await checkAvailability(date);
   res.json(result);
 } catch (err) {
   console.error("Error:", err);
   res.status(500).json({ error: "Server error" });
 }
});

// Root route
app.get("/", (req, res) => {
 res.json({ status: "Tansea availability API with pricing is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
 console.log("Tansea Availability API running on " + PORT)
);
