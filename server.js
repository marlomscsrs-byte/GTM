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
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(saida, now()) - entrada))/3600.0),0) AS horas,
               COUNT(*)::int AS turnos
        FROM pontos_servico
        WHERE usuario_id=$1 AND entrada >= date_trunc('week', now())`, [req.user.id]),
      pool.query(`
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(saida, now()) - entrada))/3600.0),0) AS horas,
               COUNT(*)::int AS turnos
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
      week: { hours: weekHours, points: Number(weekHours.toFixed(1)), turns: Number(week.rows[0].turnos || 0) },
      total: { hours: totalHours, points: Number(totalHours.toFixed(1)), turns: Number(total.rows[0].turnos || 0) },
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

app.get("/api/dashboard/eventos", auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.id, e.titulo, e.descricao, e.data_evento, e.local,
             COALESCE(ep.status, 'pendente') AS minha_participacao
      FROM eventos e
      LEFT JOIN evento_participantes ep ON ep.evento_id=e.id AND ep.usuario_id=$1
      WHERE e.ativo=true AND e.data_evento >= now()
      ORDER BY e.data_evento ASC LIMIT 6`, [req.user.id]);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Não foi possível carregar os próximos eventos." });
  }
});

app.post("/api/dashboard/eventos/:id/participar", auth, async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO evento_participantes (evento_id, usuario_id, status)
      VALUES ($1,$2,'confirmado')
      ON CONFLICT (evento_id, usuario_id) DO UPDATE SET status='confirmado'`, [req.params.id, req.user.id]);
    res.json({ ok: true, message: "Participação confirmada." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Não foi possível confirmar sua participação." });
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

app.get("/api/ranking", auth, async (req, res) => {
  try {
    const period = req.query.period === 'week' ? 'week' : 'week';
    const { rows } = await pool.query(`
      SELECT e.nome, e.patente,
             ROUND(COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ps.saida, now()) - ps.entrada))/3600.0),0)::numeric,1) AS pontos
      FROM efetivo e
      LEFT JOIN pontos_servico ps ON ps.efetivo_id=e.id
        AND ps.entrada >= date_trunc('week', now())
      WHERE e.ativo=true
      GROUP BY e.id, e.nome, e.patente
      HAVING COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ps.saida, now()) - ps.entrada))/3600.0),0) > 0
      ORDER BY pontos DESC, e.nome ASC
      LIMIT 5
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({error:"Não foi possível carregar o ranking semanal."});
  }
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

app.post("/api/ocorrencias", auth, async (req, res) => {
  try {
    const { tipo, titulo, local, descricao, dados = {} } = req.body || {};
    if (!tipo || !titulo || !descricao) return res.status(400).json({ error: "Informe o tipo, título e relato da QRU." });
    if (!Array.isArray(dados.oficiais) || dados.oficiais.length === 0) return res.status(400).json({ error: "Selecione pelo menos um oficial envolvido." });
    const protocolo = `QRU-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(1000+Math.random()*9000)}`;
    const { rows } = await pool.query(
      `INSERT INTO ocorrencias (protocolo,tipo,titulo,descricao,local,status,criado_por,qru_dados,foto_url)
       VALUES ($1,$2,$3,$4,$5,'Aberta',$6,$7,$8) RETURNING id, protocolo, created_at`,
      [protocolo, tipo, titulo, descricao, local || 'Villa', req.user.id, JSON.stringify(dados), dados.foto_url || null]
    );
    await pool.query(`INSERT INTO logs (usuario_id,acao,entidade,entidade_id,detalhes) VALUES ($1,'REGISTRAR_QRU','ocorrencias',$2,$3)`, [req.user.id, rows[0].id, JSON.stringify({ protocolo, tipo })]);
    res.status(201).json(rows[0]);
  } catch (error) { console.error(error); res.status(500).json({ error: "Não foi possível registrar a QRU." }); }
});



app.post("/api/acoes", auth, async (req, res) => {
  const { tipo, resultado, negociacao, titulo, descricao, veiculos, oficiais } = req.body || {};
  if (!tipo || !resultado || !titulo) {
    return res.status(400).json({ error: "Tipo de ação, resultado e título são obrigatórios." });
  }
  const safeVehicles = Array.isArray(veiculos) ? veiculos.filter(v => v && (v.descricao || v.deschfecho || v.desfecho)).map(v => ({
    descricao: String(v.descricao || '').trim(),
    desfecho: String(v.desfecho || 'Não informado').trim() || 'Não informado'
  })) : [];
  const safeOfficers = Array.isArray(oficiais) ? oficiais.map(o => ({
    id: o.id, nome: String(o.nome || ''), matricula: String(o.matricula || ''), patente: String(o.patente || '')
  })) : [];
  const pontos = 3.0;
  try {
    const result = await pool.query(
      `INSERT INTO acoes (usuario_id,tipo,resultado,negociacao,titulo,descricao,veiculos,oficiais,pontos)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
       RETURNING id,tipo,resultado,titulo,pontos,created_at`,
      [req.user.id, String(tipo).trim(), String(resultado).trim(), negociacao || null, String(titulo).trim(), descricao || null, JSON.stringify(safeVehicles), JSON.stringify(safeOfficers), pontos]
    );
    await pool.query(`INSERT INTO logs (usuario_id,acao,entidade,entidade_id,detalhes) VALUES ($1,'REGISTRAR_ACAO','acoes',$2,$3)`, [req.user.id, result.rows[0].id, JSON.stringify({tipo, resultado, pontos})]);
    res.status(201).json({ ok:true, acao:result.rows[0], message:'Ação registrada com sucesso.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Não foi possível registrar a ação.' });
  }
});

app.get("/api/acoes", auth, async (_, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.id,a.tipo,a.resultado,a.negociacao,a.titulo,a.descricao,a.veiculos,a.oficiais,a.pontos,a.created_at,
             u.nome AS autor,u.matricula AS autor_matricula
      FROM acoes a LEFT JOIN usuarios u ON u.id=a.usuario_id
      ORDER BY a.created_at DESC LIMIT 50`);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Não foi possível carregar as ações.' });
  }
});

app.get("/api/pessoal", auth, async (req, res) => {
  try {
    const [userQ, pointQ, historyQ, certQ, eventQ, actionQ] = await Promise.all([
      pool.query(`SELECT u.id,u.nome,u.matricula,u.patente,u.telefone_cidade,u.username,u.ultimo_acesso,u.created_at,
                         e.data_ingresso,e.status,e.unidade
                  FROM usuarios u LEFT JOIN efetivo e ON e.usuario_id=u.id
                  WHERE u.id=$1 LIMIT 1`, [req.user.id]),
      pool.query(`SELECT
                    COALESCE(SUM(CASE WHEN entrada >= date_trunc('week', now()) THEN EXTRACT(EPOCH FROM (COALESCE(saida,now())-entrada))/3600.0 ELSE 0 END),0) AS week_hours,
                    COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(saida,now())-entrada))/3600.0),0) AS total_hours
                  FROM pontos_servico WHERE usuario_id=$1`, [req.user.id]),
      pool.query(`SELECT ps.id, ps.entrada, ps.saida, ps.status,
                         ROUND((EXTRACT(EPOCH FROM (COALESCE(ps.saida,now())-ps.entrada))/3600.0)::numeric,2) AS horas
                  FROM pontos_servico ps WHERE ps.usuario_id=$1 ORDER BY ps.entrada DESC LIMIT 10`, [req.user.id]),
      pool.query(`SELECT c.nome,c.descricao,cert.concluido_em,cert.validade,cert.status
                  FROM certificacoes cert JOIN cursos c ON c.id=cert.curso_id
                  JOIN efetivo e ON e.id=cert.efetivo_id WHERE e.usuario_id=$1
                  ORDER BY cert.concluido_em DESC NULLS LAST,c.nome LIMIT 10`, [req.user.id]),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status='confirmado')::int AS presencas,
                         COUNT(*) FILTER (WHERE status='atrasado')::int AS atrasos,
                         COUNT(*) FILTER (WHERE status='falta')::int AS faltas
                  FROM evento_participantes WHERE usuario_id=$1`, [req.user.id]),
      pool.query(`SELECT id,titulo,tipo,created_at FROM acoes WHERE usuario_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.user.id]).catch(()=>({rows:[]}))
    ]);
    const u=userQ.rows[0]||{};
    const pt=pointQ.rows[0]||{};
    const weekHours=Number(pt.week_hours||0), totalHours=Number(pt.total_hours||0);
    const daysInRank=u.data_ingresso ? Math.max(0, Math.floor((Date.now()-new Date(u.data_ingresso).getTime())/86400000)) : 0;
    res.json({
      user:u,
      metrics:{weekPoints:Number(weekHours.toFixed(1)),weekHours,totalPoints:Number(totalHours.toFixed(1)),totalHours,daysInRank},
      history:historyQ.rows,
      courses:certQ.rows,
      events:eventQ.rows[0]||{presencas:0,atrasos:0,faltas:0},
      warnings:0,
      coursesTaught:0,
      actions:actionQ.rows
    });
  } catch(error) { console.error(error); res.status(500).json({error:"Não foi possível carregar seus dados pessoais."}); }
});


