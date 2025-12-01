import express from "express";
import cors from "cors";
import ical from "node-ical";

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Your real Bookalet ICS
const ICS_URL = "https://api.bookalet.co.uk/v1/16295/bookalet-723489/26085.ics";

// ---- Helper: Check if a single date is booked ----
function isDateBooked(events, dateStr) {
 const checkDate = new Date(dateStr);
 checkDate.setHours(12); // Normalize midday to avoid timezone rollbacks

 for (const ev of Object.values(events)) {
   if (!ev.start || !ev.end) continue;

   const start = new Date(ev.start);
   const end = new Date(ev.end);

   // If the date falls between start (inclusive) and end (exclusive)
   if (checkDate >= start && checkDate < end) {
     return true;
   }
 }
 return false;
}

// ---- POST: /check-date (Typebot calls this) ----
app.post("/check-date", async (req, res) => {
 try {
   const { date } = req.body;

   if (!date) {
     return res.status(400).json({ error: "No date provided" });
   }

   // Fetch & parse ICS
   const events = await ical.async.fromURL(ICS_URL);

   // Check availability
   const booked = isDateBooked(events, date);

   return res.json({
     date,
     booked,
     message: booked
       ? "Sorry — that date is booked."
       : "Great news — that date is available!",
   });
 } catch (err) {
   console.error("Availability error:", err);
   res.status(500).json({ error: "Failed to process calendar" });
 }
});

// ---- Default route (browser-friendly) ----
app.get("/", (req, res) => {
 res.json({ status: "Tansea availability API is running" });
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
 console.log("Tansea Availability running on " + PORT)
);

