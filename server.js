require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

async function query(text, params=[]) {
  return pool.query(text, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      discord TEXT,
      city_id TEXT,
      city_phone TEXT,
      rank TEXT NOT NULL DEFAULT 'Sd.',
      role TEXT NOT NULL DEFAULT 'instrutor',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ,
      avatar_data TEXT
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      instructor_id INTEGER NOT NULL REFERENCES users(id),
      date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      notes TEXT,
      course TEXT,
      course_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS course_results (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      submitted_by INTEGER NOT NULL REFERENCES users(id),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS course_result_participants (
      id SERIAL PRIMARY KEY,
      result_id INTEGER NOT NULL REFERENCES course_results(id) ON DELETE CASCADE,
      participant_name TEXT NOT NULL,
      participant_id TEXT,
      score NUMERIC(4,2) NOT NULL CHECK (score >= 0 AND score <= 10),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_course_results_booking ON course_results(booking_id);
    CREATE INDEX IF NOT EXISTS idx_course_result_participants_result ON course_result_participants(result_id);

    ALTER TABLE course_result_participants ADD COLUMN IF NOT EXISTS participant_id TEXT;

    CREATE TABLE IF NOT EXISTS availability (
      id SERIAL PRIMARY KEY,
      instructor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_presence (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_user_presence_last_seen ON user_presence(last_seen);

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS instruction_rules (
      id SERIAL PRIMARY KEY,
      rule_order INTEGER NOT NULL UNIQUE,
      content TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS instruction_uniforms (
      id SERIAL PRIMARY KEY,
      gender TEXT NOT NULL UNIQUE CHECK (gender IN ('female','male')),
      command TEXT NOT NULL,
      image_data TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS instruction_materials (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'Links úteis',
      url TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '🔗',
      section TEXT NOT NULL DEFAULT 'Manuais gerais',
      course TEXT NOT NULL DEFAULT '',
      material_order INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    ALTER TABLE instruction_materials ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'Manuais gerais';
    ALTER TABLE instruction_materials ADD COLUMN IF NOT EXISTS course TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS idx_instruction_materials_order ON instruction_materials(section, material_order, id);

    ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preference TEXT NOT NULL DEFAULT 'all';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username));
    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
    CREATE INDEX IF NOT EXISTS idx_bookings_instructor ON bookings(instructor_id);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
  `);

  const configuredUsername = (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();

  // Migração simples caso o banco tenha vindo da versão anterior.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`);
  await query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS course TEXT`);
  await query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS course_url TEXT`);
  await query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rank TEXT NOT NULL DEFAULT 'Sd.'`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS city_id TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS city_phone TEXT`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_city_id_unique ON users(city_id) WHERE city_id IS NOT NULL AND TRIM(city_id) <> ''`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data TEXT`);
  await query(`UPDATE users SET role='instrutor' WHERE role='membro'`);
  await query(`UPDATE users SET role='admin' WHERE LOWER(username)=LOWER($1)`, [configuredUsername]);

  const password = process.env.ADMIN_PASSWORD || "1234";
  const existing = await query("SELECT id FROM users WHERE LOWER(username)=LOWER($1)", [configuredUsername]);

  if (existing.rowCount === 0) {
    const hash = await bcrypt.hash(password, 10);
    await query(
      `INSERT INTO users(name,username,email,password_hash,role,status,approved_at)
       VALUES($1,$2,$3,$4,'admin','approved',NOW())`,
      ["Administrador", configuredUsername, null, hash]
    );
    console.log("Administrador inicial criado:", configuredUsername);
  }

  // Preenche usernames de registros antigos, quando houver.
  const legacy = await query(
    `SELECT id, name FROM users WHERE username IS NULL ORDER BY id`
  );
  for (const u of legacy.rows) {
    const base = (u.name || "usuario").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") || "usuario";
    let username = base;
    let n = 1;
    while ((await query("SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)", [username])).rowCount) {
      username = `${base}${n++}`;
    }
    await query("UPDATE users SET username=$1 WHERE id=$2", [username, u.id]);
  }
  await query(`ALTER TABLE users ALTER COLUMN username SET NOT NULL`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username))`);

  const rulesCount = await query(`SELECT COUNT(*)::int AS count FROM instruction_rules`);
  if (Number(rulesCount.rows[0]?.count || 0) === 0) {
    const defaultRules = [
      "Todos os cursos da semana devem ser marcados até domingo ou 24h de antecedência, podendo exceções.",
      "Cada instrutor deverá aplicar 1 curso por semana e 1 por vez, caso fique 2 semanas sem aplicar curso (e sem justificativa de ausência), será retirado do corpo de instrução.",
      "Só pode ser aplicado curso marcado, caso precise de um curso de última hora, falar com uma das coordenadoras para possível liberação.",
      "Peço que utilizem o **MANUAL DE APOIO** para auxiliar nas dúvidas e aplicação. O material ficará disponível na aba **Materiais**.",
      "Utilizem a sala de **Agenda** para marcar os cursos, depois do **CHECK** de uma das coordenadoras, utilizem a sala de **Avisos** para anunciar o curso, seguindo o modelo abaixo.",
      "NÃO marquem curso em horário de recrutamento, se atentem quando for fazer o aviso.",
      "Pegar os nomes dos participantes antes da aplicação. Quando forem corrigir a prova, verificar se as pessoas que estão fazendo o curso, são as que fizeram a prova.",
      "Apenas notas acima de 6 serão aprovados no curso. Caso reprovado, deverão retornar em outro curso.",
      "Os alunos terão 15 minutos para realizar a prova, utilizar a aba \"publicado\" no forms e selecionar 15 minutos para deixar o formulário aberto.",
      "Após o curso, utilizem a sala de **relatório-cursos** para registrar os participantes do curso, seguindo o modelo.",
      "**Proibido** instrutores terem qualquer advertência militar (seja verbal, retirada de curso ou qualquer punição relacionada a corregedoria).",
      "Somente quem aplicou ou auxiliou o curso que faz o registro de aprovação do curso para controle interno."
    ];
    for (let i=0;i<defaultRules.length;i++) await query(`INSERT INTO instruction_rules(rule_order,content) VALUES($1,$2)`, [i+1, defaultRules[i]]);
  }

  const uniformsCount = await query(`SELECT COUNT(*)::int AS count FROM instruction_uniforms`);
  if (Number(uniformsCount.rows[0]?.count || 0) === 0) {
    await query(`INSERT INTO instruction_uniforms(gender,command) VALUES($1,$2),($3,$4)`, [
      'female', 'mascara 0 0; maos 14 0; calca 512 1; mochila 157 7; sapatos 25 0; acessorios 514; blusa 6 0; colete 0 0; jaqueta 1345 11; chapeu 57 0;',
      'male', 'mascara 0 0; maos 0 0; calca 379 1; mochila 0 0; sapatos 25 0; acessorios 375; blusa 15 0; colete 0 0; jaqueta 1074 11; chapeu 8 0;'
    ]);
  }

  const materialsCount = await query(`SELECT COUNT(*)::int AS count FROM instruction_materials`);
  const legacyMaterials = await query(`SELECT COUNT(*)::int AS count FROM instruction_materials WHERE title IN ('Manual de Apoio','Modelos e documentos','Links úteis') AND url='#'`);
  if (Number(materialsCount.rows[0]?.count || 0) === 0 || Number(legacyMaterials.rows[0]?.count || 0) > 0) {
    if (Number(legacyMaterials.rows[0]?.count || 0) > 0) await query(`DELETE FROM instruction_materials`);
    await query(`INSERT INTO instruction_materials(title,description,category,url,icon,section,course,material_order) VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8),($9,$10,$11,$12,$13,$14,$15,$16),
      ($17,$18,$19,$20,$21,$22,$23,$24),($25,$26,$27,$28,$29,$30,$31,$32),($33,$34,$35,$36,$37,$38,$39,$40),
      ($41,$42,$43,$44,$45,$46,$47,$48),($49,$50,$51,$52,$53,$54,$55,$56),($57,$58,$59,$60,$61,$62,$63,$64)`, [
      'Manual de conduta Polícia','','Manuais gerais','https://manual-bpm-v.gitbook.io/bpm-v','📕','Manuais gerais','',1,
      'Apoio aos instrutores','','Manuais gerais','https://docs.google.com/document/d/1Ajl2gAL_cLj2lOTw7KIfpdu8SdcMuKCYbYnEyX/0/edit?usp=sharing','📘','Manuais gerais','',2,
      'Abordagem','','Link para provas dos alunos','https://forms.gle/mzqUIvF7hAbdY9Y7','📝','Link para provas dos alunos','Abordagem',1,
      'Acompanhamento','','Link para provas dos alunos','https://forms.gle/3U8Aeb7iJUfqjmEw6','📝','Link para provas dos alunos','Acompanhamento',2,
      'Modulação','','Link para provas dos alunos','https://forms.gle/T2CpF7eR2DUYUxZc6','📝','Link para provas dos alunos','Modulação',3,
      'Abordagem','','Link manual por curso','https://manual-bpm-v.gitbook.io/bpm-v/curso-de-abordagem','📚','Link manual por curso','Abordagem',1,
      'Acompanhamento','','Link manual por curso','https://manual-bpm-v.gitbook.io/bpm-v/curso-de-acompanhamento','📚','Link manual por curso','Acompanhamento',2,
      'Modulação','','Link manual por curso','https://manual-bpm-v.gitbook.io/bpm-v/curso-de-modulacao','📚','Link manual por curso','Modulação',3
    ]);
  }
}

function tokenFor(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  const raw = req.headers.authorization || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Não autenticado." });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Sessão inválida ou expirada." });
  }
}

async function coordinator(req, res, next) {
  try {
    // Sempre consulta o cargo atual no banco. Isso evita que um JWT antigo
    // continue tratando um coordenador como instrutor/admin após alteração de cargo.
    const result = await query(
      "SELECT role,status FROM users WHERE id=$1",
      [req.user.id]
    );
    const currentUser = result.rows[0];

    if (!currentUser || currentUser.status !== "approved") {
      return res.status(403).json({ error: "Usuário sem acesso aprovado." });
    }

    req.user.role = currentUser.role;

    if (!["coordenador", "admin"].includes(currentUser.role)) {
      return res.status(403).json({ error: "Acesso restrito a administradores e coordenadores." });
    }

    next();
  } catch (e) {
    console.error("Falha ao validar permissão de coordenador:", e);
    res.status(500).json({ error: "Não foi possível validar a permissão." });
  }
}

async function getCurrentUser(userId) {
  const result = await query(
    "SELECT id,name,username,email,discord,city_id,city_phone,rank,role,status,avatar_data,notification_preference FROM users WHERE id=$1",
    [userId]
  );
  return result.rows[0] || null;
}

async function managerAuth(req,res,next) {
  try {
    const current = await getCurrentUser(req.user.id);
    if (!current || current.status !== "approved") {
      return res.status(403).json({error:"Usuário sem acesso aprovado."});
    }
    req.currentUser = current;
    if (!["admin","coordenador"].includes(current.role)) {
      return res.status(403).json({error:"Acesso restrito a administradores e coordenadores."});
    }
    req.user.role = current.role;
    req.user.name = current.name;
    next();
  } catch(e) {
    console.error("Falha ao validar acesso:", e);
    res.status(500).json({error:"Não foi possível validar a permissão."});
  }
}

async function logAction(userId, action, details="") {
  await query(
    "INSERT INTO logs(user_id,action,details) VALUES($1,$2,$3)",
    [userId || null, action, details]
  );
}

async function createNotification(userId, type, title, message) {
  if (!userId) return;
  try {
    const pref = await query("SELECT notification_preference FROM users WHERE id=$1", [userId]);
    const preference = pref.rows[0]?.notification_preference || "all";
    const notificationType = type || "info";
    if (preference === "none") return;
    if (preference === "critical" && !["success", "danger", "result"].includes(notificationType)) return;
    await query(
      "INSERT INTO notifications(user_id,type,title,message) VALUES($1,$2,$3,$4)",
      [userId, notificationType, title, message]
    );
  } catch (e) {
    console.error("Falha ao criar notificação:", e.message);
  }
}

async function notifyManagers(type, title, message, excludeUserId=null) {
  const r = await query(
    `SELECT id FROM users WHERE role IN ('coordenador','admin') AND status='approved' ${excludeUserId ? 'AND id <> $1' : ''}`,
    excludeUserId ? [excludeUserId] : []
  );
  for (const u of r.rows) await createNotification(u.id, type, title, message);
}

async function notifyUsers(userIds, type, title, message) {
  const unique = [...new Set((userIds || []).map(Number).filter(Boolean))];
  for (const id of unique) await createNotification(id, type, title, message);
}

function normalizeDateKey(value) {
  if (value === null || value === undefined) return "";
  const raw = String(value).trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Never convert an appointment date through Date/UTC. If a timestamp is
  // received accidentally, use only its calendar-date portion.
  const datePart = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return datePart ? datePart[1] : raw;
}

function formatDateBR(value) {
  // DATE do PostgreSQL chega como YYYY-MM-DD.
  // Fazemos o parse manual para não sofrer alteração de dia por UTC.
  if (!value) return "";
  const raw = normalizeDateKey(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(d);
}

function saoPauloDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function formatTimeBR(value) {
  if (!value) return "";
  return String(value).slice(0, 5);
}

function formatScoreBR(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2).replace(".", ",") : String(value);
}

function discordStatusBR(status) {
  const map = {
    pending: "PENDENTE",
    confirmed: "APROVADA",
    completed: "REALIZADA",
    cancelled: "CANCELADA",
    rejected: "RECUSADA"
  };
  return map[String(status || "").toLowerCase()] || String(status || "").toUpperCase();
}

async function discordNotify(content, channel = "general") {
  const urls = {
    general: process.env.DISCORD_WEBHOOK_URL,
    newBooking: process.env.DISCORD_WEBHOOK_NEW_BOOKING_URL || process.env.DISCORD_WEBHOOK_URL,
    approvedBooking: process.env.DISCORD_WEBHOOK_APPROVED_BOOKING_URL || process.env.DISCORD_WEBHOOK_URL,
    results: process.env.DISCORD_WEBHOOK_RESULTS_URL || process.env.DISCORD_WEBHOOK_URL
  };
  const url = urls[channel] || urls.general;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
  } catch (e) {
    console.error(`Discord webhook (${channel}):`, e.message);
  }
}

app.get("/api/health", async (req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch {
    res.status(503).json({ ok: false, database: "disconnected" });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, username, password, discord, city_id, city_phone } = req.body || {};
    if (!name || !username || !password || !city_id || !city_phone)
      return res.status(400).json({ error: "Nome, ID na cidade, telefone da cidade, usuário e senha são obrigatórios." });
    if (password.length < 6)
      return res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres." });
    const cleanCityId = String(city_id).trim();
    const cleanCityPhone = String(city_phone).replace(/\D/g, "");
    if (!/^\d+$/.test(cleanCityId))
      return res.status(400).json({ error: "O ID na cidade deve conter apenas números." });
    if (!/^\d{6}$/.test(cleanCityPhone))
      return res.status(400).json({ error: "O telefone da cidade deve estar no formato 000-000." });

    const normalizedUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(normalizedUsername))
      return res.status(400).json({ error: "O usuário deve ter 3 a 30 caracteres e usar apenas letras, números, ponto, _ ou -." });

    const hash = await bcrypt.hash(password, 10);

    const result = await query(
      `INSERT INTO users(name,username,password_hash,discord,city_id,city_phone)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name.trim(), normalizedUsername, hash, discord || "", cleanCityId, cleanCityPhone]
    );

    await logAction(result.rows[0].id, "CADASTRO_SOLICITADO", `Novo cadastro: ${name} (@${normalizedUsername})`);
    await discordNotify(
      `📝 **NOVO CADASTRO DE INSTRUTOR**\n👤 ${name}\n🔑 @${normalizedUsername}\n💬 ${discord || "Não informado"}\n⏳ Aguardando aprovação.`
    );
    await notifyManagers("cadastro", "Novo cadastro", `${name} solicitou acesso ao sistema. Aguarda aprovação.`, result.rows[0].id);

    res.json({ ok: true, message: "Cadastro enviado. Aguarde a aprovação de um administrador." });
  } catch (e) {
    if (e.code === "23505")
      return res.status(409).json({ error: "Este usuário já está cadastrado." });
    console.error(e);
    res.status(500).json({ error: "Não foi possível criar o cadastro." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = await query(
      "SELECT * FROM users WHERE LOWER(username)=LOWER($1)",
      [(username || "").trim()]
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password || "", user.password_hash)))
      return res.status(401).json({ error: "Usuário ou senha inválidos." });

    if (user.status !== "approved") {
      return res.status(403).json({
        error: user.status === "pending"
          ? "Seu cadastro ainda aguarda aprovação."
          : "Seu cadastro foi recusado."
      });
    }

    await logAction(user.id, "LOGIN", "Login realizado");

    res.json({
      token: tokenFor(user),
      user: {
        id:user.id, name:user.name, username:user.username, email:user.email,
        discord:user.discord, rank:user.rank, role:user.role, avatar_data:user.avatar_data
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao fazer login." });
  }
});

app.post("/api/presence/heartbeat", auth, async (req,res) => {
  try {
    await query(`
      INSERT INTO user_presence(user_id,last_seen) VALUES($1,NOW())
      ON CONFLICT(user_id) DO UPDATE SET last_seen=NOW()
    `,[req.user.id]);
    res.json({ok:true});
  } catch(e) {
    console.error("Presence heartbeat:",e.message);
    res.status(500).json({error:"Não foi possível atualizar presença."});
  }
});

app.post("/api/presence/offline", auth, async (req,res) => {
  try {
    await query("DELETE FROM user_presence WHERE user_id=$1",[req.user.id]);
    res.json({ok:true});
  } catch(e) {
    res.status(500).json({error:"Não foi possível atualizar presença."});
  }
});

app.get("/api/presence", auth, async (req,res) => {
  try {
    const result=await query(`
      SELECT u.id,u.name,u.username,u.rank,u.role,u.avatar_data,up.last_seen,
             (up.last_seen >= NOW() - INTERVAL '75 seconds') AS online
      FROM users u
      LEFT JOIN user_presence up ON up.user_id=u.id
      WHERE u.status='approved'
      ORDER BY (up.last_seen >= NOW() - INTERVAL '75 seconds') DESC, u.name ASC
    `);
    res.json(result.rows);
  } catch(e) {
    console.error("Presence list:",e.message);
    res.status(500).json({error:"Não foi possível carregar usuários online."});
  }
});

app.get("/api/me", auth, async (req,res) => {
  const result = await query(
    "SELECT id,name,username,email,discord,city_id,city_phone,rank,role,status,created_at,avatar_data,notification_preference FROM users WHERE id=$1",
    [req.user.id]
  );
  res.json(result.rows[0]);
});


app.put("/api/me", auth, async (req,res) => {
  try {
    const { name, city_id, city_phone, discord, rank, avatar_data, password, notification_preference } = req.body || {};
    const cleanName = String(name || "").trim();
    if (!cleanName) return res.status(400).json({error:"O nome é obrigatório."});
    if (cleanName.length > 120) return res.status(400).json({error:"O nome é muito longo."});
    if (discord && String(discord).length > 120) return res.status(400).json({error:"O Discord é muito longo."});
    const cleanCityId = String(city_id ?? "").replace(/\D/g, "").trim();
    const cleanCityPhone = String(city_phone ?? "").replace(/\D/g, "").trim();
    if (!/^\d+$/.test(cleanCityId)) return res.status(400).json({error:"O ID na cidade deve conter apenas números."});
    if (!/^\d{6}$/.test(cleanCityPhone)) return res.status(400).json({error:"O telefone da cidade deve estar no formato 000-000."});

    const allowedRanks = ["Sd.","Cb.","3º Sgt.","2º Sgt.","1º Sgt.","STen.","Ten.","Outro"];
    const cleanRank = allowedRanks.includes(rank) ? rank : "Sd.";
    const allowedNotificationPreferences = ["all", "critical", "none"];
    const cleanNotificationPreference = allowedNotificationPreferences.includes(notification_preference) ? notification_preference : "all";

    let avatar = avatar_data;
    if (avatar !== undefined && avatar !== null) {
      if (typeof avatar !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
        return res.status(400).json({error:"Foto inválida. Use PNG, JPG ou WEBP."});
      }
      if (avatar.length > 1000000) {
        return res.status(400).json({error:"A foto é muito grande. Use uma imagem menor que 750 KB."});
      }
    }

    const current = await query("SELECT * FROM users WHERE id=$1", [req.user.id]);
    const user = current.rows[0];
    if (!user) return res.status(404).json({error:"Usuário não encontrado."});

    let passwordHash = user.password_hash;
    if (password !== undefined && password !== "") {
      if (String(password).length < 6) return res.status(400).json({error:"A nova senha precisa ter pelo menos 6 caracteres."});
      passwordHash = await bcrypt.hash(String(password), 10);
    }

    const nextAvatar = avatar_data === undefined ? user.avatar_data : avatar_data;
    await query(
      `UPDATE users
       SET name=$1, city_id=$2, city_phone=$3, discord=$4, rank=$5, avatar_data=$6, password_hash=$7, notification_preference=$8
       WHERE id=$9`,
      [cleanName, cleanCityId, cleanCityPhone, discord ? String(discord).trim() : null, cleanRank, nextAvatar, passwordHash, cleanNotificationPreference, req.user.id]
    );
    await logAction(req.user.id, "PERFIL_ATUALIZADO", "Dados pessoais atualizados");

    const updated = await query(
      "SELECT id,name,username,email,discord,city_id,city_phone,rank,role,status,created_at,avatar_data,notification_preference FROM users WHERE id=$1",
      [req.user.id]
    );
    res.json(updated.rows[0]);
  } catch (e) {
    console.error("Atualizar perfil:", e);
    res.status(500).json({error:"Não foi possível atualizar o perfil."});
  }
});

app.get("/api/dashboard", auth, async (req,res) => {
  const current = await getCurrentUser(req.user.id);
  if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});
  const isInstructor = current.role === "instrutor";
  const active = await query(
    "SELECT COUNT(*)::int AS c FROM users WHERE role IN ('coordenador','instrutor') AND status='approved'"
  );
  const pending = await query(
    "SELECT COUNT(*)::int AS c FROM users WHERE status='pending'"
  );
  const today = saoPauloDateKey();
  // "Aprovadas hoje" = aprovações realizadas hoje, não cursos que acontecem hoje.
  // Usamos o log da alteração para também contabilizar aprovações feitas antes
  // desta versão, já que elas não possuíam approved_at na tabela bookings.
  const todayCount = await query(`
    SELECT COUNT(*)::int AS c
    FROM bookings
    WHERE status='confirmed'
      AND approved_at IS NOT NULL
      AND (approved_at AT TIME ZONE 'America/Sao_Paulo')::date = $1::date
      AND date BETWEEN $1::date AND ($1::date + INTERVAL '6 day')`, [today]);
  // A agenda é compartilhada: o indicador de marcações da semana conta todos os instrutores.
  const week = await query("SELECT COUNT(*)::int AS c FROM bookings WHERE date BETWEEN $1::date AND ($1::date + INTERVAL '6 day') AND status NOT IN ('cancelled')", [today]);
  const cancelled = isInstructor
    ? await query("SELECT COUNT(*)::int AS c FROM bookings WHERE status='cancelled' AND instructor_id=$1", [current.id])
    : await query("SELECT COUNT(*)::int AS c FROM bookings WHERE status='cancelled'");
  const pendingBookings = isInstructor
    ? await query("SELECT COUNT(*)::int AS c FROM bookings WHERE status='pending' AND instructor_id=$1", [current.id])
    : await query("SELECT COUNT(*)::int AS c FROM bookings WHERE status='pending'");

  // Indicadores reais usados no Dashboard:
  // Cursos disponíveis = total de marcações ainda não realizadas.
  // Cada marcação conta individualmente; cursos concluídos ou cancelados
  // deixam de aparecer neste indicador.
  const courses = await query(`SELECT COUNT(*)::int AS c
                   FROM bookings
                   WHERE status NOT IN ('cancelled','completed')`);

  // Total de marcações no mês atual.
  const monthBookings = isInstructor
    ? await query(`SELECT COUNT(*)::int AS c
                   FROM bookings
                   WHERE instructor_id=$1
                     AND date >= date_trunc('month', CURRENT_DATE)::date
                     AND date < (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date
                     AND status <> 'cancelled'`, [current.id])
    : await query(`SELECT COUNT(*)::int AS c
                   FROM bookings
                   WHERE date >= date_trunc('month', CURRENT_DATE)::date
                     AND date < (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date
                     AND status <> 'cancelled'`);

  // Cursos realizados = cursos que possuem resultado lançado.
  // A métrica é global e compartilhada para todos os usuários aprovados.
  const completedMonth = await query(`
    SELECT COUNT(*)::int AS c
    FROM course_results cr
    JOIN bookings b ON b.id=cr.booking_id
    WHERE b.status='completed'
  `);

  // Média das notas registradas na aba Resultados.
  const dashboardAverage = await query(`
    SELECT ROUND(AVG(crp.score)::numeric, 1) AS avg
    FROM course_result_participants crp
    JOIN course_results cr ON cr.id=crp.result_id
    JOIN bookings b ON b.id=cr.booking_id
    WHERE b.status='completed'
  `);

  // A agenda e as próximas marcações são compartilhadas por todos os usuários aprovados.
  // O instrutor continua tendo permissões próprias para ações administrativas,
  // mas a visualização da agenda deve mostrar os cursos de todos.
  const next = await query(`SELECT b.*, u.name AS instructor_name
                   FROM bookings b JOIN users u ON u.id=b.instructor_id
                   WHERE b.date >= $1
                     AND b.status IN ('approved','confirmed','completed')
                   ORDER BY b.date,b.start_time LIMIT 8`, [today]);


  const logs = isInstructor ? { rows: [] } : await query(`SELECT l.*,u.name FROM logs l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 8`);

  res.json({
    kpis: {
      active: active.rows[0].c,
      pending: pending.rows[0].c,
      bookingsToday: todayCount.rows[0].c,
      week: week.rows[0].c,
      cancelled: cancelled.rows[0].c,
      pendingBookings: pendingBookings.rows[0].c,
      courses: courses.rows[0].c,
      monthBookings: monthBookings.rows[0].c,
      completedMonth: completedMonth.rows[0].c,
      averageScore: dashboardAverage.rows[0]?.avg == null ? null : Number(dashboardAverage.rows[0].avg)
    },
    next: next.rows,
    logs: logs.rows
  });
});