app.put("/api/pessoal", auth, async (req, res) => {
  const nome = String(req.body.nome || "").trim();
  const telefone_cidade = String(req.body.telefone_cidade || "").trim();
  const email = String(req.body.email || "").trim();

  if (!nome) return res.status(400).json({ error: "Informe seu nome." });
  if (nome.length > 120) return res.status(400).json({ error: "O nome é muito longo." });
  if (telefone_cidade.length > 30) return res.status(400).json({ error: "O telefone é muito longo." });
  if (email.length > 160) return res.status(400).json({ error: "O e-mail é muito longo." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await client.query(
      `SELECT id,nome,telefone_cidade,email,matricula,patente FROM usuarios WHERE id=$1 FOR UPDATE`,
      [req.user.id]
    );
    if (!before.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    const result = await client.query(
      `UPDATE usuarios
          SET nome=$1, telefone_cidade=$2, email=NULLIF($3,'')
        WHERE id=$4
      RETURNING id,username,nome,matricula,patente,telefone_cidade,email,role`,
      [nome, telefone_cidade, email, req.user.id]
    );

    // Mantém o registro do efetivo sincronizado com os dados editáveis do próprio usuário.
    await client.query(
      `UPDATE efetivo
          SET nome=$1, telefone_cidade=$2
        WHERE usuario_id=$3`,
      [nome, telefone_cidade, req.user.id]
    );

    await client.query(
      `INSERT INTO logs (usuario_id,acao,entidade,entidade_id,detalhes)
       VALUES ($1,'EDITAR_DADOS_PESSOAIS','usuarios',$1,$2)`,
      [req.user.id, JSON.stringify({
        antes: before.rows[0],
        depois: { nome, telefone_cidade, email: email || null }
      })]
    );

    await client.query("COMMIT");
    res.json({ ok:true, user:result.rows[0], message:"Informações atualizadas com sucesso." });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error:"Não foi possível atualizar suas informações." });
  } finally { client.release(); }
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
