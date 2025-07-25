const { S3Client } = require("@aws-sdk/client-s3");
const admin = require("firebase-admin");

// 🔐 Firebase init (assuming your serviceAccountKey is correctly set)
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ⚙️ Setup Cloudflare R2 client
const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

module.exports = {
  db,
  r2Client,
};
