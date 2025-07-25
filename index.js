require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const path = require("path");
const os = require("os");
const FormData = require("form-data");
const validator = require("validator");
const { db, r2Client } = require("./db");
const { PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");

const app = express();
const port = process.env.PORT || 5000;
const GEOCODE_API = process.env.OPENCAGE_API_KEY;

app.get("/", (req, res) => {
  res.send("API is running.");
});

// 🌐 Get local IP
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

// 🔧 Middleware
app.use(cors({ origin: "*" }));
app.use(express.json());

// 🧳 Multer - temporary local storage before upload to R2
const upload = multer({ dest: "temp_uploads/" });

// 📤 POST /upload
app.post("/upload", upload.array("images"), async (req, res) => {
  const files = req.files;
  const { project_name, monitored_date, latitude, longitude } = req.body;

  if (!project_name || !monitored_date || !files?.length) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  if (!validator.isLength(project_name, { min: 1, max: 255 })) {
    return res.status(400).json({ error: "Invalid project name." });
  }

  const firstFile = files[0];
  let lat = latitude;
  let lon = longitude;

  // 🔍 Extract coordinates if not provided
  if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
    const form = new FormData();
    form.append("image", fs.createReadStream(firstFile.path));

    try {
      const { data } = await axios.post(process.env.PYTHON_SERVICE_URL, form, {
        headers: form.getHeaders(),
      });

      if (!data.success) {
        fs.unlinkSync(firstFile.path);
        return res.status(400).json({
          error: "Missing or invalid GPS metadata.",
          message: data.message || "No coordinates found.",
        });
      }

      lat = data.latitude;
      lon = data.longitude;
    } catch (err) {
      fs.unlinkSync(firstFile.path);
      return res.status(500).json({ error: "EXIF extraction failed" });
    }
  }

  lat = parseFloat(lat);
  lon = parseFloat(lon);

  // 🌍 Reverse geocoding
  let address = "Unknown Location";
  try {
    const geo = await axios.get(
      `https://api.opencagedata.com/geocode/v1/json?q=${lat}+${lon}&key=${GEOCODE_API}`
    );
    if (geo?.data?.results?.length > 0) {
      address = geo.data.results[0].formatted;
    }
  } catch (geoErr) {
    console.error(
      "❌ Geocoding failed:",
      geoErr.response?.data || geoErr.message
    );
  }

  // ☁️ Upload to Cloudflare R2 via AWS SDK
  const r2Key = `images/${Date.now()}-${firstFile.originalname}`;
  try {
    const fileBuffer = fs.readFileSync(firstFile.path);

    const uploadCommand = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: r2Key,
      Body: fileBuffer,
      ContentType: firstFile.mimetype,
    });

    await r2Client.send(uploadCommand);
    fs.unlinkSync(firstFile.path);

    const r2Url = `https://${process.env.R2_PUBLIC_DOMAIN}/${r2Key}`;

    const savedFilename = r2Key.split("/")[1]; // "12345-filename.jpg"

    const docRef = await db.collection("images").add({
      project_name,
      monitored_date,
      filename: savedFilename, // ✅ This is what you use to render the image
      r2_url: r2Url,
      latitude: lat,
      longitude: lon,
      address,
      upload_date: new Date(),
    });

    res.json({
      status: "ok",
      id: docRef.id,
      r2_url: r2Url,
      latitude: lat,
      longitude: lon,
      address,
    });
  } catch (err) {
    console.error("❌ R2 upload error:", err);
    res.status(500).json({ error: "Failed to upload to R2." });
  }
});

// 📸 GET /images — Latest image per project
app.get("/images", async (req, res) => {
  try {
    const snapshot = await db.collection("images").get();
    const allDocs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    const latestPerProject = {};
    for (const doc of allDocs) {
      const key = doc.project_name;
      const existing = latestPerProject[key];

      if (
        !existing ||
        new Date(doc.upload_date) > new Date(existing.upload_date)
      ) {
        latestPerProject[key] = doc;
      }
    }

    res.json(Object.values(latestPerProject));
  } catch (err) {
    console.error("❌ Firestore fetch error:", err);
    res.status(500).json({ error: "Internal Server Error." });
  }
});

// DELETE /images — Delete all images in Firestore and R2
app.delete("/images", async (req, res) => {
  try {
    const snapshot = await db.collection("images").get();

    const deletePromises = [];

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const r2Url = data.r2_url;

      if (r2Url) {
        const r2Key = decodeURIComponent(new URL(r2Url).pathname.substring(1));

        deletePromises.push(
          r2Client
            .send(
              new DeleteObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: r2Key,
              })
            )
            .catch((err) => {
              console.warn(`⚠️ Failed to delete ${r2Key}: ${err.message}`);
            })
        );
      }

      deletePromises.push(doc.ref.delete());
    }

    await Promise.all(deletePromises);

    res.json({
      status: "ok",
      message: "All images deleted from Firestore and R2.",
    });
  } catch (err) {
    console.error("❌ Bulk delete error:", err);
    res.status(500).json({ error: "Failed to delete all images." });
  }
});

// 🚀 Start server
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Server running at: http://${ip}:${port}`);
});
