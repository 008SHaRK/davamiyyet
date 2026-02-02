require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const ExcelJS = require("exceljs");
const axios = require("axios");

const pool = require("./db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Static
app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));

// ----------------------
// Face helper
// ----------------------
function euclideanDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

const FACE_THRESHOLD = Number(process.env.FACE_THRESHOLD || 0.55);

// ----------------------
// Telegram helper
// ----------------------
async function sendTelegramMessage(text, imageUrl = null) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.log("Telegram token və ya chat id yoxdur (.env yoxla)");
      return;
    }

    // ✅ ƏLAVƏ: Debug üçün
    // console.log("TELEGRAM SEND -> chatId:", chatId, "image?", !!imageUrl);

    if (imageUrl) {
      await axios.post(`https://api.telegram.org/bot${token}/sendPhoto`, {
        chat_id: chatId,
        photo: imageUrl,
        caption: text,
      });
    } else {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
      });
    }
  } catch (err) {
    // Telegram error bəzən response ilə gəlir
    const more = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.log("Telegram xətası:", more);
  }
}

// ----------------------
// Admin Basic Auth
// ----------------------
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin Panel"');
    return res.status(401).send("Admin login lazimdir");
  }

  const base64 = auth.replace("Basic ", "");
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  const [user, pass] = decoded.split(":");

  if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Admin Panel"');
  return res.status(401).send("Yanlis login/parol");
}

// ----------------------
// Multer (log şəkil upload)
// ----------------------
const logStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/loglar"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const name = `log_${Date.now()}_${Math.floor(Math.random() * 1e9)}${ext}`;
    cb(null, name);
  },
});
const uploadLog = multer({
  storage: logStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Referans şəkil upload
const refStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/ref"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `ref_${Date.now()}_${Math.floor(Math.random() * 1e9)}${ext}`);
  },
});
const uploadRef = multer({
  storage: refStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ----------------------
// Pages
// ----------------------
app.get("/q/:mekan", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "admin.html"));
});

app.get("/admin/isciler", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "isciler.html"));
});

// ----------------------
// Utility
// ----------------------
app.get("/", (req, res) => res.send("Davamiyyet backend isleyir ✅"));