app.get("/api/instructors", auth, async (req,res) => {
  const current = await getCurrentUser(req.user.id);
  if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});
  const result = await query(`
    SELECT u.id,u.name,u.username,u.email,u.discord,u.city_id,u.city_phone,u.rank,u.role,u.status,u.created_at,u.approved_at,
      COUNT(b.id)::int AS bookings,
      COUNT(b.id) FILTER (WHERE b.status='completed')::int AS completed,
      MAX(b.date) FILTER (WHERE b.status='completed') AS last_course_date,
      COUNT(b.id) FILTER (WHERE b.status='cancelled')::int AS cancelled,
      (SELECT COUNT(*)::int FROM availability a WHERE a.instructor_id=u.id AND a.enabled=TRUE) AS availability_count
    FROM users u
    LEFT JOIN bookings b ON b.instructor_id=u.id
    WHERE u.role IN ('coordenador','instrutor') AND u.status='approved'
    GROUP BY u.id ORDER BY u.name`);
  res.json(result.rows);
});

app.get("/api/course-results", auth, async (req,res) => {
  try {
    const me = await query("SELECT id,role,status FROM users WHERE id=$1", [req.user.id]);
    const current = me.rows[0];
    if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});

    const params = [];
    let ownerFilter = "";
    if (current.role === "instrutor") {
      params.push(current.id);
      ownerFilter = `AND b.instructor_id=$${params.length}`;
    } else if (!["coordenador","admin"].includes(current.role)) {
      return res.status(403).json({error:"Acesso restrito."});
    }

    const result = await query(`
      SELECT
        b.id,b.course,b.date,b.start_time,b.end_time,b.status,
        u.name AS instructor_name,u.rank AS instructor_rank,
        cr.id AS result_id,cr.submitted_at,
        COALESCE((
          SELECT json_agg(json_build_object(
            'id',rp.id,
            'name',rp.participant_name,
            'participant_id',rp.participant_id,
            'score',rp.score,
            'result',CASE WHEN rp.score >= 6 THEN 'approved' ELSE 'reproved' END
          ) ORDER BY rp.id)
          FROM course_result_participants rp
          WHERE rp.result_id=cr.id
        ), '[]'::json) AS participants
      FROM bookings b
      JOIN users u ON u.id=b.instructor_id
      LEFT JOIN course_results cr ON cr.booking_id=b.id
      WHERE b.date <= CURRENT_DATE
        AND b.status IN ('confirmed','completed')
        ${ownerFilter}
      ORDER BY b.date DESC,b.start_time DESC,b.id DESC`, params);

    res.json(result.rows);
  } catch(e) {
    console.error("Curso resultados:",e);
    res.status(500).json({error:"Não foi possível carregar os resultados."});
  }
});

