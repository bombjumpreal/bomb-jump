

require("dotenv").config();



const express = require("express");

const session = require("express-session");

const bcrypt = require("bcryptjs");

const { Pool } = require("pg");

const path = require("path");

const fs = require("fs");

const crypto = require("crypto");

const multer = require("multer");



const app = express();

app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "bombjumpreal@gmail.com").trim().toLowerCase();



if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET) {

  console.error(".env faylında DATABASE_URL və SESSION_SECRET olmalıdır.");

  process.exit(1);

}



if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 8) {

  console.error(".env faylında ən azı 8 simvolluq ADMIN_PASSWORD yazılmalıdır.");

  process.exit(1);

}



const pool = new Pool({

  connectionString: process.env.DATABASE_URL,

  ssl: process.env.DATABASE_SSL === "true"

    ? { rejectUnauthorized: false }

    : false

});



app.use(express.json({ limit: "100kb" }));

app.use(express.urlencoded({ extended: true }));



app.use(session({

  name: "bombjump.sid",

  secret: process.env.SESSION_SECRET,

  resave: false,

  saveUninitialized: false,

  cookie: {

    httpOnly: true,

    sameSite: "lax",

    secure: process.env.NODE_ENV === "production",

    maxAge: 7 * 24 * 60 * 60 * 1000

  }

}));



const uploadDir = path.join(__dirname, "public", "uploads");

fs.mkdirSync(uploadDir, { recursive: true });



app.use("/uploads", express.static(uploadDir));

app.use(express.static(path.join(__dirname, "public")));



const storage = multer.diskStorage({

  destination: (req, file, cb) => cb(null, uploadDir),

  filename: (req, file, cb) => {

    const ext = {

      "image/jpeg": ".jpg",

      "image/png": ".png",

      "image/webp": ".webp"

    }[file.mimetype];



    if (!ext) return cb(new Error("Şəkil formatı qəbul edilmir."));



    cb(null, crypto.randomUUID() + ext);

  }

});



const upload = multer({

  storage,

  limits: { fileSize: 5 * 1024 * 1024 },

  fileFilter: (req, file, cb) => {

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {

      return cb(new Error("Yalnız JPG, PNG və WEBP şəkilləri qəbul edilir."));

    }

    cb(null, true);

  }

});



const games = new Map();

const processingUsers = new Set();



const MULTIPLIERS = [1.5, 2, 3, 4, 5, 7, 10];



function fail(res, message, status = 400) {

  return res.status(status).json({

    success: false,

    message

  });

}



function validAmount(value) {

  const amount = Number(value);



  return Number.isFinite(amount) &&

    amount >= 1 &&

    amount <= 10000 &&

    Math.round(amount * 100) === amount * 100;

}



function isAdminUser(user) {

  return Boolean(

    user &&

    String(user.email).trim().toLowerCase() === ADMIN_EMAIL

  );

}



function requireLogin(req, res, next) {

  if (!req.session.userId) {

    return fail(res, "Bu əməliyyat üçün hesabına daxil ol.", 401);

  }

  next();

}



async function requireAdmin(req, res, next) {

  try {

    if (!req.session.userId) {

      if (req.path.startsWith("/api/")) {

        return fail(res, "Admin girişi tələb olunur.", 401);

      }

      return res.redirect("/");

    }



    const result = await pool.query(

      "SELECT id,email FROM users WHERE id=$1",

      [req.session.userId]

    );



    if (!result.rows.length || !isAdminUser(result.rows[0])) {

      if (req.path.startsWith("/api/")) {

        return fail(res, "Admin giriş icazəsi yoxdur.", 403);

      }

      return res.status(403).send("Bu səhifəyə giriş icazən yoxdur.");

    }



    next();

  } catch (error) {

    console.error(error);



    if (req.path.startsWith("/api/")) {

      return fail(res, "Server xətası.", 500);

    }



    res.status(500).send("Server xətası.");

  }

}



async function getUser(userId) {

  const result = await pool.query(

    `SELECT id,username,email,balance,reserved_balance,created_at,profile_image,xp

     FROM users WHERE id=$1`,

    [userId]

  );



  return result.rows[0] || null;

}



function availableBalance(user) {

  return Number(user.balance) - Number(user.reserved_balance || 0);

}



// =======================================

// DATABASE

// =======================================



