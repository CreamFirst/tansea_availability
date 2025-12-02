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

// Convert to numeric timestamp
function toNum(d) {
 return new Date(d).getTime();
}

// Find price band for a date
function getPriceForDate(dateStr) {
 const target = toNum(dateStr);
 for (const p of prices) {
   if (target >= toNum(p.start) && target < toNum(p.end)) {
     return p.price;
   }
 }
 return null;
}

// ------------------------------
// LOAD & PARSE ICAL BOOKINGS
// ------------------------------
async function loadBookings() {
 const data = await ical.async.fromURL(ICAL_URL);
 let bookings = [];

 for (let ev of Object.values(data)) {
   if (ev.type === "VEVENT") {
     bookings.push({
       start: ev.start,
       end: ev.end,
     });
   }
 }

 return bookings;
}

// Check if a date is booked
function isBooked(date, bookings) {
 const d = new Date(date);
 return bookings.some((b) => d >= b.start && d < b.end);
}

// Check if *any* date in a range is booked
function rangeBooked(start, end, bookings) {
 let cur = new Date(start);
 const stop = new Date(end);

 while (cur < stop) {
   if (isBooked(cur, bookings)) return true;
   cur.setDate(cur.getDate() + 1);
 }

 return false;
}

// ------------------------------
// MAIN /check ENDPOINT
// ------------------------------
app.post("/check", async (req, res) => {
 try {
   let { date, start_date, end_date, vague } = req.body;

   // ⭐ NORMALISE INPUT FROM TYPEBOT (CRITICAL FIX)
   if (start_date === "") start_date = null;
   if (end_date === "") end_date = null;
   vague = vague === true || vague === "true";

   const bookings = await loadBookings();

   // -----------------------------
   // CASE 1: EXACT SINGLE DATE
   // -----------------------------
   if (date) {
     const booked = isBooked(date, bookings);
     const price = getPriceForDate(date);

     return res.json({
       mode: "exact-date",
       date,
       booked,
       price,
       message: booked
         ? "Sorry — that date is booked."
         : price
         ? `Great news — that week is £${price}. Short stays on request.`
         : "That date is available.",
     });
   }

   // -----------------------------
   // CASE 2: EXACT RANGE (NOT VAGUE)
   // -----------------------------
   if (start_date && end_date && vague === false) {
     const booked = rangeBooked(start_date, end_date, bookings);
     const price = getPriceForDate(start_date);

     return res.json({
       mode: "exact-range",
       start_date,
       end_date,
       booked,
       price,
       message: booked
         ? "Sorry — that range includes booked dates."
         : price
         ? `Great news — that stay is around £${price}.`
         : "That range appears available.",
     });
   }

   // -----------------------------
   // CASE 3: VAGUE REQUEST
   // -----------------------------
   if (start_date && end_date && vague === true) {
     const start = new Date(start_date);
     const end = new Date(end_date);

     let availableWeeks = [];
     let cur = new Date(start);

     while (cur < end) {
       let weekStart = new Date(cur);
       let weekEnd = new Date(cur);
       weekEnd.setDate(weekEnd.getDate() + 7);

       if (!rangeBooked(weekStart, weekEnd, bookings)) {
         const iso = weekStart.toISOString().slice(0, 10);
         const price = getPriceForDate(iso);

         availableWeeks.push({
           start: iso,
           price,
         });
       }

       cur.setDate(cur.getDate() + 7);
     }

     return res.json({
       mode: "vague",
       start_date,
       end_date,
       availableWeeks,
       message:
         availableWeeks.length > 0
           ? "Here are the available Sat–Sat weeks for that period."
           : "Sorry — that period is fully booked or unclear.",
     });
   }

   // -----------------------------
   // FALLBACK → INVALID REQUEST
   // -----------------------------
   return res.status(400).json({
     error: "Invalid request. Provide either date OR start_date + end_date.",
   });
 } catch (err) {
   console.error("ERROR:", err);
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

