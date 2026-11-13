require("dotenv").config();

const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Nader@2026";

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");

for (const folder of [DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(folder, { recursive: true });
}

// قاعدة البيانات
const db = new Database(
  path.join(DATA_DIR, "markaz-nader.sqlite")
);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// إنشاء الجداول
db.exec(`
  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    price INTEGER NOT NULL DEFAULT 0,
    duration_minutes INTEGER NOT NULL DEFAULT 60,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS working_hours (
    day_of_week INTEGER PRIMARY KEY,
    day_name TEXT NOT NULL,
    is_open INTEGER NOT NULL DEFAULT 1,
    open_time TEXT NOT NULL DEFAULT '08:00',
    close_time TEXT NOT NULL DEFAULT '20:00'
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_code TEXT UNIQUE,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    car_make TEXT NOT NULL,
    car_model TEXT NOT NULL,
    plate_number TEXT,
    service_id INTEGER NOT NULL,
    appointment_date TEXT NOT NULL,
    appointment_time TEXT NOT NULL,
    details TEXT,
    image_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES services(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS unique_active_booking_slot
  ON bookings (appointment_date, appointment_time)
  WHERE status != 'cancelled';
`);

// إضافة الخدمات الافتراضية
const serviceCount = db.prepare(
  "SELECT COUNT(*) AS count FROM services"
).get().count;

if (serviceCount === 0) {
  const addService = db.prepare(`
    INSERT INTO services
    (name, category, description, price, duration_minutes)
    VALUES (?, ?, ?, ?, ?)
  `);

  addService.run(
    "تغيير زيت المحرك",
    "oil",
    "تغيير زيت المحرك وفحص السوائل والفلاتر.",
    150,
    60
  );

  addService.run(
    "الميكانيكا",
    "mechanic",
    "فحص الأعطال الميكانيكية وتحديد الإصلاح المطلوب.",
    0,
    60
  );

  addService.run(
    "السمكرة",
    "bodywork",
    "فحص أضرار الهيكل والصدمات وتقدير تكلفة الإصلاح.",
    0,
    60
  );
}

// إضافة أوقات العمل الافتراضية
const hoursCount = db.prepare(
  "SELECT COUNT(*) AS count FROM working_hours"
).get().count;

if (hoursCount === 0) {
  const days = [
    "الأحد",
    "الإثنين",
    "الثلاثاء",
    "الأربعاء",
    "الخميس",
    "الجمعة",
    "السبت"
  ];

  const addHours = db.prepare(`
    INSERT INTO working_hours
    (day_of_week, day_name, is_open, open_time, close_time)
    VALUES (?, ?, ?, ?, ?)
  `);

  days.forEach((day, index) => {
    addHours.run(
      index,
      day,
      index === 5 ? 0 : 1,
      "08:00",
      "20:00"
    );
  });
}

// إعدادات الخادم
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: "markaz.sid",
  secret: process.env.SESSION_SECRET || "local-development-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60 * 8
  }
}));

// إعداد رفع صور السمكرة
const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, UPLOAD_DIR);
  },

  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();

    const safeExtension = [
      ".jpg",
      ".jpeg",
      ".png",
      ".webp"
    ].includes(extension) ? extension : ".jpg";

    callback(
      null,
      `damage-${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExtension}`
    );
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_req, file, callback) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowed.includes(file.mimetype)) {
      return callback(
        new Error("يسمح فقط بصور JPG أو PNG أو WEBP.")
      );
    }

    callback(null, true);
  }
});

app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));

// التحقق من صلاحية المدير
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    return next();
  }

  return res.status(401).json({
    message: "يجب تسجيل دخول المدير أولاً."
  });
}