async function initializeDatabase() {

  await pool.query(`

    CREATE TABLE IF NOT EXISTS users (

      id SERIAL PRIMARY KEY,

      username VARCHAR(50) NOT NULL,

      email VARCHAR(255) UNIQUE NOT NULL,

      password_hash TEXT NOT NULL,

      balance NUMERIC(12,2) NOT NULL DEFAULT 0.00,

      reserved_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00,

      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

    )

  `);



  await pool.query(`

    ALTER TABLE users

    ADD COLUMN IF NOT EXISTS reserved_balance

    NUMERIC(12,2) NOT NULL DEFAULT 0.00

  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INTEGER NOT NULL DEFAULT 0`);



  await pool.query(`

    CREATE TABLE IF NOT EXISTS game_history (

      id SERIAL PRIMARY KEY,

      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

      outcome VARCHAR(20) NOT NULL,

      stake NUMERIC(12,2) NOT NULL,

      stage INTEGER NOT NULL,

      multiplier NUMERIC(10,2) NOT NULL,

      winnings NUMERIC(12,2) NOT NULL,

      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

    )

  `);



  await pool.query(`

    CREATE TABLE IF NOT EXISTS balance_requests (

      id SERIAL PRIMARY KEY,

      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

      type VARCHAR(20) NOT NULL CHECK (type IN ('deposit','withdraw')),

      amount NUMERIC(12,2) NOT NULL,

      method VARCHAR(30) NOT NULL,

      details TEXT DEFAULT '',

      status VARCHAR(20) NOT NULL DEFAULT 'pending',

      receipt_image TEXT,

      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

    )

  `);



  await pool.query(`

    ALTER TABLE balance_requests

    ADD COLUMN IF NOT EXISTS receipt_image TEXT

  `);



  await pool.query(`

    CREATE TABLE IF NOT EXISTS admin_balance_history (

      id SERIAL PRIMARY KEY,

      admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,

      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,

      action VARCHAR(20) NOT NULL,

      amount NUMERIC(12,2) NOT NULL,

      before_balance NUMERIC(12,2) NOT NULL,

      after_balance NUMERIC(12,2) NOT NULL,

      reason TEXT DEFAULT '',

      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

    )

  `);



  const adminHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);



  await pool.query(

    `INSERT INTO users(username,email,password_hash)

     VALUES('Admin',$1,$2)

     ON CONFLICT(email)

     DO UPDATE SET username='Admin',password_hash=EXCLUDED.password_hash`,

    [ADMIN_EMAIL, adminHash]

  );



  console.log("BOMB JUMP database hazırdır.");

  console.log("Admin:", ADMIN_EMAIL);

}



// =======================================

// REGISTER

// =======================================



app.post("/api/register", async (req, res) => {

  try {

    const username = String(req.body.username || "").trim();

    const email = String(req.body.email || "").trim().toLowerCase();

    const password = String(req.body.password || "");



    if (username.length < 3 || username.length > 50) {

      return fail(res, "İstifadəçi adı 3-50 simvol olmalıdır.");

    }



    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {

      return fail(res, "Düzgün e-poçt ünvanı daxil et.");

    }



    if (email === ADMIN_EMAIL) {

      return fail(res, "Bu e-poçt qeydiyyat üçün istifadə edilə bilməz.");

    }



    if (password.length < 6 || password.length > 72) {

      return fail(res, "Şifrə ən azı 6 simvol olmalıdır.");

    }



    const hash = await bcrypt.hash(password, 12);



    const result = await pool.query(

      `INSERT INTO users(username,email,password_hash)

       VALUES($1,$2,$3)

       RETURNING id,username,email,balance,created_at`,

      [username,email,hash]

    );



    req.session.userId = result.rows[0].id;



    res.json({

      success: true,

      isAdmin: false,

      user: {

        ...result.rows[0],

        balance: Number(result.rows[0].balance)

      }

    });



  } catch (error) {

    if (error.code === "23505") {

      return fail(res, "Bu e-poçt artıq qeydiyyatdan keçib.");

    }



    console.error(error);

    fail(res, "Qeydiyyat zamanı xəta baş verdi.", 500);

  }

});



// =======================================

// LOGIN

// =======================================



