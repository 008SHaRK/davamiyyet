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

// ✅ 2 dəfə yazmağa ehtiyac yoxdur, amma sənin dediyin kimi saxlayıram
app.use(express.json({ limit: "10mb" }));
app.use(express.json());

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
// ✅ ƏLAVƏ: telefon normallaşdırma
// ----------------------
function normPhone(p) {
  if (!p) return null;
  let x = String(p).replace(/[^\d+]/g, "");
  if (x.startsWith("00")) x = "+" + x.slice(2);
  if (!x.startsWith("+")) x = "+" + x;
  return x;
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
// Telegram helper  ✅ DƏYİŞDİ: artıq seçilmiş nömrələr (abonələr)
// ----------------------
async function sendTelegramMessage(text, imageUrl = null) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      console.log("Telegram token yoxdur (.env yoxla)");
      return;
    }

    // ✅ Yalnız aktiv abonələrə göndər
    const [subs] = await pool.query(`SELECT chat_id FROM telegram_abuneler WHERE aktiv=1`);

    if (!subs.length) {
      console.log("Aktiv telegram abonə yoxdur. /start edib nömrəni göndərməlidirlər.");
      return;
    }

    for (const s of subs) {
      const chatId = s.chat_id;

      try {
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
      } catch (err2) {
        const more = err2.response?.data ? JSON.stringify(err2.response.data) : err2.message;
        console.log("Telegram göndərmə xətası:", chatId, more);
      }
    }
  } catch (err) {
    const more = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.log("Telegram xətası:", more);
  }
}

// ----------------------
// ✅ ƏLAVƏ: Telegram webhook (seçilmiş nömrələr / icazə)
// ----------------------
app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return res.json({ ok: true });

    const msg = update.message;
    if (!msg) return res.json({ ok: true });

    const chatId = msg.chat?.id;
    const text = (msg.text || "").trim();

    if (!chatId) return res.json({ ok: true });

    // /start -> contact istə
    if (text === "/start") {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text:
          "📌 Davamiyyət bildirişləri üçün nömrəni təsdiqlə.\n\n" +
          "Aşağıdakı düymədən 'Nömrəni göndər' seç.",
        reply_markup: {
          keyboard: [[{ text: "📲 Nömrəni göndər", request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
      return res.json({ ok: true });
    }

    // Contact gəlibsə -> icazə yoxla
    if (msg.contact && msg.contact.phone_number) {
      const phoneFixed = normPhone(msg.contact.phone_number);

      if (!phoneFixed) {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Nömrə oxunmadı. Yenidən göndər.",
        });
        return res.json({ ok: true });
      }

      // icazəli siyahıda varmı?
      const [allow] = await pool.query(
        `SELECT id FROM telegram_icazeli WHERE telefon=? LIMIT 1`,
        [phoneFixed]
      );

      if (!allow.length) {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: chatId,
          text: "⛔ Bu nömrə icazəli siyahıda deyil. Admin ilə əlaqə saxla.",
        });

        await pool.query(
          `INSERT INTO telegram_abuneler (chat_id, telefon, aktiv)
           VALUES (?,?,0)
           ON DUPLICATE KEY UPDATE telefon=VALUES(telefon), aktiv=0`,
          [chatId, phoneFixed]
        );

        return res.json({ ok: true });
      }

      // icazəlidirsə aktiv et
      await pool.query(
        `INSERT INTO telegram_abuneler (chat_id, telefon, aktiv)
         VALUES (?,?,1)
         ON DUPLICATE KEY UPDATE telefon=VALUES(telefon), aktiv=1`,
        [chatId, phoneFixed]
      );

      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: "✅ Təsdiqləndin. Artıq bildirişlər sənə də gələcək.",
        reply_markup: { remove_keyboard: true },
      });

      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.log("Webhook xətası:", err.message);
    return res.json({ ok: true });
  }
});

// ----------------------
// ✅ Telegram Admin APIs (icazeli telefonlar)
// ----------------------

// icazeli siyahi
app.get("/api/admin/telegram/icazeli", requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, telefon, yaradildi
      FROM telegram_icazeli
      ORDER BY id DESC
      LIMIT 500
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// icazeli elave et
app.post("/api/admin/telegram/icazeli", requireAdmin, async (req, res) => {
  try {
    let { telefon } = req.body || {};
    telefon = normPhone(telefon);

    if (!telefon) return res.status(400).json({ error: "telefon bos ola bilmez" });

    // təkrar varsa
    const [ex] = await pool.query(
      `SELECT id FROM telegram_icazeli WHERE telefon=? LIMIT 1`,
      [telefon]
    );
    if (ex.length) return res.status(409).json({ error: "bu nomre artiq icazelidir" });

    const [ins] = await pool.query(
      `INSERT INTO telegram_icazeli (telefon) VALUES (?)`,
      [telefon]
    );

    res.json({ ok: true, id: ins.insertId, telefon });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// icazeli sil
app.delete("/api/admin/telegram/icazeli/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id yanlisdir" });

    await pool.query(`DELETE FROM telegram_icazeli WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// ✅ MAAŞ QAYDALARI (mekan + vezife -> gunluk_maas)
// ----------------------

// 1) Qaydaları gətir
app.get("/api/admin/maas/qaydalar", requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, mekan, vezife, gunluk_maas, aktiv, yaradildi
      FROM maas_qaydalar
      WHERE aktiv=1
      ORDER BY mekan, vezife
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2) Qayda əlavə et / yenilə (eyni mekan+vezife varsa update edir)
app.post("/api/admin/maas/qaydalar", requireAdmin, async (req, res) => {
  try {
    let { mekan, vezife, gunluk_maas } = req.body || {};

    mekan = String(mekan || "").trim();
    vezife = String(vezife || "").trim();
    const g = Number(gunluk_maas);

    if (!mekan || !vezife) return res.status(400).json({ error: "mekan ve vezife bos ola bilmez" });
    if (!Number.isFinite(g) || g < 0) return res.status(400).json({ error: "gunluk_maas duzgun deyil" });

    // normalize (case-insensitive olsun)
    const m = mekan.toLowerCase();
    const v = vezife.toLowerCase();

    await pool.query(
      `
      INSERT INTO maas_qaydalar (mekan, vezife, gunluk_maas, aktiv)
      VALUES (?,?,?,1)
      ON DUPLICATE KEY UPDATE gunluk_maas=VALUES(gunluk_maas), aktiv=1
      `,
      [m, v, g]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3) Qaydanı sil (deaktiv)
app.delete("/api/admin/maas/qaydalar/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id yanlisdir" });

    await pool.query(`UPDATE maas_qaydalar SET aktiv=0 WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

app.get("/admin/telegram", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "telegram.html"));
});

app.get("/admin/maas", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "maas.html"));
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