app.post("/api/course-results/:bookingId", auth, async (req,res) => {
  const client = await pool.connect();
  try {
    const bookingId = Number(req.params.bookingId);
    const participants = Array.isArray(req.body?.participants) ? req.body.participants : [];
    if (!Number.isInteger(bookingId)) return res.status(400).json({error:"Curso inválido."});
    if (!participants.length) return res.status(400).json({error:"Adicione pelo menos um participante."});

    const currentRes = await client.query("SELECT id,name,role,status FROM users WHERE id=$1", [req.user.id]);
    const current = currentRes.rows[0];
    if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});
    if (!["instrutor","coordenador","admin"].includes(current.role)) return res.status(403).json({error:"Acesso restrito."});

    const bookingRes = await client.query(`
      SELECT b.*,u.name AS instructor_name
      FROM bookings b JOIN users u ON u.id=b.instructor_id
      WHERE b.id=$1`, [bookingId]);
    const booking = bookingRes.rows[0];
    if (!booking) return res.status(404).json({error:"Marcação não encontrada."});
    if (!["confirmed","completed"].includes(String(booking.status).toLowerCase())) {
      return res.status(400).json({error:"Somente cursos aprovados podem receber resultado."});
    }
    if (current.role === "instrutor" && Number(booking.instructor_id) !== Number(current.id)) {
      return res.status(403).json({error:"Você só pode lançar resultado dos seus próprios cursos."});
    }

    const clean = participants.map((p,i)=>({
      name:String(p?.name||"").trim(),
      participantId:String(p?.participantId ?? p?.id ?? "").trim(),
      score:Number(String(p?.score??"").replace(",","."))
    }));
    if (clean.some(p=>!p.name)) return res.status(400).json({error:"Preencha o nome de todos os participantes."});
    if (clean.some(p=>!p.participantId)) return res.status(400).json({error:"Preencha o ID de todos os participantes."});
    if (clean.some(p=>p.participantId.length>80)) return res.status(400).json({error:"O ID do participante deve ter no máximo 80 caracteres."});
    if (clean.some(p=>!Number.isFinite(p.score) || p.score < 0 || p.score > 10)) return res.status(400).json({error:"As notas devem estar entre 0 e 10."});

    await client.query("BEGIN");
    const resultRes = await client.query(`
      INSERT INTO course_results(booking_id,submitted_by,submitted_at)
      VALUES($1,$2,NOW())
      ON CONFLICT (booking_id)
      DO UPDATE SET submitted_by=EXCLUDED.submitted_by,submitted_at=NOW()
      RETURNING id`, [bookingId,current.id]);
    const resultId = resultRes.rows[0].id;

    await client.query("DELETE FROM course_result_participants WHERE result_id=$1", [resultId]);
    for (const p of clean) {
      await client.query(
        "INSERT INTO course_result_participants(result_id,participant_name,participant_id,score) VALUES($1,$2,$3,$4)",
        [resultId,p.name,p.participantId,p.score.toFixed(2)]
      );
    }
    await client.query("UPDATE bookings SET status='completed' WHERE id=$1", [bookingId]);
    await client.query("COMMIT");

    const approved = clean.filter(p=>p.score >= 6);
    const reproved = clean.filter(p=>p.score < 6);
    const linesApproved = approved.length ? approved.map(p=>`• ${p.name} (ID: ${p.participantId}) — ${formatScoreBR(p.score)}`).join("\n") : "• Nenhum";
    const linesReproved = reproved.length ? reproved.map(p=>`• ${p.name} (ID: ${p.participantId}) — ${formatScoreBR(p.score)}`).join("\n") : "• Nenhum";
    await discordNotify(
      `🎓 **RESULTADO DE CURSO**\n📚 **Curso:** ${booking.course}\n👨‍🏫 **Instrutor:** ${booking.instructor_name}\n📅 **Data:** ${formatDateBR(booking.date)}\n⏰ **Horário:** ${formatTimeBR(booking.start_time)} - ${formatTimeBR(booking.end_time)}\n\n🟢 **APROVADOS — ${approved.length}**\n${linesApproved}\n\n🔴 **REPROVADOS — ${reproved.length}**\n${linesReproved}\n\n📊 **Total:** ${clean.length}`,
      "results"
    );
    await logAction(current.id,"RESULTADO_CURSO_LANCADO",`${booking.course} - ${booking.date} - ${approved.length} aprovados / ${reproved.length} reprovados`);
    await notifyUsers([booking.instructor_id, booking.created_by], "result", "Resultado disponível", `O resultado de ${booking.course} (${formatDateBR(booking.date)}) foi lançado: ${approved.length} aprovados e ${reproved.length} reprovados.`);

    res.json({ok:true,result_id:resultId,approved:approved.length,reproved:reproved.length});
  } catch(e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Salvar resultado:",e);
    res.status(500).json({error:"Não foi possível salvar o resultado."});
  } finally {
    client.release();
  }
});

