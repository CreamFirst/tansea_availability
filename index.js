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

// ------------------
//  CHECK DATE ROUTE
// ------------------
app.post("/check-date", async (req, res) => {
try {
  const { date } = req.body;
  if (!date) {
    return res.status(400).json({ error: "Missing date" });
  }

  // Parse iCal
  const data = await ical.async.fromURL(ICAL_URL);

  let booked = false;

  for (let event of Object.values(data)) {
    if (event.type === "VEVENT") {
      const start = event.start;
      const end = event.end;

      // If the date falls within a booking event
      if (new Date(date) >= start && new Date(date) < end) {
        booked = true;
        break;
      }
    }
  }

  // Get price
  const weeklyPrice = getPriceForDate(date);

  if (booked) {
    return res.json({
      date,
      booked: true,
      price: weeklyPrice,
      message: `Sorry – that date is booked.`,
    });
  }

  // Available
  return res.json({
    date,
    booked: false,
    price: weeklyPrice,
    message:
      weeklyPrice !== null
        ? `Great news — that week is £${weeklyPrice}. Short stays available on request.`
        : `That date is available.`,
  });
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