// Maaş Excel (✅ indi vezife+mekan qaydası ilə)
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

    // ✅ Maaş qaydaları map: (mekan|vezife) -> gunluk_maas
    const [rules] = await pool.query(`
      SELECT mekan, vezife, gunluk_maas
      FROM maas_qaydalar
      WHERE aktiv=1
    `);
    const ruleMap = new Map(
      rules.map((r) => [`${String(r.mekan).toLowerCase()}|${String(r.vezife).toLowerCase()}`, Number(r.gunluk_maas)])
    );

    // ✅ Hər işçiyə ən çox GIRIS etdiyi məkana görə maaş seçək (ay ərzində)
    const [mekanSay] = await pool.query(
      `
      SELECT isci_id, mekan, COUNT(*) cnt
      FROM loglar
      WHERE hadise='GIRIS'
        AND status='OK'
        AND DATE(tarix_saat) BETWEEN ? AND ?
      GROUP BY isci_id, mekan
      `,
      [start, end]
    );

    // isci_id -> dominant mekan
    const dominantMekan = new Map();
    for (const row of mekanSay) {
      const id = row.isci_id;
      const cur = dominantMekan.get(id);
      if (!cur || row.cnt > cur.cnt) dominantMekan.set(id, { mekan: row.mekan, cnt: row.cnt });
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Maas");

    ws.columns = [
      { header: "ID", key: "id", width: 8 },
      { header: "Ad", key: "ad", width: 14 },
      { header: "Soyad", key: "soyad", width: 16 },
      { header: "Vəzifə", key: "vezife", width: 14 },
      { header: "Məkan (dominant)", key: "mekan", width: 18 },
      { header: "Ay", key: "ay", width: 10 },
      { header: "Ay gün sayı", key: "ay_gun", width: 12 },
      { header: "Gəldiyi gün", key: "gelen", width: 12 },
      { header: "Gəlmədiyi gün", key: "gelmeyen", width: 14 },
      { header: "Günlük maaş", key: "gunluk", width: 12 },
      { header: "Maaş cəmi", key: "cem", width: 12 },
      { header: "Qayda tapıldı?", key: "qayda", width: 12 },
    ];

    ws.getRow(1).font = { bold: true };

    for (const i of isciler) {
      const gelen = gelenMap.get(i.id) || 0;
      const gelmeyen = daysInMonth - gelen;

      const dom = dominantMekan.get(i.id);
      const mekan = dom?.mekan || "";

      // default (əgər qayda tapılmasa)
      let gunluk = 30;

    const key =
  `${String(mekan).trim().toLowerCase()}|${String(i.vezife).trim().toLowerCase()}`;

      const rule = ruleMap.get(key);

      console.log("CHECK:", {
  isci: i.ad,
  vezife: i.vezife,
  mekan,
  key,
  rule,
});


      const ruleFound = rule !== undefined;

      if (ruleFound) gunluk = rule;

      const cem = gelen * gunluk;

      ws.addRow({
        id: i.id,
        ad: i.ad,
        soyad: i.soyad,
        vezife: i.vezife,
        mekan: mekan || "-",
        ay: month,
        ay_gun: daysInMonth,
        gelen,
        gelmeyen,
        gunluk,
        cem,
        qayda: ruleFound ? "Bəli" : "Yox",
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

    const vaxt = new Date().toLocaleString();
    const mesajText = `📌 Davamiyyət Bildirişi
👤 ${ad} ${soyad}
💼 ${vezife}
📍 ${mekan}
📥 Hadisə: ${hadise}
📊 Status: ${status}
📝 Qeyd: ${qeyd || "-"}
⏰ ${vaxt}`;

    const baseUrl = process.env.PUBLIC_URL || "http://localhost:3000";
    const photoUrl = `${baseUrl}${kamera_sekil_url}`;

    await sendTelegramMessage(mesajText, photoUrl);

    return res.json({ ok: true, log_id: ins.insertId, status, hadise, kamera_sekil_url, qeyd });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ----------------------
// Listen
// ----------------------
const PORT = process.env.PORT || 3000;

app.get("/test-telegram-photo", async (req, res) => {
  try {
    const baseUrl = process.env.PUBLIC_URL || "http://localhost:3000";
    const photoUrl = `${baseUrl}/uploads/loglar/log_1769971969693_726155185.jpg`;

    await sendTelegramMessage("Test şəkilli mesaj ✅", photoUrl);
    res.json({ ok: true, photoUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server isledi, port:", PORT);
});
