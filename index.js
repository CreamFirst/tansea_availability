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

// Weekly pricing table (Sat–Sat)
const prices = JSON.parse(fs.readFileSync("./prices.json", "utf8"));

// ---------------------------
// HELPERS
// ---------------------------

function toTime(d) {
 return new Date(d).getTime();
}

function iso(d) {
 return new Date(d).toISOString().slice(0, 10);
}

function niceDate(s) {
 return new Date(s).toLocaleDateString("en-UK", {
   weekday: "short",
   day: "numeric",
   month: "short",
   year: "numeric"
 });
}

// Find price band
function getPriceForDate(dateStr) {
 const t = toTime(dateStr);
 for (const p of prices) {
   if (t >= toTime(p.start) && t < toTime(p.end)) return p.price;
 }
 return null;
}

// Snap to Saturday
function snapToSaturday(dateStr) {
 const d = new Date(dateStr);
 const day = d.getDay();
 const diff = (day + 1) % 7;
 d.setDate(d.getDate() - diff);
 return iso(d);
}

// Load bookings
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

function findNextAvailableWeek(dateStr, bookings, maxWeeks = 8) {
 let sat = snapToSaturday(dateStr);
 let d = new Date(sat);

 for (let i = 0; i < maxWeeks; i++) {
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
   if (!info.booked && info.price !== null) weeks.push(info);
   d.setDate(d.getDate() + 7);
 }
 return weeks;
}

// ---------------------------
// INTERPRET QUERY
// ---------------------------

function interpretQuery(query) {
 if (!query || typeof query !== "string") return { kind: "invalid" };

 const trimmed = query.trim().toLowerCase();

 // -------- SEASON LOGIC --------
 const year = new Date().getFullYear();

 if (trimmed.includes("summer")) {
   return {
     kind: "vagueRange",
     start: `${year}-06-01`,
     end: `${year}-09-01`,
     label: "summer",
   };
 }

 if (trimmed.includes("easter")) {
   return {
     kind: "vagueRange",
     start: `${year}-03-25`,
     end: `${year}-04-20`,
     label: "easter",
   };
 }

 if (trimmed.includes("christmas") || trimmed.includes("xmas")) {
   return {
     kind: "vagueRange",
     start: `${year}-12-15`,
     end: `${year + 1}-01-05`,
     label: "christmas",
   };
 }

 // -------- Chrono natural language parser --------
 const results = chrono.parse(trimmed, new Date(), { forwardDate: true });
 if (results.length === 0) return { kind: "invalid" };

 const r = results[0];

 // Explicit range
 if (r.end) {
   return {
     kind: "range",
     start: iso(r.start.date()),
     end: iso(r.end.date()),
   };
 }

 // Possible vague month (“in July”)
 const monthWords = ["in ", "during ", "throughout "];
 if (monthWords.some((w) => trimmed.includes(w))) {
   const base = r.start.date();
   return {
     kind: "vagueRange",
     start: iso(new Date(base.getFullYear(), base.getMonth(), 1)),
     end: iso(new Date(base.getFullYear(), base.getMonth() + 1, 1)),
     label: "month",
   };
 }

 // Single date
 return { kind: "single", date: iso(r.start.date()) };
}

// ---------------------------
// MAIN ENDPOINT
// ---------------------------

app.post("/check", async (req, res) => {
 try {
   const { query, date } = req.body;
   const userText = query || date;
   if (!userText)
     return res.status(400).json({ error: "Missing 'query' or 'date'" });

   const interpretation = interpretQuery(userText);
   const bookings = await loadBookings();

   // ---------- SINGLE ----------
   if (interpretation.kind === "single") {
     const chosen = interpretation.date;
     const week = findNextAvailableWeek(chosen, bookings);

     if (!week)
       return res.json({
         mode: "single",
         message: "No Sat–Sat availability found near those dates.",
       });

     return res.json({
       mode: "single",
       week,
       message: `The next available Sat–Sat stay is **${niceDate(
         week.start
       )} → ${niceDate(week.end)}** at **£${week.price}**.`,
     });
   }

   // ---------- RANGE ----------
   if (interpretation.kind === "range") {
     const { start } = interpretation;
     const sat = snapToSaturday(start);
     const week = getWeekInfo(sat, bookings);

     if (week.booked) {
       const alt = findNextAvailableWeek(start, bookings);
       if (!alt)
         return res.json({
           mode: "range",
           message: "That range is booked, and no nearby weeks are free.",
         });

       return res.json({
         mode: "range",
         alt,
         message: `That range is booked — but **${niceDate(
           alt.start
         )} → ${niceDate(alt.end)}** is available at **£${alt.price}**.`,
       });
     }

     return res.json({
       mode: "range",
       week,
       message: `Good news — **${niceDate(week.start)} → ${niceDate(
         week.end
       )}** is available at **£${week.price}**.`,
     });
   }

   // ---------- VAGUE ----------
   if (interpretation.kind === "vagueRange") {
     const { start, end } = interpretation;
     const weeks = findAvailableWeeksBetween(start, end, bookings);

     if (weeks.length === 0)
       return res.json({
         mode: "vagueRange",
         message: "That period appears fully booked.",
       });

     const sample = weeks
       .slice(0, 3)
       .map(
         (w) =>
           `${niceDate(w.start)} → ${niceDate(w.end)} (£${w.price})`
       )
       .join("; ");

     return res.json({
       mode: "vagueRange",
       weeks,
       message: `Available weeks include: ${sample}`,
     });
   }

   return res.json({
     mode: "invalid",
     message: "Sorry — I couldn't interpret those dates.",
   });
 } catch (err) {
   console.error("ERROR /check:", err);
   res.status(500).json({ error: "Server error" });
 }
});

// Root
app.get("/", (req, res) => {
 res.json({ status: "Tansea Smart Availability API v2 is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
 console.log("Tansea Availability API running on " + PORT)
);