app.get("/api/pending-users", auth, managerAuth, coordinator, async (req,res) => {
  const result = await query(
    "SELECT id,name,username,email,discord,city_id,city_phone,rank,created_at FROM users WHERE status='pending' ORDER BY id DESC"
  );
  res.json(result.rows);
});

app.post("/api/users/:id/approve", auth, coordinator, async (req,res) => {
  const id = Number(req.params.id);
  const { rank } = req.body || {};
  const r = await query("SELECT * FROM users WHERE id=$1", [id]);
  const u = r.rows[0];
  if (!u) return res.status(404).json({error:"Usuário não encontrado."});

  await query(
    "UPDATE users SET status='approved', rank=$2, approved_at=NOW() WHERE id=$1",
    [id, rank || 'Sd.']
  );
  await logAction(req.user.id, "USUARIO_APROVADO", `Aprovado: ${u.name}`);
  await createNotification(id, "success", "Cadastro aprovado", "Seu cadastro foi aprovado. Você já pode acessar o sistema.");
  await discordNotify(`✅ **CADASTRO APROVADO**\n👤 ${u.name}\n🔑 @${u.username}`);
  res.json({ok:true});
});

app.post("/api/users/:id/reject", auth, coordinator, async (req,res) => {
  const id = Number(req.params.id);
  const r = await query("SELECT * FROM users WHERE id=$1", [id]);
  const u = r.rows[0];
  if (!u) return res.status(404).json({error:"Usuário não encontrado."});

  await query("UPDATE users SET status='rejected' WHERE id=$1", [id]);
  await logAction(req.user.id, "USUARIO_RECUSADO", `Recusado: ${u.name}`);
  await createNotification(id, "danger", "Cadastro recusado", "Seu cadastro foi recusado. Entre em contato com a coordenação para mais informações.");
  await discordNotify(`❌ **CADASTRO RECUSADO**\n👤 ${u.name}\n🔑 @${u.username}`);
  res.json({ok:true});
});


