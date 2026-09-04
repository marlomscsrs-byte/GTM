const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const schemaPath = path.join(__dirname, "db", "schema.sql");

async function initializeDatabase() {
  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schema);
  console.log("Banco de dados GTM inicializado e efetivo sincronizado.");
}

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Não autenticado" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Sessão inválida" });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Acesso restrito ao comando." });
  }
  next();
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
    console.error(error);
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
      `INSERT INTO usuarios (username, password_hash, nome, patente, email, role, ativo, aprovado, status_cadastro)
       VALUES ($1,$2,$3,$4,$5,'admin',true,true,'aprovado')
       RETURNING id, username, nome, patente, email, role`,
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

app.post("/api/auth/register", async (req, res) => {
  const { nome, matricula, patente, telefone_cidade, username, password } = req.body;
  if (!nome || !matricula || !patente || !telefone_cidade || !username || !password) {
    return res.status(400).json({ error: "Preencha nome, ID, patente, telefone da cidade, usuário e senha." });
  }
  if (password.length < 8) return res.status(400).json({ error: "A senha deve ter pelo menos 8 caracteres." });
  if (!/^\d{1,12}$/.test(String(matricula).trim())) return res.status(400).json({ error: "O ID deve conter apenas números." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existingUser = await client.query("SELECT id FROM usuarios WHERE lower(username)=lower($1)", [username.trim()]);
    if (existingUser.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Este nome de usuário já está em uso." });
    }
    const existingId = await client.query("SELECT id FROM usuarios WHERE matricula=$1", [String(matricula).trim()]);
    if (existingId.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Este ID já possui uma solicitação ou conta no sistema." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userResult = await client.query(
      `INSERT INTO usuarios (username, password_hash, nome, patente, matricula, telefone_cidade, role, ativo, aprovado, status_cadastro)
       VALUES ($1,$2,$3,$4,$5,$6,'operador',false,false,'pendente')
       RETURNING id, username, nome, matricula, patente, telefone_cidade, role, aprovado, status_cadastro`,
      [username.trim(), passwordHash, nome.trim(), patente.trim(), String(matricula).trim(), telefone_cidade.trim()]
    );

    await client.query(
      `INSERT INTO logs (usuario_id, acao, entidade, entidade_id, detalhes)
       VALUES ($1,'SOLICITAR_CADASTRO','usuarios',$1,$2)`,
      [userResult.rows[0].id, JSON.stringify({ matricula: String(matricula).trim(), username: username.trim() })]
    );
    await client.query("COMMIT");
    res.status(201).json({
      ok: true,
      pending: true,
      message: "Cadastro enviado para aprovação do Comando. Aguarde a liberação para entrar no portal.",
      user: userResult.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Não foi possível enviar o cadastro." });
  } finally {
    client.release();
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Informe usuário e senha." });

  const { rows } = await pool.query(
    `SELECT id, username, password_hash, nome, matricula, patente, email, telefone_cidade, role, ativo, aprovado, status_cadastro
     FROM usuarios WHERE lower(username)=lower($1) LIMIT 1`, [username]
  );

  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Usuário ou senha inválidos." });
  }
  if (user.status_cadastro === 'pendente' || !user.aprovado) {
    return res.status(403).json({ error: "Seu cadastro está aguardando aprovação do Comando." });
  }
  if (user.status_cadastro === 'recusado' || !user.ativo) {
    return res.status(403).json({ error: "Seu cadastro não foi aprovado pelo Comando." });
  }

  await pool.query("UPDATE usuarios SET ultimo_acesso=now() WHERE id=$1", [user.id]);

  const token = jwt.sign(
    { id: user.id, username: user.username, nome: user.nome, patente: user.patente, telefone_cidade: user.telefone_cidade, role: user.role },
    JWT_SECRET,
    { expiresIn: "8h" }
  );
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      nome: user.nome,
      matricula: user.matricula,
      patente: user.patente,
      telefone_cidade: user.telefone_cidade,
      role: user.role
    }
  });
});

