import express from "express";
import cors from "cors";
import ical from "node-ical";

const app = express();
app.use(cors());

app.get("/", (req, res) => {
 res.json({ status: "Tansea availability API is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Tansea Availability running on " + PORT));