app.get("/api/users", auth, managerAuth, coordinator, async (req,res) => {
  const result = await query(`
    SELECT u.id,u.name,u.username,u.email,u.discord,u.city_id,u.city_phone,u.rank,u.role,u.status,u.created_at,u.approved_at,u.avatar_data,
      COUNT(b.id)::int AS bookings,
      COUNT(b.id) FILTER (WHERE b.status='completed')::int AS completed,
      MAX(b.date) FILTER (WHERE b.status='completed') AS last_course_date,
      COUNT(b.id) FILTER (WHERE b.status='cancelled')::int AS cancelled,
      (SELECT COUNT(*)::int FROM availability a WHERE a.instructor_id=u.id AND a.enabled=TRUE) AS availability_count
    FROM users u
    LEFT JOIN bookings b ON b.instructor_id=u.id
    WHERE u.role IN ('coordenador','instrutor','admin')
    GROUP BY u.id
    ORDER BY CASE WHEN u.status='approved' THEN 0 ELSE 1 END,
             CASE WHEN u.role='coordenador' THEN 0 WHEN u.role='instrutor' THEN 1 ELSE 2 END,
             u.name
  `);
  res.json(result.rows);
});

app.post("/api/admin/users", auth, managerAuth, coordinator, async (req,res) => {
  try {
    const { name, username, password, role, rank, discord } = req.body || {};
    if (!name || !username || !password)
      return res.status(400).json({error:"Nome, usuário e senha são obrigatórios."});
    if (password.length < 6)
      return res.status(400).json({error:"A senha precisa ter pelo menos 6 caracteres."});

    const normalizedUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(normalizedUsername))
      return res.status(400).json({error:"Usuário inválido. Use 3-30 caracteres: letras, números, ponto, _ ou -."});

    const finalRole = role === "coordenador" ? "coordenador" : "instrutor";
    const hash = await bcrypt.hash(password, 10);

    const result = await query(`
      INSERT INTO users(name,username,password_hash,discord,rank,role,status,approved_at)
      VALUES($1,$2,$3,$4,$5,$6,'approved',NOW())
      RETURNING id,name,username,discord,rank,role,status
    `, [name.trim(), normalizedUsername, hash, discord || "", rank || "Sd.", finalRole]);

    await logAction(
      req.user.id,
      "USUARIO_CRIADO_ADMIN",
      `${result.rows[0].name} (@${result.rows[0].username}) - cargo ${finalRole}`
    );

    res.json({ok:true,user:result.rows[0]});
  } catch(e) {
    if (e.code === "23505")
      return res.status(409).json({error:"Este usuário já está cadastrado."});
    console.error(e);
    res.status(500).json({error:"Não foi possível criar o usuário."});
  }
});

app.patch("/api/admin/users/:id/role", auth, managerAuth, coordinator, async (req,res) => {
  try {
    const id = Number(req.params.id);
    const { role } = req.body || {};
    if (!["coordenador","instrutor"].includes(role))
      return res.status(400).json({error:"Permissão inválida."});
    if (id === req.user.id)
      return res.status(400).json({error:"Você não pode alterar o próprio cargo."});

    const r = await query("SELECT id,name,username,role FROM users WHERE id=$1", [id]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({error:"Usuário não encontrado."});

    await query("UPDATE users SET role=$1 WHERE id=$2", [role,id]);
    await logAction(req.user.id, "PERMISSAO_ALTERADA", `${user.name} (@${user.username}): ${user.role} → ${role}`);
    res.json({ok:true});
  } catch(e) {
    console.error(e);
    res.status(500).json({error:"Não foi possível alterar a permissão."});
  }
});

app.patch("/api/admin/users/:id/profile", auth, managerAuth, coordinator, async (req,res) => {
  try {
    const id = Number(req.params.id);
    const { name, username, rank, discord, city_id, city_phone, role } = req.body || {};
    if (!name || !username) return res.status(400).json({error:"Nome e usuário são obrigatórios."});
    const cleanCityId = city_id === undefined ? null : String(city_id).replace(/\D/g, "").trim();
    const cleanCityPhone = city_phone === undefined ? null : String(city_phone).replace(/\D/g, "").trim();
    if (city_id !== undefined && !/^\d+$/.test(cleanCityId)) return res.status(400).json({error:"O ID na cidade deve conter apenas números."});
    if (city_phone !== undefined && !/^\d{6}$/.test(cleanCityPhone)) return res.status(400).json({error:"O telefone da cidade deve estar no formato 000-000."});
    if (role !== undefined && !["instrutor","coordenador"].includes(role)) return res.status(400).json({error:"Cargo inválido."});
    const normalizedUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(normalizedUsername))
      return res.status(400).json({error:"Usuário inválido."});
    const r = await query("SELECT id,name,username,role,city_id,city_phone FROM users WHERE id=$1", [id]);
    if (!r.rowCount) return res.status(404).json({error:"Usuário não encontrado."});
    const target = r.rows[0];
    const nextRole = target.role === "admin" ? "admin" : (role || target.role || "instrutor");
    const nextCityId = city_id === undefined ? target.city_id : cleanCityId;
    const nextCityPhone = city_phone === undefined ? target.city_phone : cleanCityPhone;
    await query("UPDATE users SET name=$1, username=$2, rank=$3, discord=$4, city_id=$5, city_phone=$6, role=$7 WHERE id=$8", [name.trim(), normalizedUsername, rank || "Sd.", discord || "", nextCityId, nextCityPhone, nextRole, id]);
    await logAction(req.user.id, "DADOS_USUARIO_ALTERADOS", `${name} (@${normalizedUsername})`);
    res.json({ok:true});
  } catch(e) {
    if (e.code === "23505") return res.status(409).json({error:"Este usuário já está cadastrado."});
    console.error(e);
    res.status(500).json({error:"Não foi possível alterar os dados."});
  }
});

