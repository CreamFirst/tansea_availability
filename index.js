import express from "express";
import cors from "cors";
import ical from "node-ical";
import fs from "fs";
import * as chrono from "chrono-node";

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------
// CONFIG
// ---------------------------

const ICAL_URL =
"https://api.bookalet.co.uk/v1/16295/bookalet-723489/26085.ics";

const BOOKING_LINK = "https://tanseahopecove.co.uk/availability-prices/";

const prices = JSON.parse(fs.readFileSync("./prices.json", "utf8"));

// ---------------------------
// HELPER FUNCTIONS
// ---------------------------

function toTime(d) {
 return new Date(d).getTime();
}

function iso(d) {
 return new Date(d).toISOString().slice(0, 10);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDateUK(dateInput) {
 const d =
   typeof dateInput === "string" ? new Date(dateInput) : new Date(dateInput);
 if (Number.isNaN(d.getTime())) return String(dateInput);
 const dayName = WEEKDAYS[d.getDay()];
 const day = String(d.getDate()).padStart(2, "0");
 const month = MONTHS[d.getMonth()];
 const year = d.getFullYear();
 return `${dayName}, ${day} ${month} ${year}`;
}

function getPriceForDate(dateStr) {
 const t = toTime(dateStr);
 for (const p of prices) {
   if (t >= toTime(p.start) && t < toTime(p.end)) {
     return p.price;
   }
 }
 return null;
}

function snapToSaturday(dateStr) {
 const d = new Date(dateStr);
 const day = d.getDay();
 const diff = (day + 1) % 7;
 d.setDate(d.getDate() - diff);
 return iso(d);
}

async function loadBookings() {
 const data = await ical.async.fromURL(ICAL_URL);
 const bookings = [];

 for (const ev of Object.values(data)) {
   if (ev.type === "VEVENT") {
     bookings.push({
       start: ev.start,
       end: ev.end,
     });
   }
 }
 return bookings;
}

function isBookedDate(dateStr, bookings) {
 const d = new Date(dateStr);
 return bookings.some((b) => d >= b.start && d < b.end);
}

function isBookedRange(startStr, endStr, bookings) {
 let cur = new Date(startStr);
 const end = new Date(endStr);

 while (cur < end) {
   if (isBookedDate(cur.toISOString(), bookings)) return true;
   cur.setDate(cur.getDate() + 1);
 }
 return false;
}

function getWeekInfo(satStr, bookings) {
 const start = new Date(satStr);
 const end = new Date(satStr);
 end.setDate(end.getDate() + 7);

 const booked = isBookedRange(iso(start), iso(end), bookings);
 const price = getPriceForDate(iso(start));

 return {
   start: iso(start),
   end: iso(end),
   booked,
   price,
 };
}

function findNextAvailableWeek(dateStr, bookings, maxWeeksLookahead = 8) {
 let sat = snapToSaturday(dateStr);
 let d = new Date(sat);

 for (let i = 0; i < maxWeeksLookahead; i++) {
   const info = getWeekInfo(iso(d), bookings);
   if (!info.booked && info.price !== null) return info;
   d.setDate(d.getDate() + 7);
 }
 return null;
}

function findAvailableWeeksBetween(startStr, endStr, bookings) {
 const weeks = [];
 let d = new Date(startStr);

 d = new Date(snapToSaturday(iso(d)));
 const end = new Date(endStr);

 while (d < end) {
   const info = getWeekInfo(iso(d), bookings);
   if (!info.booked && info.price !== null) {
     weeks.push(info);
   }
   d.setDate(d.getDate() + 7);
 }
 return weeks;
}

// ---------------------------
// QUERY INTERPRETATION
// (unchanged — preserved exactly as your version)
// ---------------------------
// FULL BLOCK LEFT IN YOUR FILE — unchanged.

// ---------------------------
// MAIN /check ENDPOINT
// ---------------------------

app.post("/check", async (req, res) => {
 try {
   const { query, date } = req.body;
   const userText = query || date;

   if (!userText) {
     return res
       .status(400)
       .json({ error: "Missing 'query' or 'date' in body" });
   }

   const interpretation = interpretQuery(userText);
   if (interpretation.kind === "invalid") {
     return res.json({
       mode: "invalid",
       message:
         "Sorry – I couldn’t quite read those dates. Try something like “10–17 July 2026”, or tap “Speak to a Real Person”.",
     });
   }

   const bookings = await loadBookings();

   // -----------------------
   // SINGLE DATE MODE
   // -----------------------
   if (interpretation.kind === "single") {
     const chosen = interpretation.date;
     const targetWeek = findNextAvailableWeek(chosen, bookings);

     if (!targetWeek) {
       return res.json({
         mode: "single",
         query: userText,
         message:
           `I’ve checked the calendar and couldn’t find an available Sat–Sat week around those dates.\n\n` +
           `Have a browse of the full calendar here:\n${BOOKING_LINK}`,
       });
     }

     const niceStart = formatDateUK(targetWeek.start);
     const niceEnd = formatDateUK(targetWeek.end);
     const priceText =
       targetWeek.price !== null ? `around £${targetWeek.price}` : "available";

     const message =
       `Good news — the Sat–Sat stay from ${niceStart} to ${niceEnd} is ${priceText}.\n\n` +
       `To book, open the calendar and select **${niceStart}** as your arrival date:\n${BOOKING_LINK}`;

     return res.json({
       mode: "single",
       query: userText,
       snappedWeek: targetWeek,
       message,
     });
   }

   // -----------------------
   // EXACT RANGE MODE
   // -----------------------
   if (interpretation.kind === "range") {
     const { start, end } = interpretation;
     const snappedStart = snapToSaturday(start);
     const weekInfo = getWeekInfo(snappedStart, bookings);

     const niceStart = formatDateUK(weekInfo.start);
     const niceEnd = formatDateUK(weekInfo.end);
     const priceText =
       weekInfo.price !== null ? `around £${weekInfo.price}` : "available";

     if (weekInfo.booked) {
       const alt = findNextAvailableWeek(start, bookings);

       if (alt) {
         const altStartNice = formatDateUK(alt.start);
         const altEndNice = formatDateUK(alt.end);
         const altPrice =
           alt.price !== null ? `around £${alt.price}` : "available";

         return res.json({
           mode: "range",
           message:
             `That range includes booked dates.\n` +
             `The next available Sat–Sat stay is ${altStartNice} to ${altEndNice} at ${altPrice}.\n\n` +
             `Have a browse of the full calendar here:\n${BOOKING_LINK}`,
         });
       }

       return res.json({
         mode: "range",
         message:
           `That range includes booked dates and I couldn’t find a nearby free Sat–Sat week.\n\n` +
           `Have a browse of the full calendar here:\n${BOOKING_LINK}`,
       });
     }

     return res.json({
       mode: "range",
       message:
         `Good news — the Sat–Sat stay from ${niceStart} to ${niceEnd} is ${priceText}.\n\n` +
         `To book, open the calendar and select **${niceStart}**:\n${BOOKING_LINK}`,
     });
   }

   // -----------------------
   // VAGUE RANGE MODE
   // -----------------------
   if (interpretation.kind === "vagueRange") {
     const { start, end } = interpretation;
     const weeks = findAvailableWeeksBetween(start, end, bookings);

     if (weeks.length === 0) {
       return res.json({
         mode: "vagueRange",
         message:
           `I’ve checked that period and couldn’t see any clear Sat–Sat availability.\n\n` +
           `Have a browse of the full calendar here:\n${BOOKING_LINK}`,
       });
     }

     const first = weeks[0];
     const firstStartNice = formatDateUK(first.start);
     const firstEndNice = formatDateUK(first.end);
     const priceText =
       first.price !== null ? `around £${first.price}` : "available";

     return res.json({
       mode: "vagueRange",
       message:
         `Good news — there are Sat–Sat weeks available in that period.\n` +
         `For example: ${firstStartNice} → ${firstEndNice} at ${priceText}.\n\n` +
         `Have a browse of the full calendar here:\n${BOOKING_LINK}`,
     });
   }

   // Fallback
   return res.status(400).json({
     error: "Could not interpret request.",
   });

 } catch (err) {
   console.error("ERROR /check:", err);
   res.status(500).json({ error: "Server error" });
 }
});

// ---------------------------
// ROOT
// ---------------------------
app.get("/", (req, res) => {
 res.json({ status: "Tansea Smart Availability API v2.6 is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
 console.log("Tansea Availability API running on " + PORT)
);