// التاريخ المحلي
function localDateString() {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(":").map(Number);

  return hours * 60 + minutes;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

// الخدمات وساعات العمل المتاحة
app.get("/api/public", (_req, res) => {
  const services = db.prepare(`
    SELECT id, name, category, description, price, duration_minutes
    FROM services
    WHERE active = 1
    ORDER BY id
  `).all();

  const hours = db.prepare(`
    SELECT day_of_week, day_name, is_open, open_time, close_time
    FROM working_hours
    ORDER BY day_of_week
  `).all();

  res.json({
    workshopName: "مركز نادر",
    services,
    hours
  });
});

// المواعيد المتاحة
app.get("/api/slots", (req, res) => {
  const date = String(req.query.date || "");

  if (!validDate(date) || date < localDateString()) {
    return res.status(400).json({
      message: "اختر تاريخاً صحيحاً من اليوم فصاعداً.",
      slots: []
    });
  }

  const day = new Date(`${date}T12:00:00`).getDay();

  const hours = db.prepare(`
    SELECT * FROM working_hours
    WHERE day_of_week = ?
  `).get(day);

  if (!hours || !hours.is_open) {
    return res.json({
      slots: [],
      message: "الورشة مغلقة في هذا اليوم."
    });
  }

  const busy = new Set(
    db.prepare(`
      SELECT appointment_time
      FROM bookings
      WHERE appointment_date = ?
      AND status != 'cancelled'
    `).all(date).map(row => row.appointment_time)
  );

  const open = timeToMinutes(hours.open_time);
  const close = timeToMinutes(hours.close_time);

  const now = new Date();
  const currentMinutes =
    now.getHours() * 60 + now.getMinutes();

  const slots = [];

  for (
    let minute = open;
    minute + 60 <= close;
    minute += 60
  ) {
    const time =
      `${String(Math.floor(minute / 60)).padStart(2, "0")}:` +
      `${String(minute % 60).padStart(2, "0")}`;

    if (busy.has(time)) continue;

    if (date === localDateString() && minute <= currentMinutes) {
      continue;
    }

    slots.push(time);
  }

  res.json({ slots });
});

// استقبال الحجوزات
app.post("/api/bookings", upload.single("damageImage"), (req, res) => {
  const {
    customerName,
    phone,
    carMake,
    carModel,
    plateNumber,
    serviceId,
    appointmentDate,
    appointmentTime,
    details
  } = req.body;

  const name = String(customerName || "").trim();
  const mobile = String(phone || "").trim();
  const make = String(carMake || "").trim();
  const model = String(carModel || "").trim();
  const date = String(appointmentDate || "").trim();
  const time = String(appointmentTime || "").trim();
  const id = Number(serviceId);

  if (
    !name ||
    !mobile ||
    !make ||
    !model ||
    !id ||
    !date ||
    !time
  ) {
    return res.status(400).json({
      message: "أكمل الحقول المطلوبة قبل إرسال الحجز."
    });
  }

  if (!/^[0-9+\s-]{8,18}$/.test(mobile)) {
    return res.status(400).json({
      message: "رقم الجوال غير صحيح."
    });
  }

  if (
    !validDate(date) ||
    date < localDateString() ||
    !/^([01]\d|2[0-3]):00$/.test(time)
  ) {
    return res.status(400).json({
      message: "التاريخ أو الوقت غير صحيح."
    });
  }

  const service = db.prepare(`
    SELECT * FROM services
    WHERE id = ? AND active = 1
  `).get(id);

  if (!service) {
    return res.status(400).json({
      message: "الخدمة المختارة غير متاحة."
    });
  }

  const day = new Date(`${date}T12:00:00`).getDay();

  const hours = db.prepare(`
    SELECT * FROM working_hours
    WHERE day_of_week = ?
  `).get(day);

  if (!hours || !hours.is_open) {
    return res.status(400).json({
      message: "الورشة مغلقة في هذا اليوم."
    });
  }

  const slotMinutes = timeToMinutes(time);

  if (
    slotMinutes < timeToMinutes(hours.open_time) ||
    slotMinutes + 60 > timeToMinutes(hours.close_time)
  ) {
    return res.status(400).json({
      message: "الوقت المختار خارج ساعات العمل."
    });
  }

  if (date === localDateString()) {
    const now = new Date();

    if (slotMinutes <= now.getHours() * 60 + now.getMinutes()) {
      return res.status(400).json({
        message: "هذا الوقت مضى، اختر وقتاً لاحقاً."
      });
    }
  }

  const imagePath = req.file
    ? `/uploads/${req.file.filename}`
    : null;

  try {
    const result = db.prepare(`
      INSERT INTO bookings (
        customer_name,
        phone,
        car_make,
        car_model,
        plate_number,
        service_id,
        appointment_date,
        appointment_time,
        details,
        image_path
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      mobile,
      make,
      model,
      String(plateNumber || "").trim(),
      id,
      date,
      time,
      String(details || "").trim(),
      imagePath
    );

    const bookingCode =
      `ND-${String(result.lastInsertRowid).padStart(5, "0")}`;

    db.prepare(`
      UPDATE bookings
      SET booking_code = ?
      WHERE id = ?
    `).run(bookingCode, result.lastInsertRowid);

    res.status(201).json({
      message: "تم إرسال طلب الحجز بنجاح.",
      bookingCode
    });

  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({
        message: "هذا الموعد حُجز للتو. اختر وقتاً آخر."
      });
    }

    console.error(error);

    res.status(500).json({
      message: "تعذر حفظ الحجز حالياً."
    });
  }
});

// دخول المدير
app.post("/api/admin/login", (req, res) => {
  const password = String(req.body.password || "");

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      message: "كلمة المرور غير صحيحة."
    });
  }

  req.session.isAdmin = true;

  res.json({
    message: "تم تسجيل الدخول."
  });
});

// التحقق من جلسة المدير
app.get("/api/admin/me", requireAdmin, (_req, res) => {
  res.json({ isAdmin: true });
});

// تسجيل الخروج
app.post("/api/admin/logout", requireAdmin, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("markaz.sid");

    res.json({
      message: "تم تسجيل الخروج."
    });
  });
});

// بيانات لوحة التحكم
app.get("/api/admin/dashboard", requireAdmin, (_req, res) => {
  const today = localDateString();

  const stats = {
    total: db.prepare(`
      SELECT COUNT(*) AS value FROM bookings
    `).get().value,

    today: db.prepare(`
      SELECT COUNT(*) AS value
      FROM bookings
      WHERE appointment_date = ?
    `).get(today).value,

    pending: db.prepare(`
      SELECT COUNT(*) AS value
      FROM bookings
      WHERE status = 'pending'
    `).get().value,

    active: db.prepare(`
      SELECT COUNT(*) AS value
      FROM bookings
      WHERE status IN ('confirmed', 'in_progress')
    `).get().value,

    completed: db.prepare(`
      SELECT COUNT(*) AS value
      FROM bookings
      WHERE status = 'completed'
    `).get().value
  };

  const bookings = db.prepare(`
    SELECT
      b.*,
      s.name AS service_name,
      s.category AS service_category
    FROM bookings b
    JOIN services s ON s.id = b.service_id
    ORDER BY
      b.appointment_date DESC,
      b.appointment_time DESC,
      b.id DESC
    LIMIT 100
  `).all();

  const services = db.prepare(`
    SELECT * FROM services ORDER BY id
  `).all();

  res.json({
    stats,
    bookings,
    services,
    today
  });
});

// تحديث حالة الحجز
app.patch(
  "/api/admin/bookings/:id/status",
  requireAdmin,
  (req, res) => {
    const allowed = [
      "pending",
      "confirmed",
      "in_progress",
      "ready",
      "completed",
      "cancelled"
    ];

    const status = String(req.body.status || "");
    const id = Number(req.params.id);

    if (!allowed.includes(status)) {
      return res.status(400).json({
        message: "حالة الحجز غير معروفة."
      });
    }

    const result = db.prepare(`
      UPDATE bookings
      SET status = ?
      WHERE id = ?
    `).run(status, id);

    if (!result.changes) {
      return res.status(404).json({
        message: "الحجز غير موجود."
      });
    }

    res.json({
      message: "تم تحديث حالة الحجز."
    });
  }
);

// تحديث أسعار الخدمات
app.patch(
  "/api/admin/services/:id",
  requireAdmin,
  (req, res) => {
    const id = Number(req.params.id);
    const price = Number(req.body.price);

    if (
      !Number.isInteger(price) ||
      price < 0 ||
      price > 100000
    ) {
      return res.status(400).json({
        message: "أدخل سعراً صحيحاً."
      });
    }

    const result = db.prepare(`
      UPDATE services
      SET price = ?
      WHERE id = ?
    `).run(price, id);

    if (!result.changes) {
      return res.status(404).json({
        message: "الخدمة غير موجودة."
      });
    }

    res.json({
      message: "تم تحديث السعر."
    });
  }
);

// الصفحة الوحيدة للمشروع
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// معالجة الأخطاء
app.use((error, _req, res, _next) => {
  console.error(error);

  const message =
    error instanceof multer.MulterError &&
    error.code === "LIMIT_FILE_SIZE"
      ? "حجم الصورة أكبر من 5 ميجابايت."
      : (error.message || "حدث خطأ غير متوقع.");

  res.status(400).json({ message });
});

app.listen(PORT, () => {
  console.log(
    `مركز نادر يعمل على http://localhost:${PORT}`
  );
});