app.patch("/api/admin/users/:id/status", auth, managerAuth, coordinator, async (req,res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body || {};
    if (!["approved","pending","rejected"].includes(status))
      return res.status(400).json({error:"Status inválido."});
    if (id === req.user.id && status !== "approved")
      return res.status(400).json({error:"Você não pode bloquear seu próprio acesso."});

    const r = await query("SELECT id,name,username,status FROM users WHERE id=$1", [id]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({error:"Usuário não encontrado."});

    await query(
      "UPDATE users SET status=$1, approved_at=CASE WHEN $1='approved' THEN COALESCE(approved_at,NOW()) ELSE approved_at END WHERE id=$2",
      [status,id]
    );
    await logAction(req.user.id, "STATUS_USUARIO_ALTERADO", `${user.name} (@${user.username}): ${user.status} → ${status}`);
    res.json({ok:true});
  } catch(e) {
    console.error(e);
    res.status(500).json({error:"Não foi possível alterar o status."});
  }
});



// Exclusão definitiva de usuário: disponível para Administrador e Coordenador.
// Remove os dados diretamente vinculados à conta, preservando logs (ON DELETE SET NULL).
// Resultados lançados por esse usuário em cursos de terceiros são protegidos para evitar
// apagar histórico operacional por acidente.
app.delete("/api/admin/users/:id", auth, managerAuth, coordinator, async (req,res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({error:"Usuário inválido."});
    }
    if (id === req.user.id) {
      return res.status(400).json({error:"Você não pode excluir seu próprio acesso."});
    }

    const current = await client.query(
      "SELECT id,name,username,role,status FROM users WHERE id=$1",
      [id]
    );
    const user = current.rows[0];
    if (!user) return res.status(404).json({error:"Usuário não encontrado."});

    // Não permite excluir outro administrador pela interface administrativa.
    if (user.role === "admin") {
      return res.status(400).json({error:"A conta de Administrador não pode ser excluída por este recurso."});
    }

    const submitted = await client.query(
      "SELECT COUNT(*)::int AS c FROM course_results WHERE submitted_by=$1",
      [id]
    );
    if (Number(submitted.rows[0].c) > 0) {
      return res.status(409).json({
        error:"Este usuário possui resultados de cursos lançados. Bloqueie a conta em vez de excluí-la para preservar o histórico."
      });
    }

    await client.query("BEGIN");

    // course_results é ligado às marcações por ON DELETE CASCADE.
    // Removemos as marcações criadas pelo usuário e as marcações em que ele é instrutor.
    await client.query(
      `DELETE FROM bookings WHERE created_by=$1 OR instructor_id=$1`,
      [id]
    );

    // Disponibilidades e notificações possuem ON DELETE CASCADE no schema atual.
    await client.query("DELETE FROM users WHERE id=$1", [id]);

    await client.query("COMMIT");

    try {
      await logAction(req.user.id, "USUARIO_EXCLUIDO", `${user.name} (@${user.username}) - cargo ${user.role}`);
    } catch (e) {
      console.error("Falha ao registrar exclusão do usuário:", e.message);
    }

    res.json({ok:true});
  } catch(e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Falha ao excluir usuário:", e);
    if (e.code === "23503") {
      return res.status(409).json({error:"Não foi possível excluir este usuário porque existem registros históricos vinculados à conta. Bloqueie o usuário para preservar o histórico."});
    }
    res.status(500).json({error:"Não foi possível excluir o usuário."});
  } finally {
    client.release();
  }
});

app.patch("/api/admin/users/:id/password", auth, managerAuth, coordinator, async (req,res) => {
  try {
    const id = Number(req.params.id);
    const { password } = req.body || {};
    if (!password || password.length < 6)
      return res.status(400).json({error:"A nova senha precisa ter pelo menos 6 caracteres."});

    const r = await query("SELECT name,username FROM users WHERE id=$1", [id]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({error:"Usuário não encontrado."});

    const hash = await bcrypt.hash(password, 10);
    await query("UPDATE users SET password_hash=$1 WHERE id=$2", [hash,id]);
    await logAction(req.user.id, "SENHA_REDEFINIDA", `${user.name} (@${user.username})`);
    res.json({ok:true});
  } catch(e) {
    console.error(e);
    res.status(500).json({error:"Não foi possível redefinir a senha."});
  }
});

app.get("/api/bookings", auth, async (req,res) => {
  const current = await getCurrentUser(req.user.id);
  if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});

  // A agenda/marcações são uma visão compartilhada para todos os usuários aprovados.
  // Cada registro continua exibindo o instrutor responsável pelo curso.
  const result = await query(`
    SELECT b.*,u.name AS instructor_name
    FROM bookings b JOIN users u ON u.id=b.instructor_id
    ORDER BY b.date,b.start_time`);
  res.json(result.rows);
});

app.post("/api/bookings", auth, async (req,res) => {
  try {
    const { instructor_id,date,start_time,end_time,notes,course } = req.body || {};
    const bookingDate = normalizeDateKey(date);
    if (!instructor_id || !bookingDate || !start_time || !end_time || !course)
      return res.status(400).json({error:"Preencha curso, instrutor, data e horários."});

    const current = await getCurrentUser(req.user.id);
    if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});
    const manager = ["coordenador","admin"].includes(current.role);
    if (!manager && Number(instructor_id) !== Number(current.id)) {
      return res.status(403).json({error:"Instrutores só podem agendar cursos para si mesmos."});
    }
    const targetResult = await query(
      "SELECT id,name,role FROM users WHERE id=$1 AND role IN ('coordenador','instrutor') AND status='approved'",
      [instructor_id]
    );
    const target = targetResult.rows[0];

    if (!target) return res.status(400).json({error:"Membro inválido."});

    const overlap = await query(`
      SELECT id FROM bookings
      WHERE instructor_id=$1 AND date=$2 AND status!='cancelled'
      AND start_time < $3 AND end_time > $4
      LIMIT 1`,
      [instructor_id,bookingDate,end_time,start_time]
    );

    if (overlap.rowCount)
      return res.status(409).json({error:"Este instrutor já possui uma marcação nesse horário."});

    const result = await query(`
      INSERT INTO bookings(instructor_id,date,start_time,end_time,notes,course,status,created_by)
      VALUES($1,$2,$3,$4,$5,$6,'pending',$7) RETURNING id`,
      [instructor_id,bookingDate,start_time,end_time,notes||"",course,req.user.id]
    );

    await logAction(
      req.user.id,
      "MARCACAO_CRIADA",
      `${course} - ${target.name} - ${bookingDate} ${start_time}-${end_time}`
    );

    await discordNotify(
      `📅 **NOVA MARCAÇÃO**\n📚 **Curso:** ${course}\n👨‍🏫 **Instrutor:** ${target.name}\n📅 **Data:** ${formatDateBR(date)}\n⏰ **Horário:** ${formatTimeBR(start_time)} - ${formatTimeBR(end_time)}\n🟡 **Status:** PENDENTE`,
      "newBooking"
    );
    await notifyManagers("booking", "Nova marcação", `${course} • ${target.name} • ${formatDateBR(bookingDate)} às ${formatTimeBR(start_time)}. Aguarda aprovação.`, req.user.id);

    res.json({ok:true,id:result.rows[0].id});
  } catch(e) {
    console.error(e);
    res.status(500).json({error:"Não foi possível criar a marcação."});
  }
});