app.post("/api/login", async (req, res) => {

  try {

    const email = String(req.body.email || "").trim().toLowerCase();

    const password = String(req.body.password || "");



    const result = await pool.query(

      "SELECT * FROM users WHERE email=$1",

      [email]

    );



    const user = result.rows[0];



    if (!user || !(await bcrypt.compare(password, user.password_hash))) {

      return fail(res, "E-poçt və ya şifrə yanlışdır.");

    }



    req.session.userId = user.id;



    res.json({

      success: true,

      isAdmin: isAdminUser(user),

      user: {

        id: user.id,

        username: user.username,

        email: user.email,

        balance: availableBalance(user)

      }

    });



  } catch (error) {

    console.error(error);

    fail(res, "Giriş zamanı xəta baş verdi.", 500);

  }

});



// =======================================

// LOGOUT

// =======================================



app.post("/api/logout", (req, res) => {

  req.session.destroy(error => {

    if (error) return fail(res, "Çıxış mümkün olmadı.", 500);



    res.clearCookie("bombjump.sid");

    res.json({ success: true });

  });

});



// =======================================

// STATUS

// =======================================



app.get("/api/status", async (req, res) => {

  try {

    if (!req.session.userId) {

      return res.json({

        success: true,

        authenticated: false,

        balance: 0,

        isAdmin: false

      });

    }



    const user = await getUser(req.session.userId);



    if (!user) {

      req.session.userId = null;



      return res.json({

        success: true,

        authenticated: false,

        balance: 0,

        isAdmin: false

      });

    }



    res.json({

      success: true,

      authenticated: true,

      balance: availableBalance(user),

      isAdmin: isAdminUser(user)

    });



  } catch (error) {

    console.error(error);

    fail(res, "Balans yüklənmədi.", 500);

  }

});



// =======================================

// PROFILE

// =======================================



