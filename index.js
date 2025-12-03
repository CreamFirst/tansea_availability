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

// ---------- helpers ----------
function toNum(d) {
 return new Date(d).getTime();
}

function toISO(d) {
 const dd = new Date(d);
 const y = dd.getFullYear();
 const m = String(dd.getMonth() + 1).padStart(2, "0");
 const day = String(dd.getDate()).padStart(2, "0");
 return `${y}-${m}-${day}`;
}

// price band for any date inside that band
function getPriceForDate(dateStr) {
 const target = toNum(dateStr);
 for (const p of prices) {
   if (target >= toNum(p.start) && target < toNum(p.end)) {
     return p.price;
   }
 }
 return null;
}

// load bookings from iCal
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

function isBookedDate(date, bookings) {
 const d = new Date(date);
 return bookings.some((b) => d >= b.start && d < b.end);
}

function rangeBooked(start, end, bookings) {
 let cur = new Date(start);
 const stop = new Date(end);

 while (cur < stop) {
   if (isBookedDate(cur, bookings)) return true;
   cur.setDate(cur.getDate() + 1);
 }
 return false;
}

function getNextSaturday(fromDate = new Date()) {
 const d = new Date(fromDate);
 while (d.getDay() !== 6) {
   d.setDate(d.getDate() + 1);
 }
 return d;
}

// --------- query parser (natural language → mode) ---------

const MONTHS = [
 "january","february","march","april","may","june",
 "july","august","september","october","november","december"
];

function bestYearForMonth(monthIdx, now = new Date()) {
 const thisYear = now.getFullYear();
 if (monthIdx > now.getMonth()) return thisYear;
 return thisYear + 1;
}

function parseQuery(query) {
 const raw = query || "";
 const text = raw.toLowerCase().trim();
 const now = new Date();

 // 1) "next week" / "this week"
 if (text.includes("next week")) {
   const start = getNextSaturday(now);
   const end = new Date(start);
   end.setDate(end.getDate() + 7);
   return { mode: "week", startISO: toISO(start), endISO: toISO(end) };
 }
 if (text.includes("this week")) {
   const start = getNextSaturday(now); // treat "this week" as upcoming Sat–Sat
   const end = new Date(start);
   end.setDate(end.getDate() + 7);
   return { mode: "week", startISO: toISO(start), endISO: toISO(end) };
 }

 // 2) explicit day–day in a month: "10-17 july", "10 to 17 aug 2026"
 for (let i = 0; i < MONTHS.length; i++) {
   const name = MONTHS[i];
   if (text.includes(name)) {
     const yearMatch = text.match(/(\d{4})/);
     const year = yearMatch
       ? parseInt(yearMatch[1], 10)
       : bestYearForMonth(i, now);

     // day range
     const rangeMatch = text.match(/(\d{1,2})\D+(\d{1,2})/);
     if (rangeMatch) {
       let d1 = parseInt(rangeMatch[1], 10);
       let d2 = parseInt(rangeMatch[2], 10);
       if (d2 < d1) [d1, d2] = [d2, d1];

       const startISO = toISO(new Date(year, i, d1));
       const endISO = toISO(new Date(year, i, d2));
       return { mode: "range", startISO, endISO };
     }

     // no explicit days → vague month ("anything in July")
     const startISO = toISO(new Date(year, i, 1));
     const endTmp = new Date(year, i + 1, 0); // last day of month
     const endISO = toISO(endTmp);
     return { mode: "month", startISO, endISO };
   }
 }

 // 3) "next month" / "this month"
 if (text.includes("next month")) {
   const m = now.getMonth() + 1;
   const y = m > 11 ? now.getFullYear() + 1 : now.getFullYear();
   const realMonth = m > 11 ? 0 : m;
   const startISO = toISO(new Date(y, realMonth, 1));
   const endISO = toISO(new Date(y, realMonth + 1, 0));
   return { mode: "month", startISO, endISO };
 }
 if (text.includes("this month")) {
   const y = now.getFullYear();
   const m = now.getMonth();
   const startISO = toISO(new Date(y, m, 1));
   const endISO = toISO(new Date(y, m + 1, 0));
   return { mode: "month", startISO, endISO };
 }

 // 4) fall back → try exact date
 const d = new Date(raw);
 if (!isNaN(d)) {
   return { mode: "single", dateISO: toISO(d) };
 }

 // unknown
 return { mode: "unknown" };
}