app.get("/test-db", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ ƏLAVƏ: Telegram test route (işləyirsə, botdan mesaj gəlməlidir)
app.get("/api/test-telegram", async (req, res) => {
  await sendTelegramMessage("✅ Test mesaj: serverdən Telegrama gəldi.");
  res.json({ ok: true });
});

// ----------------------
// Admin APIs
// ----------------------

// Loglar (son 50)
app.get("/api/admin/loglar", requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        l.id,
        l.tarix_saat,
        l.hadise,
        l.mekan,
        l.status,
        l.kamera_sekil_url,
        l.ad,
        l.soyad,
        l.vezife,
        l.qeyd
      FROM loglar l
      ORDER BY l.tarix_saat DESC
      LIMIT 50
    `);

    const fixed = rows.map((r) => ({
      ...r,
      kamera_sekil_url: r.kamera_sekil_url?.startsWith("/")
        ? r.kamera_sekil_url
        : "/" + r.kamera_sekil_url,
    }));

    res.json(fixed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// İşçilər siyahısı
app.get("/api/admin/isciler", requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, ad, soyad, vezife, aktiv, yaradildi, ref_sekil_url, profil_sekil_url
      FROM isciler
      ORDER BY id DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// İşçi əlavə et
app.post("/api/admin/isciler", requireAdmin, async (req, res) => {
  try {
    const { ad, soyad, vezife } = req.body;

    if (!ad || !soyad || !vezife) {
      return res.status(400).json({ error: "ad/soyad/vezife bos ola bilmez" });
    }

    const A = ad.trim();
    const S = soyad.trim();
    const V = vezife.trim();

    const [exists] = await pool.query(
      `SELECT id FROM isciler
       WHERE LOWER(ad)=LOWER(?) AND LOWER(soyad)=LOWER(?) AND LOWER(vezife)=LOWER(?)
       LIMIT 1`,
      [A, S, V]
    );

    if (exists.length) return res.status(409).json({ error: "Bu isci artiq var" });

    const [ins] = await pool.query(
      `INSERT INTO isciler (ad, soyad, vezife, aktiv)
       VALUES (?,?,?,1)`,
      [A, S, V]
    );

    res.json({ ok: true, id: ins.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Referans şəkil + descriptor yaz
app.post("/api/admin/isciler/:id/ref", requireAdmin, uploadRef.single("ref"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id yanlisdir" });

    if (!req.file) return res.status(400).json({ error: "ref sekil gonderilmedi" });
    if (!req.body.descriptor) return res.status(400).json({ error: "descriptor gonderilmedi" });

    const ref_sekil_url = `/uploads/ref/${req.file.filename}`;

    await pool.query(
      `UPDATE isciler SET ref_sekil_url=?, ref_descriptor=? WHERE id=?`,
      [ref_sekil_url, req.body.descriptor, id]
    );

    res.json({ ok: true, ref_sekil_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Maaş Excel
app.get("/api/admin/maas.xlsx", requireAdmin, async (req, res) => {
  try {
    const month = (req.query.month || "").trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "month formati: 2026-02" });
    }

    const [Y, M] = month.split("-").map(Number);
    const daysInMonth = new Date(Y, M, 0).getDate();

    const start = `${month}-01`;
    const end = `${month}-${String(daysInMonth).padStart(2, "0")}`;

    const [isciler] = await pool.query(`
      SELECT id, ad, soyad, vezife, aktiv
      FROM isciler
      ORDER BY id
    `);

    const [gelenler] = await pool.query(
      `
      SELECT isci_id, COUNT(DISTINCT DATE(tarix_saat)) AS gelen_gun
      FROM loglar
      WHERE hadise='GIRIS'
        AND status='OK'
        AND DATE(tarix_saat) BETWEEN ? AND ?
      GROUP BY isci_id
      `,
      [start, end]
    );

    const gelenMap = new Map(gelenler.map((x) => [x.isci_id, Number(x.gelen_gun)]));
    const GUNLUK_MAAS = 30;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Maas");

    ws.columns = [
      { header: "ID", key: "id", width: 8 },
      { header: "Ad", key: "ad", width: 14 },
      { header: "Soyad", key: "soyad", width: 16 },
      { header: "Vəzifə", key: "vezife", width: 14 },
      { header: "Ay", key: "ay", width: 10 },
      { header: "Ay gün sayı", key: "ay_gun", width: 12 },
      { header: "Gəldiyi gün", key: "gelen", width: 12 },
      { header: "Gəlmədiyi gün", key: "gelmeyen", width: 14 },
      { header: "Günlük maaş", key: "gunluk", width: 12 },
      { header: "Maaş cəmi", key: "cem", width: 12 },
    ];

    ws.getRow(1).font = { bold: true };

    for (const i of isciler) {
      const gelen = gelenMap.get(i.id) || 0;
      const gelmeyen = daysInMonth - gelen;
      const cem = gelen * GUNLUK_MAAS;

      ws.addRow({
        id: i.id,
        ad: i.ad,
        soyad: i.soyad,
        vezife: i.vezife,
        ay: month,
        ay_gun: daysInMonth,
        gelen,
        gelmeyen,
        gunluk: GUNLUK_MAAS,
        cem,
      });
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="maas_${month}.xlsx"`);

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// İşçi API: qeydiyyat
// ----------------------
app.post("/api/qeydiyyat", uploadLog.single("sekil"), async (req, res) => {
  try {
    const { ad, soyad, vezife, mekan } = req.body;

    let shotDesc = null;
    try {
      shotDesc = JSON.parse(req.body.descriptor || "null");
    } catch {
      shotDesc = null;
    }

    if (!ad || !soyad || !vezife || !mekan) {
      return res.status(400).json({ error: "ad/soyad/vezife/mekan boş ola bilməz" });
    }
    if (!shotDesc) {
      return res.status(400).json({ error: "üz tapılmadı (descriptor gelmedi)" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "sekil göndərilmədi" });
    }

    const kamera_sekil_url = `/uploads/loglar/${req.file.filename}`;

    const [isciRows] = await pool.query(
      `SELECT id, aktiv, ref_descriptor
       FROM isciler
       WHERE LOWER(ad)=LOWER(?) AND LOWER(soyad)=LOWER(?) AND LOWER(vezife)=LOWER(?)
       LIMIT 1`,
      [ad.trim(), soyad.trim(), vezife.trim()]
    );

    const isci = isciRows[0];
    const isci_id = isci ? isci.id : null;

    let hadise = "GIRIS";
    let status = "OK";
    let qeyd = null;

    // işçi yox / deaktiv
    if (!isci_id || isci.aktiv !== 1) {
      status = "REJECT";
      qeyd = !isci_id ? "isci tapilmadi" : "isci deaktivdir";
    } else {
      // face match
      let refDesc = null;
      try {
        refDesc = isci.ref_descriptor ? JSON.parse(isci.ref_descriptor) : null;
      } catch {
        refDesc = null;
      }

      if (!refDesc) {
        status = "REJECT";
        qeyd = "referans şəkil yoxdur";
      } else {
        const dist = euclideanDistance(shotDesc, refDesc);
        console.log("FACE CHECK:", { isci_id, dist, threshold: FACE_THRESHOLD });

        if (dist === null) {
          status = "REJECT";
          qeyd = "descriptor format xətası";
        } else if (dist > FACE_THRESHOLD) {
          status = "REJECT";
          qeyd = `face uyusmadi (dist=${dist.toFixed(3)})`;
        }
      }

      // üz uyğundursa limit qaydası
      if (status === "OK") {
        const [todayRows] = await pool.query(
          `SELECT hadise
           FROM loglar
           WHERE isci_id=? AND DATE(tarix_saat)=CURDATE() AND status='OK'`,
          [isci_id]
        );

        const hasGiris = todayRows.some((r) => r.hadise === "GIRIS");
        const hasCixis = todayRows.some((r) => r.hadise === "CIXIS");

        if (!hasGiris) hadise = "GIRIS";
        else if (!hasCixis) hadise = "CIXIS";
        else {
          hadise = "CIXIS";
          status = "LIMIT";
          qeyd = "bugun 1 giris + 1 cixis limiti dolub";
        }
      }
    }

    // 6) log yaz (hər halda)
    const [ins] = await pool.query(
      `INSERT INTO loglar
        (isci_id, mekan, hadise, kamera_sekil_url, status, qeyd, ad, soyad, vezife)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        isci_id,
        mekan.trim(),
        hadise,
        kamera_sekil_url,
        status,
        qeyd,
        ad.trim(),
        soyad.trim(),
        vezife.trim(),
      ]
    );

    // ✅ TELEGRAM MESAJ (status + qeyd də daxil)
    const vaxt = new Date().toLocaleString();
    const mesajText = `📌 Davamiyyət Bildirişi
👤 ${ad} ${soyad}
💼 ${vezife}
📍 ${mekan}
📥 Hadisə: ${hadise}
📊 Status: ${status}
📝 Qeyd: ${qeyd || "-"}
⏰ ${vaxt}`;

    // ŞƏKİL URL:
    // Telegram LOCALHOST-u GÖRMÜR. Ona görə, əgər PUBLIC_URL varsa onu istifadə edirik.
    // Məs: PUBLIC_URL=https://xxxx.ngrok-free.app
    const baseUrl = process.env.PUBLIC_URL || "http://localhost:3000";
    const photoUrl = `${baseUrl}${kamera_sekil_url}`;

    await sendTelegramMessage(mesajText, photoUrl);

    // ✅ cavab (1 dəfə!)
    return res.json({ ok: true, log_id: ins.insertId, status, hadise, kamera_sekil_url, qeyd });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ----------------------
// Listen  (MÜTLƏQ FAYLIN ƏN SONUNDA)
// ----------------------
const PORT = 3000;
app.get("/test-telegram-photo", async (req, res) => {
  try {
    const baseUrl = process.env.PUBLIC_URL || "http://localhost:3000";
    const photoUrl = `${baseUrl}/uploads/loglar/log_1769971969693_726155185.jpg`; // uploads/loglar/test.jpg olmalıdır

    await sendTelegramMessage("Test şəkilli mesaj ✅", photoUrl);
    res.json({ ok: true, photoUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("Server isledi: http://localhost:" + PORT);
});
