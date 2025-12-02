import express from "express";
import cors from "cors";
import ical from "node-ical";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

// -------- Load Pricing --------
const prices = JSON.parse(fs.readFileSync("./prices.json", "utf8"));

// -------- Bookalet ICS URL --------
const ICAL_URL =
 "https://api.bookalet.co.uk/v1/16295/bookalet-723489/26085.ics";

// Convert date to numeric timestamp
function toNum(d) {
 return new Date(d).getTime();
}

// Find weekly price band
function getPriceForDate(dateStr) {
 const target = toNum(dateStr);

 for (const p of prices) {
   if (target >= toNum(p.start) && target < toNum(p.end)) {
     return p.price;
   }
 }
 return null;
}

// ---------- Load bookings from ICS ----------
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

// ---------- Check if a date is booked ----------
function isBooked(date, bookings) {
 const d = new Date(date);
 return bookings.some((b) => d >= b.start && d < b.end);
}

// ---------- Main Endpoint (simple version) ----------
app.post("/check", async (req, res) => {
 try {
   const { date } = req.body;

   if (!date) {
     return res.status(400).json({ error: "Missing date" });
   }

   const bookings = await loadBookings();
   const booked = isBooked(date, bookings);
   const price = getPriceForDate(date);

   return res.json({
     date,
     booked,
     price,
     message: booked
       ? "Sorry — that date is booked."
       : price
       ? `Great news — that week is £${price}. Short stays on request.`
       : "That date is available.",
   });
 } catch (err) {
   console.error("ERROR:", err);
   return res.status(500).json({ error: "Server error" });
 }
});

// Root route
app.get("/", (req, res) => {
 res.json({ status: "Tansea availability API (simple mode) running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
 console.log("Tansea Availability API running on port " + PORT)
);