// --------- main /check endpoint ----------

app.post("/check", async (req, res) => {
 try {
   const { query } = req.body || {};
   if (!query) {
     return res.status(400).json({ error: "Missing 'query' in body" });
   }

   const parsed = parseQuery(query);
   const bookings = await loadBookings();

   // SINGLE DATE
   if (parsed.mode === "single") {
     const dateISO = parsed.dateISO;
     const booked = isBookedDate(dateISO, bookings);
     const price = getPriceForDate(dateISO);

     return res.json({
       mode: "single",
       date: dateISO,
       booked,
       price,
       message: booked
         ? `Sorry – ${dateISO} sits inside a booked week.`
         : price
         ? `Good news – that week is around £${price}. Short stays on request.`
         : `That date looks available. Short stays on request.`,
     });
   }

   // EXACT RANGE (user typed 10–17 July)
   if (parsed.mode === "range") {
     const { startISO, endISO } = parsed;
     const booked = rangeBooked(startISO, endISO, bookings);
     const price = getPriceForDate(startISO);

     return res.json({
       mode: "range",
       start_date: startISO,
       end_date: endISO,
       booked,
       price,
       message: booked
         ? "Sorry – that range includes booked nights."
         : price
         ? `Great news – that stay is around £${price}.`
         : "That range appears available.",
     });
   }

   // WEEK: show just that Sat–Sat
   if (parsed.mode === "week") {
     const { startISO, endISO } = parsed;
     const booked = rangeBooked(startISO, endISO, bookings);
     const price = getPriceForDate(startISO);

     return res.json({
       mode: "week",
       start_date: startISO,
       end_date: endISO,
       booked,
       price,
       message: booked
         ? "Sorry – that week is booked."
         : price
         ? `That Sat–Sat week is available at about £${price}.`
         : "That Sat–Sat week looks available.",
     });
   }

   // MONTH / VAGUE PERIOD → list available Sat–Sat weeks
   if (parsed.mode === "month") {
     const { startISO, endISO } = parsed;
     const start = new Date(startISO);
     const end = new Date(endISO);

     let cur = new Date(start);
     // move to first Saturday on/after start
     while (cur.getDay() !== 6) {
       cur.setDate(cur.getDate() + 1);
     }

     const availableWeeks = [];
     while (cur <= end) {
       const weekStart = new Date(cur);
       const weekEnd = new Date(cur);
       weekEnd.setDate(weekEnd.getDate() + 7);

       if (!rangeBooked(weekStart, weekEnd, bookings)) {
         const iso = toISO(weekStart);
         availableWeeks.push({
           start: iso,
           price: getPriceForDate(iso),
         });
       }

       cur.setDate(cur.getDate() + 7);
     }

     if (availableWeeks.length === 0) {
       return res.json({
         mode: "month",
         start_date: startISO,
         end_date: endISO,
         availableWeeks,
         message:
           "That period looks fully booked, or there are no clear Sat–Sat weeks left.",
       });
     }

     // build a human message
     const lines = availableWeeks.slice(0, 8).map((w) => {
       const s = new Date(w.start);
       const e = new Date(s);
       e.setDate(e.getDate() + 7);

       const fmt = (d) =>
         d.toLocaleDateString("en-GB", {
           day: "2-digit",
           month: "short",
         });

       const priceText = w.price ? ` — £${w.price}` : "";
       return `• ${fmt(s)} to ${fmt(e)}${priceText}`;
     });

     return res.json({
       mode: "month",
       start_date: startISO,
       end_date: endISO,
       availableWeeks,
       message:
         "Here are the available Sat–Sat weeks in that period:\n" +
         lines.join("\n") +
         "\n\nYou can book any of these directly on the Tansea site.",
     });
   }

   // UNKNOWN
   return res.json({
     mode: "unknown",
     message:
       "Sorry, I couldn't understand those dates. Try something like:\n" +
       "• '12 July 2026'\n" +
       "• '10–17 August 2026'\n" +
       "• 'anything in July 2026'\n" +
       "• 'next week'",
   });
 } catch (err) {
   console.error("ERROR /check:", err);
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

