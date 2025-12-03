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

// Human-friendly UK date: "Sat, 27 Jun 2026"
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
 const lower = trimmed.toLowerCase();

 // First parse with chrono for general hints
 const results = chrono.parse(trimmed, new Date(), { forwardDate: true });
 const r = results[0];

 // -----------------------
 // SEASONS (meteorological)
 // -----------------------
 const seasonMatch = lower.match(/\b(spring|summer|autumn|fall|winter)\b/);
 if (seasonMatch) {
   const season = seasonMatch[1];
   const now = new Date();

   // Try to grab an explicit year, otherwise use chrono/base year
   let year;
   const yearMatch = lower.match(/\b(20\d{2})\b/);
   if (yearMatch) {
     year = parseInt(yearMatch[1], 10);
   } else if (r && r.start) {
     year = r.start.date().getFullYear();
   } else {
     year = now.getFullYear();
     if (/\bnext\b/.test(lower)) {
       year += 1;
     }
   }

   let startDate;
   let endDate; // exclusive

   switch (season) {
     case "spring":
       // 1 Mar → 1 Jun
       startDate = new Date(year, 2, 1);
       endDate = new Date(year, 5, 1);
       break;
     case "summer":
       // 1 Jun → 1 Sep
       startDate = new Date(year, 5, 1);
       endDate = new Date(year, 8, 1);
       break;
     case "autumn":
     case "fall":
       // 1 Sep → 1 Dec
       startDate = new Date(year, 8, 1);
       endDate = new Date(year, 11, 1);
       break;
     case "winter":
       // 1 Dec → 1 Mar (next year)
       startDate = new Date(year, 11, 1);
       endDate = new Date(year + 1, 2, 1);
       break;
     default:
       return { kind: "invalid" };
   }

   return {
     kind: "vagueRange",
     start: iso(startDate),
     end: iso(endDate),
     label: "season",
     season,
   };
 }

 // -----------------------
 // WEEKEND HANDLING
 // -----------------------
 if (/\bweekend\b/.test(lower)) {
   const now = new Date();
   let baseDate = now;

   // “weekend of 10 July 2026”
   if (
     /\bweekend of\b|\bweekend around\b|\bweekend starting\b/.test(lower) &&
     r &&
     r.start
   ) {
     baseDate = r.start.date();
   } else if (/\bnext weekend\b/.test(lower)) {
     baseDate = new Date(now);
     baseDate.setDate(baseDate.getDate() + 7);
   } else if (/\bthis weekend\b/.test(lower)) {
     baseDate = now;
   }

   // Move forward to Saturday of that weekend
   const sat = new Date(baseDate);
   const diff = (6 - sat.getDay() + 7) % 7; // 6 = Saturday
   sat.setDate(sat.getDate() + diff);

   return { kind: "single", date: iso(sat) };
 }

 // If chrono couldn't parse anything, bail out
 if (!r) {
   return { kind: "invalid" };
 }

 // -----------------------
 // EXACT RANGE "10–17 Jan"
 // -----------------------
 if (r.end) {
   const start = iso(r.start.date());
   const end = iso(r.end.date());
   return { kind: "range", start, end };
 }

 // -----------------------
 // VAGUE MONTH / WEEK HANDLING
 // -----------------------
 const baseDate = r.start.date();
 const single = iso(baseDate);

 const mentionsMonthOnly =
   /(anything|any|sometime|somewhere|in)\s+[a-z]+/.test(lower) ||
   /throughout|all month/.test(lower);

 const mentionsWeek =
   /next week|that week|for a week|week in/.test(lower);

 if (mentionsMonthOnly) {
   // Treat as vague **month** range
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

 // -----------------------
 // Plain single date (“4 Feb 2026”)
 // -----------------------
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
           "I’ve checked the calendar and couldn’t find an available Sat–Sat week around those dates. Tap “Speak to a Real Person” and we’ll double-check for you.",
       });
     }

     const snapped = snapToSaturday(chosen);
     const includesChosen =
       targetWeek.start === snapped && !targetWeek.booked;

     const priceText =
       targetWeek.price !== null
         ? `around £${targetWeek.price}`
         : "available";

     const niceStart = formatDateUK(targetWeek.start);
     const niceEnd = formatDateUK(targetWeek.end);

     let message;

     if (includesChosen) {
       message = `Good news — the Sat–Sat stay from ${niceStart} to ${niceEnd} is ${priceText}. Short stays are available on request.`;
     } else {
       message = `That exact week looks busy, but the next available Sat–Sat stay is ${niceStart} to ${niceEnd} at ${priceText}. Short stays are available on request.`;
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

     const niceStart = formatDateUK(weekInfo.start);
     const niceEnd = formatDateUK(weekInfo.end);

     if (weekInfo.booked) {
       const alt = findNextAvailableWeek(start, bookings);
       if (alt) {
         const altStartNice = formatDateUK(alt.start);
         const altEndNice = formatDateUK(alt.end);
         const priceText =
           alt.price !== null ? `around £${alt.price}` : "available";

         return res.json({
           mode: "range",
           query: userText,
           requestedRange: { start, end },
           snappedWeek: weekInfo,
           altWeek: alt,
           message: `That range includes booked dates. The next available Sat–Sat week is ${altStartNice} to ${altEndNice} at ${priceText}. Short stays are available on request.`,
         });
       }

       return res.json({
         mode: "range",
         query: userText,
         requestedRange: { start, end },
         snappedWeek: weekInfo,
         message:
           "That range includes booked dates and I couldn’t find a nearby free Sat–Sat week. Tap “Speak to a Real Person” and we’ll help you look.",
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
       message: `Good news — the Sat–Sat stay from ${niceStart} to ${niceEnd} is ${priceText}. Short stays are available on request.`,
     });
   }

   // -----------------------
   // VAGUE RANGE MODE
   // (e.g. "anything in July 2026?" or "summer 2026")
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
           "I’ve checked that period and couldn’t see any clear Sat–Sat availability. Try another month or tap “Speak to a Real Person” and we’ll check manually.",
       });
     }

     const first = weeks[0];
     const priceText =
       first.price !== null ? `around £${first.price}` : "available";

     // Short, human-friendly summary (max 3)
     const summaryList = weeks
       .slice(0, 3)
       .map((w) => {
         const sNice = formatDateUK(w.start);
         const eNice = formatDateUK(w.end);
         return `${sNice} → ${eNice}${
           w.price ? ` (£${w.price})` : ""
         }`;
       })
       .join("; ");

     const firstStartNice = formatDateUK(first.start);
     const firstEndNice = formatDateUK(first.end);

     return res.json({
       mode: "vagueRange",
       query: userText,
       range: { start, end },
       availableWeeks: weeks,
       message: `Good news — there are Sat–Sat weeks available in that period. For example, ${firstStartNice} to ${firstEndNice} at ${priceText}. A few options include: ${summaryList}. Short stays are often possible on request.`,
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
 res.json({ status: "Tansea Smart Availability API v2.5 is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
 console.log("Tansea Availability API running on " + PORT)
);





