const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const schemaPath = path.join(__dirname, "db", "schema.sql");
const fs = require("fs");

async function initializeDatabase() {
  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schema);
  console.log("Banco de dados GTM inicializado.");
}

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Não autenticado" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    next();
  } catch {
    res.status(401).json({ error: "Sessão inválida" });
  }
}

app.get("/api/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "online" });
  } catch {
    res.status(503).json({ ok: false, database: "offline" });
  }
});


app.get("/api/setup/status", async (_, res) => {
  try {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM usuarios");
    res.json({ needsSetup: rows[0].n === 0 });
  } catch (error) {
    res.status(500).json({ error: "Não foi possível verificar a configuração inicial." });
  }
});

app.post("/api/setup/admin", async (req, res) => {
  const { username, password, nome, patente, email } = req.body;
  if (!username || !password || !nome) {
    return res.status(400).json({ error: "Usuário, senha e nome são obrigatórios." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "A senha deve ter pelo menos 8 caracteres." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const count = await client.query("SELECT count(*)::int AS n FROM usuarios");
    if (count.rows[0].n > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "A configuração inicial já foi concluída." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await client.query(
      `INSERT INTO usuarios (username, password_hash, nome, patente, email, ativo, aprovado)
       VALUES ($1,$2,$3,$4,$5,true,true)
       RETURNING id, username, nome, patente, email`,
      [username.trim(), passwordHash, nome.trim(), patente || "Comando", email || null]
    );
    await client.query("COMMIT");
    res.status(201).json({ ok: true, user: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Não foi possível criar o administrador inicial." });
  } finally {
    client.release();
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Informe usuário e senha." });

  const { rows } = await pool.query(
    `SELECT id, username, password_hash, nome, patente, ativo, aprovado
     FROM usuarios WHERE lower(username)=lower($1) LIMIT 1`, [username]
  );

  const user = rows[0];
  if (!user || !user.ativo || !user.aprovado || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Usuário ou senha inválidos." });
  }

  await pool.query("UPDATE usuarios SET ultimo_acesso=now() WHERE id=$1", [user.id]);

  const token = jwt.sign(
    { id: user.id, username: user.username, nome: user.nome, patente: user.patente },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "8h" }
  );
  res.json({ token, user: { id: user.id, username: user.username, nome: user.nome, patente: user.patente } });
});

app.get("/api/dashboard", auth, async (_, res) => {
  const [efetivo, ocorrencias, servicos, cursos, motos, online] = await Promise.all([
    pool.query("SELECT count(*)::int AS n FROM efetivo WHERE ativo=true"),
    pool.query("SELECT count(*)::int AS n FROM ocorrencias WHERE created_at >= now() - interval '7 days'"),
    pool.query("SELECT count(*)::int AS n FROM servicos WHERE data::date = current_date"),
    pool.query("SELECT count(*)::int AS n FROM cursos WHERE ativo=true"),
    pool.query("SELECT count(*)::int AS n FROM motocicletas WHERE ativo=true"),
    pool.query("SELECT count(*)::int AS n FROM usuarios WHERE ultimo_acesso >= now() - interval '15 minutes' AND ativo=true")
  ]);

  res.json({
    stats: {
      efetivo: efetivo.rows[0].n,
      ocorrencias: ocorrencias.rows[0].n,
      servicos: servicos.rows[0].n,
      cursos: cursos.rows[0].n,
      motocicletas: motos.rows[0].n,
      online: online.rows[0].n
    }
  });
});

app.get("/api/efetivo", auth, async (_, res) => {
  const { rows } = await pool.query(
    `SELECT e.id, e.nome, e.matricula, e.patente, e.status, e.unidade, e.ativo
     FROM efetivo e ORDER BY e.patente DESC, e.nome`
  );
  res.json(rows);
});

app.get("/api/ocorrencias", auth, async (_, res) => {
  const { rows } = await pool.query(
    `SELECT id, protocolo, tipo, titulo, local, status, created_at
     FROM ocorrencias ORDER BY created_at DESC LIMIT 100`
  );
  res.json(rows);
});

app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

initializeDatabase()
  .then(() => app.listen(port, () => console.log(`Portal GTM rodando na porta ${port}`)))
  .catch((error) => {
    console.error("Falha ao inicializar o banco de dados:", error);
    process.exit(1);
  });