app.get("/api/me", requireLogin, async (req, res) => {
  try {
    const user = await getUser(req.session.userId);
    if (!user) return fail(res, "İstifadəçi tapılmadı.", 404);

    const statsResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE outcome IN ('win','lost'))::int AS total_games,
         COUNT(*) FILTER (WHERE outcome='win')::int AS wins,
         COUNT(*) FILTER (WHERE outcome='lost')::int AS losses
       FROM game_history WHERE user_id=$1`,
      [req.session.userId]
    );
    const totalXp = Math.max(0, Number(user.xp || 0));
    const stats = statsResult.rows[0] || {};

    res.json({
      success: true,
      isAdmin: isAdminUser(user),
      user: {
        username: user.username,
        email: user.email,
        balance: availableBalance(user),
        reserved_balance: Number(user.reserved_balance || 0),
        created_at: user.created_at,
        profile_image: user.profile_image || null,
        xp: totalXp,
        level: Math.floor(totalXp / 1000) + 1,
        level_xp: totalXp % 1000,
        next_level_xp: 1000
      },
      stats: {
        total_games: Number(stats.total_games || 0),
        wins: Number(stats.wins || 0),
        losses: Number(stats.losses || 0)
      }
    });
  } catch (error) {
    console.error(error);
    fail(res, "Profil yüklənmədi.", 500);
  }
});

// İSTİFADƏÇİ ADINI DƏYİŞ
app.post("/api/profile/username", requireLogin, async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    if (username.length < 3 || username.length > 50) return fail(res, "İstifadəçi adı 3-50 simvol olmalıdır.");
    const result = await pool.query("UPDATE users SET username=$1 WHERE id=$2 RETURNING username", [username, req.session.userId]);
    if (!result.rows.length) return fail(res, "İstifadəçi tapılmadı.", 404);
    res.json({ success: true, username: result.rows[0].username, message: "İstifadəçi adı dəyişdirildi." });
  } catch (error) {
    console.error("Ad dəyişmə xətası:", error);
    fail(res, "İstifadəçi adı dəyişdirilmədi.", 500);
  }
});

// ŞİFRƏNİ DƏYİŞ
app.post("/api/profile/password", requireLogin, async (req, res) => {
  try {
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");
    if (!currentPassword || newPassword.length < 6 || newPassword.length > 72) return fail(res, "Yeni şifrə 6-72 simvol olmalıdır.");
    const result = await pool.query("SELECT password_hash FROM users WHERE id=$1", [req.session.userId]);
    if (!result.rows.length) return fail(res, "İstifadəçi tapılmadı.", 404);
    if (!(await bcrypt.compare(currentPassword, result.rows[0].password_hash))) return fail(res, "Cari şifrə yanlışdır.");
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [hash, req.session.userId]);
    res.json({ success: true, message: "Şifrə uğurla dəyişdirildi." });
  } catch (error) {
    console.error("Şifrə dəyişmə xətası:", error);
    fail(res, "Şifrə dəyişdirilmədi.", 500);
  }
});

// PROFİL ŞƏKLİNİ YÜKLƏ
app.post("/api/profile/avatar", requireLogin, (req, res, next) => {
  upload.single("avatar")(req, res, error => {
    if (error) return fail(res, error.message || "Profil şəkli yüklənmədi.");
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return fail(res, "Profil şəklini seç.");
    const oldResult = await pool.query("SELECT profile_image FROM users WHERE id=$1", [req.session.userId]);
    const oldImage = oldResult.rows[0]?.profile_image;
    const imagePath = "/uploads/" + req.file.filename;
    await pool.query("UPDATE users SET profile_image=$1 WHERE id=$2", [imagePath, req.session.userId]);
    if (oldImage && oldImage.startsWith("/uploads/")) {
      const oldName = path.basename(oldImage);
      const oldPath = path.join(uploadDir, oldName);
      if (oldName && oldName !== req.file.filename && fs.existsSync(oldPath)) fs.unlink(oldPath, () => {});
    }
    res.json({ success: true, profile_image: imagePath, message: "Profil şəkli yeniləndi." });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
    console.error("Profil şəkli xətası:", error);
    fail(res, "Profil şəkli yadda saxlanmadı.", 500);
  }
});

app.get("/api/history", requireLogin, async (req, res) => {

  try {

    const result = await pool.query(

      `SELECT outcome,stake,stage,multiplier,winnings,created_at

       FROM game_history

       WHERE user_id=$1

       ORDER BY id DESC

       LIMIT 100`,

      [req.session.userId]

    );



    res.json({

      success: true,

      history: result.rows

    });



  } catch (error) {

    console.error(error);

    fail(res, "Tarixçə yüklənmədi.", 500);

  }

});



// =======================================


// =======================================
// USER DEPOSIT / WITHDRAW HISTORY
// =======================================

app.get("/api/balance-requests", requireLogin, async (req, res) => {
  try {
    // İstifadəçi yalnız öz depozit və çıxarış müraciətlərini görə bilər.
    const result = await pool.query(
      `SELECT id,type,amount,method,details,status,receipt_image,created_at
       FROM balance_requests
       WHERE user_id=$1
       ORDER BY id DESC
       LIMIT 200`,
      [req.session.userId]
    );

    res.json({ success: true, requests: result.rows });
  } catch (error) {
    console.error("Balans tarixçəsi xətası:", error);
    fail(res, "Depozit və çıxarış tarixçəsi yüklənmədi.", 500);
  }
});

// DEPOSIT REQUEST

// =======================================



app.post("/api/deposit/request", requireLogin, (req,res,next) => {

  upload.single("receipt")(req,res,error => {

    if (error) return fail(res, error.message || "Şəkil yüklənmədi.");

    next();

  });

}, async (req, res) => {

  try {

    const amount = Number(req.body.amount);

    const method = String(req.body.method || "");

    const details = String(req.body.details || "").trim().slice(0,500);



    if (!validAmount(amount)) {

      if (req.file) fs.unlinkSync(req.file.path);

      return fail(res, "Məbləğ 1-10000 AZN arasında olmalıdır.");

    }



    if (!["bank","m10"].includes(method)) {

      if (req.file) fs.unlinkSync(req.file.path);

      return fail(res, "Ödəniş üsulunu seç.");

    }



    if (!req.file) return fail(res, "Qəbz şəklini seç.");



    const receipt = "/uploads/" + req.file.filename;



    await pool.query(

      `INSERT INTO balance_requests

       (user_id,type,amount,method,details,receipt_image)

       VALUES($1,'deposit',$2,$3,$4,$5)`,

      [req.session.userId,amount,method,details,receipt]

    );



    res.json({

      success: true,

      message: "Depozit müraciətin adminə göndərildi."

    });



  } catch (error) {

    if (req.file && fs.existsSync(req.file.path)) {

      fs.unlinkSync(req.file.path);

    }



    console.error(error);

    fail(res, "Depozit müraciəti göndərilmədi.", 500);

  }

});



// =======================================

// WITHDRAW REQUEST

// =======================================



app.post("/api/withdraw/request", requireLogin, async (req, res) => {

  const client = await pool.connect();



  try {

    const amount = Number(req.body.amount);

    const method = String(req.body.method || "");

    const details = String(req.body.details || "").trim().slice(0,500);



if (!Number.isFinite(amount) ||
    amount < 20 ||
    amount > 10000 ||
    Math.round(amount * 100) !== amount * 100) {

  return fail(res, "Minimum çıxarış məbləği 20 AZN olmalıdır. Maksimum 10000 AZN.");

}



    if (!["bank","m10"].includes(method)) {

      return fail(res, "Çıxarış üsulunu seç.");

    }



    if (!details) {

      return fail(res, "Kart və ya M10 məlumatını daxil et.");

    }



    await client.query("BEGIN");



    const result = await client.query(

      `SELECT balance,reserved_balance

       FROM users

       WHERE id=$1

       FOR UPDATE`,

      [req.session.userId]

    );



    if (!result.rows.length) {

      await client.query("ROLLBACK");

      return fail(res, "İstifadəçi tapılmadı.", 404);

    }



    const user = result.rows[0];

    const available = Number(user.balance) - Number(user.reserved_balance || 0);



    if (amount > available) {

      await client.query("ROLLBACK");

      return fail(res, "Balansında kifayət qədər vəsait yoxdur.");

    }



    await client.query(

      `UPDATE users

       SET reserved_balance=reserved_balance+$1

       WHERE id=$2`,

      [amount,req.session.userId]

    );



    await client.query(

      `INSERT INTO balance_requests(user_id,type,amount,method,details)

       VALUES($1,'withdraw',$2,$3,$4)`,

      [req.session.userId,amount,method,details]

    );



    await client.query("COMMIT");



    res.json({

      success: true,

      message: "Çıxarış müraciətin göndərildi. Məbləğ rezerv edildi."

    });



  } catch (error) {

    await client.query("ROLLBACK").catch(() => {});

    console.error(error);

    fail(res, "Çıxarış müraciəti göndərilmədi.", 500);

  } finally {

    client.release();

  }

});



// =======================================

// GAME START

// =======================================



app.post("/api/game/start", requireLogin, async (req,res) => {

  const userId = req.session.userId;



  if (processingUsers.has(userId)) return fail(res, "Əməliyyat davam edir.");



  processingUsers.add(userId);



  try {

    if (games.has(userId)) return fail(res, "Artıq aktiv oyunun var.");



    const amount = Number(req.body.amount);



    if (!validAmount(amount)) {

      return fail(res, "Mərc 1-10000 AZN arasında olmalıdır.");

    }



    const client = await pool.connect();



    try {

      await client.query("BEGIN");



      const result = await client.query(

        `SELECT balance,reserved_balance

         FROM users

         WHERE id=$1

         FOR UPDATE`,

        [userId]

      );



      if (!result.rows.length) {

        await client.query("ROLLBACK");

        return fail(res, "İstifadəçi tapılmadı.", 404);

      }



      const user = result.rows[0];

      const available = Number(user.balance) - Number(user.reserved_balance || 0);



      if (amount > available) {

        await client.query("ROLLBACK");

        return fail(res, "Balansın kifayət etmir.");

      }



      await client.query(

        "UPDATE users SET balance=balance-$1 WHERE id=$2",

        [amount,userId]

      );



      await client.query("COMMIT");



    } catch (error) {

      await client.query("ROLLBACK").catch(() => {});

      throw error;

    } finally {

      client.release();

    }



    games.set(userId, {

      stake: amount,

      stage: 0,

      multiplier: 1,

      bombSide: Math.random() < 0.5 ? "left" : "right"

    });



    const user = await getUser(userId);



    res.json({

      success: true,

      balance: availableBalance(user)

    });



  } catch (error) {

    console.error(error);

    fail(res, "Oyun başlatılmadı.", 500);

  } finally {

    processingUsers.delete(userId);

  }

});



// =======================================

// GAME CHOOSE

// =======================================



app.post("/api/game/choose", requireLogin, async (req,res) => {

  const userId = req.session.userId;



  if (processingUsers.has(userId)) return fail(res, "Əməliyyat davam edir.");



  processingUsers.add(userId);



  try {

    const game = games.get(userId);



    if (!game) return fail(res, "Aktiv oyun tapılmadı.");



    const side = String(req.body.side || "");



    if (!["left","right"].includes(side)) {

      return fail(res, "Yanlış seçim.");

    }



    if (side === game.bombSide) {

      await pool.query(

        `INSERT INTO game_history(user_id,outcome,stake,stage,multiplier,winnings)

         VALUES($1,'lost',$2,$3,$4,0)`,

        [userId,game.stake,game.stage,game.multiplier]

      );

      // Tamamlanmış məğlub oyun üçün 10 XP.
      await pool.query("UPDATE users SET xp=xp+10 WHERE id=$1", [userId]);



      games.delete(userId);



      const user = await getUser(userId);



      return res.json({

        success: true,

        result: "lost",

        balance: availableBalance(user)

      });

    }



    game.stage++;



    game.multiplier = MULTIPLIERS[

      Math.min(game.stage - 1, MULTIPLIERS.length - 1)

    ];



    game.bombSide = Math.random() < 0.5 ? "left" : "right";



    res.json({

      success: true,

      result: "safe",

      stage: game.stage,

      multiplier: game.multiplier

    });



  } catch (error) {

    console.error(error);

    fail(res, "Seçim zamanı xəta baş verdi.", 500);

  } finally {

    processingUsers.delete(userId);

  }

});



// =======================================

// GAME CASHOUT

// =======================================



app.post("/api/game/cashout", requireLogin, async (req,res) => {

  const userId = req.session.userId;



  if (processingUsers.has(userId)) return fail(res, "Əməliyyat davam edir.");



  processingUsers.add(userId);



  const client = await pool.connect();



  try {

    const game = games.get(userId);



    if (!game || game.stage < 1) {

      return fail(res, "Əvvəlcə təhlükəsiz seçim et.");

    }



    const winnings = Math.round(game.stake * game.multiplier * 100) / 100;



    await client.query("BEGIN");



    await client.query(

      "UPDATE users SET balance=balance+$1 WHERE id=$2",

      [winnings,userId]

    );



    await client.query(

      `INSERT INTO game_history(user_id,outcome,stake,stage,multiplier,winnings)

       VALUES($1,'win',$2,$3,$4,$5)`,

      [userId,game.stake,game.stage,game.multiplier,winnings]

    );

    // Qələbə üçün 15 XP (10 oyun + 5 bonus).
    await client.query("UPDATE users SET xp=xp+15 WHERE id=$1", [userId]);



    await client.query("COMMIT");



    games.delete(userId);



    const user = await getUser(userId);



    res.json({

      success: true,

      winnings,

      balance: availableBalance(user)

    });



  } catch (error) {

    await client.query("ROLLBACK").catch(() => {});

    console.error(error);

    fail(res, "Qazancı götürmək mümkün olmadı.", 500);

  } finally {

    client.release();

    processingUsers.delete(userId);

  }

});



// =======================================

// GAME CANCEL

// =======================================



app.post("/api/game/cancel", requireLogin, async (req,res) => {

  const userId = req.session.userId;



  if (processingUsers.has(userId)) return fail(res, "Əməliyyat davam edir.");



  processingUsers.add(userId);



  const client = await pool.connect();



  try {

    const game = games.get(userId);



    if (!game) return fail(res, "Aktiv oyun tapılmadı.");



    if (game.stage > 0) {

      return fail(res, "Təhlükəsiz seçimdən sonra oyunu ləğv etmək olmaz.");

    }



    await client.query("BEGIN");



    await client.query(

      "UPDATE users SET balance=balance+$1 WHERE id=$2",

      [game.stake,userId]

    );



    await client.query(

      `INSERT INTO game_history(user_id,outcome,stake,stage,multiplier,winnings)

       VALUES($1,'cancelled',$2,$3,$4,0)`,

      [userId,game.stake,game.stage,game.multiplier]

    );



    await client.query("COMMIT");



    games.delete(userId);



    const user = await getUser(userId);



    res.json({

      success: true,

      balance: availableBalance(user)

    });



  } catch (error) {

    await client.query("ROLLBACK").catch(() => {});

    console.error(error);

    fail(res, "Oyunu ləğv etmək mümkün olmadı.", 500);

  } finally {

    client.release();

    processingUsers.delete(userId);

  }

});



// =======================================

// ADMIN PAGE

// =======================================



app.get("/admin", requireAdmin, (req,res) => {

  res.sendFile(path.join(__dirname,"admin.html"));

});



// =======================================

// ADMIN DATA

// =======================================



app.get("/api/admin/data", requireAdmin, async (req,res) => {

  try {

    const [users,requests,gamesResult,balanceHistory] = await Promise.all([

      pool.query(`

        SELECT id,username,email,balance,reserved_balance,created_at

        FROM users ORDER BY id DESC

      `),



      pool.query(`

        SELECT br.id,br.user_id,u.username,u.email,

               br.type,br.amount,br.method,br.details,

               br.status,br.receipt_image,br.created_at

        FROM balance_requests br

        JOIN users u ON u.id=br.user_id

        ORDER BY br.id DESC LIMIT 500

      `),



      pool.query(`

        SELECT gh.id,gh.user_id,u.username,u.email,

               gh.outcome,gh.stake,gh.stage,gh.multiplier,

               gh.winnings,gh.created_at

        FROM game_history gh

        JOIN users u ON u.id=gh.user_id

        ORDER BY gh.id DESC LIMIT 300

      `),



      pool.query(`

        SELECT abh.id,abh.admin_id,abh.user_id,

               u.username,u.email,abh.action,abh.amount,

               abh.before_balance AS balance_before,

               abh.after_balance AS balance_after,

               abh.reason,abh.created_at

        FROM admin_balance_history abh

        LEFT JOIN users u ON u.id=abh.user_id

        ORDER BY abh.id DESC LIMIT 500

      `)

    ]);



    res.json({

      success: true,

      users: users.rows,

      requests: requests.rows,

      games: gamesResult.rows,

      gameHistory: gamesResult.rows,

      balanceHistory: balanceHistory.rows

    });



  } catch (error) {

    console.error("Admin məlumat xətası:",error);

    fail(res, "Admin məlumatları yüklənmədi.", 500);

  }

});



// =======================================

// ADMIN BALANCE ADD / SUBTRACT

// =======================================



app.post("/api/admin/users/:id/balance", requireAdmin, async (req,res) => {

  const client = await pool.connect();



  try {

    const userId = Number(req.params.id);

    const action = String(req.body.action || "");

    const amount = Number(req.body.amount);

    const reason = String(req.body.reason || "").trim().slice(0,300);



    if (!Number.isInteger(userId) || userId < 1) {

      return fail(res, "İstifadəçi ID-si yanlışdır.");

    }



    if (!["add","subtract"].includes(action)) {

      return fail(res, "Əməliyyat növü yanlışdır.");

    }



    if (!validAmount(amount)) {

      return fail(res, "Məbləğ 1-10000 AZN arasında olmalıdır.");

    }



    if (!reason) return fail(res, "Əməliyyatın səbəbini yaz.");



    await client.query("BEGIN");



    const result = await client.query(

      `SELECT id,email,balance,reserved_balance

       FROM users WHERE id=$1 FOR UPDATE`,

      [userId]

    );



    if (!result.rows.length) {

      await client.query("ROLLBACK");

      return fail(res, "İstifadəçi tapılmadı.", 404);

    }



    const user = result.rows[0];



    if (isAdminUser(user)) {

      await client.query("ROLLBACK");

      return fail(res, "Admin hesabının balansı dəyişdirilə bilməz.");

    }



    const before = Number(user.balance);

    const reserved = Number(user.reserved_balance || 0);



    const after = action === "add"

      ? before + amount

      : before - amount;



    if (action === "subtract" && after < reserved) {

      await client.query("ROLLBACK");

      return fail(res, "Rezerv edilmiş balansdan aşağı salmaq olmaz.");

    }



    await client.query(

      "UPDATE users SET balance=$1 WHERE id=$2",

      [after,userId]

    );



    await client.query(

      `INSERT INTO admin_balance_history

       (admin_id,user_id,action,amount,before_balance,after_balance,reason)

       VALUES($1,$2,$3,$4,$5,$6,$7)`,

      [

        req.session.userId,

        userId,

        action,

        amount,

        before,

        after,

        reason

      ]

    );



    await client.query("COMMIT");



    res.json({

      success: true,

      message: action === "add" ? "Balans artırıldı." : "Balans azaldıldı.",

      balance: after,

      availableBalance: after - reserved

    });



  } catch (error) {

    await client.query("ROLLBACK").catch(() => {});

    console.error("Balans dəyişmə xətası:",error);

    fail(res, "Balans dəyişdirilmədi.", 500);

  } finally {

    client.release();

  }

});



// =======================================

// DEPOSIT / WITHDRAW APPROVE / REJECT

// =======================================



app.post("/api/admin/requests/:id/status", requireAdmin, async (req,res) => {

  const client = await pool.connect();



  try {

    const requestId = Number(req.params.id);

    const status = String(req.body.status || "");



    if (!Number.isInteger(requestId) || requestId < 1) {

      return fail(res, "Müraciət ID-si yanlışdır.");

    }



    if (!["approved","rejected"].includes(status)) {

      return fail(res, "Status yanlışdır.");

    }



    await client.query("BEGIN");



    const result = await client.query(

      `SELECT id,user_id,type,amount,status

       FROM balance_requests

       WHERE id=$1

       FOR UPDATE`,

      [requestId]

    );



    if (!result.rows.length) {

      await client.query("ROLLBACK");

      return fail(res, "Müraciət tapılmadı.", 404);

    }



    const item = result.rows[0];



    if (item.status !== "pending") {

      await client.query("ROLLBACK");

      return fail(res, "Bu müraciət artıq işlənib.");

    }



    const amount = Number(item.amount);



    // Depozit təsdiqi: balans artır.

    if (status === "approved" && item.type === "deposit") {

      await client.query(

        "UPDATE users SET balance=balance+$1 WHERE id=$2",

        [amount,item.user_id]

      );

    }



    // Çıxarış: rezerv məbləğ təsdiqdə yekun silinir.

    if (item.type === "withdraw") {

      const userResult = await client.query(

        `SELECT balance,reserved_balance

         FROM users WHERE id=$1 FOR UPDATE`,

        [item.user_id]

      );



      if (!userResult.rows.length) {

        await client.query("ROLLBACK");

        return fail(res, "İstifadəçi tapılmadı.", 404);

      }



      const user = userResult.rows[0];



      if (Number(user.reserved_balance) < amount) {

        await client.query("ROLLBACK");

        return fail(res, "Rezerv balans kifayət etmir.");

      }



      if (status === "approved") {

        if (Number(user.balance) < amount) {

          await client.query("ROLLBACK");

          return fail(res, "Ümumi balans kifayət etmir.");

        }



        await client.query(

          `UPDATE users

           SET balance=balance-$1,

               reserved_balance=reserved_balance-$1

           WHERE id=$2`,

          [amount,item.user_id]

        );



      } else {

        // Rədd ediləndə rezerv balans açılır.

        await client.query(

          `UPDATE users

           SET reserved_balance=reserved_balance-$1

           WHERE id=$2`,

          [amount,item.user_id]

        );

      }

    }



    await client.query(

      "UPDATE balance_requests SET status=$1 WHERE id=$2",

      [status,requestId]

    );



    await client.query("COMMIT");



    res.json({

      success: true,

      message: status === "approved"

        ? (item.type === "deposit"

          ? "Depozit təsdiqləndi. Balans artırıldı."

          : "Çıxarış təsdiqləndi.")

        : "Müraciət rədd edildi."

    });



  } catch (error) {

    await client.query("ROLLBACK").catch(() => {});

    console.error("Müraciət status xətası:",error);

    fail(res, "Müraciətin statusu dəyişdirilmədi.", 500);

  } finally {

    client.release();

  }

});



// Naməlum API ünvanları

app.use("/api", (req,res) => {

  fail(res, "API ünvanı tapılmadı.", 404);

});



// Əsas səhifə

app.get("/{*splat}", (req,res) => {

  res.sendFile(path.join(__dirname,"public","index.html"));

});



// Xəta

app.use((error,req,res,next) => {

  console.error(error);



  if (res.headersSent) return next(error);



  res.status(500).json({

    success: false,

    message: error.message || "Serverdə xəta baş verdi."

  });

});



// SERVER START

initializeDatabase()

  .then(() => {

    app.listen(PORT,"0.0.0.0",() => {

      console.log(`BOMB JUMP: http://localhost:${PORT}`);

      console.log(`ADMIN: http://localhost:${PORT}/admin`);

    });

  })

  .catch(error => {

    console.error("Database xətası:",error);

    process.exit(1);

  });