app.post("/api/bookings/:id/status", auth, async (req,res) => {
  const id=Number(req.params.id);
  const {status}=req.body||{};
  if(!["confirmed","completed","cancelled","pending"].includes(status))
    return res.status(400).json({error:"Status inválido."});

  const r = await query(`
    SELECT b.*, to_char(b.date, 'YYYY-MM-DD') AS booking_date_key, u.name AS instructor_name
    FROM bookings b JOIN users u ON u.id=b.instructor_id
    WHERE b.id=$1`, [id]);
  const b = r.rows[0];

  if(!b) return res.status(404).json({error:"Marcação não encontrada."});
  const current = await getCurrentUser(req.user.id);
  if(!current || current.status !== "approved" || !["coordenador","admin"].includes(current.role))
    return res.status(403).json({error:"Sem permissão."});

  await query("UPDATE bookings SET status=$1 WHERE id=$2", [status,id]);
  await logAction(req.user.id,"STATUS_MARCACAO_ALTERADO",`${b.instructor_name} → ${status}`);
  await discordNotify(
    status === "confirmed"
      ? `✅ **AGENDAMENTO APROVADO**\n📚 **Curso:** ${b.course}\n👨‍🏫 **Instrutor:** ${b.instructor_name}\n📅 **Data:** ${formatDateBR(b.booking_date_key || b.date)}\n⏰ **Horário:** ${formatTimeBR(b.start_time)} - ${formatTimeBR(b.end_time)}\n🟢 **Status:** APROVADA`
      : `📌 **MARCAÇÃO ATUALIZADA**\n📚 **Curso:** ${b.course}\n👨‍🏫 **Instrutor:** ${b.instructor_name}\n📅 **Data:** ${formatDateBR(b.booking_date_key || b.date)}\n⏰ **Horário:** ${formatTimeBR(b.start_time)} - ${formatTimeBR(b.end_time)}\n🔹 **Status:** ${discordStatusBR(status)}`,
    status === "confirmed" ? "approvedBooking" : "general"
  );
  if (status === "confirmed") {
    await notifyUsers([b.created_by, b.instructor_id], "success", "Agendamento aprovado", `${b.course} foi aprovado para ${formatDateBR(b.date)} das ${formatTimeBR(b.start_time)} às ${formatTimeBR(b.end_time)}.`);
  } else if (status === "cancelled") {
    await notifyUsers([b.created_by, b.instructor_id], "danger", "Agendamento recusado", `${b.course} em ${formatDateBR(b.booking_date_key || b.date)} foi recusado/cancelado.`);
  }
  res.json({ok:true});
});

app.get("/api/pending-bookings", auth, managerAuth, coordinator, async (req,res) => {
  const result = await query(`
    SELECT b.*,u.name AS instructor_name,u.rank AS instructor_rank,u.username AS instructor_username
    FROM bookings b JOIN users u ON u.id=b.instructor_id
    WHERE b.status='pending'
    ORDER BY b.date,b.start_time`);
  res.json(result.rows);
});

app.get("/api/availability", auth, async (req,res) => {
  try {
    const current = await getCurrentUser(req.user.id);
    if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});
    // A disponibilidade é uma visão compartilhada: todos os usuários aprovados
    // devem conseguir visualizar os horários de todos os instrutores.
    // A permissão para editar/remover continua sendo controlada separadamente
    // nas rotas POST e DELETE abaixo.
    const sql = `SELECT a.id,a.instructor_id,a.weekday,a.start_time,a.end_time,a.enabled,
         u.name AS instructor_name,u.rank AS instructor_rank,u.username AS instructor_username
       FROM availability a JOIN users u ON u.id=a.instructor_id
       WHERE a.enabled=TRUE AND u.status='approved' AND u.role='instrutor'
       ORDER BY u.name,a.weekday,a.start_time`;
    const result = await query(sql);
    res.json(result.rows);
  } catch(e) {
    console.error("Disponibilidade GET:",e);
    res.status(500).json({error:"Não foi possível carregar as disponibilidades."});
  }
});

app.post("/api/availability", auth, async (req,res) => {
  try {
    const { instructor_id, weekday, start_time, end_time } = req.body || {};
    const current = await getCurrentUser(req.user.id);
    if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});
    const targetId = Number(instructor_id || current.id);
    const day = Number(weekday);
    if (!Number.isInteger(targetId) || !Number.isInteger(day) || day < 0 || day > 6 || !start_time || !end_time)
      return res.status(400).json({error:"Informe dia, horário inicial e horário final."});
    if (String(start_time) >= String(end_time)) return res.status(400).json({error:"O horário final deve ser maior que o inicial."});
    const manager = ["coordenador","admin"].includes(current.role);
    if (!manager && targetId !== Number(current.id)) return res.status(403).json({error:"Você só pode alterar sua própria disponibilidade."});
    const target = await query("SELECT id FROM users WHERE id=$1 AND status='approved' AND role IN ('instrutor','coordenador','admin')", [targetId]);
    if (!target.rowCount) return res.status(400).json({error:"Instrutor inválido."});
    const overlap = await query(`
      SELECT id FROM availability
      WHERE instructor_id=$1 AND weekday=$2 AND enabled=TRUE
        AND start_time < $4 AND end_time > $3
      LIMIT 1`, [targetId,day,start_time,end_time]);
    if (overlap.rowCount) return res.status(409).json({error:"Este horário se sobrepõe a outro horário já cadastrado."});
    const result = await query(`
      INSERT INTO availability(instructor_id,weekday,start_time,end_time,enabled)
      VALUES($1,$2,$3,$4,TRUE) RETURNING id,weekday,start_time,end_time`, [targetId,day,start_time,end_time]);
    await logAction(req.user.id,"DISPONIBILIDADE_ADICIONADA",`${targetId} - dia ${day} ${start_time}-${end_time}`);
    res.json(result.rows[0]);
  } catch(e) {
    console.error("Disponibilidade POST:",e);
    res.status(500).json({error:"Não foi possível salvar a disponibilidade."});
  }
});

app.delete("/api/availability/:id", auth, async (req,res) => {
  try {
    const id = Number(req.params.id);
    const current = await getCurrentUser(req.user.id);
    if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});
    const row = await query("SELECT id,instructor_id,weekday,start_time,end_time FROM availability WHERE id=$1", [id]);
    const item = row.rows[0];
    if (!item) return res.status(404).json({error:"Horário não encontrado."});
    const manager = ["coordenador","admin"].includes(current.role);
    if (!manager && Number(item.instructor_id) !== Number(current.id)) return res.status(403).json({error:"Você só pode remover sua própria disponibilidade."});
    await query("DELETE FROM availability WHERE id=$1", [id]);
    await logAction(req.user.id,"DISPONIBILIDADE_REMOVIDA",`${item.instructor_id} - dia ${item.weekday} ${item.start_time}-${item.end_time}`);
    res.json({ok:true});
  } catch(e) {
    console.error("Disponibilidade DELETE:",e);
    res.status(500).json({error:"Não foi possível remover a disponibilidade."});
  }
});

app.get("/api/logs", auth, managerAuth, coordinator, async (req,res) => {
  const result = await query(`
    SELECT l.*,u.name
    FROM logs l LEFT JOIN users u ON u.id=l.user_id
    ORDER BY l.id DESC LIMIT 200`);
  res.json(result.rows);
});


app.delete("/api/bookings/:id", auth, coordinator, async (req,res)=>{
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({error:"ID de marcação inválido."});
    const found = await query(`
      SELECT b.*, u.name AS instructor_name
      FROM bookings b JOIN users u ON u.id=b.instructor_id
      WHERE b.id=$1`, [id]);
    if (!found.rowCount) return res.status(404).json({error:"Marcação não encontrada."});
    const b = found.rows[0];
    await query("DELETE FROM bookings WHERE id=$1", [id]);
    try { await logAction(req.user.id, "booking_deleted", `Marcação ${id} excluída`); } catch(e) { console.error("Falha ao registrar exclusão:", e.message); }
    await discordNotify(
      `❌ **MARCAÇÃO EXCLUÍDA**\n📚 **Curso:** ${b.course}\n👨‍🏫 **Instrutor:** ${b.instructor_name}\n📅 **Data:** ${formatDateBR(b.date)}\n⏰ **Horário:** ${formatTimeBR(b.start_time)} - ${formatTimeBR(b.end_time)}\n🔴 **Status:** EXCLUÍDA`,
      "general"
    );
    await notifyUsers([b.created_by, b.instructor_id], "danger", "Marcação excluída", `${b.course} de ${formatDateBR(b.date)} foi excluída da agenda.`);
    res.json({ok:true});
  } catch(e) { console.error(e); res.status(500).json({error:"Erro ao excluir marcação."}); }
});

app.get("/api/instruction-rules", auth, async (req,res) => {
  try {
    const result = await query(`SELECT id, rule_order, content, updated_at FROM instruction_rules ORDER BY rule_order ASC`);
    res.json({rules: result.rows});
  } catch(e) { console.error(e); res.status(500).json({error:"Não foi possível carregar as regras."}); }
});

