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

// iCal feed from Bookalet
const ICAL_URL =
 "https://api.bookalet.co.uk/v1/16295/bookalet-723489/26085.ics";

// Weekly pricing table (Sat–Sat) – you already have this file
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

// Find price band for a given date (uses your Sat–Sat bands)
function getPriceForDate(dateStr) {
 const t = toTime(dateStr);
 for (const p of prices) {
   if (t >= toTime(p.start) && t < toTime(p.end)) {
     return p.price;
   }
 }
 return null;
}

// Snap any date to the **Saturday** of its week (UK style, Sat = 6)
function snapToSaturday(dateStr) {
 const d = new Date(dateStr);
 const day = d.getDay(); // 0=Sun, 6=Sat
 const diff = (day + 1) % 7; // distance from Sat going backwards
 d.setDate(d.getDate() - diff);
 return iso(d);
}

// Load bookings from iCal (each event = a booked block)
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

// Is a **single date** inside any booking?
function isBookedDate(dateStr, bookings) {
 const d = new Date(dateStr);
 return bookings.some((b) => d >= b.start && d < b.end);
}

// Is **any day in [start, end)** booked?
function isBookedRange(startStr, endStr, bookings) {
 let cur = new Date(startStr);
 const end = new Date(endStr);

 while (cur < end) {
   if (isBookedDate(cur.toISOString(), bookings)) return true;
   cur.setDate(cur.getDate() + 1);
 }
 return false;
}

// Given a Saturday, return the Sat–Sat week info
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

// Find the **first available** Sat–Sat week on/after a given date
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

// For vague queries like "anything in July 2026":
// find ALL available Sat–Sat weeks in that window
function findAvailableWeeksBetween(startStr, endStr, bookings) {
 const weeks = [];
 let d = new Date(startStr);

 // Snap first week to Saturday
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
// ---------------------------

/**
* Interpret the natural language query into one of:
* - { kind: "single", date }
* - { kind: "range", start, end }
* - { kind: "vagueRange", start, end, label }
*/
function interpretQuery(query) {
 if (!query || typeof query !== "string") {
   return { kind: "invalid" };
 }

 const trimmed = query.trim();

 // Use chrono to parse natural language
 const results = chrono.parse(trimmed, new Date(), { forwardDate: true });

 if (results.length === 0) {
   return { kind: "invalid" };
 }

 const r = results[0];

 // Explicit range "10–17 Jan", "28 Jan to 5 Feb"
 if (r.end) {
   const start = iso(r.start.date());
   const end = iso(r.end.date());
   return { kind: "range", start, end };
 }

 // Single date, but maybe "anything in July 2026" etc.
 const single = iso(r.start.date());

 const lower = trimmed.toLowerCase();

 const mentionsMonthOnly =
   /(anything|any|sometime|somewhere|in)\s+[a-z]+/.test(lower) ||
   /throughout|all month/.test(lower);

 const mentionsWeek =
   /next week|that week|for a week|week in/.test(lower);

 if (mentionsMonthOnly) {
   // Treat as vague **month** range
   const baseDate = r.start.date();
   const monthStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
   const monthEnd = new Date(
     baseDate.getFullYear(),
     baseDate.getMonth() + 1,
     1
   );
   return {
     kind: "vagueRange",
     start: iso(monthStart),
     end: iso(monthEnd),
     label: "month",
   };
 }

 if (mentionsWeek) {
   // Treat as vague **week** range
   const baseDate = r.start.date();
   const weekStart = new Date(baseDate);
   const weekEnd = new Date(baseDate);
   weekEnd.setDate(weekEnd.getDate() + 7);
   return {
     kind: "vagueRange",
     start: iso(weekStart),
     end: iso(weekEnd),
     label: "week",
   };
 }

 // Plain single date (“4 Feb 2026”)
 return { kind: "single", date: single };
}

// ---------------------------
// MAIN /check ENDPOINT
// ---------------------------

/**
* Body formats supported:
* 1) { "query": "28 Jan 2026", ... }  ← Typebot style
* 2) { "date": "2026-01-28" }         ← legacy
*/
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
         "Sorry – I couldn’t quite read those dates. Try something like “10–17 July 2026”.",
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
           "I’ve checked the calendar and couldn’t find an available Sat–Sat week around those dates.",
       });
     }

     const snapped = snapToSaturday(chosen);
     const includesChosen =
       targetWeek.start === snapped && !targetWeek.booked;

     const priceText =
       targetWeek.price !== null
         ? `around £${targetWeek.price}`
         : "available";

     let message;

     if (includesChosen) {
       message = `Good news — the Sat–Sat week from ${targetWeek.start} to ${targetWeek.end} is ${priceText}. Short stays are available on request.`;
     } else {
       message = `That exact week looks busy, but the next available Sat–Sat stay is ${targetWeek.start} to ${targetWeek.end} at around £${targetWeek.price}. Short stays available on request.`;
     }

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

     if (weekInfo.booked) {
       const alt = findNextAvailableWeek(start, bookings);
       if (alt) {
         const priceText =
           alt.price !== null ? `around £${alt.price}` : "available";
         return res.json({
           mode: "range",
           query: userText,
           requestedRange: { start, end },
           snappedWeek: weekInfo,
           altWeek: alt,
           message: `That range includes booked dates. The next available Sat–Sat week is ${alt.start} to ${alt.end} at ${priceText}.`,
         });
       }

       return res.json({
         mode: "range",
         query: userText,
         requestedRange: { start, end },
         snappedWeek: weekInfo,
         message:
           "That range includes booked dates and I couldn’t find a nearby free Sat–Sat week.",
       });
     }

     const priceText =
       weekInfo.price !== null
         ? `around £${weekInfo.price}`
         : "available";

     return res.json({
       mode: "range",
       query: userText,
       requestedRange: { start, end },
       snappedWeek: weekInfo,
       message: `Great news — the Sat–Sat week from ${weekInfo.start} to ${weekInfo.end} is ${priceText}. Short stays available on request.`,
     });
   }

   // -----------------------
   // VAGUE RANGE MODE
   // (e.g. "anything in July 2026?")
   // -----------------------
   if (interpretation.kind === "vagueRange") {
     const { start, end } = interpretation;
     const weeks = findAvailableWeeksBetween(start, end, bookings);

     if (weeks.length === 0) {
       return res.json({
         mode: "vagueRange",
         query: userText,
         range: { start, end },
         availableWeeks: [],
         message:
           "I’ve checked that period and it looks fully booked or unclear. Try a different month or specific dates.",
       });
     }

     const first = weeks[0];
     const priceText =
       first.price !== null ? `around £${first.price}` : "available";

     // Short, human-friendly summary
     const summaryList = weeks
       .slice(0, 3)
       .map(
         (w) =>
           `${w.start}–${w.end}${
             w.price ? ` (£${w.price})` : ""
           }`
       )
       .join("; ");

     return res.json({
       mode: "vagueRange",
       query: userText,
       range: { start, end },
       availableWeeks: weeks,
       message: `Here are available Sat–Sat weeks in that period. For example: ${summaryList}. Short stays are often possible on request.`,
     });
   }

   // Fallback – should never hit
   return res.status(400).json({
     error: "Could not interpret request.",
   });
 } catch (err) {
   console.error("ERROR /check:", err);
   res.status(500).json({ error: "Server error" });
 }
});

// Legacy root route
app.get("/", (req, res) => {
 res.json({ status: "Tansea Smart Availability API v2 is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
 console.log("Tansea Availability API running on " + PORT)
);


