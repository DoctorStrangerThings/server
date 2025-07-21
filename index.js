require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const os = require("os");
const db = require("./db");
const FormData = require("form-data");
const validator = require("validator");
const GEOCODE_API = process.env.OPENCAGE_API_KEY;
console.log("🌍 OpenCage API Key:", process.env.OPENCAGE_API_KEY);

const app = express();
const port = 5000;

// Get local IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}
const ip = getLocalIP();

// Ensure uploads/ exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Middleware
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Multer config
const upload = multer({ dest: "uploads/" });

// 📤 Upload endpoint (supports both web and Flutter)
app.post("/upload", upload.array("images"), async (req, res) => {
  const files = req.files;
  const { project_name, monitored_date, latitude, longitude } = req.body;

  console.log("➡️ Received upload request");
  console.log("📦 Body:", req.body);
  console.log("🖼️ Files:", files);

  if (!project_name || !monitored_date || !files?.length) {
    console.log("❌ Missing required fields.");
    return res.status(400).json({ error: "Missing required fields." });
  }

  if (!validator.isLength(project_name, { min: 1, max: 255 })) {
    return res.status(400).json({ error: "Invalid project name." });
  }

  const firstFile = files[0];

  // If coordinates from Flutter are missing or invalid, fallback to EXIF extraction
  let lat = latitude;
  let lon = longitude;

  if (!lat || !lon || isNaN(parseFloat(lat)) || isNaN(parseFloat(lon))) {
    console.log(
      "⚠️ Coordinates not provided or invalid. Extracting from EXIF..."
    );
    const form = new FormData();
    form.append("image", fs.createReadStream(firstFile.path));

    try {
      const extractResponse = await axios.post(
        "http://localhost:5001/extract",
        form,
        { headers: form.getHeaders() }
      );

      const extractData = extractResponse.data;
      if (!extractData.success) {
        console.warn("⚠️ GPS extraction failed. Skipping DB insert.");
        fs.unlinkSync(firstFile.path);
        return res.status(400).json({
          error: "Missing or invalid GPS metadata. Image was not saved.",
          message: extractData.message || "No coordinates found.",
        });
      }

      lat = extractData.latitude;
      lon = extractData.longitude;
    } catch (err) {
      console.error("❌ EXIF extraction error:", err);
      fs.unlinkSync(firstFile.path);
      return res.status(500).json({ error: "EXIF extraction failed" });
    }
  } else {
    console.log("✅ Coordinates received from Flutter:");
    console.log("Latitude:", lat, "Longitude:", lon);
  }

  lat = parseFloat(lat);
  lon = parseFloat(lon);

  // Reverse geocoding
  let address = "Unknown Location";
  try {
    console.log("📡 Requesting reverse geocode for:", lat, lon);
    const geocodeResponse = await axios.get(
      `https://api.opencagedata.com/geocode/v1/json?q=${lat}+${lon}&key=${GEOCODE_API}`
    );
    console.log("📬 Geocode full response:", geocodeResponse.data);

    if (
      geocodeResponse.data &&
      geocodeResponse.data.results &&
      geocodeResponse.data.results.length > 0
    ) {
      address = geocodeResponse.data.results[0].formatted;
    } else {
      console.warn("⚠️ No geocoding results for coordinates:", lat, lon);
    }
  } catch (geoErr) {
    console.error(
      "❌ Geocoding request failed:",
      geoErr.response?.data || geoErr.message
    );
  }

  const insertQuery = `
    INSERT INTO images (project_name, monitored_date, filename, filepath, latitude, longitude, address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  const values = [
    project_name,
    monitored_date,
    firstFile.filename,
    firstFile.path,
    lat,
    lon,
    address,
  ];

  console.log("📝 Inserting to DB with values:", values);

  db.query(insertQuery, values, (err, result) => {
    if (err) {
      console.error("❌ DB Insert Error:", err);
      return res.status(500).json({ error: "Internal Server Error." });
    }

    console.log("✅ Inserted successfully with ID:", result.insertId);
    res.json({
      status: "ok",
      id: result.insertId,
      project_name,
      latitude: lat,
      longitude: lon,
      address,
    });
  });
});

// 📸 GET: Latest image per project
app.get("/images", (req, res) => {
  const query = `
    SELECT i.*
    FROM images i
    INNER JOIN (
      SELECT project_name, MAX(upload_date) AS latest
      FROM images
      GROUP BY project_name
    ) latest_per_project
    ON i.project_name = latest_per_project.project_name
    AND i.upload_date = latest_per_project.latest
  `;

  db.query(query, (err, rows) => {
    if (err) {
      console.error("❌ DB Error on /images:", err);
      return res.status(500).json({ error: "Internal Server Error." });
    }
    res.json(rows);
  });
});

// 🧹 DELETE: All images and DB entries
app.delete("/images", (req, res) => {
  db.query("SELECT filepath FROM images", (err, rows) => {
    if (err) return res.status(500).json({ error: "DB fetch failed" });

    let deletedCount = 0;

    for (const row of rows) {
      const fullPath = path.join(__dirname, row.filepath); // ✅ e.g. /app/uploads/filename.jpg

      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
          console.log("✅ Deleted:", fullPath);
          deletedCount++;
        } catch (err) {
          console.error("❌ Failed to delete:", fullPath, err);
        }
      } else {
        console.warn("⚠️ File not found:", fullPath);
      }
    }

    db.query("DELETE FROM images", (err) => {
      if (err) return res.status(500).json({ error: "DB delete failed" });
      res.json({
        status: "ok",
        message: `🗑️ Deleted ${deletedCount} image files and cleared DB.`,
      });
    });
  });
});

// 🚀 Start server
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Server running at: http://${ip}:${port}`);
});