app.get("/api/ponto/status", auth, async (req, res) => {
  try {
    const [current, week, total, team] = await Promise.all([
      pool.query(`
        SELECT ps.id, ps.entrada, ps.saida, ps.status, e.nome, e.matricula, e.patente
        FROM pontos_servico ps
        JOIN efetivo e ON e.id = ps.efetivo_id
        WHERE ps.usuario_id=$1 AND ps.status='em_servico'
        ORDER BY ps.entrada DESC LIMIT 1`, [req.user.id]),
      pool.query(`
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(saida, now()) - entrada))/3600.0),0) AS horas
        FROM pontos_servico
        WHERE usuario_id=$1 AND entrada >= date_trunc('week', now())`, [req.user.id]),
      pool.query(`
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(saida, now()) - entrada))/3600.0),0) AS horas
        FROM pontos_servico
        WHERE usuario_id=$1`, [req.user.id]),
      pool.query(`
        SELECT ps.id, e.nome, e.matricula, e.patente, ps.entrada
        FROM pontos_servico ps
        JOIN efetivo e ON e.id=ps.efetivo_id
        WHERE ps.status='em_servico'
        ORDER BY ps.entrada ASC`)
    ]);
    const weekHours = Number(week.rows[0].horas || 0);
    const totalHours = Number(total.rows[0].horas || 0);
    res.json({
      current: current.rows[0] || null,
      week: { hours: weekHours, points: Number(weekHours.toFixed(1)) },
      total: { hours: totalHours, points: Number(totalHours.toFixed(1)) },
      team: team.rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Não foi possível consultar o ponto de serviço." });
  }
});

app.post("/api/ponto/iniciar", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const linked = await client.query(`
      SELECT id, nome, matricula, patente FROM efetivo
      WHERE usuario_id=$1 AND ativo=true LIMIT 1`, [req.user.id]);
    if (!linked.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Seu cadastro ainda não está vinculado a um integrante ativo do efetivo." });
    }
    const active = await client.query(`
      SELECT id, entrada FROM pontos_servico
      WHERE usuario_id=$1 AND status='em_servico' LIMIT 1`, [req.user.id]);
    if (active.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Você já está em serviço." });
    }
    const result = await client.query(`
      INSERT INTO pontos_servico (usuario_id, efetivo_id, entrada, status)
      VALUES ($1,$2,now(),'em_servico')
      RETURNING id, entrada, status`, [req.user.id, linked.rows[0].id]);
    await client.query(`
      INSERT INTO logs (usuario_id, acao, entidade, entidade_id, detalhes)
      VALUES ($1,'INICIAR_SERVICO','pontos_servico',$2,$3)`,
      [req.user.id, result.rows[0].id, JSON.stringify({ efetivo_id: linked.rows[0].id })]);
    await client.query("COMMIT");
    res.status(201).json({ ok: true, message: "Serviço iniciado.", service: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Não foi possível iniciar o serviço." });
  } finally { client.release(); }
});

app.post("/api/ponto/encerrar", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(`
      SELECT id, entrada FROM pontos_servico
      WHERE usuario_id=$1 AND status='em_servico'
      ORDER BY entrada DESC LIMIT 1 FOR UPDATE`, [req.user.id]);
    if (!current.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Você não está em serviço." });
    }
    const result = await client.query(`
      UPDATE pontos_servico
      SET saida=now(), status='encerrado'
      WHERE id=$1
      RETURNING id, entrada, saida, status,
        EXTRACT(EPOCH FROM (saida-entrada))/3600.0 AS horas`, [current.rows[0].id]);
    await client.query(`
      INSERT INTO logs (usuario_id, acao, entidade, entidade_id, detalhes)
      VALUES ($1,'ENCERRAR_SERVICO','pontos_servico',$2,$3)`,
      [req.user.id, result.rows[0].id, JSON.stringify({ horas: Number(result.rows[0].horas || 0) })]);
    await client.query("COMMIT");
    res.json({ ok: true, message: "Serviço encerrado.", service: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Não foi possível encerrar o serviço." });
  } finally { client.release(); }
});

app.get("/api/ponto/historico", auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, entrada, saida, status,
        ROUND((EXTRACT(EPOCH FROM (COALESCE(saida, now())-entrada))/3600.0)::numeric,2) AS horas,
        ROUND((EXTRACT(EPOCH FROM (COALESCE(saida, now())-entrada))/3600.0)::numeric,1) AS pontos
      FROM pontos_servico WHERE usuario_id=$1
      ORDER BY entrada DESC LIMIT 100`, [req.user.id]);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Não foi possível carregar o histórico de serviço." });
  }
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
    `SELECT e.id, e.nome, e.matricula, e.patente, e.status, e.unidade, e.ativo, e.telefone_cidade,
            u.id AS usuario_id, u.username, u.aprovado AS conta_aprovada, u.ativo AS conta_ativa
     FROM efetivo e
     LEFT JOIN usuarios u ON u.id=e.usuario_id
     ORDER BY CASE e.unidade
       WHEN 'Comando' THEN 1 WHEN 'Sub-Comando' THEN 2 WHEN 'Supervisor' THEN 3
       WHEN 'Piloto Oficial' THEN 4 WHEN 'Probatório' THEN 5 ELSE 9 END,
       e.nome` 
  );
  res.json(rows);
});

app.get("/api/admin/cadastros-pendentes", auth, requireAdmin, async (_, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, matricula, patente, telefone_cidade, username, created_at
     FROM usuarios
     WHERE status_cadastro='pendente'
     ORDER BY created_at ASC`
  );
  res.json(rows);
});