app.put("/api/instruction-rules", auth, managerAuth, coordinator, async (req,res) => {
  try {
    const incoming = Array.isArray(req.body?.rules) ? req.body.rules : [];
    const rules = incoming.map(x => String(x ?? "").trim()).filter(Boolean).slice(0,50);
    if (!rules.length) return res.status(400).json({error:"Informe pelo menos uma regra."});
    await query("BEGIN");
    await query("DELETE FROM instruction_rules");
    for (let i=0;i<rules.length;i++) await query(`INSERT INTO instruction_rules(rule_order,content,updated_at,updated_by) VALUES($1,$2,NOW(),$3)`, [i+1,rules[i],req.user.id]);
    await query("COMMIT");
    await logAction(req.user.id,"REGRAS_INSTRUCAO_ATUALIZADAS",`${rules.length} regra(s) atualizada(s)`);
    const result = await query(`SELECT id, rule_order, content, updated_at FROM instruction_rules ORDER BY rule_order ASC`);
    res.json({ok:true,rules:result.rows});
  } catch(e) { try { await query("ROLLBACK"); } catch {} console.error(e); res.status(500).json({error:"Não foi possível salvar as regras."}); }
});

app.get("/api/instruction-uniforms", auth, async (req,res) => {
  try {
    const result = await query(`SELECT gender, command, image_data, updated_at FROM instruction_uniforms ORDER BY CASE gender WHEN 'female' THEN 1 ELSE 2 END`);
    res.json({uniforms: result.rows});
  } catch(e) { console.error(e); res.status(500).json({error:"Não foi possível carregar os uniformes."}); }
});

app.put("/api/instruction-uniforms/:gender", auth, managerAuth, coordinator, async (req,res) => {
  try {
    const gender = String(req.params.gender || '').toLowerCase();
    if (!['female','male'].includes(gender)) return res.status(400).json({error:"Uniforme inválido."});
    const command = String(req.body?.command || '').trim();
    if (!command) return res.status(400).json({error:"Informe o comando F8."});
    if (command.length > 2000) return res.status(400).json({error:"O comando é muito grande."});
    let imageData = req.body?.image_data == null ? null : String(req.body.image_data);
    if (imageData && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imageData)) return res.status(400).json({error:"Imagem inválida. Use JPG, PNG ou WEBP."});
    if (imageData && imageData.length > 3500000) return res.status(400).json({error:"Imagem muito grande. Reduza para até 2 MB."});
    const result = await query(`
      INSERT INTO instruction_uniforms(gender,command,image_data,updated_at,updated_by) VALUES($1,$2,$3,NOW(),$4)
      ON CONFLICT(gender) DO UPDATE SET command=EXCLUDED.command,image_data=EXCLUDED.image_data,updated_at=NOW(),updated_by=EXCLUDED.updated_by
      RETURNING gender,command,image_data,updated_at`, [gender, command, imageData, req.user.id]);
    await logAction(req.user.id,"UNIFORME_ATUALIZADO",`Fardamento ${gender} atualizado`);
    res.json({ok:true,uniform:result.rows[0]});
  } catch(e) { console.error(e); res.status(500).json({error:"Não foi possível salvar o uniforme."}); }
});

app.get('/api/instruction-materials', auth, async (req,res) => {
  try {
    const result = await query(`SELECT id,title,description,category,url,icon,section,course,material_order,updated_at FROM instruction_materials ORDER BY CASE section WHEN 'Manuais gerais' THEN 1 WHEN 'Link para provas dos alunos' THEN 2 WHEN 'Link manual por curso' THEN 3 ELSE 4 END, material_order ASC, id ASC`);
    res.json({materials:result.rows});
  } catch(e) { console.error(e); res.status(500).json({error:'Não foi possível carregar os materiais.'}); }
});

app.post('/api/instruction-materials', auth, managerAuth, coordinator, async (req,res) => {
  try {
    const title=String(req.body?.title||'').trim(), description=String(req.body?.description||'').trim(), category=String(req.body?.category||'Links úteis').trim(), url=String(req.body?.url||'').trim(), icon=String(req.body?.icon||'🔗').trim()||'🔗', section=String(req.body?.section||'Manuais gerais').trim(), course=String(req.body?.course||'').trim();
    if(!title || !url) return res.status(400).json({error:'Informe o nome e o link do material.'});
    if(url !== '#' && !/^https?:\/\//i.test(url)) return res.status(400).json({error:'O link deve começar com http:// ou https://.'});
    const max=await query(`SELECT COALESCE(MAX(material_order),0)+1 AS next FROM instruction_materials WHERE category=$1`,[category]);
    const result=await query(`INSERT INTO instruction_materials(title,description,category,url,icon,section,course,material_order,updated_at,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9) RETURNING *`,[title,description,category,url,icon,section,course,Number(max.rows[0].next),req.user.id]);
    await logAction(req.user.id,'MATERIAL_INSTRUCAO_CRIADO',`Material ${title} criado`);
    res.json({ok:true,material:result.rows[0]});
  } catch(e) { console.error(e); res.status(500).json({error:'Não foi possível criar o material.'}); }
});

app.put('/api/instruction-materials/:id', auth, managerAuth, coordinator, async (req,res) => {
  try {
    const id=Number(req.params.id); const title=String(req.body?.title||'').trim(), description=String(req.body?.description||'').trim(), category=String(req.body?.category||'Links úteis').trim(), url=String(req.body?.url||'').trim(), icon=String(req.body?.icon||'🔗').trim()||'🔗', section=String(req.body?.section||'Manuais gerais').trim(), course=String(req.body?.course||'').trim();
    if(!Number.isInteger(id)||id<1) return res.status(400).json({error:'Material inválido.'});
    if(!title || !url) return res.status(400).json({error:'Informe o nome e o link do material.'});
    if(url !== '#' && !/^https?:\/\//i.test(url)) return res.status(400).json({error:'O link deve começar com http:// ou https://.'});
    const result=await query(`UPDATE instruction_materials SET title=$1,description=$2,category=$3,url=$4,icon=$5,section=$6,course=$7,updated_at=NOW(),updated_by=$8 WHERE id=$9 RETURNING *`,[title,description,category,url,icon,section,course,req.user.id,id]);
    if(!result.rowCount) return res.status(404).json({error:'Material não encontrado.'});
    await logAction(req.user.id,'MATERIAL_INSTRUCAO_ATUALIZADO',`Material ${title} atualizado`);
    res.json({ok:true,material:result.rows[0]});
  } catch(e) { console.error(e); res.status(500).json({error:'Não foi possível atualizar o material.'}); }
});

app.delete('/api/instruction-materials/:id', auth, managerAuth, coordinator, async (req,res) => {
  try { const id=Number(req.params.id); if(!Number.isInteger(id)||id<1) return res.status(400).json({error:'Material inválido.'}); const result=await query(`DELETE FROM instruction_materials WHERE id=$1 RETURNING title`,[id]); if(!result.rowCount)return res.status(404).json({error:'Material não encontrado.'}); await logAction(req.user.id,'MATERIAL_INSTRUCAO_EXCLUIDO',`Material ${result.rows[0].title} excluído`); res.json({ok:true}); }
  catch(e){console.error(e);res.status(500).json({error:'Não foi possível excluir o material.'});}
});

app.get("/api/notifications", auth, async (req,res) => {
  try {
    const pref = await query("SELECT notification_preference FROM users WHERE id=$1", [req.user.id]);
    const preference = pref.rows[0]?.notification_preference || "all";
    if (preference === "none") return res.json({items:[], unread:0});

    const typeFilter = preference === "critical" ? `AND type IN ('success','danger','result')` : "";
    // O sino exibe somente notificações ainda não lidas.
    // As notificações lidas permanecem no banco para preservar o histórico,
    // mas deixam de aparecer no painel do sino.
    const result = await query(
      `SELECT id,type,title,message,read_at,created_at
       FROM notifications
       WHERE user_id=$1 AND read_at IS NULL ${typeFilter}
       ORDER BY created_at DESC
       LIMIT 30`,
      [req.user.id]
    );
    res.json({items:result.rows, unread:result.rows.length});
  } catch(e) {
    console.error("Notificações:",e);
    res.status(500).json({error:"Não foi possível carregar as notificações."});
  }
});

app.patch("/api/notifications/:id/read", auth, async (req,res) => {
  await query("UPDATE notifications SET read_at=NOW() WHERE id=$1 AND user_id=$2", [Number(req.params.id), req.user.id]);
  res.json({ok:true});
});

app.post("/api/notifications/read-all", auth, async (req,res) => {
  await query("UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL", [req.user.id]);
  res.json({ok:true});
});

app.get("/", (req,res) => {
  res.sendFile(path.join(__dirname,"public","index.html"));
});

async function start() {
  try {
    await initDb();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Instrutores rodando na porta ${PORT}`);
    });
  } catch (e) {
    console.error("Falha ao iniciar:", e);
    process.exit(1);
  }
}

start();