app.post("/api/admin/cadastros/:id/aprovar", auth, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query(
      `SELECT id, nome, matricula, patente, telefone_cidade, username, status_cadastro
       FROM usuarios WHERE id=$1 FOR UPDATE`, [req.params.id]
    );
    const user = userResult.rows[0];
    if (!user) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Cadastro não encontrado." }); }
    if (user.status_cadastro !== 'pendente') { await client.query("ROLLBACK"); return res.status(409).json({ error: "Este cadastro já foi processado." }); }

    const duplicate = await client.query("SELECT id FROM efetivo WHERE matricula=$1", [user.matricula]);
    if (duplicate.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "O ID informado já existe no efetivo." });
    }

    const efetivoResult = await client.query(
      `INSERT INTO efetivo (usuario_id, nome, matricula, patente, status, unidade, ativo, telefone_cidade)
       VALUES ($1,$2,$3,$4,'Ativo','A definir',true,$5)
       RETURNING id`,
      [user.id, user.nome, user.matricula, user.patente, user.telefone_cidade]
    );

    await client.query(
      `UPDATE usuarios SET ativo=true, aprovado=true, status_cadastro='aprovado' WHERE id=$1`, [user.id]
    );
    await client.query(
      `INSERT INTO logs (usuario_id, acao, entidade, entidade_id, detalhes)
       VALUES ($1,'APROVAR_CADASTRO','efetivo',$2,$3)`,
      [req.user.id, efetivoResult.rows[0].id, JSON.stringify({ usuario_id: user.id, matricula: user.matricula })]
    );
    await client.query("COMMIT");
    res.json({ ok: true, message: "Cadastro aprovado e incluído no efetivo." });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Não foi possível aprovar o cadastro." });
  } finally { client.release(); }
});

app.post("/api/admin/cadastros/:id/recusar", auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE usuarios SET ativo=false, aprovado=false, status_cadastro='recusado'
       WHERE id=$1 AND status_cadastro='pendente' RETURNING id, nome, matricula`, [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Cadastro pendente não encontrado." });
    await pool.query(
      `INSERT INTO logs (usuario_id, acao, entidade, entidade_id, detalhes)
       VALUES ($1,'RECUSAR_CADASTRO','usuarios',$2,$3)`,
      [req.user.id, result.rows[0].id, JSON.stringify({ matricula: result.rows[0].matricula })]
    );
    res.json({ ok: true, message: "Cadastro recusado." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Não foi possível recusar o cadastro." });
  }
});

app.get("/api/admin/usuarios", auth, requireAdmin, async (_, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.nome, u.matricula, u.patente, u.email, u.telefone_cidade, u.role, u.ativo, u.aprovado, u.status_cadastro, u.ultimo_acesso,
            e.id AS efetivo_id, e.matricula
     FROM usuarios u
     LEFT JOIN efetivo e ON e.usuario_id=u.id
     ORDER BY u.role DESC, u.nome`
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
