// v77: calendário sempre derivado diretamente do DATE do PostgreSQL para evitar deslocamento UTC no Discord.
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
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
// Discord Interactions precisam do corpo JSON bruto para validação Ed25519.
// Esta rota é registrada antes do express.json() e usa express.raw() apenas nela.
app.post("/api/discord/interactions", express.raw({ type: "application/json", limit: "2mb" }), async (req,res) => {
  let deferred = false;
  let interactionForReply = null;
  try {
    const publicKey = String(process.env.DISCORD_PUBLIC_KEY || "").trim();
    const signature = String(req.headers["x-signature-ed25519"] || "").trim();
    const timestamp = String(req.headers["x-signature-timestamp"] || "").trim();
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""));
    if (!publicKey || !signature || !timestamp || !rawBody.length) return res.status(401).send("invalid request");
    const signatureBuffer = Buffer.from(signature, "hex");
    const publicKeyHex = publicKey.replace(/[^0-9a-f]/gi, "");
    if (publicKeyHex.length !== 64 || signatureBuffer.length !== 64 || !/^\d+$/.test(timestamp)) return res.status(401).send("invalid request");
    // Chave pública do Discord é Ed25519 em hexadecimal; o Node recebe um SPKI DER.
    const spkiDer = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]);
    const publicKeyObject = crypto.createPublicKey({key: spkiDer, format:"der", type:"spki"});
    const verified = crypto.verify(null, Buffer.from(timestamp + rawBody.toString("utf8")), publicKeyObject, signatureBuffer);
    if (!verified) return res.status(401).send("invalid request");
    if (Math.abs(Date.now() - Number(timestamp) * 1000) > 5 * 60 * 1000) return res.status(401).send("expired request");

    const interaction = JSON.parse(rawBody.toString("utf8"));
    interactionForReply = interaction;
    if (Number(interaction.type) === 1) return res.json({ type: 1 });
    if (Number(interaction.type) !== 3) return res.json({ type: 4, data: { content: "Interação não suportada.", flags: 64 } });

    const customId = String(interaction.data?.custom_id || "");
    const parts = customId.split(":");
    if (parts[0] !== "cip" || parts.length !== 4 || !["approve","reject"].includes(parts[2])) {
      return res.json({ type: 4, data: { content: "Botão inválido ou expirado.", flags: 64 } });
    }

    // ACK imediato: o Discord exige resposta em ~3 segundos.
    // Depois do ACK, o processamento do banco/permissões e a atualização do embed
    // podem continuar sem fazer o botão expirar.
    deferred = true;
    res.json({ type: 6 });
    const originalJson = res.json.bind(res);
    res.json = async (payload) => {
      if (!deferred) return originalJson(payload);
      try {
        const appId = String(interactionForReply?.application_id || "").trim();
        const token = String(interactionForReply?.token || "").trim();
        if (!appId || !token) return;
        const data = payload?.data || {};
        await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data)
        });
      } catch (e) {
        console.error("Discord interaction follow-up:", e.message);
      }
    };
    const [, entity, action, rawId] = parts;
    const targetId = Number(rawId);
    const discordUserId = String(interaction.member?.user?.id || interaction.user?.id || "").trim();
    if (!Number.isInteger(targetId) || targetId < 1 || !discordUserId) {
      return res.json({ type: 4, data: { content: "Não foi possível identificar a solicitação.", flags: 64 } });
    }

    const normalizeDiscordId = value => String(value || "").replace(/[<@!>]/g, "").trim();
    const actorRes = await query("SELECT id,name,discord,role,status,instruction_internal_role FROM users WHERE status='approved' AND regexp_replace(COALESCE(discord,''),'[^0-9]','','g')=$1 LIMIT 1", [normalizeDiscordId(discordUserId)]);
    const actor = actorRes.rows[0];
    if (!actor) return res.json({ type: 4, data: { content: "❌ Seu Discord ID não está vinculado a um usuário aprovado no CIP.", flags: 64 } });

    const role = String(actor.role || "").toLowerCase();
    let resultMessage = "";
    let changed = false;

    if (entity === "booking") {
      if (!canApproveInstructionEmbed(role, actor.instruction_internal_role)) return res.json({ type: 4, data: { content: "❌ Você não possui cargo autorizado para aprovar marcações de Instrutores.", flags: 64 } });
      const r = await query("SELECT b.*,to_char(b.date,'YYYY-MM-DD') AS booking_date_key,u.name AS instructor_name FROM bookings b JOIN users u ON u.id=b.instructor_id WHERE b.id=$1", [targetId]);
      const b = r.rows[0];
      if (!b) return res.json({ type: 4, data: { content: "❌ Marcação não encontrada.", flags: 64 } });
      if (String(b.status).toLowerCase() !== "pending") return res.json({ type: 4, data: { content: `ℹ️ Esta marcação já está **${discordStatusBR(b.status)}**.`, flags: 64 } });
      const isApprove = action === "approve";
      let approvedRows = [b];
      if (isApprove && b.recurrence_group_id) {
        const recurring = await query(`SELECT b.*,to_char(b.date,'YYYY-MM-DD') AS booking_date_key,u.name AS instructor_name FROM bookings b JOIN users u ON u.id=b.instructor_id WHERE b.recurrence_group_id=$1 ORDER BY b.date,b.start_time,b.id`, [b.recurrence_group_id]);
        approvedRows = recurring.rows.length ? recurring.rows : [b];
        await query("UPDATE bookings SET status='confirmed' WHERE recurrence_group_id=$1 AND status='pending'", [b.recurrence_group_id]);
      } else {
        await query("UPDATE bookings SET status=$1 WHERE id=$2", [isApprove ? "confirmed" : "cancelled", targetId]);
      }
      await logAction(actor.id, "STATUS_MARCACAO_ALTERADO", `${b.instructor_name} → ${isApprove ? "confirmed" : "cancelled"} via Discord`);
      const label = isApprove ? "APROVADA" : "RECUSADA";
      resultMessage = `${isApprove ? "✅" : "❌"} **${label}**\n📚 **Curso:** ${b.course}\n👨‍🏫 **Instrutor:** ${b.instructor_name}\n📅 **Data:** ${formatDateBR(b.booking_date_key || b.date)}\n⏰ **Horário:** ${formatTimeBR(b.start_time)} - ${formatTimeBR(b.end_time)}\n👤 **Por:** ${actor.name}`;

      // A aprovação feita pelo Discord precisa executar a mesma notificação da aprovação feita no site.
      // O aviso aprovado vai para o canal Agenda de Instrutores (approvedBooking), além de atualizar o embed original.
      if (isApprove) {
        const first = approvedRows[0] || b;
        const last = approvedRows[approvedRows.length - 1] || b;
        const firstDateKey = first.booking_date_key || first.date;
        const lastDateKey = last.booking_date_key || last.date;
        const firstDateTs = discordDateRelative(firstDateKey, b.start_time) || formatDateBR(firstDateKey);
        const lastDateTs = discordDateRelative(lastDateKey, b.start_time) || formatDateBR(lastDateKey);
        const approvedNotice = b.recurrence_group_id && approvedRows.length > 1
          ? `📅 **RECORRÊNCIA APROVADA — AGENDA**\n\n📚 **Curso:** ${b.course}\n👨‍🏫 **Instrutor:** ${b.instructor_name}\n📅 **De:** ${firstDateTs}\n📅 **Até:** ${lastDateTs}\n⏰ **Horário:** ${formatTimeBR(b.start_time)} - ${formatTimeBR(b.end_time)}\n🔁 **Recorrência:** semanal\n📌 **Ocorrências aprovadas:** ${approvedRows.length}\n🟢 **Status:** APROVADAS`
          : `✅ **AGENDAMENTO APROVADO**\n📚 **Curso:** ${b.course}\n👨‍🏫 **Instrutor:** ${b.instructor_name}\n📅 **Data:** ${firstDateTs}\n⏰ **Horário:** ${formatTimeBR(b.start_time)} - ${formatTimeBR(b.end_time)}\n🟢 **Status:** APROVADA`;
        try { await discordNotify(approvedNotice, "approvedBooking"); } catch (e) { console.error("Discord approval agenda notice:", e.message); }
        try { await notifyUsers([b.created_by, b.instructor_id], "success", "Agendamento aprovado", `${b.course} foi aprovado para ${formatDateBR(b.date)} das ${formatTimeBR(b.start_time)} às ${formatTimeBR(b.end_time)}.`); } catch (e) { console.error("Discord approval in-app notice:", e.message); }
        try { for (const approvedRow of approvedRows) await ensureDiscordScheduledEventForBooking({...approvedRow,date_key:approvedRow.date_key||approvedRow.booking_date_key||approvedRow.date}); } catch (e) { console.error("Criação automática de evento Discord após aprovação:", e.message); }
      } else {
        try { await discordNotify(`❌ **MARCAÇÃO RECUSADA**\n📚 **Curso:** ${b.course}\n👨‍🏫 **Instrutor:** ${b.instructor_name}\n📅 **Data:** ${formatDateBR(b.booking_date_key || b.date)}\n⏰ **Horário:** ${formatTimeBR(b.start_time)} - ${formatTimeBR(b.end_time)}\n🔴 **Status:** RECUSADA`, "newBooking"); } catch (e) { console.error("Discord rejection notice:", e.message); }
      }
      changed = true;
    } else if (entity === "recruitment") {
      if (!isRecruitmentCoordinatorRole(role)) return res.json({ type: 4, data: { content: "❌ Você não possui cargo autorizado para aprovar recrutamentos.", flags: 64 } });
      const r = await query("SELECT *, to_char(date, 'YYYY-MM-DD') AS date_key FROM cip_recruitments WHERE id=$1", [targetId]);
      const rec = r.rows[0];
      if (!rec) return res.json({ type: 4, data: { content: "❌ Recrutamento não encontrado.", flags: 64 } });
      if (String(rec.status).toLowerCase() !== "pending") return res.json({ type: 4, data: { content: `ℹ️ Este recrutamento já está **${discordStatusBR(rec.status)}**.`, flags: 64 } });
      const isApprove = action === "approve";
      const nextStatus = isApprove ? "confirmed" : "cancelled";
      await query("UPDATE cip_recruitments SET status=$1 WHERE id=$2", [nextStatus,targetId]);
      if (rec.booking_id) await query("UPDATE bookings SET status=$1 WHERE id=$2", [nextStatus,targetId === rec.booking_id ? targetId : rec.booking_id]);
      await logAction(actor.id, "RECRUTAMENTO_STATUS_ALTERADO", `Recrutamento Nº ${rec.recruitment_number || "—"} → ${nextStatus} via Discord`);
      resultMessage = `${isApprove ? "✅" : "❌"} **RECRUTAMENTO ${isApprove ? "APROVADO" : "RECUSADO"}**
🎯 **Recrutamento Nº:** ${rec.recruitment_number || "—"}
📅 **Data:** ${recruitmentDiscordDateTimestamp(rec) || formatDateBR(rec.date_key || rec.date)}
⏰ **Horário:** ${formatTimeBR(rec.start_time)} - ${formatTimeBR(rec.end_time)}
👤 **Por:** ${actor.name}`;
      if(isApprove){
        try { const agendaDiscord=await sendRecruitmentAgendaDiscordMessage(targetId); if(!agendaDiscord?.ok) console.error('Discord Agenda recrutamento aprovado via botão:',agendaDiscord?.reason||'falha ao enviar embed'); }
        catch(e){ console.error('Discord Agenda recrutamento aprovado via botão:',e.message); }
      }
        try { scheduleRecruitmentThreeHourReminder(targetId); } catch(e) { console.error('Agendamento do aviso 3h via Discord:', e.message); }
      changed = true;
    } else if (entity === "recruitment_result") {
      if (!isRecruitmentCoordinatorRole(role)) return res.json({ type: 4, data: { content: "❌ Você não possui cargo autorizado para aprovar resultados de recrutamento.", flags: 64 } });
      const r = await query(`SELECT r.id,r.recruitment_number,r.cutoff_score,COUNT(p.id)::int AS total,COUNT(p.id) FILTER (WHERE p.status='submitted')::int AS pending FROM cip_recruitments r JOIN cip_recruitment_participants p ON p.recruitment_id=r.id WHERE r.id=$1 GROUP BY r.id`, [targetId]);
      const rec = r.rows[0];
      if (!rec) return res.json({ type: 4, data: { content: "❌ Resultado de recrutamento não encontrado.", flags: 64 } });
      if (Number(rec.total) < 1) return res.json({ type: 4, data: { content: "❌ Este recrutamento não possui resultados.", flags: 64 } });
      if (Number(rec.pending) === 0) return res.json({ type: 4, data: { content: "ℹ️ Este resultado já foi revisado.", flags: 64 } });
      const isApprove = action === "approve";
      await refreshRecruitmentCutoffs();
      if (isApprove) {
        await query(`UPDATE cip_recruitment_participants p SET status=CASE WHEN p.score IS NOT NULL AND p.score >= r.cutoff_score THEN 'approved' ELSE 'rejected' END, reviewed_at=NOW(), reviewed_by=$1 FROM cip_recruitments r WHERE p.recruitment_id=$2 AND r.id=p.recruitment_id AND p.status='submitted'`, [actor.id, targetId]);
      } else {
        await query(`UPDATE cip_recruitment_participants SET status='rejected', reviewed_at=NOW(), reviewed_by=$1 WHERE recruitment_id=$2 AND status='submitted'`, [actor.id, targetId]);
      }
      await logAction(actor.id, 'RESULTADO_RECRUTAMENTO_LANCADO', `Recrutamento Nº ${rec.recruitment_number || '—'} → ${isApprove ? 'APROVADO' : 'RECUSADO'} via Discord`);
      try { await sendRecruitmentResultSummary(targetId); } catch (e) { console.error('Bot Discord - resultado final após aprovação:', e.message); }
      resultMessage = `${isApprove ? '✅' : '❌'} **RESULTADO DO RECRUTAMENTO ${isApprove ? 'APROVADO' : 'RECUSADO'}**\n🎯 **Recrutamento Nº:** ${rec.recruitment_number || '—'}\n👤 **Por:** ${actor.name}`;
      changed = true;
    } else if (entity === "user") {
      if (!isAnyCoordinatorRole(role)) return res.json({ type: 4, data: { content: "❌ Você não possui cargo autorizado para aprovar cadastros.", flags: 64 } });
      const r = await query("SELECT * FROM users WHERE id=$1", [targetId]);
      const u = r.rows[0];
      if (!u) return res.json({ type: 4, data: { content: "❌ Cadastro não encontrado.", flags: 64 } });
      if (String(u.status).toLowerCase() !== "pending") return res.json({ type: 4, data: { content: `ℹ️ Este cadastro já está **${u.status}**.`, flags: 64 } });
      const isApprove = action === "approve";
      const nextRole = ["instrutor","coordenador","coordenador_instrucao","coordenador_recrutamentos","recrutador","instrutor_recrutador"].includes(String(u.role||"")) ? u.role : "instrutor";
      if (isApprove) await query("UPDATE users SET status='approved',role=$2,approved_at=NOW() WHERE id=$1", [targetId,nextRole]);
      else await query("UPDATE users SET status='rejected' WHERE id=$1", [targetId]);
      await logAction(actor.id, isApprove ? "USUARIO_APROVADO" : "USUARIO_RECUSADO", `${isApprove ? "Aprovado" : "Recusado"} via Discord: ${u.name}`);
      await createNotification(targetId, isApprove ? "success" : "danger", isApprove ? "Cadastro aprovado" : "Cadastro recusado", isApprove ? "Seu cadastro foi aprovado. Você já pode acessar o sistema." : "Seu cadastro foi recusado. Entre em contato com a coordenação para mais informações.");
      resultMessage = `${isApprove ? "✅" : "❌"} **CADASTRO ${isApprove ? "APROVADO" : "RECUSADO"}**
👤 **Nome:** ${u.name}
🔑 **Usuário:** @${u.username}
👤 **Por:** ${actor.name}`;
      changed = true;
    } else {
      return res.json({ type: 4, data: { content: "❌ Tipo de aprovação não reconhecido.", flags: 64 } });
    }

    if (changed) {
      const token = String(process.env.DISCORD_BOT_TOKEN || "").trim();
      const channelId = String(interaction.channel_id || "").trim();
      const messageId = String(interaction.message?.id || "").trim();
      if (token && channelId && messageId) {
        const oldEmbed = interaction.message?.embeds?.[0] || {};
        const updatedEmbed = { ...oldEmbed, description: `${oldEmbed.description || ""}${oldEmbed.description ? "\n\n" : ""}${resultMessage}`, footer: { text: `CIP • ${action === "approve" ? "Aprovado" : "Recusado"} por ${actor.name}` }, timestamp: new Date().toISOString() };
        await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, { method:"PATCH", headers:{"Authorization":`Bot ${token}`,"Content-Type":"application/json"}, body:JSON.stringify({embeds:[updatedEmbed],components:[]}) }).catch(()=>{});
      }
    }
    return;
  } catch (e) {
    console.error("Discord interaction:", e);
    return res.json({ type: 4, data: { content: "❌ Ocorreu um erro ao processar a aprovação. Verifique os logs do servidor.", flags: 64 } });
  }
});
app.post('/api/twitch/eventsub', express.raw({ type: 'application/json', limit: '2mb' }), async (req,res)=>{
  try{const rawBody=Buffer.isBuffer(req.body)?req.body.toString('utf8'):String(req.body||'');const result=await handleTwitchEventSubNotification(rawBody,req.headers);if(result?.verification)return res.type('text/plain').send(result.challenge||'');return res.status(204).end();}catch(e){console.error('[TWITCH EVENTSUB]',e.message);return res.status(403).send('invalid event');}
});

app.use(express.json({ limit: "8mb" }));
app.get("/", (req,res) => {
  // index.html muda com deploy, portanto não recebe cache longo.
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  const acceptsGzip = /\bgzip\b/i.test(req.headers["accept-encoding"] || "");
  if (acceptsGzip) {
    const gz = path.join(__dirname, "public", "index.html.gz");
    if (fs.existsSync(gz)) {
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.sendFile(gz);
    }
  }
  res.sendFile(path.join(__dirname,"public","index.html"));
});

// Arquivos estáticos: cache agressivo reduz downloads repetidos no Render.
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "7d",
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.(?:webp|png|jpg|jpeg|gif|svg|ico|css|js|woff2?)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
    }
  }
}));

async function query(text, params=[]) {
  return pool.query(text, params);
}

// Recrutamentos podem chegar à tabela de marcações como "Recrutamento" ou "Recrutamento Nº 6".
// Ambos são cursos simples: não recebem notas e devem apenas ser marcados como realizados.
function isSimpleCourseName(course){
  return /^(recrutamento|formação|formacao)(?:\s|$)/i.test(String(course||'').trim());
}
function isRecruitmentCourseName(course){
  return /^recrutamento(?:\s|$)/i.test(String(course||'').trim());
}

async function assignNextRecruitmentNumber(recruitmentId){
  // NUMERAÇÃO PERMANENTE E CIRÚRGICA:
  // Atribui número SOMENTE ao registro oficial informado que ainda está sem número.
  // Nunca renumera registros existentes e nunca toca em recrutamentos fora da agenda.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializa apenas a atribuição de números para evitar colisão em criações simultâneas.
    await client.query('SELECT pg_advisory_xact_lock($1)', [482193]);
    const r = await client.query(`
      SELECT id, official, recruitment_number
      FROM cip_recruitments
      WHERE id=$1
      FOR UPDATE
    `, [recruitmentId]);
    if (!r.rowCount) throw new Error('Recrutamento não encontrado para numeração.');
    const rec = r.rows[0];
    if (!rec.official || rec.recruitment_number != null) {
      await client.query('COMMIT');
      return rec.recruitment_number == null ? null : Number(rec.recruitment_number);
    }
    const next = await client.query(`
      SELECT COALESCE(MAX(recruitment_number),0)+1 AS next_number
      FROM cip_recruitments
      WHERE official=TRUE AND recruitment_number IS NOT NULL
    `);
    const number = Number(next.rows[0].next_number);
    await client.query(`UPDATE cip_recruitments SET recruitment_number=$1 WHERE id=$2`, [number, recruitmentId]);
    await client.query('COMMIT');
    return number;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function diagnosticRecruitmentNumbers(){
  // DIAGNÓSTICO SOMENTE LEITURA. NÃO ALTERA NENHUMA TABELA.
  const r = await query(`
    SELECT r.id,r.recruitment_number,r.date,r.start_time,r.end_time,r.status,r.official,
           r.created_at,r.booking_id,
           ru.name AS recruiter_name,
           (SELECT COUNT(*)::int FROM cip_recruitment_participants p WHERE p.recruitment_id=r.id) AS conscripts,
           (SELECT COUNT(*)::int FROM cip_recruitment_participants p WHERE p.recruitment_id=r.id AND p.status='approved') AS approved,
           (SELECT COUNT(*)::int FROM cip_recruitment_participants p WHERE p.recruitment_id=r.id AND p.status='rejected') AS rejected,
           (SELECT MIN(p.created_at) FROM cip_recruitment_participants p WHERE p.recruitment_id=r.id) AS first_participant_at,
           (SELECT MAX(p.submitted_at) FROM cip_recruitment_participants p WHERE p.recruitment_id=r.id) AS last_submitted_at,
           (SELECT MAX(p.reviewed_at) FROM cip_recruitment_participants p WHERE p.recruitment_id=r.id) AS last_reviewed_at
    FROM cip_recruitments r
    LEFT JOIN users ru ON ru.id=r.recruiter_id
    ORDER BY r.date ASC,r.start_time ASC,r.id ASC
  `);
  const out=[];
  for(const rec of r.rows){
    const number = rec.recruitment_number == null ? null : Number(rec.recruitment_number);
    const dateKey = String(rec.date).slice(0,10);
    const timeKey = String(rec.start_time).slice(0,8);
    const recruiter = String(rec.recruiter_name || '').trim();
    const terms=[];
    if(number != null) terms.push(`%Nº ${number}%`);
    terms.push(`%${dateKey}%`);
    if(recruiter) terms.push(`%${recruiter}%`);
    // Procuramos evidências no histórico, sem alterar nada. Como os logs antigos
    // não guardam necessariamente o ID do recrutamento, combinamos número/data/nome.
    const logRows = await query(`
      SELECT id,action,details,created_at
      FROM logs
      WHERE action IN (
        'RECRUTAMENTO_CRIADO','RECRUTAMENTO_APROVADO','RECRUTAMENTO_EXCLUIDO',
        'PRESENCA_RECRUTADOR_ADICIONADA','RESULTADO_RECRUTAMENTO_REENVIADO_DISCORD',
        'RESULTADO_RECRUTAMENTO_LANCADO','RESULTADO_RECRUTAMENTO_APROVADO'
      )
      AND (
        ($1::int IS NOT NULL AND details ILIKE ('%Nº ' || $1::text || '%'))
        OR (details ILIKE ('%' || $2 || '%') AND details ILIKE ('%' || $3 || '%'))
      )
      ORDER BY created_at ASC,id ASC
      LIMIT 50
    `,[number,dateKey,recruiter]);
    out.push({
      id:Number(rec.id), official:Boolean(rec.official), current_number:number,
      date:dateKey, start_time:timeKey, end_time:String(rec.end_time).slice(0,8),
      status:rec.status, recruiter:recruiter || null, booking_id:rec.booking_id == null ? null : Number(rec.booking_id),
      conscripts:Number(rec.conscripts||0), approved:Number(rec.approved||0), rejected:Number(rec.rejected||0),
      first_participant_at:rec.first_participant_at, last_submitted_at:rec.last_submitted_at, last_reviewed_at:rec.last_reviewed_at,
      log_evidence:logRows.rows.map(x=>({id:Number(x.id),action:x.action,details:x.details,created_at:x.created_at}))
    });
  }
  return out;
}

async function printRecruitmentNumberDiagnostic(){
  try {
    const rows=await diagnosticRecruitmentNumbers();
    console.log('========== DIAGNÓSTICO DE NÚMEROS DOS RECRUTAMENTOS (SOMENTE LEITURA) ==========');
    for(const x of rows){
      console.log(`[RECRUTAMENTO DIAGNÓSTICO] id=${x.id} | oficial=${x.official?'SIM':'NÃO'} | atual=${x.current_number??'—'} | ${x.date} ${x.start_time}-${x.end_time} | recrutador=${x.recruiter||'—'} | conscritos=${x.conscripts} | aprovados=${x.approved} | reprovados=${x.rejected} | logs=${x.log_evidence.length}`);
      for(const l of x.log_evidence.slice(-10)) console.log(`  log#${l.id} ${l.created_at} ${l.action} :: ${l.details}`);
    }
    console.log('========== FIM DO DIAGNÓSTICO (NENHUMA ALTERAÇÃO FEITA) ==========' );
    return rows;
  } catch(e){
    console.error('[RECRUTAMENTO DIAGNÓSTICO] Falha:',e.message);
    return [];
  }
}

async function refreshRecruitmentCutoffs(){
  // Regra do CIP: a Nota de Corte de CADA recrutamento nasce da média
  // aritmética de TODAS as notas válidas daquele recrutamento.
  // A corte é normalizada para a faixa inteira inferior (ex.: média 10,29
  // => corte 10,00), mantendo a média exibida separadamente com 2 casas.
  // Isso garante que a corte não seja confundida com a média exibida.
  await query(`
    UPDATE cip_recruitments cr
    SET cutoff_score = stats.cutoff_score
    FROM (
      SELECT recruitment_id, FLOOR(AVG(score))::numeric AS cutoff_score
      FROM cip_recruitment_participants
      WHERE score IS NOT NULL
      GROUP BY recruitment_id
    ) stats
    WHERE cr.id=stats.recruitment_id
  `);
  await query(`
    UPDATE cip_recruitments cr
    SET cutoff_score=NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM cip_recruitment_participants p
      WHERE p.recruitment_id=cr.id AND p.score IS NOT NULL
    )
  `);
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
      avatar_data TEXT,
      must_change_password BOOLEAN NOT NULL DEFAULT FALSE
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recurrence_group_id TEXT
    );

    CREATE TABLE IF NOT EXISTS course_results (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      result_type TEXT NOT NULL DEFAULT 'principal',
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

    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS recurrence_group_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_bookings_recurrence_group ON bookings(recurrence_group_id);

    CREATE INDEX IF NOT EXISTS idx_course_results_booking ON course_results(booking_id);
    CREATE INDEX IF NOT EXISTS idx_course_result_participants_result ON course_result_participants(result_id);

    ALTER TABLE course_results ADD COLUMN IF NOT EXISTS result_type TEXT NOT NULL DEFAULT 'principal';
    ALTER TABLE course_results DROP CONSTRAINT IF EXISTS course_results_booking_id_key;
    UPDATE course_results SET result_type='principal' WHERE result_type IS NULL OR trim(result_type)='';
    CREATE UNIQUE INDEX IF NOT EXISTS ux_course_results_booking_type ON course_results(booking_id,result_type);

    ALTER TABLE course_result_participants ADD COLUMN IF NOT EXISTS participant_id TEXT;

    CREATE TABLE IF NOT EXISTS availability (
      id SERIAL PRIMARY KEY,
      instructor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS absences (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      city_id TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT absences_valid_period CHECK (end_date >= start_date)
    );
    CREATE INDEX IF NOT EXISTS idx_absences_dates ON absences(start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_absences_user ON absences(user_id, start_date DESC);

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

    CREATE TABLE IF NOT EXISTS password_reset_requests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      username TEXT NOT NULL,
      requester_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_requests_status ON password_reset_requests(status, created_at DESC);

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

    CREATE TABLE IF NOT EXISTS cip_system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cip_changelog_entries (
      id SERIAL PRIMARY KEY,
      version TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Sistema',
      description TEXT NOT NULL,
      discord_message_id TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cip_changelog_created ON cip_changelog_entries(created_at DESC);
    CREATE TABLE IF NOT EXISTS cip_discord_event_announcements (
      event_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      event_name TEXT,
      scheduled_start_time TIMESTAMPTZ,
      discord_message_id TEXT,
      announced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      test_only BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_cip_discord_event_announcements_date ON cip_discord_event_announcements(scheduled_start_time DESC);

    CREATE TABLE IF NOT EXISTS cip_discord_scheduled_events (
      booking_id INTEGER PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      channel_id TEXT,
      event_name TEXT NOT NULL,
      scheduled_start_time TIMESTAMPTZ NOT NULL,
      scheduled_end_time TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cip_discord_scheduled_events_start ON cip_discord_scheduled_events(scheduled_start_time);

    ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preference TEXT NOT NULL DEFAULT 'all';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS twitch_channel TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS twitch_user_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS twitch_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS cip_twitch_eventsub_subscriptions (
      broadcaster_user_id TEXT PRIMARY KEY,
      twitch_login TEXT NOT NULL DEFAULT '',
      twitch_display_name TEXT NOT NULL DEFAULT '',
      subscription_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cip_twitch_eventsub_messages (
      message_id TEXT PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_users_twitch_user_id ON users(twitch_user_id);
    CREATE INDEX IF NOT EXISTS idx_users_twitch_enabled ON users(twitch_enabled);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username));
    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
    CREATE INDEX IF NOT EXISTS idx_bookings_instructor ON bookings(instructor_id);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
  `);


  /* ===== RECRUTAMENTOS — tabelas próprias e isoladas do banco do CIP ===== */
  await query(`CREATE TABLE IF NOT EXISTS cip_recruitments (
    id SERIAL PRIMARY KEY,
    recruitment_number INTEGER UNIQUE,
    date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    cutoff_score NUMERIC(5,2),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','completed','cancelled')),
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`ALTER TABLE cip_recruitments ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE cip_recruitments ADD COLUMN IF NOT EXISTS official BOOLEAN NOT NULL DEFAULT TRUE`);
  await query(`ALTER TABLE cip_recruitments ADD COLUMN IF NOT EXISTS recruiter_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE cip_recruitments ADD COLUMN IF NOT EXISTS authorized_by TEXT`);
  await query(`ALTER TABLE cip_recruitments ADD COLUMN IF NOT EXISTS discord_agenda_message_id TEXT`);
  // Registros existentes vieram da Agenda e, portanto, são oficiais.
  await query(`UPDATE cip_recruitments SET official=TRUE WHERE official IS NULL`);
  await query(`UPDATE cip_recruitments cr SET recruiter_id=b.instructor_id FROM bookings b WHERE cr.booking_id=b.id AND cr.recruiter_id IS NULL`);

  await query(`CREATE TABLE IF NOT EXISTS cip_recruitment_presence (
    id SERIAL PRIMARY KEY,
    recruitment_id INTEGER NOT NULL REFERENCES cip_recruitments(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    present BOOLEAN NOT NULL DEFAULT TRUE,
    marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(recruitment_id,user_id)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS cip_recruitment_participants (
    id SERIAL PRIMARY KEY,
    recruitment_id INTEGER NOT NULL REFERENCES cip_recruitments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    city_id TEXT NOT NULL,
    answers JSONB,
    score NUMERIC(5,2),
    proof_completed BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','approved','rejected')),
    started_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    reviewed_at TIMESTAMPTZ,
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    review_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(recruitment_id,city_id)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS cip_recruitment_participant_edits (
    id SERIAL PRIMARY KEY,
    participant_id INTEGER NOT NULL REFERENCES cip_recruitment_participants(id) ON DELETE CASCADE,
    recruitment_id INTEGER NOT NULL REFERENCES cip_recruitments(id) ON DELETE CASCADE,
    old_name TEXT NOT NULL,
    old_city_id TEXT NOT NULL,
    new_name TEXT NOT NULL,
    new_city_id TEXT NOT NULL,
    changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS cip_recruitment_reminders (
    id SERIAL PRIMARY KEY,
    recruitment_id INTEGER NOT NULL REFERENCES cip_recruitments(id) ON DELETE CASCADE,
    reminder_type TEXT NOT NULL DEFAULT '24h',
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS cip_recruitment_result_notifications (
    id SERIAL PRIMARY KEY,
    recruitment_id INTEGER NOT NULL REFERENCES cip_recruitments(id) ON DELETE CASCADE,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(recruitment_id)
  )`);
  await query(`ALTER TABLE cip_recruitment_reminders ADD COLUMN IF NOT EXISTS reminder_type TEXT NOT NULL DEFAULT '24h'`);
  await query(`ALTER TABLE cip_recruitment_reminders ADD COLUMN IF NOT EXISTS message_id TEXT`);
  // AVISOS SEMANAIS DOS INSTRUTORES — uma vez por domingo, com idempotência por semana.
  await query(`CREATE TABLE IF NOT EXISTS cip_instruction_weekly_notices (
    week_key TEXT PRIMARY KEY,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    message_id TEXT,
    sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  )`);
  // AVISOS SEMANAIS DOS RECRUTADORES — uma vez por domingo, com idempotência por semana.
  await query(`CREATE TABLE IF NOT EXISTS cip_recruitment_weekly_notices (
    week_key TEXT PRIMARY KEY,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    message_id TEXT,
    sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  )`);
  await query(`ALTER TABLE cip_recruitment_reminders DROP CONSTRAINT IF EXISTS cip_recruitment_reminders_recruitment_id_key`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_cip_recruitment_reminders_type ON cip_recruitment_reminders(recruitment_id,reminder_type)`);
  await query(`ALTER TABLE cip_recruitment_participants ADD COLUMN IF NOT EXISTS proof_completed BOOLEAN NOT NULL DEFAULT FALSE`);


  // ===== CORREÇÃO CIRÚRGICA FINAL — 05/09/2026 Nº 15 -> Nº 6 =====
  // O usuário removeu manualmente os registros vazios que ocupavam os Nº 6 e 7.
  // Portanto, agora corrigimos SOMENTE o recrutamento de 05/09/2026 16:00 que
  // ainda está como Nº 15, desde que o Nº 6 esteja livre. Nenhum participante,
  // resultado, presença ou outro recrutamento é alterado.
  try {
    const fixKey = 'corrigir-recrutamento-05-09-2026-15-para-6-v3';
    await query(`CREATE TABLE IF NOT EXISTS cip_recruitment_number_fixes (
      fix_key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const alreadyFixed = await query(`SELECT 1 FROM cip_recruitment_number_fixes WHERE fix_key=$1 LIMIT 1`, [fixKey]);
    if (!alreadyFixed.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [482194]);
        const target = await client.query(`
          SELECT id, recruitment_number
          FROM cip_recruitments
          WHERE official=TRUE
            AND recruitment_number=15
            AND date=DATE '2026-09-05'
            AND start_time=TIME '16:00'
            AND end_time=TIME '18:00'
          FOR UPDATE
        `);
        const six = await client.query(`
          SELECT id FROM cip_recruitments
          WHERE official=TRUE AND recruitment_number=6
          FOR UPDATE
        `);
        if (target.rowCount === 1 && six.rowCount === 0) {
          await client.query(`UPDATE cip_recruitments SET recruitment_number=6 WHERE id=$1`, [target.rows[0].id]);
          await client.query(`INSERT INTO cip_recruitment_number_fixes(fix_key) VALUES($1)`, [fixKey]);
          console.log(`[RECRUTAMENTO NUMERAÇÃO] CORREÇÃO APLICADA: id=${target.rows[0].id} Nº 15 -> Nº 6`);
        } else if (target.rowCount === 1 && six.rowCount > 0) {
          console.warn('[RECRUTAMENTO NUMERAÇÃO] 15 -> 6 NÃO aplicada: o Nº 6 ainda existe. Nenhum dado foi alterado.');
        }
        await client.query('COMMIT');
      } catch(e) {
        try { await client.query('ROLLBACK'); } catch(_) {}
        throw e;
      } finally { client.release(); }
    }
  } catch(e) {
    console.error('[RECRUTAMENTO NUMERAÇÃO] Falha na correção 15 -> 6:', e.message);
  }
  // ===== REESTRUTURAÇÃO DEFINITIVA DA NUMERAÇÃO OFICIAL — SET/2026 =====
  // A sequência oficial terminou no Nº 6 em 05/09/2026. Os recrutamentos
  // seguintes devem ocupar 7, 8, 9... em ordem cronológica. Esta correção é
  // executada uma única vez e SOMENTE nos registros oficiais abaixo.
  // Participantes, provas, presenças e resultados não são alterados.
  try {
    const fixKey = 'reestruturar-numeracao-oficial-setembro-2026-v1';
    await query(`CREATE TABLE IF NOT EXISTS cip_recruitment_number_fixes (
      fix_key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const alreadyFixed = await query(`SELECT 1 FROM cip_recruitment_number_fixes WHERE fix_key=$1 LIMIT 1`, [fixKey]);
    if (!alreadyFixed.rowCount) {
      const mapping = [
        { date:'2026-09-05', start:'16:00', end:'18:00', number:6 },
        { date:'2026-09-08', start:'20:00', end:'22:00', number:7 },
        { date:'2026-09-12', start:'16:00', end:'18:00', number:8 },
        { date:'2026-09-15', start:'20:00', end:'22:00', number:9 },
        { date:'2026-09-19', start:'16:00', end:'18:00', number:10 },
        { date:'2026-09-22', start:'20:00', end:'22:00', number:11 },
        { date:'2026-09-29', start:'20:00', end:'22:00', number:12 }
      ];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [482195]);

        const targets=[];
        for (const m of mapping) {
          const r=await client.query(`
            SELECT id,recruitment_number,booking_id
            FROM cip_recruitments
            WHERE official=TRUE
              AND date=$1::date
              AND start_time=$2::time
              AND end_time=$3::time
              AND status<>'cancelled'
          `,[m.date,m.start,m.end]);
          if(r.rowCount!==1) throw new Error(`Numeração segura abortada: esperado 1 recrutamento oficial em ${m.date} ${m.start}-${m.end}, encontrado ${r.rowCount}.`);
          targets.push({...m,row:r.rows[0]});
        }

        // Primeiro tira todos os números da faixa para não colidir com a UNIQUE.
        for (let i=0;i<targets.length;i++) {
          await client.query(`UPDATE cip_recruitments SET recruitment_number=$1 WHERE id=$2`,[-900000-i,targets[i].row.id]);
        }
        // Depois aplica a sequência oficial definitiva.
        for (const t of targets) {
          await client.query(`UPDATE cip_recruitments SET recruitment_number=$1 WHERE id=$2`,[t.number,t.row.id]);
          // A Agenda Geral usa o vínculo booking_id. Se o título salvo era apenas
          // o número antigo/genérico, atualizamos para refletir o mesmo número.
          if(t.row.booking_id){
            await client.query(`
              UPDATE bookings
              SET course=$1
              WHERE id=$2
                AND (course IS NULL OR TRIM(course)='' OR course ~* '^Recrutamento(\\s+Nº)?\\s+\\d+$' OR LOWER(TRIM(course))='recrutamento')
            `,[`Recrutamento Nº ${t.number}`,t.row.booking_id]);
          }
        }
        await client.query(`INSERT INTO cip_recruitment_number_fixes(fix_key) VALUES($1)`,[fixKey]);
        await client.query('COMMIT');
        console.log('[RECRUTAMENTO NUMERAÇÃO] Sequência oficial de setembro reestruturada: Nº 6 a Nº 12.');
      } catch(e) {
        try { await client.query('ROLLBACK'); } catch(_) {}
        throw e;
      } finally { client.release(); }
    }
  } catch(e) {
    console.error('[RECRUTAMENTO NUMERAÇÃO] Falha na reestruturação de setembro:',e.message);
  }

  await query(`UPDATE cip_recruitment_participants SET proof_completed=TRUE WHERE proof_completed=FALSE AND answers IS NOT NULL AND score IS NOT NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cip_recruitments_date ON cip_recruitments(date)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cip_recruitment_participants_recruitment ON cip_recruitment_participants(recruitment_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cip_recruitment_presence_user ON cip_recruitment_presence(user_id)`);
  // MATERIAL DE APOIO DOS RECRUTAMENTOS — estrutura isolada do módulo de Instrutores.
  await query(`CREATE TABLE IF NOT EXISTS cip_recruitment_bank_movements (
    id SERIAL PRIMARY KEY,
    movement_type TEXT NOT NULL CHECK (movement_type IN ('deposit','withdrawal')),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    description TEXT NOT NULL DEFAULT '',
    receipt_url TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cip_recruitment_bank_created_at ON cip_recruitment_bank_movements(created_at DESC)`);

  await query(`CREATE TABLE IF NOT EXISTS discord_result_outbox (
    id SERIAL PRIMARY KEY,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    result_type TEXT NOT NULL DEFAULT 'principal',
    content TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_discord_result_outbox_pending ON discord_result_outbox(status,next_attempt_at)`);

  await query(`CREATE TABLE IF NOT EXISTS cip_recruitment_materials (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🔗',
    material_order INTEGER NOT NULL DEFAULT 1,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  )`);
  await query(`ALTER TABLE cip_recruitment_materials ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Links úteis'`);
  const recruitmentMaterialsCount = await query(`SELECT COUNT(*)::int AS count FROM cip_recruitment_materials`);
  if (Number(recruitmentMaterialsCount.rows[0]?.count || 0) === 0) {
    await query(`INSERT INTO cip_recruitment_materials(title,description,url,icon,material_order) VALUES
      ($1,$2,$3,$4,1),($5,$6,$7,$8,2),($9,$10,$11,$12,3),($13,$14,$15,$16,4),($17,$18,$19,$20,5)`, [
      'REGISTRO GERAL DOS RECRUTADORES','Controle geral da equipe de recrutadores.','https://docs.google.com/spreadsheets/d/15PQHZCHhFmbLo_7heR5vL_PP1jAMd0_/edit?gid=1017027356#gid=1017027356','👥',
      'REGISTRO DE NOTAS DO RECRUTAMENTO','Registro das notas e resultados dos recrutamentos.','https://docs.google.com/spreadsheets/d/16Uzr?CsboGO0LrPK_ubKrzesOWsmU-mS/edit?gid=1275103683#gid=1275103683','📊',
      'FORMULÁRIO DE INTERESSE A RECRUTADOR','Formulário para ingresso/interesse na equipe de recrutadores.','https://docs.google.com/forms/d/1fojYn7luR4TBTV3AdwO2SPPeekTHlfRCqkh62ELj/edit','📝',
      'APOIO AOS INSTRUTORES','Material de apoio compartilhado com a equipe.','https://docs.google.com/document/d/1AjJ2gAL_cL_j2jL1OtW7KTfpdlu6SdcMuKCYbYnE7yX0/edit?usp=sharing','📘',
      'PLANILHA DE AVALIAÇÃO','Planilha de avaliação utilizada no recrutamento.','https://docs.google.com/spreadsheets/d/1XleF25ORXR3BufGmM9T-x4amgCPuCKKbWPR3umRUk0/edit?gid=2081221307#gid=2081221307','📋'
    ]);
  }


  // Integração retrocompatível: os recrutamentos que já foram marcados na
  // Agenda de Marcações (tabela bookings) também precisam aparecer no módulo
  // Recrutamentos. Não movemos nem apagamos a marcação original. Apenas
  // criamos um espelho interno ligado pelo booking_id.
  await query(`ALTER TABLE cip_recruitments ADD COLUMN IF NOT EXISTS booking_id INTEGER`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_cip_recruitments_booking_id ON cip_recruitments(booking_id) WHERE booking_id IS NOT NULL`);

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
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS recruitment_internal_role TEXT NOT NULL DEFAULT 'avaliado'`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS instruction_internal_role TEXT NOT NULL DEFAULT 'instrutor'`);
  await query(`UPDATE users SET recruitment_internal_role='coordenador' WHERE role='coordenador' AND COALESCE(TRIM(recruitment_internal_role),'') IN ('','avaliado')`);
  await query(`UPDATE users SET recruitment_internal_role='avaliado' WHERE recruitment_internal_role IS NULL OR TRIM(recruitment_internal_role)=''`);
  await query(`UPDATE users SET instruction_internal_role='instrutor' WHERE instruction_internal_role IS NULL OR TRIM(instruction_internal_role)=''`);
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

  // A Agenda de Marcações e os Recrutamentos são módulos independentes.
  // Recrutamentos FORA DA AGENDA não são copiados para bookings e nunca
  // participam da sequência de numeração oficial. Recrutamentos oficiais
  // criados pelo módulo podem continuar vinculados a uma marcação criada
  // explicitamente no fluxo de criação. Não fazemos mais sincronização
  // automática de bookings -> cip_recruitments no startup.

  // ===== PRESENÇA HISTÓRICA — RECRUTAMENTO DE 01/09/2026 =====
  // Registro solicitado pelo administrador. Executado uma única vez por
  // recrutamento/usuário para não sobrescrever alterações futuras de presença.
  try {
    await query(`CREATE TABLE IF NOT EXISTS cip_recruitment_presence_seed (
      recruitment_id INTEGER NOT NULL REFERENCES cip_recruitments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seeded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (recruitment_id,user_id)
    )`);

    const yesterday = await query(`
      SELECT id
      FROM cip_recruitments
      WHERE date = DATE '2026-09-01' AND status <> 'cancelled'
      ORDER BY start_time DESC NULLS LAST, id DESC
      LIMIT 1
    `);

    if (yesterday.rowCount === 1) {
      const recruitmentId = yesterday.rows[0].id;
      const names = ['Leonardo','Agatha','Gustav','Gabriel','Malu','Boris'];

      for (const firstName of names) {
        const person = await query(`
          SELECT id
          FROM users
          WHERE LOWER(TRIM(SPLIT_PART(name,' ',1))) = LOWER($1)
            AND role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','recrutador','instrutor_recrutador')
          ORDER BY id
          LIMIT 1
        `, [firstName]);

        if (person.rowCount === 1) {
          const userId = person.rows[0].id;
          const seeded = await query(`
            INSERT INTO cip_recruitment_presence_seed(recruitment_id,user_id)
            VALUES($1,$2)
            ON CONFLICT DO NOTHING
            RETURNING recruitment_id
          `, [recruitmentId,userId]);

          if (seeded.rowCount === 1) {
            await query(`
              INSERT INTO cip_recruitment_presence(recruitment_id,user_id,present)
              VALUES($1,$2,TRUE)
              ON CONFLICT(recruitment_id,user_id)
              DO UPDATE SET present=TRUE, marked_at=NOW()
            `, [recruitmentId,userId]);
          }
        } else {
          console.warn(`Presença histórica: usuário não localizado para '${firstName}'.`);
        }
      }
      console.log('Presença histórica registrada para Leonardo, Agatha, Gustav, Gabriel, Malu e Boris no recrutamento de 01/09/2026.');
    }
  } catch (presenceSeedError) {
    console.error('Importação de presença histórica:', presenceSeedError.message);
  }

  // IMPORTANTE: participantes de recrutamento NAO sao importados automaticamente.
  // Um conscrito so entra quando for inserido explicitamente pela tela/API daquele recrutamento.
  // Isso impede heranca de nomes, notas ou status de outro recrutamento.

  // ===== IMPORTAÇÃO HISTÓRICA — RECRUTAMENTOS 1 A 4 =====
  // Histórico oficial informado pelo administrador. Esta rotina é idempotente:
  // nunca cria usuários históricos; usa somente usuários que já existem no
  // banco e preserva os IDs reais deles. Os recrutamentos 1–4 são oficiais,
  // têm Leonardo Cooper Ferreira como responsável e ficam vinculados à Agenda.
  try {
    await query(`CREATE TABLE IF NOT EXISTS cip_recruitment_history_seed (
      recruitment_number INTEGER PRIMARY KEY,
      seeded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    const historyRecruiter = await query(`
      SELECT id, name
      FROM users
      WHERE LOWER(TRIM(name)) = LOWER('Leonardo Cooper Ferreira')
        AND role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','recrutador','instrutor_recrutador')
        AND status='approved'
      ORDER BY id
      LIMIT 1
    `);

    if (historyRecruiter.rowCount === 1) {
      const recruiterId = historyRecruiter.rows[0].id;
      const creatorId = recruiterId;
      const historical = [
        {
          number: 1, date: '2026-08-13', cutoff: 7, start: '20:00', end: '22:00',
          results: [
            ['Neves Kiew','1368',9.14,'approved'],
            ['Matteo Tomahawk','1528',14.50,'approved'],
            ['Kendra Kurtz','1171',11.67,'approved']
          ],
          presence: ['Lincoln Dyak','Leonardo Cooper Ferreira','Gabriel Freitas']
        },
        {
          number: 2, date: '2026-08-18', cutoff: 9, start: '20:00', end: '22:00',
          results: [
            ['Vicent Silva','1141',6.69,'rejected'],
            ['baiarzinho dosete','1575',2.25,'rejected'],
            ['Vitor Darmule','905',11.82,'approved'],
            ['Jordan Faltiz','1898',12.26,'approved'],
            ['Matteo Neves','825',7.26,'rejected'],
            ['Gabriel Locatelli','1916',8.99,'approved'],
            ['Joseph Camolle','1922',14.50,'approved'],
            ['Oito Kitty','1853',12.29,'approved']
          ],
          presence: ['Leonardo Cooper Ferreira','Malu Adams','Gustav Ballard TK','Boris Hammer','Gabriel Freitas']
        },
        {
          number: 3, date: '2026-08-22', cutoff: 9, start: '20:00', end: '22:00',
          results: [
            ['Luke Koenigsgeg','1697',13.17,'approved'],
            ['Luiz Silva','909',14.66,'approved'],
            ['Antonio Montana','384',3.75,'rejected'],
            ['Malte Prizak','2054',9.99,'approved'],
            ['gggg ggggg','2121',8.31,'rejected']
          ],
          presence: ['Lincoln Dyak','Boris Hammer','Gabriel Freitas','Salatiel Sagaz']
        },
        {
          number: 4, date: '2026-08-25', cutoff: 12, start: '20:00', end: '22:00',
          results: [
            ['Guilherme Blackbelt','2364',13.04,'approved'],
            ['Flash Draft','1846',12.71,'approved']
          ],
          presence: ['Malu Adams','Gustav Ballard TK','Gabriel Freitas']
        }
      ];

      for (const h of historical) {
        let recruitment = await query(`
          SELECT id, booking_id
          FROM cip_recruitments
          WHERE recruitment_number=$1 AND official=TRUE
          LIMIT 1
        `, [h.number]);

        // Se a numeração ainda não existe, procura pela data para evitar duplicação
        // caso uma versão anterior tenha criado o histórico sem número.
        if (!recruitment.rowCount) {
          recruitment = await query(`
            SELECT id, booking_id
            FROM cip_recruitments
            WHERE date=$1 AND official=TRUE AND status<>'cancelled'
            ORDER BY id
            LIMIT 1
          `, [h.date]);
        }

        let recruitmentId;
        let bookingId = recruitment.rowCount ? recruitment.rows[0].booking_id : null;

        if (recruitment.rowCount) {
          recruitmentId = recruitment.rows[0].id;
          await query(`
            UPDATE cip_recruitments
            SET recruitment_number=$1, date=$2, start_time=$3, end_time=$4,
                status='completed', official=TRUE, recruiter_id=$5, cutoff_score=$6,
                notes=CASE WHEN notes IS NULL OR notes='' THEN 'Histórico importado.' ELSE notes END
            WHERE id=$7
          `, [h.number,h.date,h.start,h.end,recruiterId,h.cutoff,recruitmentId]);
        } else {
          const created = await query(`
            INSERT INTO cip_recruitments
              (recruitment_number,date,start_time,end_time,notes,cutoff_score,status,created_by,official,recruiter_id)
            VALUES($1,$2,$3,$4,'Histórico importado.',$5,'completed',$6,TRUE,$7)
            RETURNING id
          `, [h.number,h.date,h.start,h.end,h.cutoff,creatorId,recruiterId]);
          recruitmentId = created.rows[0].id;
        }

        // Garante o espelho histórico na Agenda Geral dos Instrutores.
        if (bookingId) {
          await query(`
            UPDATE bookings
            SET instructor_id=$1,date=$2,start_time=$3,end_time=$4,
                course='Recrutamento',status='completed'
            WHERE id=$5
          `, [recruiterId,h.date,h.start,h.end,bookingId]);
        } else {
          const existingBooking = await query(`
            SELECT id FROM bookings
            WHERE date=$1 AND start_time=$2 AND instructor_id=$3
              AND status<>'cancelled'
            ORDER BY id LIMIT 1
          `, [h.date,h.start,recruiterId]);
          if (existingBooking.rowCount) {
            bookingId = existingBooking.rows[0].id;
            await query(`UPDATE bookings SET end_time=$1,course='Recrutamento',status='completed' WHERE id=$2`, [h.end,bookingId]);
          } else {
            const b = await query(`
              INSERT INTO bookings(instructor_id,date,start_time,end_time,notes,course,status,created_by)
              VALUES($1,$2,$3,$4,'Histórico importado.','Recrutamento','completed',$5)
              RETURNING id
            `, [recruiterId,h.date,h.start,h.end,creatorId]);
            bookingId = b.rows[0].id;
          }
          await query(`UPDATE cip_recruitments SET booking_id=$1 WHERE id=$2`, [bookingId,recruitmentId]);
        }

        // Resultados históricos: atualiza se já existir, cria caso contrário.
        for (const [name,cityId,score,status] of h.results) {
          const existing = await query(`
            SELECT id FROM cip_recruitment_participants
            WHERE recruitment_id=$1 AND city_id=$2 LIMIT 1
          `, [recruitmentId,cityId]);
          if (existing.rowCount) {
            await query(`
              UPDATE cip_recruitment_participants
              SET name=$1,score=$2,status=$3,proof_completed=TRUE,
                  answers=COALESCE(answers,'{}'::jsonb),submitted_at=COALESCE(submitted_at,NOW())
              WHERE id=$4
            `, [name,score,status,existing.rows[0].id]);
          } else {
            await query(`
              INSERT INTO cip_recruitment_participants
                (recruitment_id,name,city_id,answers,score,proof_completed,status,submitted_at)
              VALUES($1,$2,$3,'{}'::jsonb,$4,TRUE,$5,NOW())
            `, [recruitmentId,name,cityId,score,status]);
          }
        }

        // Presença: somente pessoas que já estão cadastradas e aprovadas no sistema.
        await query(`CREATE TABLE IF NOT EXISTS cip_recruitment_presence_seed (
          recruitment_id INTEGER NOT NULL REFERENCES cip_recruitments(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          seeded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (recruitment_id,user_id)
        )`);
        for (const participantName of h.presence) {
          const person = await query(`
            SELECT id FROM users
            WHERE LOWER(TRIM(name))=LOWER(TRIM($1))
              AND role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','recrutador','instrutor_recrutador')
              AND status='approved'
            ORDER BY id LIMIT 1
          `, [participantName]);
          if (person.rowCount === 1) {
            const userId = person.rows[0].id;
            const seeded = await query(`
              INSERT INTO cip_recruitment_presence_seed(recruitment_id,user_id)
              VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING recruitment_id
            `, [recruitmentId,userId]);
            if (seeded.rowCount === 1) {
              await query(`
                INSERT INTO cip_recruitment_presence(recruitment_id,user_id,present)
                VALUES($1,$2,TRUE)
                ON CONFLICT(recruitment_id,user_id)
                DO UPDATE SET present=TRUE,marked_at=NOW()
              `, [recruitmentId,userId]);
            }
          } else {
            console.warn(`Histórico ${h.number}: usuário não cadastrado/aprovado ignorado: ${participantName}`);
          }
        }

        await query(`INSERT INTO cip_recruitment_history_seed(recruitment_number) VALUES($1) ON CONFLICT DO NOTHING`, [h.number]);
      }

      // Completa somente números oficiais que estejam ausentes.
        console.log('Histórico dos Recrutamentos 1 a 4 importado/validado com sucesso.');
    } else {
      console.warn('Histórico 1–4 não importado: Leonardo Cooper Ferreira não foi localizado como usuário aprovado do módulo.');
    }
  } catch (historyError) {
    console.error('Importação histórica dos Recrutamentos 1 a 4:', historyError.message);
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

const INSTRUCTION_COORDINATOR_ROLES = ["coordenador", "coordenador_instrucao"];
const RECRUITMENT_COORDINATOR_ROLES = ["coordenador", "coordenador_instrucao", "coordenador_recrutamentos"];
const INSTRUCTION_INTERNAL_ROLES = ["coordenador", "supervisor", "instrutor_chefe", "instrutor_senior", "instrutor"];
const INSTRUCTION_MANAGER_INTERNAL_ROLES = ["coordenador", "supervisor", "instrutor_chefe"];
function canApproveInstructionEmbed(role, internalRole){
  const r=String(role||"").toLowerCase();
  return isAdminRole(r) || INSTRUCTION_COORDINATOR_ROLES.includes(r) || r === "coordenador_recrutamentos" || ["coordenador","supervisor","instrutor_chefe"].includes(normalizeInstructionInternalRole(internalRole));
}
function normalizeInstructionInternalRole(role){
  const raw=String(role||"").trim().toLowerCase();
  const aliases={
    "coordenador":"coordenador",
    "supervisor":"supervisor",
    "instrutor chefe":"instrutor_chefe",
    "instrutor-chefe":"instrutor_chefe",
    "instrutor_chefe":"instrutor_chefe",
    "instrutor senior":"instrutor_senior",
    "instrutor sênior":"instrutor_senior",
    "instrutor-senior":"instrutor_senior",
    "instrutor_senior":"instrutor_senior",
    "instrutor":"instrutor"
  };
  return aliases[raw]||raw;
}
function isInstructionInternalManager(role){ return INSTRUCTION_MANAGER_INTERNAL_ROLES.includes(normalizeInstructionInternalRole(role)); }
// Acesso de navegação cruzada entre os dois módulos:
// Coordenador de Instrução também pode abrir Recrutamentos, e
// Coordenador de Recrutamentos também pode abrir Instrutores.
function hasInstructionModuleAccessRole(role, internalRole){
  const r=String(role||"").toLowerCase();
  return isAdminRole(r) || INSTRUCTION_COORDINATOR_ROLES.includes(r) || r === "coordenador_recrutamentos" || r === "instrutor_recrutador" || INSTRUCTION_INTERNAL_ROLES.includes(normalizeInstructionInternalRole(internalRole));
}
function hasRecruitmentModuleAccessRole(role){
  const r=String(role||"").toLowerCase();
  return isAdminRole(r) || RECRUITMENT_COORDINATOR_ROLES.includes(r) || r === "coordenador_instrucao" || ["recrutador","instrutor_recrutador"].includes(r);
}
const ALL_COORDINATOR_ROLES = ["coordenador", "coordenador_instrucao", "coordenador_recrutamentos"];
function isAdminRole(role){ return String(role||"").toLowerCase()==="admin"; }
function isInstructionCoordinatorRole(role){ return isAdminRole(role) || INSTRUCTION_COORDINATOR_ROLES.includes(String(role||"").toLowerCase()) || String(role||"").toLowerCase()==="coordenador_recrutamentos"; }
function isRecruitmentCoordinatorRole(role){ return isAdminRole(role) || RECRUITMENT_COORDINATOR_ROLES.includes(String(role||"").toLowerCase()); }
function isAnyCoordinatorRole(role){ return isAdminRole(role) || ALL_COORDINATOR_ROLES.includes(String(role||"").toLowerCase()); }
function canManageInstructionTeam(user){
  return !!user && (isInstructionCoordinatorRole(user.role) || isInstructionInternalManager(user.instruction_internal_role));
}

async function coordinator(req, res, next) {
  try {
    // Sempre consulta o cargo atual no banco. Isso evita que um JWT antigo
    // continue tratando um coordenador como instrutor/admin após alteração de cargo.
    const result = await query(
      "SELECT role,status,instruction_internal_role FROM users WHERE id=$1",
      [req.user.id]
    );
    const currentUser = result.rows[0];

    if (!currentUser || currentUser.status !== "approved") {
      return res.status(403).json({ error: "Usuário sem acesso aprovado." });
    }

    req.user.role = currentUser.role;

    const path = String(req.path || "");
    const recruitmentRoute = path.startsWith("/api/recruitments");
    const instructionRoute = path.startsWith("/api/instructors") || path.startsWith("/api/bookings") || path.startsWith("/api/course-results");
    const allowed = recruitmentRoute
      ? hasRecruitmentModuleAccessRole(currentUser.role)
      : instructionRoute
        ? hasInstructionModuleAccessRole(currentUser.role, currentUser.instruction_internal_role)
        : (isAnyCoordinatorRole(currentUser.role) || canManageInstructionTeam(currentUser));
    if (!allowed) {
      return res.status(403).json({ error: "Acesso restrito ao módulo correspondente ao seu cargo." });
    }

    next();
  } catch (e) {
    console.error("Falha ao validar permissão de coordenador:", e);
    res.status(500).json({ error: "Não foi possível validar a permissão." });
  }
}

function normalizeTwitchChannel(value='') {
  let raw=String(value||'').trim();
  if(!raw) return '';
  raw=raw.replace(/^https?:\/\/(www\.)?twitch\.tv\//i,'').split(/[?#\s/]/)[0].trim();
  return raw.toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,60);
}
function getTwitchConfig(){return {clientId:String(process.env.TWITCH_CLIENT_ID||'').trim(),clientSecret:String(process.env.TWITCH_CLIENT_SECRET||'').trim(),callbackUrl:String(process.env.TWITCH_EVENTSUB_CALLBACK_URL||'').trim(),secret:String(process.env.TWITCH_EVENTSUB_SECRET||'').trim()};}
let twitchAppTokenCache={token:'',expiresAt:0};
async function getTwitchAppToken(){
  const cfg=getTwitchConfig();
  if(!cfg.clientId||!cfg.clientSecret) throw new Error('TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET não estão configurados no Render.');
  if(twitchAppTokenCache.token&&twitchAppTokenCache.expiresAt>Date.now()+60000)return twitchAppTokenCache.token;
  const rr=await fetch(`https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(cfg.clientId)}&client_secret=${encodeURIComponent(cfg.clientSecret)}&grant_type=client_credentials`,{method:'POST'});
  const body=await rr.text(); if(!rr.ok)throw new Error(`Twitch OAuth HTTP ${rr.status}: ${body.slice(0,300)}`);
  const d=JSON.parse(body); twitchAppTokenCache={token:String(d.access_token||''),expiresAt:Date.now()+Number(d.expires_in||0)*1000};
  if(!twitchAppTokenCache.token)throw new Error('Twitch não retornou App Access Token.'); return twitchAppTokenCache.token;
}
async function twitchApi(path,options={}){const cfg=getTwitchConfig(),token=await getTwitchAppToken();const rr=await fetch(`https://api.twitch.tv/helix${path}`,{...options,headers:{'Client-Id':cfg.clientId,'Authorization':`Bearer ${token}`,...(options.headers||{})}});const text=await rr.text();let d={};try{d=text?JSON.parse(text):{};}catch{}if(!rr.ok)throw new Error(`Twitch API HTTP ${rr.status}: ${d.message||text.slice(0,300)}`);return d;}
async function resolveTwitchUser(channel){const login=normalizeTwitchChannel(channel);if(!login)return null;const d=await twitchApi(`/users?login=${encodeURIComponent(login)}`);const u=Array.isArray(d.data)?d.data[0]:null;if(!u)throw new Error(`Canal da Twitch não encontrado: ${login}`);return u;}
async function ensureTwitchSubscription(broadcaster){
  const cfg=getTwitchConfig(); if(!cfg.callbackUrl)throw new Error('TWITCH_EVENTSUB_CALLBACK_URL não está configurado no Render.'); if(!cfg.secret||cfg.secret.length<10||cfg.secret.length>100)throw new Error('TWITCH_EVENTSUB_SECRET deve ter entre 10 e 100 caracteres.');
  const token=await getTwitchAppToken(); const existing=await twitchApi('/eventsub/subscriptions');
  const same=(existing.data||[]).find(x=>String(x.type)==='stream.online'&&String(x.condition?.broadcaster_user_id)===String(broadcaster.id)&&String(x.transport?.callback||'')===cfg.callbackUrl&&['enabled','webhook_callback_verification_pending'].includes(String(x.status||'')));
  if(same){await query(`INSERT INTO cip_twitch_eventsub_subscriptions(broadcaster_user_id,twitch_login,twitch_display_name,subscription_id,status,updated_at) VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT(broadcaster_user_id) DO UPDATE SET twitch_login=EXCLUDED.twitch_login,twitch_display_name=EXCLUDED.twitch_display_name,subscription_id=EXCLUDED.subscription_id,status=EXCLUDED.status,updated_at=NOW()`,[String(broadcaster.id),String(broadcaster.login||''),String(broadcaster.display_name||broadcaster.login||''),String(same.id||''),String(same.status||'')]);return {ok:true,subscriptionId:String(same.id||''),status:String(same.status||'')};}
  const rr=await fetch('https://api.twitch.tv/helix/eventsub/subscriptions',{method:'POST',headers:{'Client-Id':cfg.clientId,'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({type:'stream.online',version:'1',condition:{broadcaster_user_id:String(broadcaster.id)},transport:{method:'webhook',callback:cfg.callbackUrl,secret:cfg.secret}})});const text=await rr.text();let d={};try{d=text?JSON.parse(text):{};}catch{}if(!rr.ok)throw new Error(`Twitch EventSub HTTP ${rr.status}: ${d.message||text.slice(0,400)}`);const sub=d.data?.[0];await query(`INSERT INTO cip_twitch_eventsub_subscriptions(broadcaster_user_id,twitch_login,twitch_display_name,subscription_id,status,updated_at) VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT(broadcaster_user_id) DO UPDATE SET twitch_login=EXCLUDED.twitch_login,twitch_display_name=EXCLUDED.twitch_display_name,subscription_id=EXCLUDED.subscription_id,status=EXCLUDED.status,updated_at=NOW()`,[String(broadcaster.id),String(broadcaster.login||''),String(broadcaster.display_name||broadcaster.login||''),String(sub?.id||''),String(sub?.status||'pending')]);return {ok:true,subscriptionId:String(sub?.id||''),status:String(sub?.status||'pending')};
}
async function syncTwitchSubscriptionForUser(userId,channel,enabled){const normalized=normalizeTwitchChannel(channel);if(!enabled){await query(`UPDATE users SET twitch_channel=$1,twitch_user_id=NULL,twitch_enabled=FALSE WHERE id=$2`,[normalized||null,userId]);return {ok:true,enabled:false};}if(!normalized)throw new Error('Informe seu canal da Twitch para ativar o aviso de live.');const broadcaster=await resolveTwitchUser(normalized);await query(`UPDATE users SET twitch_channel=$1,twitch_user_id=$2,twitch_enabled=TRUE WHERE id=$3`,[String(broadcaster.login||normalized),String(broadcaster.id),userId]);const sub=await ensureTwitchSubscription(broadcaster);return {ok:true,enabled:true,channel:String(broadcaster.login||normalized),userId:String(broadcaster.id),subscriptionStatus:sub.status};}
async function getTwitchLiveDetails(event){const id=String(event?.broadcaster_user_id||'').trim();if(!id)return null;for(let i=0;i<3;i++){try{const d=await twitchApi(`/streams?user_id=${encodeURIComponent(id)}`);const stream=Array.isArray(d.data)?d.data[0]:null;if(stream)return stream;}catch(e){console.error('[TWITCH] Get Streams:',e.message);}if(i<2)await new Promise(r=>setTimeout(r,1000));}return null;}
async function sendTwitchLiveNotification(event){const channelId=String(process.env.DISCORD_CHANNEL_CIP_LIVES||'').trim();if(!/^\d{17,20}$/.test(channelId))return {ok:false,reason:'Canal de Lives do CIP não configurado no Render (DISCORD_CHANNEL_CIP_LIVES).'};const users=await query(`SELECT DISTINCT twitch_user_id,twitch_channel FROM users WHERE status='approved' AND twitch_enabled=TRUE AND twitch_user_id=$1`,[String(event.broadcaster_user_id||'')]);if(!users.rowCount)return {ok:true,skipped:true,reason:'Nenhum usuário aprovado com aviso de Twitch ativo para este canal.'};const stream=await getTwitchLiveDetails(event);const login=String(event.broadcaster_user_login||users.rows[0]?.twitch_channel||'').trim();const display=String(stream?.user_name||event.broadcaster_user_name||login).trim();const title=String(stream?.title||'Ao vivo agora!').trim();const game=String(stream?.game_name||'Não informado').trim();const viewers=stream?.viewer_count!=null?Number(stream.viewer_count):null;const startedAt=stream?.started_at||event.started_at||null;const startedTs=startedAt?`<t:${Math.floor(new Date(startedAt).getTime()/1000)}:R>`:'';const url=`https://www.twitch.tv/${encodeURIComponent(login)}`;const thumb=String(stream?.thumbnail_url||'').replace('{width}','1280').replace('{height}','720');const embed={title:`🔴 ${display} ESTÁ AO VIVO!`,url,description:`**${title}**\n\n🎮 **Categoria:** ${game}\n👀 **Espectadores:** ${viewers!=null?viewers.toLocaleString('pt-BR'):'—'}${startedTs?`\n⏱️ **Início:** ${startedTs}`:''}`,color:0x9146FF,footer:{text:'CIP • Lives da Twitch • Divulgação automática'},timestamp:new Date().toISOString()};if(thumb)embed.image={url:thumb};const components=[{type:1,components:[{type:2,style:5,label:'🔴 ASSISTIR LIVE',url}]}];const result=await discordNotify(`🔴 **${display} entrou ao vivo na Twitch!**`,'cipLives',{embed,components,noAgendaButton:true});if(result?.ok)console.log(`[TWITCH] Live anunciada | canal=${login} | discord=${result.channelId||channelId}`);return result;}
async function handleTwitchEventSubNotification(rawBody,headers={}){const cfg=getTwitchConfig();const messageId=String(headers['twitch-eventsub-message-id']||'').trim();const timestamp=String(headers['twitch-eventsub-message-timestamp']||'').trim();const signature=String(headers['twitch-eventsub-message-signature']||'').trim();if(!cfg.secret||!messageId||!timestamp||!signature)throw new Error('Cabeçalhos/segredo do Twitch EventSub ausentes.');const expected='sha256='+crypto.createHmac('sha256',cfg.secret).update(messageId+timestamp+rawBody).digest('hex');if(expected.length!==signature.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(signature)))throw new Error('Assinatura Twitch EventSub inválida.');const ts=Date.parse(timestamp);if(!Number.isFinite(ts)||Math.abs(Date.now()-ts)>10*60*1000)throw new Error('Mensagem Twitch EventSub expirada.');const type=String(headers['twitch-eventsub-message-type']||'').trim();const body=JSON.parse(rawBody);if(type==='webhook_callback_verification')return {verification:true,challenge:String(body.challenge||'')};if(type!=='notification')return {ok:true,ignored:true};const inserted=await query(`INSERT INTO cip_twitch_eventsub_messages(message_id) VALUES($1) ON CONFLICT(message_id) DO NOTHING RETURNING message_id`,[messageId]);if(!inserted.rowCount)return {ok:true,duplicate:true};if(String(body.subscription?.type||'')==='stream.online')await sendTwitchLiveNotification(body.event||{});return {ok:true};}

async function getCurrentUser(userId) {
  const result = await query(
    "SELECT id,name,username,email,discord,city_id,city_phone,rank,role,status,avatar_data,notification_preference,twitch_channel,twitch_user_id,twitch_enabled,recruitment_internal_role,instruction_internal_role FROM users WHERE id=$1",
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
    const managerPath = String(req.path || "");
    const isRecruitmentManagerPath = managerPath.startsWith("/api/recruitments");
    const isInstructionManagerPath = managerPath.startsWith("/api/instructors") || managerPath.startsWith("/api/bookings") || managerPath.startsWith("/api/course-results") || managerPath.startsWith("/api/pending-users") || managerPath.startsWith("/api/users") || managerPath.startsWith("/api/admin/users") || managerPath.startsWith("/api/admin/password-reset-requests") || managerPath.startsWith("/api/weekly-activity") || managerPath.startsWith("/api/pending-bookings") || managerPath.startsWith("/api/instruction-");
    const internalRole = normalizeRecruitmentInternalRole(current.recruitment_internal_role);
    const allowedManager = isAnyCoordinatorRole(current.role) || (isRecruitmentManagerPath && internalRole === "braco_direito") || (isInstructionManagerPath && isInstructionInternalManager(current.instruction_internal_role));
    if (!allowedManager) {
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
    `SELECT id FROM users WHERE role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','admin') AND status='approved' ${excludeUserId ? 'AND id <> $1' : ''}`,
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

const discordBotQueues = new Map();
const DISCORD_CHANNELS = {
  // Instrutores
  cadastros: process.env.DISCORD_CHANNEL_INSTRUTORES_CADASTROS_ID || "1542648874945220779",
  instructionAgenda: process.env.DISCORD_CHANNEL_INSTRUTORES_AGENDA_ID || "1534527437281689664",
  courseResults: process.env.DISCORD_CHANNEL_INSTRUTORES_RELATORIO_ID || "1534527437281689665",
  courseNewBooking: process.env.DISCORD_CHANNEL_INSTRUTORES_NOVO_AGENDAMENTO_ID || "1542649641735028776",
  instructionNotices: process.env.DISCORD_CHANNEL_INSTRUTORES_AVISOS_ID || "1534527437281689664",
  // Canal exclusivo do CIP para os avisos automáticos de cursos.
  cipAvisos: process.env.discord_channel_CIP_Avisos || process.env.DISCORD_CHANNEL_CIP_AVISOS || "",
  cipLives: process.env.DISCORD_CHANNEL_CIP_LIVES || "",
  // Recrutamentos
  recruitmentNewBooking: process.env.DISCORD_CHANNEL_RECRUTAMENTO_NOVO_AGENDAMENTO_ID || "1545945698434945074",
  recruitmentAgenda: process.env.DISCORD_CHANNEL_RECRUTAMENTO_AGENDA_ID || "1534527437482889226",
  recruitmentBank: process.env.DISCORD_CHANNEL_RECRUTAMENTO_BANCO_ID || "1539452981458767912",
  approvals: process.env.DISCORD_CHANNEL_APROVACOES_ID || "1545950248734826567",
  recruitmentResults: process.env.DISCORD_CHANNEL_RECRUTAMENTO_RESULTADOS_ID || "1534527437482889229",
  changeLog: String(process.env.DISCORD_CHANNEL_CHANGELOG_ID || '').trim()
};

const DISCORD_ROLE_RECRUTADORES_ID = "1534527435347853325";
const DISCORD_ROLE_INSTRUTORES_ID = "1534527435364761695";
// Cargo mencionado especificamente nos avisos automáticos de cursos.
const DISCORD_ROLE_AVISO_CURSO_ID = "1495476154130370741";

function getSaoPauloGreeting(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {timeZone:"America/Sao_Paulo",hour:"2-digit",hour12:false}).format(date));
  return hour < 12 ? "BOM DIA" : hour < 18 ? "BOA TARDE" : "BOA NOITE";
}

let discordChangelogChannelIdCache = String(process.env.DISCORD_CHANNEL_CHANGELOG_ID || '').trim();

async function getSystemSetting(key) {
  const r = await query('SELECT value FROM cip_system_settings WHERE key=$1 LIMIT 1', [String(key)]);
  return String(r.rows[0]?.value || '').trim();
}

async function setSystemSetting(key, value) {
  await query(`INSERT INTO cip_system_settings(key,value,updated_at) VALUES($1,$2,NOW())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`, [String(key), String(value || '')]);
}

async function getChangelogChannelId() {
  return String(process.env.DISCORD_CHANNEL_CHANGELOG_ID || '').trim();
}

function discordChannelId(channel = "cadastros") {
  const map = {
    general: DISCORD_CHANNELS.cadastros,
    cadastros: DISCORD_CHANNELS.cadastros,
    newBooking: DISCORD_CHANNELS.courseNewBooking,
    courseNewBooking: DISCORD_CHANNELS.courseNewBooking,
    instructionNotices: DISCORD_CHANNELS.instructionNotices,
    instructionAvisos: DISCORD_CHANNELS.instructionNotices,
    cipAvisos: DISCORD_CHANNELS.cipAvisos,
    cipLives: DISCORD_CHANNELS.cipLives,
    approvedBooking: DISCORD_CHANNELS.instructionAgenda,
    instructionAgenda: DISCORD_CHANNELS.instructionAgenda,
    results: DISCORD_CHANNELS.courseResults,
    courseResults: DISCORD_CHANNELS.courseResults,
    recruitmentNewBooking: DISCORD_CHANNELS.recruitmentNewBooking,
    recruitmentApprovedBooking: DISCORD_CHANNELS.approvals,
    approvals: DISCORD_CHANNELS.approvals,
    recruiters: DISCORD_CHANNELS.recruitmentAgenda,
    recruitmentAgenda: DISCORD_CHANNELS.recruitmentAgenda,
    recruitmentBank: DISCORD_CHANNELS.recruitmentBank,
    recruitmentResults: DISCORD_CHANNELS.recruitmentResults,
    changeLog: discordChangelogChannelIdCache || DISCORD_CHANNELS.changeLog
  };
  return String(map[channel] || DISCORD_CHANNELS.cadastros);
}

function approvalButtons(entity, id){
  const n=Number(id);
  if(!Number.isInteger(n)||n<1) return undefined;
  return [{
    type:1,
    components:[
      {type:2,style:3,label:"✅ Aprovar",custom_id:`cip:${entity}:approve:${n}`},
      {type:2,style:4,label:"❌ Reprovar",custom_id:`cip:${entity}:reject:${n}`}
    ]
  }];
}

function discordUnixTimestamp(dateValue, timeValue = "00:00") {
  const dateKey = normalizeDateKey(dateValue);
  const m = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const tm = String(timeValue || "00:00").slice(0, 8);
  const parts = tm.split(":").map(Number);
  const hh = Number.isFinite(parts[0]) ? parts[0] : 0;
  const mm = Number.isFinite(parts[1]) ? parts[1] : 0;
  const ss = Number.isFinite(parts[2]) ? parts[2] : 0;
  // America/Sao_Paulo is UTC-03:00 (no DST in Brazil).
  const ms = Date.parse(`${dateKey}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}-03:00`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function discordTimestamp(dateValue, timeValue = "00:00", style = "F") {
  const unix = discordUnixTimestamp(dateValue, timeValue);
  return unix === null ? null : `<t:${unix}:${style}>`;
}

function convertDatesToDiscordTimestamps(text) {
  let raw = String(text || "");
  // Procura o horário do próprio aviso para que o timestamp relativo conte
  // até o início real do curso/recrutamento, e nunca para 00:00.
  const timeMatch = raw.match(/(?:Hor[áa]rio|às|as|In[íi]cio)\s*:?[\s\*]*(\d{1,2}:\d{2})(?:\s*[-–]\s*\*{0,2}(\d{1,2}:\d{2}))?/i);
  const defaultTime = timeMatch?.[1] || "00:00";
  return raw.replace(/(\d{2})\/(\d{2})\/(\d{4})/g, (full, dd, mm, yyyy) => {
    const unix = discordUnixTimestamp(`${yyyy}-${mm}-${dd}`, defaultTime);
    if (unix === null) return full;
    return `<t:${unix}:F> (<t:${unix}:R>)`;
  });
}

function discordDateRelative(dateValue, timeValue = "00:00") {
  const unix = discordUnixTimestamp(dateValue, timeValue);
  if (unix === null) return null;
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

// Timestamp oficial de recrutamentos: SEMPRE usa a data e o horário
// cadastrados na Agenda. O horário do disparo do aviso (15:00) nunca
// participa do timestamp.
function recruitmentDiscordDateTimestamp(row) {
  if (!row) return null;
  const dateKey = String(row.date_key || normalizeDateKey(row.date) || "").slice(0, 10);
  const startTime = String(row.start_time || "").slice(0, 8);
  return discordDateRelative(dateKey, startTime || "00:00");
}

function recruitmentPresenceBar(count, width = 24) {
  const n = Math.max(0, Number(count) || 0);
  const filled = Math.min(width, n);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

async function buildRecruitmentAgendaEmbed(recruitmentId) {
  const id = Number(recruitmentId);
  const r = await query(`
    SELECT r.id,r.recruitment_number,r.date,to_char(r.date,'YYYY-MM-DD') AS date_key,r.start_time,r.end_time,r.status,r.title,r.recruiter_id,
           u.name AS recruiter_name,
           (SELECT COUNT(*)::int FROM cip_recruitment_presence pr WHERE pr.recruitment_id=r.id AND pr.present=TRUE) AS presences
    FROM cip_recruitments r
    LEFT JOIN users u ON u.id=r.recruiter_id
    WHERE r.id=$1
    LIMIT 1
  `,[id]);
  if (!r.rowCount) return null;
  const x=r.rows[0];
  const presences=Math.max(0,Number(x.presences)||0);
  const status=String(x.status||'').toLowerCase();
  const statusLabel={pending:'AGUARDANDO APROVAÇÃO',confirmed:'APROVADO',completed:'REALIZADO',cancelled:'CANCELADO'}[status]||String(x.status||'').toUpperCase();
  const color=status==='completed'?0x2ECC71:status==='cancelled'?0xE74C3C:status==='pending'?0xF1C40F:0x00B0F4;
  const dateTs=discordDateRelative(x.date_key || x.date,x.start_time)||formatDateBR(x.date_key || x.date);
  return {
    title:`📢 RECRUTAMENTO Nº ${x.recruitment_number||'—'}`,
    description:`${x.title?`**${String(x.title).slice(0,160)}**\n\n`:''}📅 **Data:** ${dateTs}\n⏰ **Horário:** ${formatTimeBR(x.start_time)} - ${formatTimeBR(x.end_time)}\n👮 **Recrutador:** ${x.recruiter_name||'—'}\n🟢 **Status:** ${statusLabel}`,
    color,
    fields:[
      {name:'👥 PRESENÇAS CONFIRMADAS',value:`**${presences}** participante${presences===1?'':'s'}\n\`${recruitmentPresenceBar(presences)}\``,inline:false},
      {name:'📌 PARTICIPAÇÃO',value:presences?`🟢 **${presences}** presença${presences===1?'':'s'} registrada${presences===1?'':'s'}.`:'🟡 **Nenhuma presença registrada ainda.**',inline:false}
    ],
    footer:{text:'CIP • Agenda de Recrutamentos • Presença em tempo real'},
    timestamp:new Date().toISOString()
  };
}

async function updateRecruitmentAgendaDiscordMessage(recruitmentId) {
  const id=Number(recruitmentId);
  if(!Number.isInteger(id)||id<1)return {ok:false,skipped:true,reason:'Recrutamento inválido.'};
  const token=String(process.env.DISCORD_BOT_TOKEN||'').trim();
  if(!token)return {ok:false,skipped:true,reason:'DISCORD_BOT_TOKEN não configurado.'};
  const r=await query(`SELECT discord_agenda_message_id,recruitment_number FROM cip_recruitments WHERE id=$1`,[id]);
  let messageId=String(r.rows[0]?.discord_agenda_message_id||'').trim();
  const channelId=discordChannelId('recruitmentAgenda');
  // Compatibilidade: recrutamentos aprovados antes desta melhoria podem não ter
  // o message_id salvo. Procuramos o embed correspondente entre as mensagens
  // recentes da Agenda e passamos a salvar o ID encontrado.
  if(!messageId){
    try{
      const listResponse=await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=100`,{headers:{'Authorization':`Bot ${token}`}});
      if(listResponse.ok){
        const messages=await listResponse.json();
        const needle=`RECRUTAMENTO Nº ${r.rows[0]?.recruitment_number||'—'}`.toUpperCase();
        const found=(Array.isArray(messages)?messages:[]).find(m=>String(m?.author?.bot||'').toLowerCase()==='true' && Array.isArray(m?.embeds) && m.embeds.some(e=>`${e.title||''} ${e.description||''}`.toUpperCase().includes(needle)));
        messageId=String(found?.id||'').trim();
        if(messageId) await query(`UPDATE cip_recruitments SET discord_agenda_message_id=$1 WHERE id=$2`,[messageId,id]);
      }
    }catch(e){ console.warn('Busca do embed legado da Agenda:',e.message); }
  }
  if(!messageId)return {ok:false,skipped:true,reason:'Embed da Agenda não localizado no Discord.'};
  const embed=await buildRecruitmentAgendaEmbed(id);
  if(!embed)return {ok:false,skipped:true,reason:'Recrutamento não encontrado.'};
  const response=await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,{
    method:'PATCH',headers:{'Authorization':`Bot ${token}`,'Content-Type':'application/json'},body:JSON.stringify({embeds:[embed]})
  });
  if(response.ok)return {ok:true,messageId,channelId,presences:embed.fields?.[0]?.value||''};
  const body=await response.text().catch(()=> '');
  if(response.status===404){
    await query(`UPDATE cip_recruitments SET discord_agenda_message_id=NULL WHERE id=$1`,[id]);
  }
  return {ok:false,reason:`Não foi possível atualizar o embed da Agenda (HTTP ${response.status}).`,detail:body.slice(0,300)};
}

async function syncRecruitmentAgendaDiscordMessages() {
  try {
    const rows = await query(`SELECT id FROM cip_recruitments WHERE discord_agenda_message_id IS NOT NULL ORDER BY date,start_time,id`);
    for (const row of rows.rows) {
      try {
        const result = await updateRecruitmentAgendaDiscordMessage(row.id);
        if (result?.ok) console.log(`[DISCORD AGENDA] Embed sincronizado com timestamp | recrutamento=${row.id}`);
      } catch (e) {
        console.warn(`[DISCORD AGENDA] Falha ao sincronizar recrutamento=${row.id}:`, e.message);
      }
    }
  } catch (e) {
    console.warn('[DISCORD AGENDA] Falha na sincronização inicial:', e.message);
  }
}

async function sendRecruitmentAgendaDiscordMessage(recruitmentId) {
  const id=Number(recruitmentId);
  const embed=await buildRecruitmentAgendaEmbed(id);
  if(!embed)return {ok:false,reason:'Recrutamento não encontrado.'};
  const result=await discordNotify('', 'recruitmentAgenda', {embed});
  if(result?.ok && result.messageId){
    await query(`UPDATE cip_recruitments SET discord_agenda_message_id=$1 WHERE id=$2`,[String(result.messageId),id]);
  }
  return result;
}

function discordEmbedFromText(content, channel = "cadastros") {
  let raw = String(content || "").trim();
  // Menções de cargos ficam fora do Embed para o Discord realmente notificar a role.
  // O texto da menção é enviado no campo content da mensagem.
  const roleMentions = [`<@&${DISCORD_ROLE_RECRUTADORES_ID}>`, `<@&${DISCORD_ROLE_INSTRUTORES_ID}>`];
  // Menções de cargos e a saudação ficam FORA do Embed.
  if (roleMentions.some(m => raw.includes(m))) {
    const cleanedLines = raw.split(/\r?\n/);
    const kept = [];
    for (const line of cleanedLines) {
      let withoutMention = line;
      for (const mention of roleMentions) withoutMention = withoutMention.replaceAll(mention, "");
      const plain = withoutMention.replace(/\*\*/g, "").replace(/[!！]\s*$/, "").trim();
      if (/^(BOM DIA|BOA TARDE|BOA NOITE)$/i.test(plain)) continue;
      if (!plain && withoutMention.trim() === "" && line.trim() !== "") continue;
      kept.push(withoutMention);
    }
    raw = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  // Datas exibidas dentro dos Embeds usam o timestamp nativo do Discord.
  // Assim cada usuário vê a data no próprio fuso e o Discord mantém a formatação dinâmica.
  raw = convertDatesToDiscordTimestamps(raw);
  const lines = raw.split(/\r?\n/);
  let title = "Notificação do CIP";
  if (lines[0]) {
    const first = lines[0].replace(/\*\*/g, "").trim();
    if (first && first.length <= 256) title = first;
  }
  let description = raw;
  const match = raw.match(/^\*\*([^*]{2,256})\*\*\s*/);
  if (match) description = raw.slice(match[0].length).replace(/^\s+/, "").replace(/\s+$/, "") || raw;
  else if (lines.length > 1) description = lines.slice(1).join("\n").replace(/^\s+/, "").replace(/\s+$/, "") || raw;

  // Mantém exatamente as quebras de linha do texto original.
  // Não usamos caracteres invisíveis nem substituímos \n\n, pois o Discord já preserva os parágrafos da description.
  return {
    title,
    description: description.slice(0, 4096),
    // Padrão visual do CIP: barra lateral dourada em todos os Embeds.
    color: 0xF1C40F,
    footer: { text: "CIP • Sistema de Gestão" },
    timestamp: new Date().toISOString()
  };
}

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function parseDiscordRetryAfter(response, bodyText = "") {
  const header = Number.parseFloat(response.headers.get("retry-after") || "");
  if (Number.isFinite(header) && header > 0) return header;
  try {
    const body = JSON.parse(bodyText || "{}");
    const value = Number(body?.retry_after);
    if (Number.isFinite(value) && value > 0) return value;
  } catch {}
  return 1;
}

async function discordBotNotify(content, channel = "cadastros", options = {}) {
  const token = String(process.env.DISCORD_BOT_TOKEN || "").trim();
  const channelId = discordChannelId(channel);
  if (!token) return { ok:false, reason:"DISCORD_BOT_TOKEN não está configurado no Render.", code:"BOT_NOT_CONFIGURED" };
  if (!/^\d{17,20}$/.test(channelId)) return { ok:false, reason:`Canal Discord inválido para ${channel}: ${channelId}`, code:"INVALID_CHANNEL_ID" };
  const previous = discordBotQueues.get(channelId) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    try {
      const rawContent = String(content || "");
      const recruiterMention = `<@&${DISCORD_ROLE_RECRUTADORES_ID}>`;
      const instructorMention = `<@&${DISCORD_ROLE_INSTRUTORES_ID}>`;
      const shouldMentionRecruiters = Boolean(options.allowRecruiterRole || channel === "recruitmentAgenda" || rawContent.includes(recruiterMention));
      const shouldMentionInstructors = Boolean(channel === "instructionNotices" || channel === "instructionAvisos" || rawContent.includes(instructorMention));
      // Avisos de Curso usam uma role específica do CIP. A menção vem no
      // content da mensagem (fora do Embed) para gerar notificação real.
      const courseRoleMention = `<@&${DISCORD_ROLE_AVISO_CURSO_ID}>`;
      const shouldMentionCourseRole = Boolean(channel === "cipAvisos" || rawContent.includes(courseRoleMention));
      const rolesToMention = [
        ...(shouldMentionRecruiters ? [DISCORD_ROLE_RECRUTADORES_ID] : []),
        ...(shouldMentionInstructors ? [DISCORD_ROLE_INSTRUTORES_ID] : []),
        ...(shouldMentionCourseRole ? [DISCORD_ROLE_AVISO_CURSO_ID] : [])
      ];
      // Nunca reutiliza a menção dentro do Embed.
      const embed = options.embed || discordEmbedFromText(rawContent, channel);
      const firstLine = rawContent.split(/\r?\n/)[0].replace(/\*\*/g, "").trim();
      const publicBaseUrl=getCipPublicBaseUrl();
      const agendaUrl=publicBaseUrl ? `${publicBaseUrl}/#marcacoes` : null;
      // Componentes: uma mensagem de aprovação NUNCA deve receber o botão
      // genérico "Abrir Agenda". Se o chamador forneceu os botões de aprovação,
      // eles têm prioridade absoluta sobre qualquer componente padrão.
      let components = options.components;
      if (!components && !options.noAgendaButton && (channel === "instructionNotices" || channel === "instructionAvisos") && agendaUrl) {
        components = [{
          type:1,
          components:[{type:2,style:5,label:"📅 Abrir Agenda de Marcações",url:agendaUrl}]
        }];
      }
      const body = {
        // Saudação + menção real ficam no content, fora do Embed.
        ...(rolesToMention.length ? { content: firstLine } : {}),
        embeds: [embed],
        ...(components ? {components} : {}),
        allowed_mentions: rolesToMention.length ? { roles: rolesToMention } : { parse: [] }
      };
      if (options.components?.[0]?.components?.some(c => String(c.custom_id || "").startsWith("cip:"))) {
        console.log(`[DISCORD APROVACAO] canal=${channel} canalId=${channelId} componentes=aprovar/reprovar`);
      }
      const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method:"POST",
        headers:{"Authorization":`Bot ${token}`,"Content-Type":"application/json"},
        body:JSON.stringify(body)
      });
      if (response.ok) {
        let data={}; try { data=await response.json(); } catch {}
        return {ok:true,messageId:data.id||null,channelId};
      }
      const bodyText=await response.text().catch(() => "");
      console.error(`Discord bot HTTP ${response.status} [${channel}]:`, bodyText.slice(0,500));
      if (response.status===429) {
        const retryAfter=parseDiscordRetryAfter(response,bodyText);
        return {ok:false,rateLimited:true,retryAfter,reason:`Discord está limitando o bot. Aguarde ${Math.ceil(retryAfter)}s antes de tentar novamente.`};
      }
      const reasons={400:"Discord rejeitou a mensagem (400).",401:"Token do bot inválido ou não autorizado (401).",403:"O bot não tem permissão para enviar mensagens/embeds neste canal (403).",404:"Canal não encontrado ou o bot não consegue acessá-lo (404)."};
      return {ok:false,reason:reasons[response.status]||`Discord retornou HTTP ${response.status}.`,code:response.status};
    } catch(e) {
      console.error(`Discord bot [${channel}]:`,e.message);
      return {ok:false,reason:`Falha de conexão com o Discord: ${e.message}`,code:"NETWORK"};
    }
  });
  discordBotQueues.set(channelId,current);
  try { return await current; }
  finally { if (discordBotQueues.get(channelId)===current) discordBotQueues.delete(channelId); }
}

async function discordNotify(content, channel = "general", options = {}) {
  return discordBotNotify(content, channel, options);
}

async function sendRecruitmentResultSummary(recruitmentId, options = {}) {
  const id = Number(recruitmentId);
  if (!Number.isInteger(id) || id < 1) throw new Error('Recrutamento inválido.');

  const r = await query(`
    SELECT r.id,r.recruitment_number,r.date,to_char(r.date,'YYYY-MM-DD') AS date_key,r.start_time,r.end_time,r.cutoff_score,r.status,
           ru.name AS recruiter_name,
           COUNT(p.id)::int AS total,
           COUNT(p.id) FILTER (WHERE p.status='approved')::int AS approved,
           COUNT(p.id) FILTER (WHERE p.status='rejected')::int AS rejected,
           COUNT(p.id) FILTER (WHERE p.status NOT IN ('approved','rejected'))::int AS pending,
           ROUND(AVG(p.score) FILTER (WHERE p.score IS NOT NULL),2) AS average_score
    FROM cip_recruitments r
    LEFT JOIN users ru ON ru.id=r.recruiter_id
    LEFT JOIN cip_recruitment_participants p ON p.recruitment_id=r.id
    WHERE r.id=$1
    GROUP BY r.id,ru.name
  `,[id]);
  if (!r.rowCount) throw new Error('Recrutamento não encontrado.');
  const rec = r.rows[0];
  const total = Number(rec.total || 0);
  const pending = Number(rec.pending || 0);
  if (!total) return {ok:false, skipped:true, reason:'Nenhum conscrito no recrutamento.'};
  if (pending > 0) return {ok:false, skipped:true, reason:`Ainda há ${pending} resultado(s) pendente(s).`};

  const forceResend = options?.forceResend === true;
  const already = await query(`SELECT 1 FROM cip_recruitment_result_notifications WHERE recruitment_id=$1 LIMIT 1`,[id]);
  if (already.rowCount && !forceResend) return {ok:true, alreadySent:true};

  const participants = await query(`
    SELECT name,city_id,score,status
    FROM cip_recruitment_participants
    WHERE recruitment_id=$1
    ORDER BY CASE WHEN status='approved' THEN 0 ELSE 1 END, score DESC NULLS LAST, name
  `,[id]);
  const approved = participants.rows.filter(p=>p.status==='approved');
  const rejected = participants.rows.filter(p=>p.status==='rejected');
  const lines = list => list.length
    ? list.map((p,i)=>`${i+1}. **${p.name}** | ID ${p.city_id} | Nota ${p.score!=null?formatScoreBR(p.score):'—'}`).join('\n')
    : 'Nenhum';

  // A data do recrutamento vem da Agenda como DATE. Use date_key para
  // impedir qualquer conversão implícita por UTC que possa voltar um dia.
  const recruitmentDateKey = rec.date_key || normalizeDateKey(rec.date);
  const dateTs = discordDateRelative(recruitmentDateKey, rec.start_time) || formatDateBR(recruitmentDateKey);
  const startTimeTs = discordTimestamp(recruitmentDateKey, rec.start_time, "t") || formatTimeBR(rec.start_time);
  const endTimeTs = discordTimestamp(recruitmentDateKey, rec.end_time, "t") || formatTimeBR(rec.end_time);
  const msg = `🏁 **RESULTADO FINAL DO RECRUTAMENTO**\n\n`+
    `🎯 **Recrutamento Nº:** ${rec.recruitment_number}\n`+
    `📅 **Data:** ${dateTs}\n`+
    `⏰ **Horário:** ${startTimeTs} - ${endTimeTs}\n`+
    `👮 **Recrutador:** ${rec.recruiter_name || '—'}\n\n`+
    `📊 **Média das notas:** ${rec.average_score!=null?formatScoreBR(rec.average_score):'—'}\n`+
    `🎯 **Nota de corte:** ${rec.cutoff_score!=null?formatScoreBR(rec.cutoff_score):'—'}\n`+
    `👥 **Total:** ${total}\n\n`+
    `🟢 **APROVADOS — ${approved.length}**\n${lines(approved)}\n\n`+
    `🔴 **REPROVADOS — ${rejected.length}**\n${lines(rejected)}\n\n`+
    `✅ **RESULTADO ENCERRADO**`;

  const result = await discordNotify(msg,'recruitmentResults');
  if (!result.ok) throw new Error(result.reason || 'Falha ao enviar resultado do recrutamento ao Discord.');
  await query(`INSERT INTO cip_recruitment_result_notifications(recruitment_id) VALUES($1) ON CONFLICT (recruitment_id) DO NOTHING`,[id]);
  console.log(`[RECRUTAMENTO RESULTADO] ${forceResend?'Reenviado':'Enviado'} ao Discord | id=${id} nº=${rec.recruitment_number}`);
  return {ok:true,sent:true,resend:forceResend};
}

async function sendPendingRecruitmentResultNotifications() {
  try {
    const pending = await query(`
      SELECT r.id
      FROM cip_recruitments r
      JOIN cip_recruitment_participants p ON p.recruitment_id=r.id
      LEFT JOIN cip_recruitment_result_notifications n ON n.recruitment_id=r.id
      GROUP BY r.id,n.recruitment_id
      HAVING n.recruitment_id IS NULL
         AND COUNT(p.id) > 0
         AND COUNT(p.id) FILTER (WHERE p.status NOT IN ('approved','rejected')) = 0
      ORDER BY r.date,r.start_time,r.id
      LIMIT 20
    `);
    for (const row of pending.rows) {
      try { await sendRecruitmentResultSummary(row.id); }
      catch (e) { console.error(`[RECRUTAMENTO RESULTADO] Falha no id=${row.id}:`, e.message); }
    }
  } catch (e) {
    console.error('Fila de resultados de recrutamento:', e.message);
  }
}

async function enqueueDiscordResult(bookingId, resultType, content, reason = "") {
  await query(`DELETE FROM discord_result_outbox WHERE booking_id=$1 AND result_type=$2 AND status='pending'`, [bookingId, resultType]);
  await query(`INSERT INTO discord_result_outbox(booking_id,result_type,content,next_attempt_at,last_error) VALUES($1,$2,$3,NOW(),$4)`, [bookingId,resultType,content,reason]);
}

async function processDiscordResultOutbox() {
  try {
    const pending = await query(`
      SELECT id,booking_id,result_type,content,attempts
      FROM discord_result_outbox
      WHERE status='pending' AND next_attempt_at <= NOW()
      ORDER BY id
      LIMIT 5
    `);
    for (const item of pending.rows) {
      const result = await discordNotify(item.content, "results");
      if (result.ok) {
        await query(`UPDATE discord_result_outbox SET status='sent',sent_at=NOW(),last_error='' WHERE id=$1`, [item.id]);
      } else if (result.rateLimited) {
        await query(`UPDATE discord_result_outbox SET next_attempt_at=NOW() + ($2 * INTERVAL '1 second'),last_error=$3 WHERE id=$1`, [item.id, Math.max(1, Math.ceil(result.retryAfter || 1)), result.reason || '429']);
        // O Bot está limitado; não desperdiçamos as demais tentativas do lote.
        break;
      } else {
        const attempts = Number(item.attempts || 0) + 1;
        const failed = attempts >= 5;
        await query(`UPDATE discord_result_outbox SET attempts=$2,status=$3,next_attempt_at=NOW() + INTERVAL '5 minutes',last_error=$4 WHERE id=$1`, [item.id, attempts, failed ? 'failed' : 'pending', result.reason || 'Falha no Discord']);
      }
    }
  } catch (e) {
    console.error("Fila Discord resultados:", e.message);
  }
}


// ===== AVISOS AUTOMÁTICOS DOS EVENTOS DO DISCORD =====
// O Bot lê os Eventos Agendados do próprio Discord e publica o aviso no canal
// de Avisos um dia antes. O evento continua sendo a origem do RSVP/"Me interessa".
function discordEventDateParts(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12:false
  }).formatToParts(d);
  const get=k=>parts.find(x=>x.type===k)?.value||'';
  return {year:get('year'),month:get('month'),day:get('day'),hour:get('hour'),minute:get('minute')};
}

function discordEventLocalDateKey(iso) {
  const p=discordEventDateParts(iso);
  return p ? `${p.year}-${p.month}-${p.day}` : '';
}

function discordEventLocalTime(iso) {
  const p=discordEventDateParts(iso);
  return p ? `${p.hour}:${p.minute}` : '';
}

function discordEventLink(guildId,eventId){
  return guildId && eventId ? `https://discord.com/events/${guildId}/${eventId}` : '';
}

function extractFirstUrl(text='') {
  const m=String(text||'').match(/https?:\/\/[^\s<>]+/i);
  return m ? m[0].replace(/[),.;]+$/,'') : '';
}

async function getDiscordGuildIdFromChannel(channelId, token) {
  if(!channelId||!token) return '';
  try {
    const r=await fetch(`https://discord.com/api/v10/channels/${channelId}`,{headers:{Authorization:`Bot ${token}`}});
    if(!r.ok) return '';
    const data=await r.json();
    return String(data.guild_id||'').trim();
  } catch { return ''; }
}

async function getTomorrowDateKeySaoPaulo(){
  const now=new Date();
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const get=k=>parts.find(x=>x.type===k)?.value||'';
  const localNow=`${get('year')}-${get('month')}-${get('day')}`;
  const tomorrowDate=new Date(`${localNow}T12:00:00-03:00`);
  tomorrowDate.setDate(tomorrowDate.getDate()+1);
  const tp=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(tomorrowDate);
  const tg=k=>tp.find(x=>x.type===k)?.value||'';
  return `${tg('year')}-${tg('month')}-${tg('day')}`;
}

async function createDiscordScheduledEventForBooking(booking){
  const token=String(process.env.DISCORD_BOT_TOKEN||'').trim();
  const channelId=String(process.env.discord_channel_CIP_Avisos||process.env.DISCORD_CHANNEL_CIP_AVISOS||DISCORD_CHANNELS.cipAvisos||'').trim();
  if(!token) return {ok:false,reason:'DISCORD_BOT_TOKEN não configurado.'};
  if(!channelId) return {ok:false,reason:'Canal de Avisos do CIP não configurado.'};
  const guildId=await getDiscordGuildIdFromChannel(channelId,token);
  if(!guildId) return {ok:false,reason:'Não foi possível identificar o servidor do canal de Avisos.'};
  try {
    const exists=await query(`SELECT event_id FROM cip_discord_scheduled_events WHERE booking_id=$1 LIMIT 1`,[Number(booking.id)]);
    if(exists.rowCount){
      return {ok:true,alreadyCreated:true,eventId:String(exists.rows[0].event_id),guildId,channelId};
    }

    // Se alguém já criou manualmente o evento correspondente, reaproveita-o.
    const existingEvents=await listDiscordScheduledEvents();
    if(existingEvents.ok){
      const existing=pickEventForBooking(existingEvents.events||[],booking);
      if(existing?.id){
        await query(`INSERT INTO cip_discord_scheduled_events(booking_id,guild_id,event_id,channel_id,event_name,scheduled_start_time,scheduled_end_time,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
          ON CONFLICT(booking_id) DO UPDATE SET guild_id=EXCLUDED.guild_id,event_id=EXCLUDED.event_id,channel_id=EXCLUDED.channel_id,event_name=EXCLUDED.event_name,scheduled_start_time=EXCLUDED.scheduled_start_time,scheduled_end_time=EXCLUDED.scheduled_end_time,updated_at=NOW()`,[
          Number(booking.id),guildId,String(existing.id),channelId,String(existing.name||booking.course||'Curso'),existing.scheduled_start_time || `${String(booking.date_key||booking.booking_date_key||booking.date||'').slice(0,10)}T${String(booking.start_time||'').slice(0,8)}-03:00`,existing.scheduled_end_time || null
        ]);
        return {ok:true,reused:true,eventId:String(existing.id),guildId,channelId,eventUrl:discordEventLink(guildId,String(existing.id))};
      }
    }

    const dateKey=String(booking.date_key||booking.booking_date_key||booking.date||'').trim();
    const start=String(booking.start_time||'').slice(0,8);
    const end=String(booking.end_time||'').slice(0,8);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)||!/^\d{2}:\d{2}/.test(start)) return {ok:false,reason:'Data/horário inválidos para criar o Evento Discord.'};
    const startIso=`${dateKey}T${start}-03:00`;
    const endIso=/^\d{2}:\d{2}/.test(end) ? `${dateKey}T${end}-03:00` : null;
    const startMs=Date.parse(startIso);
    if(!Number.isFinite(startMs) || startMs<=Date.now()) return {ok:false,reason:'O horário do curso já passou; Evento Discord não criado.'};
    const instructor=String(booking.instructor_name||'').trim();
    const course=String(booking.course||'Curso').trim()||'Curso';
    const manual=await manualUrlForBooking(booking);
    const defaultLocation=String(process.env.DISCORD_EVENT_DEFAULT_LOCATION||'CIP • Curso').trim();
    const description=[
      `📚 Curso: ${course}`,
      instructor?`👨‍🏫 Instrutor: ${instructor}`:'',
      `📅 Data: ${dateKey.split('-').reverse().join('/')}`,
      `⏰ Horário: ${formatTimeBR(booking.start_time)} - ${formatTimeBR(booking.end_time)}`,
      manual?`📚 Manual: ${manual}`:'',
      '',
      '⚠️ Chegue com 10 minutos de antecedência.'
    ].filter(Boolean).join('\n').slice(0,1000);
    const payload={
      name:course.slice(0,100),
      privacy_level:2,
      scheduled_start_time:new Date(startMs).toISOString(),
      ...(endIso?{scheduled_end_time:new Date(Date.parse(endIso)).toISOString()}:{scheduled_end_time:new Date(startMs+60*60*1000).toISOString()}),
      entity_type:3,
      entity_metadata:{location:defaultLocation.slice(0,100)},
      description
    };
    const r=await fetch(`https://discord.com/api/v10/guilds/${guildId}/scheduled-events`,{
      method:'POST',
      headers:{Authorization:`Bot ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    });
    const body=await r.text();
    if(!r.ok) return {ok:false,reason:`Discord retornou HTTP ${r.status} ao criar o Evento Agendado: ${body.slice(0,300)}`};
    const event=JSON.parse(body);
    await query(`INSERT INTO cip_discord_scheduled_events(booking_id,guild_id,event_id,channel_id,event_name,scheduled_start_time,scheduled_end_time,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT(booking_id) DO UPDATE SET guild_id=EXCLUDED.guild_id,event_id=EXCLUDED.event_id,channel_id=EXCLUDED.channel_id,event_name=EXCLUDED.event_name,scheduled_start_time=EXCLUDED.scheduled_start_time,scheduled_end_time=EXCLUDED.scheduled_end_time,updated_at=NOW()`,[
      Number(booking.id),guildId,String(event.id),channelId,String(event.name||course),event.scheduled_start_time || new Date(startMs).toISOString(),event.scheduled_end_time || null
    ]);
    return {ok:true,created:true,eventId:String(event.id),guildId,channelId,eventUrl:discordEventLink(guildId,String(event.id))};
  } catch(e) {
    return {ok:false,reason:`Falha ao criar/reutilizar Evento Discord: ${e.message}`};
  }
}

async function ensureDiscordScheduledEventForBooking(booking){
  if(!booking || isRecruitmentCourseName(booking.course)) return {ok:true,skipped:true,reason:'Recrutamento não utiliza criação automática de Evento de Curso.'};
  const result=await createDiscordScheduledEventForBooking(booking);
  if(!result.ok) console.error(`[EVENTO DISCORD] booking=${booking.id} • ${result.reason}`);
  return result;
}

async function listDiscordScheduledEvents(){
  const token=String(process.env.DISCORD_BOT_TOKEN||'').trim();
  if(!token) return {ok:false,reason:'DISCORD_BOT_TOKEN não configurado no Render.',events:[]};
  const channelId=String(process.env.discord_channel_CIP_Avisos||process.env.DISCORD_CHANNEL_CIP_AVISOS||DISCORD_CHANNELS.cipAvisos||'').trim();
  if(!channelId) return {ok:false,reason:'Canal de Avisos do CIP não configurado. Configure discord_channel_CIP_Avisos no Render.',events:[]};
  const guildId=await getDiscordGuildIdFromChannel(channelId,token);
  if(!guildId) return {ok:false,reason:'Não foi possível identificar o servidor do canal de Avisos.',events:[]};
  try{
    const r=await fetch(`https://discord.com/api/v10/guilds/${guildId}/scheduled-events?with_user_count=true`,{headers:{Authorization:`Bot ${token}`}});
    const body=await r.text();
    if(!r.ok) return {ok:false,reason:`Discord retornou HTTP ${r.status} ao consultar os Eventos Agendados.`,status:r.status,events:[]};
    const events=JSON.parse(body);
    const active=Array.isArray(events)?events.filter(e=>[1,2].includes(Number(e.status||1))):[];
    return {ok:true,guildId,channelId,events:active};
  }catch(e){
    return {ok:false,reason:`Falha ao consultar os Eventos Agendados: ${e.message}`,events:[]};
  }
}

function isOfficialInstructionCourseName(value){
  const n=normalizeCourseName(String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,''));
  return ['abordagem','acompanhamento','modulacao','procedimentosadministrativos'].includes(n);
}

async function listTomorrowCourseBookings(dateKey){
  const r=await query(`
    SELECT b.id,b.date,to_char(b.date,'YYYY-MM-DD') AS date_key,b.start_time,b.end_time,b.course,b.course_url,b.status,
           u.name AS instructor_name
    FROM bookings b
    JOIN users u ON u.id=b.instructor_id
    WHERE b.date=$1::date
      AND LOWER(COALESCE(b.status,'')) IN ('confirmed','approved')
      AND LOWER(TRIM(COALESCE(b.course,''))) <> 'recrutamento'
    ORDER BY b.date,b.start_time,b.id
  `,[dateKey]);
  return r.rows.filter(b=>isOfficialInstructionCourseName(b.course));
}

function normalizeCourseName(value){
  return String(value||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'').trim();
}

function eventMatchesBooking(event,booking){
  const eventDate=discordEventLocalDateKey(event?.scheduled_start_time);
  const eventStart=discordEventLocalTime(event?.scheduled_start_time);
  if(!eventDate||!eventStart) return false;
  if(eventDate!==String(booking.date_key||'')) return false;
  if(!String(booking.start_time||'').startsWith(eventStart)) return false;
  const eventName=normalizeCourseName(event?.name);
  const courseName=normalizeCourseName(booking?.course);
  if(!eventName||!courseName) return false;
  return eventName===courseName || eventName.includes(courseName) || courseName.includes(eventName);
}

function pickEventForBooking(events,booking){
  const matches=events.filter(e=>eventMatchesBooking(e,booking));
  if(!matches.length) return null;
  const end=String(booking.end_time||'').slice(0,5);
  matches.sort((a,b)=>{
    const aEnd=discordEventLocalTime(a.scheduled_end_time||'');
    const bEnd=discordEventLocalTime(b.scheduled_end_time||'');
    return (aEnd===end?0:1)-(bEnd===end?0:1);
  });
  return matches[0];
}

async function manualUrlForBooking(booking){
  let manualUrl=String(booking?.course_url||'').trim();
  if(manualUrl) return manualUrl;
  try{
    const normalizedCourse=String(booking?.course||'').trim();
    const m=await query(`
      SELECT url
      FROM instruction_materials
      WHERE section='Link manual por curso'
        AND COALESCE(TRIM(url),'') <> ''
        AND (
          LOWER(TRIM(course))=LOWER(TRIM($1))
          OR LOWER(TRIM(title))=LOWER(TRIM($1))
          OR REGEXP_REPLACE(LOWER(TRIM(COALESCE(course,title))), '[^a-z0-9]+', '', 'g')=
             REGEXP_REPLACE(LOWER(TRIM($1)), '[^a-z0-9]+', '', 'g')
        )
      ORDER BY
        CASE
          WHEN LOWER(TRIM(course))=LOWER(TRIM($1)) THEN 0
          WHEN LOWER(TRIM(title))=LOWER(TRIM($1)) THEN 1
          ELSE 2
        END,
        material_order,id
      LIMIT 1
    `,[normalizedCourse]);
    manualUrl=String(m.rows[0]?.url||'').trim();
  }catch{}
  return manualUrl;
}

async function buildCourseAnnouncementFromBooking(booking,event,guildId){
  const dateKey=String(booking.date_key||'');
  const startTime=String(booking.start_time||'').slice(0,5);
  const endTime=String(booking.end_time||'').slice(0,5);
  const course=String(booking.course||event?.name||'Curso').trim()||'Curso';
  const instructor=String(booking.instructor_name||'').trim();
  const location=String(event?.entity_metadata?.location||'').trim() || 'Conforme o Evento do Discord';
  const eventUrl=event ? discordEventLink(guildId,String(event.id||'')) : '';
  const manualUrl=await manualUrlForBooking(booking);
  const startTs=discordDateRelative(dateKey,startTime)||formatDateBR(dateKey);
  const eventText=eventUrl ? `🎟️ **Confirme sua presença no evento:**\n${eventUrl}` : `🎟️ **EVENTO DO DISCORD:** Evento do Discord não criado.`;
  const description=`📚 **CURSO:** ${course}\n\n`+
    `📅 **Data:** ${startTs}\n`+
    `🕐 **Horário:** ${formatTimeBR(startTime)}${endTime?` - ${formatTimeBR(endTime)}`:''}\n`+
    `📍 **Local:** ${location}\n`+
    (instructor?`👨‍🏫 **Instrutor:** ${instructor}\n`: '')+
    `\n⚠️ **ATENÇÃO:** Todos deverão chegar com **10 minutos de antecedência** para organização e preparação antes do início do curso.\n\n`+
    (manualUrl?`📚 **Link do Manual:**\n${manualUrl}\n\n`: '')+
    eventText;
  const embed={
    title:'📢 AVISO DE CURSO',
    description,
    color:0x00B06B,
    footer:{text:'CIP • Avisos de Cursos • Divulgação automática'},
    timestamp:new Date().toISOString()
  };
  const base=getCipPublicBaseUrl();
  if(base){
    embed.thumbnail={url:`${base}/CIP.webp`};
    embed.image={url:`${base}/aviso-curso.png`};
  }
  return {embed,message:`<@&${DISCORD_ROLE_AVISO_CURSO_ID}>\n${description}`,eventUrl,booking,dateKey,eventId:event?.id||null};
}

async function announceTomorrowCourses(options={}){
  const test=options?.test===true;
  const tomorrowKey=await getTomorrowDateKeySaoPaulo();
  const eventData=await listDiscordScheduledEvents();
  if(!eventData.ok) return eventData;
  const bookings=await listTomorrowCourseBookings(tomorrowKey);
  let sent=0,skipped=0,failed=0,withEvent=0,withoutEvent=0;
  const details=[];
  for(const booking of bookings){
    let event=pickEventForBooking(eventData.events,booking);

    // Às 12:00 a Agenda é a fonte principal: se o evento ainda não existir,
    // tenta criar automaticamente antes de publicar o aviso.
    if(!event){
      try{
        const created=await ensureDiscordScheduledEventForBooking({
          ...booking,
          date_key: booking.date_key || booking.booking_date_key || booking.date
        });
        if(created?.ok && created.event){
          event=created.event;
          withEvent++;
          console.log(`[AVISOS CURSOS] Evento criado automaticamente | booking=${booking.id} | event=${created.event.id}`);
        }else if(created?.ok && (created.eventId || created.event_id)){
          // Recupera o evento recém-criado/reutilizado pelo ID para que o Embed
          // receba o link correto, sem depender de uma nova listagem.
          const eid=String(created.eventId||created.event_id);
          event={
            id:eid,
            name:String(booking.course||'Curso'),
            scheduled_start_time:created.scheduled_start_time || null,
            scheduled_end_time:created.scheduled_end_time || null
          };
          withEvent++;
          console.log(`[AVISOS CURSOS] Evento criado/reutilizado | booking=${booking.id} | event=${eid}`);
        }else{
          withoutEvent++;
          console.error(`[AVISOS CURSOS] Evento não criado | booking=${booking.id} | ${created?.reason||'motivo desconhecido'}`);
        }
      }catch(e){
        withoutEvent++;
        console.error(`[AVISOS CURSOS] Erro ao criar Evento Discord | booking=${booking.id}: ${e.message}`);
      }
    }else{
      withEvent++;
    }

    const announcementKey=`booking:${booking.id}`;
    const existing=await query(`SELECT discord_message_id FROM cip_discord_event_announcements WHERE event_id=$1 LIMIT 1`,[announcementKey]);
    if(existing.rowCount && !test){
      skipped++; details.push({booking_id:booking.id,name:booking.course,skipped:true,reason:'Já anunciado'}); continue;
    }
    try{
      const built=await buildCourseAnnouncementFromBooking(booking,event,eventData.guildId);
      const result=await discordNotify(built.message,'cipAvisos',{embed:built.embed,noAgendaButton:true});
      if(!result?.ok){
        failed++; details.push({booking_id:booking.id,name:booking.course,error:result?.reason||'Falha no Discord',event_created:Boolean(event)}); continue;
      }
      if(!test){
        await query(`INSERT INTO cip_discord_event_announcements(event_id,guild_id,channel_id,event_name,scheduled_start_time,discord_message_id,test_only) VALUES($1,$2,$3,$4,$5,$6,FALSE) ON CONFLICT(event_id) DO UPDATE SET guild_id=EXCLUDED.guild_id,channel_id=EXCLUDED.channel_id,event_name=EXCLUDED.event_name,scheduled_start_time=EXCLUDED.scheduled_start_time,discord_message_id=EXCLUDED.discord_message_id,announced_at=NOW(),test_only=FALSE`,[
          announcementKey,eventData.guildId,eventData.channelId,String(event?.name||booking.course||''),event?.scheduled_start_time || `${booking.date_key}T${String(booking.start_time||'').slice(0,8)}-03:00`,result.messageId||null
        ]);
      }
      sent++;
      details.push({booking_id:booking.id,name:booking.course,message_id:result.messageId||null,event_created:Boolean(event),event_id:event?.id||null,test});
    }catch(e){
      failed++; details.push({booking_id:booking.id,name:booking.course,error:e.message,event_created:Boolean(event)});
    }
  }
  return {ok:true,test,tomorrowKey,found:bookings.length,sent,skipped,failed,withEvent,withoutEvent,details};
}

function scheduleDiscordCourseAnnouncements(){
  const tz='America/Sao_Paulo'; let lastRunKey='';
  const getParts=()=>{const p=new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(new Date());const g=k=>p.find(x=>x.type===k)?.value||'';return {year:Number(g('year')),month:Number(g('month')),day:Number(g('day')),hour:Number(g('hour')),minute:Number(g('minute'))};};
  const check=async()=>{const p=getParts();const dateKey=`${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;const minute=Number(p.minute||0);if(Number(p.hour)!==12||minute>15||lastRunKey===dateKey)return;lastRunKey=dateKey;console.log(`[AVISOS CURSOS] Janela automática do meio-dia iniciada | ${dateKey} ${String(p.hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} America/Sao_Paulo`);for(let i=0;i<=15;i++){const rr=await announceTomorrowCourses();if(rr?.ok){console.log(`[AVISOS CURSOS] Verificação concluída | encontrados=${rr.found||0} enviados=${rr.sent||0} ignorados=${rr.skipped||0} com_evento=${rr.withEvent||0} sem_evento=${rr.withoutEvent||0}`);break;}if(i<15)await waitMs(60000);}};
  check().catch(e=>console.error('[AVISOS CURSOS] Verificação inicial:',e.message));
  setInterval(()=>check().catch(e=>console.error('[AVISOS CURSOS] Falha no agendador:',e.message)),60000);
}

app.post('/api/instruction-notices/discord-events/test', auth, async(req,res)=>{
  try{
    if(!isInstructionCoordinatorRole(req.user.role)) return res.status(403).json({error:'Somente Coordenadores de Instrução e Administradores podem testar os avisos automáticos de cursos.'});
    const result=await announceTomorrowCourses({test:true});
    if(!result?.ok) return res.status(502).json({error:result?.reason||'Não foi possível consultar a Agenda e os Eventos do Discord.'});
    await logAction(req.user.id,'AVISO_EVENTOS_DISCORD_TESTE',`Teste dos avisos automáticos de cursos • encontrados=${result.found||0} • enviados=${result.sent||0}`);
    res.json(result);
  }catch(e){console.error('[AVISOS CURSOS TESTE]',e);res.status(500).json({error:e.message||'Não foi possível testar os avisos automáticos.'});}
});

app.get('/api/changelog', auth, async (req,res)=>{
  try {
    const r=await query(`SELECT c.id,c.version,c.title,c.category,c.description,c.discord_message_id,c.created_at,u.name AS created_by_name
      FROM cip_changelog_entries c LEFT JOIN users u ON u.id=c.created_by ORDER BY c.created_at DESC LIMIT 50`);
    const channelId=await getChangelogChannelId();
    let guildId='';
    if(channelId){
      const token=String(process.env.DISCORD_BOT_TOKEN||'').trim();
      if(token){
        const cr=await fetch(`https://discord.com/api/v10/channels/${channelId}`,{headers:{Authorization:`Bot ${token}`}}).catch(()=>null);
        if(cr?.ok){const cd=await cr.json();guildId=String(cd.guild_id||'');}
      }
    }
    const discordUrl=(guildId&&channelId)?`https://discord.com/channels/${guildId}/${channelId}`:'';
    res.json({entries:r.rows,channelId,guildId,discordUrl});
  }catch(e){console.error('[CHANGELOG GET]',e);res.status(500).json({error:'Não foi possível carregar o Change Log.'});}
});


app.post('/api/admin/changelog', auth, managerAuth, coordinator, async (req,res)=>{
  try{
    const version=String(req.body?.version||'').trim();
    const title=String(req.body?.title||'').trim();
    const category=String(req.body?.category||'Sistema').trim()||'Sistema';
    const description=String(req.body?.description||'').trim();
    if(!version||!title||!description) return res.status(400).json({error:'Informe versão, título e descrição.'});
    if(version.length>40||title.length>120||category.length>60||description.length>3500) return res.status(400).json({error:'Um dos campos ultrapassou o limite permitido.'});
    const channelId=await getChangelogChannelId();
    if(!/^\d{17,20}$/.test(channelId)){
      return res.status(400).json({error:'DISCORD_CHANNEL_CHANGELOG_ID não está configurado no Render. Informe o ID da sala do Change Log nas Environment Variables.'});
    }
    const embed={
      title:`📋 Atualização ${version} — ${title}`,
      description,
      color:0xD9B85C,
      fields:[{name:'Categoria',value:category,inline:true},{name:'Versão',value:version,inline:true}],
      footer:{text:'CIP • Sistema de Gestão • Change Log'},
      timestamp:new Date().toISOString()
    };
    const result=await discordNotify('', 'changeLog', {embed});
    if(!result?.ok) return res.status(502).json({error:result?.reason||'Não foi possível publicar no Discord.'});
    const saved=await query(`INSERT INTO cip_changelog_entries(version,title,category,description,discord_message_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,version,title,category,description,discord_message_id,created_at`,[version,title,category,description,result.messageId||null,req.user.id]);
    await logAction(req.user.id,'CHANGELOG_PUBLICADO',`${version} — ${title}`);
    res.json({ok:true,entry:saved.rows[0],messageId:result.messageId,channelId});
  }catch(e){console.error('[CHANGELOG POST]',e);res.status(500).json({error:e.message||'Não foi possível publicar o Change Log.'});}
});

app.get("/api/discord/diagnostic", auth, async (req,res) => {
  try {
    const current = await getCurrentUser(req.user.id);
    if (!current || !isInstructionCoordinatorRole(current.role)) return res.status(403).json({error:"Acesso restrito."});
    const token = String(process.env.DISCORD_BOT_TOKEN || "").trim();
    if (!token) return res.json({ok:false,configured:false,message:"DISCORD_BOT_TOKEN não está configurado no Render."});
    const channelId = discordChannelId('recruitmentResults');
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {headers:{"Authorization":`Bot ${token}`}});
    const body = await response.text().catch(() => "");
    if (!response.ok) return res.status(response.status === 429 ? 429 : 502).json({ok:false,configured:true,status:response.status,message:`Discord respondeu HTTP ${response.status}.`});
    let data={}; try { data=JSON.parse(body); } catch {}
    res.json({ok:true,configured:true,status:response.status,name:data.name||null,channel_id:data.id||channelId,guild_id:data.guild_id||null,transport:"bot"});
  } catch(e) {
    console.error("Diagnóstico Discord Bot:",e.message);
    res.status(502).json({ok:false,message:`Não foi possível consultar o Discord pelo Bot: ${e.message}`});
  }
});

function buildCourseResultDiscordMessage(booking, participants, resultType = 'principal') {
  const approved = participants.filter(p => Number(p.score) >= 6);
  const reproved = participants.filter(p => Number(p.score) < 6);
  const linesApproved = approved.length ? approved.map(p => `• ${p.participant_name || p.name} (ID: ${p.participant_id || p.participantId || '—'}) — ${formatScoreBR(p.score)}`).join("\n") : "• Nenhum";
  const linesReproved = reproved.length ? reproved.map(p => `• ${p.participant_name || p.name} (ID: ${p.participant_id || p.participantId || '—'}) — ${formatScoreBR(p.score)}`).join("\n") : "• Nenhum";
  const isIntensive = String(booking.course || '').trim().toLowerCase() === 'intensivo';
  const stageLabel = resultType === 'acompanhamento' ? 'Acompanhamento' : resultType === 'abordagem' ? 'Abordagem' : resultType === 'modulacao' ? 'Modulação' : '';
  return `🎓 **RESULTADO DE CURSO${isIntensive ? ' — INTENSIVO' : ''}**\n📚 **Curso:** ${booking.course}${isIntensive ? `\n📌 **Etapa:** ${stageLabel}` : ''}\n👨‍🏫 **Instrutor:** ${booking.instructor_name}\n📅 **Data:** ${formatDateBR(booking.booking_date_key || booking.date)}\n⏰ **Horário:** ${formatTimeBR(booking.start_time)} - ${formatTimeBR(booking.end_time)}\n\n🟢 **APROVADOS — ${approved.length}**\n${linesApproved}\n\n🔴 **REPROVADOS — ${reproved.length}**\n${linesReproved}\n\n📊 **Total:** ${participants.length}`;
}

app.get("/api/health", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  try {
    await query("SELECT 1");
    res.status(200).json({ ok: true, service: "CIP", database: "connected" });
  } catch {
    res.status(503).json({ ok: false, service: "CIP", database: "disconnected" });
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
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id,role`,
      [name.trim(), normalizedUsername, hash, discord || "", cleanCityId, cleanCityPhone]
    );

    await logAction(result.rows[0].id, "CADASTRO_SOLICITADO", `Novo cadastro: ${name} (@${normalizedUsername})`);
    const pendingRole = String(result.rows[0]?.role || "instrutor").toLowerCase();
    const cadastroLabel = pendingRole.includes("recrut") ? "RECRUTADOR" : "INSTRUTOR";
    await discordNotify(
      `📝 **NOVO CADASTRO DE ${cadastroLabel}**\n👤 ${name}\n🔑 @${normalizedUsername}\n💬 ${discord || "Não informado"}\n⏳ Aguardando aprovação.`,
      "cadastros",
      { components: approvalButtons("user", result.rows[0].id) }
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

    // O nome exibido para a conta administrativa é fixo na interface.
    // Mantemos o nome original no banco para não alterar o cadastro/histórico.
    const displayName = user.role === "admin" ? "Administrador" : user.name;

    res.json({
      token: tokenFor(user),
      user: {
        id:user.id, name:displayName, username:user.username, email:user.email,
        discord:user.discord, rank:user.rank, role:user.role, avatar_data:user.avatar_data,
        recruitment_internal_role:user.recruitment_internal_role,
        instruction_internal_role:user.instruction_internal_role,
        must_change_password: Boolean(user.must_change_password)
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
    "SELECT id,name,username,email,discord,city_id,city_phone,rank,role,status,created_at,avatar_data,notification_preference,twitch_channel,twitch_user_id,twitch_enabled,must_change_password,recruitment_internal_role,instruction_internal_role FROM users WHERE id=$1",
    [req.user.id]
  );
  const user = result.rows[0];
  if (!user) return res.status(404).json({error:"Usuário não encontrado."});

  // A conta administrativa pode ter um nome antigo cadastrado no banco,
  // mas deve aparecer como Administrador em toda a sessão autenticada.
  if (user.role === "admin") user.name = "Administrador";

  res.json(user);
});


app.put("/api/me", auth, async (req,res) => {
  try {
    const { name, city_id, city_phone, discord, rank, avatar_data, password, notification_preference, twitch_channel, twitch_enabled } = req.body || {};
    const cleanName = String(name || "").trim();
    if (!cleanName) return res.status(400).json({error:"O nome é obrigatório."});
    if (cleanName.length > 120) return res.status(400).json({error:"O nome é muito longo."});
    if (discord && String(discord).length > 120) return res.status(400).json({error:"O Discord é muito longo."});
    const cleanCityId = String(city_id ?? "").replace(/\D/g, "").trim();
    const cleanCityPhone = String(city_phone ?? "").replace(/\D/g, "").trim();
    if (!/^\d+$/.test(cleanCityId)) return res.status(400).json({error:"O ID na cidade deve conter apenas números."});
    if (!/^\d{6}$/.test(cleanCityPhone)) return res.status(400).json({error:"O telefone da cidade deve estar no formato 000-000."});

    const allowedRanks = ["Sd.","Cb.","3º Sgt.","2º Sgt.","1º Sgt.","STen.","2º Ten.","1º Ten.","Cap.","Maj.","Ten.-Cel.","Cel.","Coronel","Outro"];
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
    const cleanTwitchChannel=normalizeTwitchChannel(twitch_channel===undefined?user.twitch_channel:twitch_channel);
    const cleanTwitchEnabled=twitch_enabled===undefined?Boolean(user.twitch_enabled):Boolean(twitch_enabled);
    await query(
      `UPDATE users
       SET name=$1, city_id=$2, city_phone=$3, discord=$4, rank=$5, avatar_data=$6, password_hash=$7, notification_preference=$8, twitch_channel=$9, twitch_enabled=$10
       WHERE id=$11`,
      [cleanName, cleanCityId, cleanCityPhone, discord ? String(discord).trim() : null, cleanRank, nextAvatar, passwordHash, cleanNotificationPreference, cleanTwitchChannel||null, cleanTwitchEnabled, req.user.id]
    );
    let twitchSync={ok:true,enabled:cleanTwitchEnabled};
    try{twitchSync=await syncTwitchSubscriptionForUser(req.user.id,cleanTwitchChannel,cleanTwitchEnabled);}catch(twitchError){console.error('[TWITCH PERFIL] Falha ao sincronizar canal:',twitchError.message);twitchSync={ok:false,enabled:cleanTwitchEnabled,reason:twitchError.message};if(cleanTwitchEnabled)await query(`UPDATE users SET twitch_enabled=FALSE WHERE id=$1`,[req.user.id]);}
    await logAction(req.user.id, "PERFIL_ATUALIZADO", "Dados pessoais atualizados");

    const updated = await query(
      "SELECT id,name,username,email,discord,city_id,city_phone,rank,role,status,created_at,avatar_data,notification_preference,twitch_channel,twitch_user_id,twitch_enabled FROM users WHERE id=$1",
      [req.user.id]
    );
    res.json({...updated.rows[0],twitch_sync:twitchSync});
  } catch (e) {
    console.error("Atualizar perfil:", e);
    res.status(500).json({error:"Não foi possível atualizar o perfil."});
  }
});

app.get("/api/dashboard", auth, async (req,res) => {
  const current = await getCurrentUser(req.user.id);
  if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});
  const isInstructor = ["instrutor","instrutor_recrutador"].includes(current.role);
  const active = await query(
    "SELECT COUNT(*)::int AS c FROM users WHERE role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','instrutor','instrutor_recrutador') AND status='approved'"
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
  // A semana do Dashboard deve ser exatamente a mesma semana exibida pela Agenda:
  // segunda-feira até domingo, considerando o calendário de São Paulo.
  // Antes, o cálculo usava hoje + 6 dias; isso fazia, por exemplo, a quinta-feira
  // contar quinta→quarta, enquanto a Agenda mostrava segunda→domingo.
  const week = await query(`
    SELECT COUNT(*)::int AS c
    FROM bookings
    WHERE date BETWEEN
      ($1::date - (EXTRACT(ISODOW FROM $1::date)::int - 1))::date
      AND
      ($1::date - (EXTRACT(ISODOW FROM $1::date)::int - 1) + INTERVAL '6 day')::date
      AND status NOT IN ('cancelled')`, [today]);
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
    FROM bookings b
    WHERE b.status='completed'
      AND (LOWER(TRIM(b.course)) IN ('recrutamento','formação','formacao') OR LOWER(TRIM(b.course)) ~ '^(recrutamento|formação|formacao)([[:space:]]|$)'
           OR EXISTS (SELECT 1 FROM course_results cr WHERE cr.booking_id=b.id))
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
  const next = await query(`SELECT b.*, to_char(b.date, 'YYYY-MM-DD') AS booking_date_key, u.name AS instructor_name
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
      (SELECT MAX(b_last.date)
       FROM bookings b_last
       WHERE b_last.instructor_id=u.id
         AND (
           LOWER(COALESCE(b_last.status,'')) IN ('completed','realized','realizado')
           OR EXISTS (
             SELECT 1
             FROM course_results cr_last
             WHERE cr_last.booking_id=b_last.id
           )
         )
      )::date::text AS last_course_date,
      COUNT(b.id) FILTER (WHERE b.status='cancelled')::int AS cancelled,
      (SELECT COUNT(*)::int FROM availability a WHERE a.instructor_id=u.id AND a.enabled=TRUE) AS availability_count
    FROM users u
    LEFT JOIN bookings b ON b.instructor_id=u.id
    WHERE u.role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','instrutor','instrutor_recrutador') AND u.status='approved'
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
    if (["instrutor","instrutor_recrutador"].includes(current.role)) {
      params.push(current.id);
      ownerFilter = `AND b.instructor_id=$${params.length}`;
    } else if (!isInstructionCoordinatorRole(current.role)) {
      return res.status(403).json({error:"Acesso restrito."});
    }

    const result = await query(`
      SELECT
        b.id,b.course,b.date,to_char(b.date, 'YYYY-MM-DD') AS booking_date_key,b.start_time,b.end_time,b.status,
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
        ), '[]'::json) AS participants,
        COALESCE((
          SELECT json_agg(json_build_object(
            'type',crs.result_type,
            'result_id',crs.id,
            'submitted_at',crs.submitted_at,
            'participants',COALESCE((SELECT json_agg(json_build_object(
              'id',rp2.id,'name',rp2.participant_name,'participant_id',rp2.participant_id,
              'score',rp2.score,'result',CASE WHEN rp2.score >= 6 THEN 'approved' ELSE 'reproved' END
            ) ORDER BY rp2.id) FROM course_result_participants rp2 WHERE rp2.result_id=crs.id),'[]'::json)
          ) ORDER BY CASE crs.result_type WHEN 'acompanhamento' THEN 1 WHEN 'abordagem' THEN 2 WHEN 'modulacao' THEN 3 ELSE 9 END)
          FROM course_results crs
          WHERE crs.booking_id=b.id AND crs.result_type <> 'principal'
        ), '[]'::json) AS intensive_results
      FROM bookings b
      JOIN users u ON u.id=b.instructor_id
      LEFT JOIN course_results cr ON cr.booking_id=b.id AND cr.result_type='principal'
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

app.post("/api/course-results/:bookingId/transfer", auth, async (req,res) => {
  const client = await pool.connect();
  try {
    const sourceBookingId = Number(req.params.bookingId);
    const targetBookingId = Number(req.body?.targetBookingId);
    if(!Number.isInteger(sourceBookingId) || !Number.isInteger(targetBookingId) || sourceBookingId === targetBookingId) {
      return res.status(400).json({error:"Origem ou destino inválido."});
    }
    const meRes = await client.query("SELECT id,name,role,status FROM users WHERE id=$1", [req.user.id]);
    const current = meRes.rows[0];
    if(!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});
    if(!isInstructionCoordinatorRole(current.role)) return res.status(403).json({error:"Somente Coordenadores de Instrução e Administradores podem transferir resultados."});

    const sourceRes = await client.query(`
      SELECT b.*,to_char(b.date, 'YYYY-MM-DD') AS booking_date_key,u.name AS instructor_name,cr.id AS result_id
      FROM bookings b JOIN users u ON u.id=b.instructor_id
      JOIN course_results cr ON cr.booking_id=b.id
      WHERE b.id=$1`, [sourceBookingId]);
    const source = sourceRes.rows[0];
    if(!source) return res.status(404).json({error:"Curso de origem ou resultado não encontrado."});
    const sourceParticipantsRes = await client.query(
      "SELECT participant_name,participant_id,score FROM course_result_participants WHERE result_id=$1 ORDER BY id",
      [source.result_id]
    );
    const sourceParticipants = sourceParticipantsRes.rows;

    const targetRes = await client.query(`
      SELECT b.*,to_char(b.date, 'YYYY-MM-DD') AS booking_date_key,u.name AS instructor_name,cr.id AS result_id
      FROM bookings b JOIN users u ON u.id=b.instructor_id
      LEFT JOIN course_results cr ON cr.booking_id=b.id
      WHERE b.id=$1`, [targetBookingId]);
    const target = targetRes.rows[0];
    if(!target) return res.status(404).json({error:"Curso de destino não encontrado."});
    if(target.result_id) return res.status(400).json({error:"O curso de destino já possui resultado lançado."});
    if(isSimpleCourseName(target.course)) return res.status(400).json({error:"Recrutamento e Formação não recebem lançamento de notas."});
    const targetStatus = String(target.status || '').trim().toLowerCase();
    // A transferência não exige que o curso de destino já esteja realizado.
    // O próprio processo de transferência transforma o destino em realizado,
    // pois o resultado está sendo corrigido para esse curso.
    // A única exigência é que o destino esteja aprovado/confirmado e ainda não possua resultado.
    if(!['approved','confirmed','completed'].includes(targetStatus)) return res.status(400).json({error:"O curso de destino precisa estar aprovado."});

    await client.query("BEGIN");
    await client.query("UPDATE course_results SET booking_id=$1 WHERE id=$2", [targetBookingId, source.result_id]);
    await client.query("UPDATE bookings SET status='confirmed' WHERE id=$1", [sourceBookingId]);
    await client.query("UPDATE bookings SET status='completed' WHERE id=$1", [targetBookingId]);
    await client.query("COMMIT");

    await logAction(current.id,"RESULTADO_TRANSFERIDO",`${source.course} (${source.date} ${source.start_time}) → ${target.course} (${target.date} ${target.start_time})`);

    const approved = sourceParticipants.filter(p => Number(p.score) >= 6);
    const reproved = sourceParticipants.filter(p => Number(p.score) < 6);
    const linesApproved = approved.length ? approved.map(p => `• ${p.participant_name} (ID: ${p.participant_id || '—'}) — ${formatScoreBR(p.score)}`).join('\n') : '• Nenhum';
    const linesReproved = reproved.length ? reproved.map(p => `• ${p.participant_name} (ID: ${p.participant_id || '—'}) — ${formatScoreBR(p.score)}`).join('\n') : '• Nenhum';
    await discordNotify(
      `🔄 **RESULTADO TRANSFERIDO — CURSO CORRETO**\n📚 **Curso:** ${target.course}\n👨‍🏫 **Instrutor:** ${target.instructor_name}\n📅 **Data:** ${formatDateBR(target.booking_date_key || target.date)}\n⏰ **Horário:** ${formatTimeBR(target.start_time)} - ${formatTimeBR(target.end_time)}\n\n📌 **Origem corrigida:** ${source.course} — ${formatDateBR(source.booking_date_key || source.date)}\n\n🟢 **APROVADOS — ${approved.length}**\n${linesApproved}\n\n🔴 **REPROVADOS — ${reproved.length}**\n${linesReproved}\n\n📊 **Total:** ${sourceParticipants.length}`,
      "results"
    );
    await notifyUsers([target.instructor_id, target.created_by], "result", "Resultado transferido", `O resultado de ${target.course} (${formatDateBR(target.booking_date_key || target.date)}) foi transferido para o curso correto.`);
    res.json({ok:true,sourceBookingId,targetBookingId,discordNotified:true});
  } catch(e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Transferir resultado:",e);
    res.status(500).json({error:"Não foi possível transferir o resultado."});
  } finally { client.release(); }
});

app.post("/api/course-results/:bookingId", auth, async (req,res) => {
  const client = await pool.connect();
  try {
    const bookingId = Number(req.params.bookingId);
    const participants = Array.isArray(req.body?.participants) ? req.body.participants : [];
    const requestedResultType = String(req.body?.resultType || 'principal').trim().toLowerCase();
    const intensiveTypes = ['acompanhamento','abordagem','modulacao'];
    if (!Number.isInteger(bookingId)) return res.status(400).json({error:"Curso inválido."});
    if (!participants.length) return res.status(400).json({error:"Adicione pelo menos um participante."});

    const currentRes = await client.query("SELECT id,name,role,status FROM users WHERE id=$1", [req.user.id]);
    const current = currentRes.rows[0];
    if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});
    if (!(isInstructionCoordinatorRole(current.role) || ["instrutor","instrutor_recrutador"].includes(current.role))) return res.status(403).json({error:"Acesso restrito."});

    const bookingRes = await client.query(`
      SELECT b.*,to_char(b.date, 'YYYY-MM-DD') AS booking_date_key,u.name AS instructor_name
      FROM bookings b JOIN users u ON u.id=b.instructor_id
      WHERE b.id=$1`, [bookingId]);
    const booking = bookingRes.rows[0];
    if (!booking) return res.status(404).json({error:"Marcação não encontrada."});
    const simpleCourse = isSimpleCourseName(booking.course);
    if (simpleCourse) return res.status(400).json({error:"Recrutamento e Formação não possuem lançamento de notas. Marque o curso como realizado."});
    if (!["confirmed","completed"].includes(String(booking.status).toLowerCase())) {
      return res.status(400).json({error:"Somente cursos aprovados podem receber resultado."});
    }
    if ((current.role === "instrutor" || current.role === "instrutor_recrutador") && Number(booking.instructor_id) !== Number(current.id)) {
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

    const resultType = String(booking.course || '').trim().toLowerCase() === 'intensivo'
      ? requestedResultType
      : 'principal';
    if (String(booking.course || '').trim().toLowerCase() === 'intensivo' && !intensiveTypes.includes(resultType)) {
      return res.status(400).json({error:'Para o curso Intensivo, escolha Acompanhamento, Abordagem ou Modulação.'});
    }
    if (String(booking.course || '').trim().toLowerCase() !== 'intensivo' && requestedResultType !== 'principal') {
      return res.status(400).json({error:'Este curso possui apenas um resultado.'});
    }

    await client.query("BEGIN");
    const resultRes = await client.query(`
      INSERT INTO course_results(booking_id,result_type,submitted_by,submitted_at)
      VALUES($1,$2,$3,NOW())
      ON CONFLICT (booking_id,result_type)
      DO UPDATE SET submitted_by=EXCLUDED.submitted_by,submitted_at=NOW()
      RETURNING id`, [bookingId,resultType,current.id]);
    const resultId = resultRes.rows[0].id;

    await client.query("DELETE FROM course_result_participants WHERE result_id=$1", [resultId]);
    for (const p of clean) {
      await client.query(
        "INSERT INTO course_result_participants(result_id,participant_name,participant_id,score) VALUES($1,$2,$3,$4)",
        [resultId,p.name,p.participantId,p.score.toFixed(2)]
      );
    }
    if (String(booking.course || '').trim().toLowerCase() === 'intensivo') {
      const stageCount = await client.query(
        "SELECT COUNT(*)::int AS c FROM course_results WHERE booking_id=$1 AND result_type IN ('acompanhamento','abordagem','modulacao')",
        [bookingId]
      );
      await client.query("UPDATE bookings SET status=$2 WHERE id=$1", [bookingId, Number(stageCount.rows[0].c) === 3 ? 'completed' : 'confirmed']);
    } else {
      await client.query("UPDATE bookings SET status='completed' WHERE id=$1", [bookingId]);
    }
    await client.query("COMMIT");

    const approved = clean.filter(p=>p.score >= 6);
    const reproved = clean.filter(p=>p.score < 6);
    const isIntensive = String(booking.course || '').trim().toLowerCase() === 'intensivo';
    const stageLabel = resultType === 'acompanhamento' ? 'Acompanhamento' : resultType === 'abordagem' ? 'Abordagem' : resultType === 'modulacao' ? 'Modulação' : '';
    const discordContent = buildCourseResultDiscordMessage(booking, clean, resultType);
    const discordResult = await discordNotify(discordContent, "results");
    const discordNotified = discordResult.ok;
    if (!discordNotified && discordResult.rateLimited) {
      await enqueueDiscordResult(bookingId, resultType, discordContent, discordResult.reason || "429");
    }
    await logAction(current.id,"RESULTADO_CURSO_LANCADO",`${booking.course}${isIntensive ? ` / ${stageLabel}` : ''} - ${booking.date} - ${approved.length} aprovados / ${reproved.length} reprovados${discordNotified ? ' - Discord enviado' : discordResult.rateLimited ? ' - Discord em fila por limite' : ' - Discord pendente'}`);
    await notifyUsers([booking.instructor_id, booking.created_by], "result", "Resultado disponível", `O resultado de ${booking.course}${isIntensive ? ` / ${stageLabel}` : ''} (${formatDateBR(booking.booking_date_key || booking.date)}) foi lançado: ${approved.length} aprovados e ${reproved.length} reprovados.`);

    res.json({ok:true,result_id:resultId,approved:approved.length,reproved:reproved.length,discordNotified});
  } catch(e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Salvar resultado:",e);
    res.status(500).json({error:"Não foi possível salvar o resultado."});
  } finally {
    client.release();
  }
});

app.post("/api/course-results/:bookingId/resend-discord", auth, async (req,res) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const requestedResultType = String(req.body?.resultType || 'principal').trim().toLowerCase();
    const allowedTypes = ['principal','acompanhamento','abordagem','modulacao'];
    if (!Number.isInteger(bookingId) || !allowedTypes.includes(requestedResultType)) return res.status(400).json({error:"Curso ou etapa inválidos."});

    const meRes = await query("SELECT id,role,status FROM users WHERE id=$1", [req.user.id]);
    const current = meRes.rows[0];
    if (!current || current.status !== 'approved') return res.status(403).json({error:"Usuário sem acesso aprovado."});
    if (!(isInstructionCoordinatorRole(current.role) || ['instrutor','instrutor_recrutador'].includes(current.role))) return res.status(403).json({error:"Acesso restrito."});

    const bookingRes = await query(`
      SELECT b.id,b.course,b.date,to_char(b.date,'YYYY-MM-DD') AS booking_date_key,b.start_time,b.end_time,b.instructor_id,
             u.name AS instructor_name
      FROM bookings b JOIN users u ON u.id=b.instructor_id WHERE b.id=$1`, [bookingId]);
    const booking = bookingRes.rows[0];
    if (!booking) return res.status(404).json({error:"Curso não encontrado."});
    if ((current.role === 'instrutor' || current.role === 'instrutor_recrutador') && Number(booking.instructor_id) !== Number(current.id)) return res.status(403).json({error:"Você só pode reenviar resultados dos seus próprios cursos."});

    const courseKey = String(booking.course || '').trim().toLowerCase();
    const resultType = courseKey === 'intensivo' ? requestedResultType : 'principal';
    if (courseKey !== 'intensivo' && requestedResultType !== 'principal') return res.status(400).json({error:"Este curso possui apenas um resultado."});
    const resultRes = await query(`
      SELECT cr.id,cr.result_type,
        COALESCE(json_agg(json_build_object('participant_name',rp.participant_name,'participant_id',rp.participant_id,'score',rp.score) ORDER BY rp.id) FILTER (WHERE rp.id IS NOT NULL),'[]'::json) AS participants
      FROM course_results cr
      LEFT JOIN course_result_participants rp ON rp.result_id=cr.id
      WHERE cr.booking_id=$1 AND cr.result_type=$2
      GROUP BY cr.id,cr.result_type`, [bookingId,resultType]);
    const result = resultRes.rows[0];
    if (!result) return res.status(404).json({error:"Nenhum resultado lançado para este curso/etapa."});
    const participants = Array.isArray(result.participants) ? result.participants : [];
    if (!participants.length) return res.status(400).json({error:"O resultado não possui participantes para enviar."});

    const discordContent = buildCourseResultDiscordMessage(booking, participants, resultType);
    const discordResult = await discordNotify(discordContent, 'results');
    if (!discordResult.ok) {
      if (discordResult.rateLimited) {
        await enqueueDiscordResult(bookingId, resultType, discordContent, discordResult.reason || "429");
        return res.status(429).json({error:`${discordResult.reason} O resultado foi colocado na fila e será tentado automaticamente quando o limite liberar.`,retryAfter:discordResult.retryAfter,queued:true});
      }
      return res.status(502).json({error:`${discordResult.reason || "Não foi possível enviar ao Discord."} Verifique DISCORD_BOT_TOKEN e as permissões do Bot no Render/Discord e tente novamente.`});
    }
    await logAction(current.id,'RESULTADO_CURSO_REENVIADO_DISCORD',`${booking.course}${courseKey === 'intensivo' ? ` / ${resultType}` : ''} - ${booking.date}`);
    res.json({ok:true,discordNotified:true,result_id:result.id});
  } catch(e) {
    console.error('Reenviar resultado ao Discord:',e);
    res.status(500).json({error:'Não foi possível reenviar o resultado ao Discord.'});
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
  const { rank, role } = req.body || {};
  const r = await query("SELECT * FROM users WHERE id=$1", [id]);
  const u = r.rows[0];
  if (!u) return res.status(404).json({error:"Usuário não encontrado."});

  const allowedRanks = ["Sd.","Cb.","3º Sgt.","2º Sgt.","1º Sgt.","STen.","2º Ten.","1º Ten.","Cap.","Maj.","Ten.-Cel.","Cel.","Coronel","Outro"];
  const cleanRank = allowedRanks.includes(String(rank || "")) ? String(rank) : "Sd.";
  const allowedRoles = ["instrutor","coordenador","coordenador_instrucao","coordenador_recrutamentos","recrutador","instrutor_recrutador"];
  if (role !== undefined && !allowedRoles.includes(String(role))) {
    if (String(role) === "admin" && req.user.role === "admin") {
      // Administrador pode aprovar outro administrador.
    } else {
      return res.status(400).json({error:"Cargo inválido ou sem permissão para este cargo."});
    }
  }
  const cleanRole = role === undefined ? (u.role || "instrutor") : String(role);
  await query(
    "UPDATE users SET status='approved', rank=$2, role=$3, approved_at=NOW() WHERE id=$1",
    [id, cleanRank, cleanRole]
  );
  await logAction(req.user.id, "USUARIO_APROVADO", `Aprovado: ${u.name}`);
  await createNotification(id, "success", "Cadastro aprovado", "Seu cadastro foi aprovado. Você já pode acessar o sistema.");
  await discordNotify(`✅ **CADASTRO APROVADO**\n👤 ${u.name}\n🔑 @${u.username}`, "cadastros");
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
  await discordNotify(`❌ **CADASTRO RECUSADO**\n👤 ${u.name}\n🔑 @${u.username}`, "cadastros");
  res.json({ok:true});
});



app.get("/api/weekly-activity", auth, managerAuth, coordinator, async (req,res) => {
  try {
    const start = String(req.query?.start_date || "").trim();
    const end = String(req.query?.end_date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
      return res.status(400).json({error:"Período semanal inválido."});
    }

    const [usersResult, bookingsResult, absencesResult] = await Promise.all([
      query(`
        SELECT id,name,username,city_id,rank,role,status,avatar_data
        FROM users
        WHERE status='approved'
          AND role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','instrutor','instrutor_recrutador','admin')
        ORDER BY CASE WHEN role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','admin') THEN 0 ELSE 1 END, name
      `),
      query(`
        SELECT b.id,b.instructor_id,b.date,
               to_char(b.date,'YYYY-MM-DD') AS booking_date_key,
               b.start_time,b.end_time,b.course,'' AS room,b.status
        FROM bookings b
        WHERE b.date >= $1::date
          AND b.date <= $2::date
          AND LOWER(COALESCE(b.status,''))='completed'
        ORDER BY b.date,b.start_time,b.id
      `,[start,end]),
      query(`
        SELECT a.id,a.user_id,a.name,a.city_id,
               to_char(a.start_date,'YYYY-MM-DD') AS start_date,
               to_char(a.end_date,'YYYY-MM-DD') AS end_date,
               a.reason
        FROM absences a
        JOIN users u ON u.id=a.user_id
        WHERE u.status='approved'
          AND a.start_date <= $2::date
          AND a.end_date >= $1::date
        ORDER BY a.start_date,a.end_date,a.name
      `,[start,end])
    ]);

    res.json({
      users: usersResult.rows,
      bookings: bookingsResult.rows,
      absences: absencesResult.rows
    });
  } catch (e) {
    console.error("GET /api/weekly-activity:", e);
    res.status(500).json({error:"Não foi possível carregar o controle de atuação semanal."});
  }
});

app.get("/api/users", auth, managerAuth, coordinator, async (req,res) => {
  const result = await query(`
    SELECT u.id,u.name,u.username,u.email,u.discord,u.city_id,u.city_phone,u.rank,u.role,u.status,u.created_at,u.approved_at,u.avatar_data,u.instruction_internal_role,
      COUNT(b.id)::int AS bookings,
      COUNT(b.id) FILTER (WHERE b.status='completed')::int AS completed,
      (SELECT MAX(b_last.date)
       FROM bookings b_last
       WHERE b_last.instructor_id=u.id
         AND (
           LOWER(COALESCE(b_last.status,'')) IN ('completed','realized','realizado')
           OR EXISTS (
             SELECT 1
             FROM course_results cr_last
             WHERE cr_last.booking_id=b_last.id
           )
         )
      )::date::text AS last_course_date,
      COUNT(b.id) FILTER (WHERE b.status='cancelled')::int AS cancelled,
      (SELECT COUNT(*)::int FROM availability a WHERE a.instructor_id=u.id AND a.enabled=TRUE) AS availability_count
    FROM users u
    LEFT JOIN bookings b ON b.instructor_id=u.id
    WHERE u.role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','instrutor','instrutor_recrutador','admin')
    GROUP BY u.id
    ORDER BY CASE WHEN u.status='approved' THEN 0 ELSE 1 END,
             CASE WHEN u.role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos') THEN 0 WHEN u.role IN ('instrutor','instrutor_recrutador') THEN 1 ELSE 2 END,
             u.name
  `);
  res.json(result.rows);
});


app.post("/api/auth/password-reset-request", async (req,res) => {
  try {
    const normalizedUsername = String(req.body?.username || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(normalizedUsername))
      return res.status(400).json({error:"Informe um usuário válido."});

    const r = await query(
      "SELECT id,name,username,status FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1",
      [normalizedUsername]
    );
    const user = r.rows[0];

    // Não revela se o usuário existe.
    if (user && user.status === "approved") {
      const pending = await query(
        "SELECT id FROM password_reset_requests WHERE user_id=$1 AND status='pending' LIMIT 1",
        [user.id]
      );
      if (pending.rowCount === 0) {
        await query(
          `INSERT INTO password_reset_requests(user_id,username,requester_name)
           VALUES($1,$2,$3)`,
          [user.id, user.username, user.name || ""]
        );

        // Avisar imediatamente todos os administradores/coordenadores aprovados.
        await notifyManagers(
          "danger",
          "Nova recuperação de senha",
          `${user.name || user.username} (@${user.username}) solicitou uma nova senha.`
        );

        // Também registra no canal de Cadastros pelo Bot.
        await discordNotify(
          `🔐 **SOLICITAÇÃO DE RECUPERAÇÃO DE SENHA**\n👤 **Usuário:** ${user.name || user.username}\n🔑 **@${user.username}**\n⏳ Aguardando ação do administrador.`
        );
      }
    }

    res.json({
      ok:true,
      message:"Se o usuário estiver cadastrado e aprovado, a solicitação foi registrada para análise do administrador."
    });
  } catch(e) {
    console.error("Password reset request:",e);
    res.status(500).json({error:"Não foi possível registrar a solicitação agora."});
  }
});


app.patch("/api/auth/password", auth, async (req,res) => {
  try {
    const password = String(req.body?.password || "");
    if (password.length < 6)
      return res.status(400).json({error:"A senha precisa ter pelo menos 6 caracteres."});

    const hash = await bcrypt.hash(password, 10);
    await query(
      "UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE id=$2",
      [hash, req.user.id]
    );
    await logAction(req.user.id, "SENHA_ALTERADA_PRIMEIRO_ACESSO", "Usuário definiu uma nova senha.");
    res.json({ok:true,message:"Senha alterada com sucesso."});
  } catch(e) {
    console.error("Change own password:",e);
    res.status(500).json({error:"Não foi possível alterar a senha."});
  }
});

app.get("/api/admin/password-reset-requests", auth, managerAuth, coordinator, async (req,res) => {
  try {
    const r = await query(`
      SELECT pr.id, pr.user_id, pr.username, pr.requester_name, pr.created_at,
             u.name, u.status AS user_status
      FROM password_reset_requests pr
      LEFT JOIN users u ON u.id=pr.user_id
      WHERE pr.status='pending'
      ORDER BY pr.created_at ASC
    `);
    res.json(r.rows);
  } catch(e) {
    console.error("Password reset requests:",e);
    res.status(500).json({error:"Não foi possível carregar as solicitações de recuperação."});
  }
});

app.post("/api/admin/password-reset-requests/:id/resolve", auth, managerAuth, coordinator, async (req,res) => {
  try {
    const requestId = Number(req.params.id);
    const password = String(req.body?.password || "");
    if (!Number.isInteger(requestId) || requestId <= 0)
      return res.status(400).json({error:"Solicitação inválida."});
    if (password.length < 6)
      return res.status(400).json({error:"A nova senha precisa ter pelo menos 6 caracteres."});

    const r = await query(
      "SELECT id,user_id,username,status FROM password_reset_requests WHERE id=$1 LIMIT 1",
      [requestId]
    );
    const request = r.rows[0];
    if (!request || request.status !== "pending")
      return res.status(404).json({error:"Solicitação não encontrada ou já resolvida."});
    if (!request.user_id)
      return res.status(400).json({error:"O usuário desta solicitação não existe mais."});

    const u = await query("SELECT id,name,username FROM users WHERE id=$1", [request.user_id]);
    const user = u.rows[0];
    if (!user) return res.status(404).json({error:"Usuário não encontrado."});

    const hash = await bcrypt.hash(password, 10);
    await query("UPDATE users SET password_hash=$1, must_change_password=TRUE WHERE id=$2", [hash, user.id]);
    await query(
      `UPDATE password_reset_requests
       SET status='resolved', resolved_at=NOW(), resolved_by=$1
       WHERE id=$2`,
      [req.user.id, requestId]
    );
    await logAction(req.user.id, "RECUPERACAO_SENHA_RESOLVIDA", `${user.name} (@${user.username})`);
    res.json({ok:true,username:user.username,message:"Senha redefinida e solicitação concluída."});
  } catch(e) {
    console.error("Resolve password reset:",e);
    res.status(500).json({error:"Não foi possível redefinir a senha."});
  }
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

    const allowedRoles = ['instrutor','coordenador','coordenador_instrucao','coordenador_recrutamentos','recrutador','instrutor_recrutador'];
    const finalRole = allowedRoles.includes(role) ? role : 'instrutor';
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
    if (!["coordenador","coordenador_instrucao","coordenador_recrutamentos","instrutor","recrutador","instrutor_recrutador"].includes(role))
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
    if (role !== undefined && !["instrutor","coordenador","coordenador_instrucao","coordenador_recrutamentos","recrutador","instrutor_recrutador"].includes(role)) return res.status(400).json({error:"Cargo inválido."});
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

app.patch("/api/admin/users/:id/instruction-role", auth, managerAuth, coordinator, async (req,res) => {
  try {
    if (!canManageInstructionTeam(req.currentUser) || !isInstructionCoordinatorRole(req.currentUser.role)) {
      return res.status(403).json({error:"Somente administradores e coordenadores principais podem alterar o cargo interno de Instrutores."});
    }
    const id = Number(req.params.id);
    const internalRole = normalizeInstructionInternalRole(req.body?.instruction_internal_role);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({error:"Usuário inválido."});
    if (!INSTRUCTION_INTERNAL_ROLES.includes(internalRole)) return res.status(400).json({error:"Cargo interno de Instrutor inválido."});
    const target = await query("SELECT id,name,role,instruction_internal_role FROM users WHERE id=$1 AND status='approved'", [id]);
    if (!target.rowCount) return res.status(404).json({error:"Integrante não encontrado."});
    if (!['admin','coordenador','coordenador_instrucao','coordenador_recrutamentos','instrutor','instrutor_recrutador'].includes(String(target.rows[0].role||'').toLowerCase())) {
      return res.status(400).json({error:"O integrante não pertence à equipe de Instrutores."});
    }
    await query("UPDATE users SET instruction_internal_role=$1 WHERE id=$2", [internalRole,id]);
    await logAction(req.user.id, "CARGO_INTERNO_INSTRUTOR_ALTERADO", `${target.rows[0].name}: ${target.rows[0].instruction_internal_role || 'instrutor'} → ${internalRole}`);
    res.json({ok:true,instruction_internal_role:internalRole});
  } catch(e) {
    console.error("PATCH cargo interno Instrutor:",e);
    res.status(500).json({error:"Não foi possível alterar o cargo interno do Instrutor."});
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
    SELECT b.*, to_char(b.date, 'YYYY-MM-DD') AS booking_date_key, u.name AS instructor_name, u.avatar_data AS instructor_avatar,
           rr.recruitment_number, rr.id AS recruitment_id, rr.title AS recruitment_title,
           EXISTS(SELECT 1 FROM course_results cr WHERE cr.booking_id=b.id) AS result_id
    FROM bookings b JOIN users u ON u.id=b.instructor_id
    LEFT JOIN cip_recruitments rr ON rr.booking_id=b.id AND rr.official=TRUE
    ORDER BY b.date,b.start_time`);
  res.json(result.rows);
});

app.post("/api/bookings", auth, async (req,res) => {
  const client = await pool.connect();
  try {
    const { instructor_id,date,start_time,end_time,notes,course,recurrence } = req.body || {};
    const bookingDate = normalizeDateKey(date);
    if (!instructor_id || !bookingDate || !start_time || !end_time || !course)
      return res.status(400).json({error:"Preencha curso, instrutor, data e horários."});

    const current = await getCurrentUser(req.user.id);
    if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});
    const manager = isInstructionCoordinatorRole(current.role);
    if (!manager && Number(instructor_id) !== Number(current.id)) {
      return res.status(403).json({error:"Instrutores só podem agendar cursos para si mesmos."});
    }
    const targetResult = await query(
      "SELECT id,name,role FROM users WHERE id=$1 AND role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','instrutor','instrutor_recrutador') AND status='approved'",
      [instructor_id]
    );
    const target = targetResult.rows[0];
    if (!target) return res.status(400).json({error:"Membro inválido."});
    if (String(start_time) >= String(end_time))
      return res.status(400).json({error:"O horário de término deve ser maior que o horário de início."});

    const isRecurring = !!recurrence?.enabled;
    let dates = [bookingDate];
    let recurrenceUntil = bookingDate;
    if (isRecurring) {
      recurrenceUntil = normalizeDateKey(recurrence.until);
      if (!recurrenceUntil) return res.status(400).json({error:"Informe até qual data a marcação deve se repetir."});
      if (recurrenceUntil < bookingDate) return res.status(400).json({error:"A data final da recorrência deve ser igual ou posterior à data inicial."});
      const start = new Date(`${bookingDate}T12:00:00Z`);
      const until = new Date(`${recurrenceUntil}T12:00:00Z`);
      const days = Math.round((until-start)/86400000);
      if (days > 366) return res.status(400).json({error:"A recorrência pode ter no máximo 1 ano."});
      for(let i=7;i<=days;i+=7){
        const d=new Date(start.getTime()+i*86400000);
        dates.push(d.toISOString().slice(0,10));
      }
    }

    // Regra da agenda: dois cursos não podem começar no mesmo dia e horário,
    // independentemente do instrutor. A duração de cada curso é livre.
    await client.query("BEGIN");
    for (const d of dates) {
      const conflict = await client.query(`
        SELECT b.id, b.course, b.start_time, b.end_time, u.name AS instructor_name
        FROM bookings b
        JOIN users u ON u.id=b.instructor_id
        WHERE b.date=$1 AND b.start_time=$2 AND b.status!='cancelled'
        LIMIT 1`, [d,start_time]);
      if (conflict.rowCount) {
        const existing = conflict.rows[0];
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:`Já existe uma marcação iniciando às ${formatTimeBR(start_time)} no dia ${formatDateBR(d)}: ${existing.course || "Curso"} — ${existing.instructor_name || "Instrutor"}. Escolha outro horário de início.`,
          conflict_date:d
        });
      }
    }

    const recurrenceGroupId = isRecurring ? `REC-${Date.now()}-${req.user.id}` : null;
    const created=[];
    for (const d of dates) {
      const result = await client.query(`
        INSERT INTO bookings(instructor_id,date,start_time,end_time,notes,course,status,created_by,recurrence_group_id)
        VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8) RETURNING id`,
        [instructor_id,d,start_time,end_time,notes||"",course,req.user.id,recurrenceGroupId]
      );
      created.push({id:result.rows[0].id,date:d});
    }
    await client.query("COMMIT");

    await logAction(
      req.user.id,
      isRecurring ? "MARCACAO_RECORRENTE_CRIADA" : "MARCACAO_CRIADA",
      `${course} - ${target.name} - ${bookingDate} ${start_time}-${end_time}${isRecurring?` - ${dates.length} ocorrências até ${recurrenceUntil}`:""}`
    );

    if (isRecurring) {
      await discordNotify(
        `📅 **NOVA MARCAÇÃO RECORRENTE**\n📚 **Curso:** ${course}\n👨‍🏫 **Instrutor:** ${target.name}\n📅 **Início:** ${formatDateBR(bookingDate)}\n📅 **Até:** ${formatDateBR(recurrenceUntil)}\n⏰ **Horário:** ${formatTimeBR(start_time)} - ${formatTimeBR(end_time)}\n🔁 **Recorrência:** semanal\n📌 **Ocorrências:** ${dates.length}\n🟡 **Status:** PENDENTE`,
        "newBooking",
        { components: approvalButtons("booking", created[0]?.id) }
      );
      await notifyManagers("booking", "Nova marcação recorrente", `${course} • ${target.name} • ${dates.length} ocorrências semanais a partir de ${formatDateBR(bookingDate)}. Aguarda aprovação.`, req.user.id);
    } else {
      await discordNotify(
        `📅 **NOVA MARCAÇÃO**\n📚 **Curso:** ${course}\n👨‍🏫 **Instrutor:** ${target.name}\n📅 **Data:** ${formatDateBR(bookingDate)}\n⏰ **Horário:** ${formatTimeBR(start_time)} - ${formatTimeBR(end_time)}\n🟡 **Status:** PENDENTE`,
        "newBooking",
        { components: approvalButtons("booking", created[0]?.id) }
      );
      await notifyManagers("booking", "Nova marcação", `${course} • ${target.name} • ${formatDateBR(bookingDate)} às ${formatTimeBR(start_time)}. Aguarda aprovação.`, req.user.id);
    }

    res.json({ok:true,id:created[0].id,ids:created.map(x=>x.id),count:created.length,recurring:isRecurring,recurrence_group_id:recurrenceGroupId});
  } catch(e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error(e);
    res.status(500).json({error:"Não foi possível criar a marcação."});
  } finally {
    client.release();
  }
});


app.put("/api/bookings/:id", auth, coordinator, async (req,res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({error:"ID de marcação inválido."});

    const { instructor_id, date, start_time, end_time, notes, course, edit_scope="single", recurrence } = req.body || {};
    const bookingDate = normalizeDateKey(date);
    if (!instructor_id || !bookingDate || !start_time || !end_time || !course)
      return res.status(400).json({error:"Preencha curso, instrutor, data e horários."});
    if (String(start_time) >= String(end_time))
      return res.status(400).json({error:"O horário de término deve ser maior que o horário de início."});
    if (!['single','future','series'].includes(edit_scope))
      return res.status(400).json({error:"Escopo de edição inválido."});

    const current = await getCurrentUser(req.user.id);
    if (!current || current.status !== "approved" || !isInstructionCoordinatorRole(current.role))
      return res.status(403).json({error:"Somente Coordenadores e Administradores podem editar marcações."});

    const found = await query(`
      SELECT b.*, to_char(b.date, 'YYYY-MM-DD') AS booking_date_key, u.name AS instructor_name
      FROM bookings b JOIN users u ON u.id=b.instructor_id WHERE b.id=$1`, [id]);
    if (!found.rowCount) return res.status(404).json({error:"Marcação não encontrada."});
    const original = found.rows[0];
    if (original.status === 'cancelled') return res.status(400).json({error:"Não é possível editar uma marcação cancelada."});

    const groupId = original.recurrence_group_id || null;
    const convertToRecurring = !groupId && !!recurrence?.enabled;
    if (convertToRecurring && edit_scope !== 'single')
      return res.status(400).json({error:"Para transformar uma marcação normal em recorrente, use 'Somente esta ocorrência'."});
    if (edit_scope !== 'single' && !groupId)
      return res.status(400).json({error:"Esta marcação não pertence a uma recorrência."});

    let recurrenceUntil = null;
    let recurrenceDates = [bookingDate];
    if (convertToRecurring) {
      recurrenceUntil = normalizeDateKey(recurrence.until);
      if (!recurrenceUntil) return res.status(400).json({error:"Informe até qual data a marcação deve se repetir."});
      if (recurrenceUntil < bookingDate) return res.status(400).json({error:"A data final da recorrência deve ser igual ou posterior à data da marcação."});
      const start = new Date(`${bookingDate}T12:00:00Z`);
      const until = new Date(`${recurrenceUntil}T12:00:00Z`);
      const days = Math.round((until-start)/86400000);
      if (days > 366) return res.status(400).json({error:"A recorrência pode ter no máximo 1 ano."});
      for (let i=7;i<=days;i+=7) {
        const d=new Date(start.getTime()+i*86400000);
        recurrenceDates.push(d.toISOString().slice(0,10));
      }
    }

    const targetResult = await query(
      "SELECT id,name,role FROM users WHERE id=$1 AND role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','instrutor','instrutor_recrutador') AND status='approved'",
      [instructor_id]
    );
    const target = targetResult.rows[0];
    if (!target) return res.status(400).json({error:"Membro inválido."});

    let scopeWhere = 'b.id=$1';
    let scopeParams = [id];
    if (edit_scope === 'future') {
      scopeWhere = 'b.recurrence_group_id=$1 AND b.date >= $2::date';
      scopeParams = [groupId, original.booking_date_key || original.date];
    } else if (edit_scope === 'series') {
      scopeWhere = 'b.recurrence_group_id=$1';
      scopeParams = [groupId];
    }

    const affected = await query(`
      SELECT b.id, to_char(b.date,'YYYY-MM-DD') AS booking_date_key, b.start_time, b.end_time,
             b.course, b.instructor_id, b.status, u.name AS instructor_name
      FROM bookings b JOIN users u ON u.id=b.instructor_id
      WHERE ${scopeWhere}
      ORDER BY b.date,b.start_time,b.id`, scopeParams);
    if (!affected.rowCount) return res.status(404).json({error:"Nenhuma ocorrência encontrada para editar."});

    // Para edições em uma única ocorrência, a data também pode ser alterada.
    // Em uma recorrência inteira/futura, preservamos as datas das ocorrências e alteramos os demais dados.
    const updatesDate = edit_scope === 'single' ? bookingDate : null;

    await client.query("BEGIN");
    const rowsToUpdate = affected.rows;
    const datesToCheck = convertToRecurring ? recurrenceDates : rowsToUpdate.map(row => updatesDate || row.booking_date_key);
    for (const nextDate of datesToCheck) {
      const excludeId = nextDate === (updatesDate || original.booking_date_key) ? id : 0;
      const conflict = await client.query(`
        SELECT b.id, b.course, b.start_time, b.end_time, u.name AS instructor_name
        FROM bookings b JOIN users u ON u.id=b.instructor_id
        WHERE b.date=$1 AND b.start_time=$2 AND b.status!='cancelled' AND b.id<>$3
        LIMIT 1`, [nextDate,start_time,excludeId]);
      if (conflict.rowCount) {
        const c=conflict.rows[0];
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:`Já existe uma marcação iniciando às ${formatTimeBR(start_time)} no dia ${formatDateBR(nextDate)}: ${c.course || "Curso"} — ${c.instructor_name || "Instrutor"}. Escolha outro horário de início.`,
          conflict_date:nextDate
        });
      }
    }

    const ids=[];
    let effectiveGroupId=groupId;
    if (convertToRecurring) effectiveGroupId=`REC-${Date.now()}-${req.user.id}`;
    for (const row of rowsToUpdate) {
      const nextDate = updatesDate || row.booking_date_key;
      await client.query(`
        UPDATE bookings
        SET instructor_id=$1,date=$2::date,start_time=$3,end_time=$4,notes=$5,course=$6,recurrence_group_id=$8
        WHERE id=$7`, [Number(instructor_id),nextDate,start_time,end_time,notes||"",course,row.id,effectiveGroupId]);
      ids.push(row.id);
    }

    if (convertToRecurring) {
      for (const d of recurrenceDates.slice(1)) {
        const result = await client.query(`
          INSERT INTO bookings(instructor_id,date,start_time,end_time,notes,course,status,created_by,recurrence_group_id)
          VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8) RETURNING id`,
          [Number(instructor_id),d,start_time,end_time,notes||"",course,req.user.id,effectiveGroupId]);
        ids.push(result.rows[0].id);
      }
    }
    await client.query("COMMIT");

    const oldDate=formatDateBR(original.booking_date_key || original.date);
    const oldTime=`${formatTimeBR(original.start_time)} - ${formatTimeBR(original.end_time)}`;
    const newDate=formatDateBR(updatesDate || original.booking_date_key || original.date);
    const newTime=`${formatTimeBR(start_time)} - ${formatTimeBR(end_time)}`;
    const scopeLabel=convertToRecurring?'transformada em recorrência':edit_scope==='series'?'toda a recorrência':edit_scope==='future'?'esta e as próximas ocorrências':'esta ocorrência';
    const actionDetails=`${original.course} | ${original.instructor_name} | ${oldDate} ${oldTime} → ${course} | ${target.name} | ${newDate} ${newTime} | ${scopeLabel}${convertToRecurring?` | ${ids.length} ocorrências até ${formatDateBR(recurrenceUntil)}`:""}`;
    await logAction(req.user.id,convertToRecurring?"MARCACAO_TRANSFORMADA_RECORRENTE":"MARCACAO_EDITADA",actionDetails);

    await discordNotify(
      convertToRecurring
        ? `🔄 **MARCAÇÃO TRANSFORMADA EM RECORRENTE**\n\n📚 **Curso:** ${course}\n👨‍🏫 **Instrutor:** ${target.name}\n📅 **Início:** ${newDate}\n📅 **Até:** ${formatDateBR(recurrenceUntil)}\n⏰ **Horário:** ${newTime}\n🔁 **Recorrência:** semanal\n📌 **Ocorrências:** ${ids.length}\n🔹 **Status da marcação original:** ${discordStatusBR(original.status)}`
        : `✏️ **MARCAÇÃO ALTERADA NA AGENDA**\n\n📚 **Curso:** ${course}\n👨‍🏫 **Instrutor:** ${target.name}\n📅 **Data:** ${newDate}\n⏰ **Horário:** ${newTime}\n🔄 **Alterado:** ${oldDate} • ${oldTime}\n📌 **Escopo:** ${scopeLabel}\n🔹 **Status:** ${discordStatusBR(original.status)}\n🆔 **Ocorrências alteradas:** ${ids.length}`,
      "newBooking"
    );
    await notifyUsers([original.created_by, original.instructor_id, Number(instructor_id)], "info", convertToRecurring?"Marcação transformada em recorrente":"Marcação alterada", convertToRecurring?`${course} foi transformado em recorrência semanal até ${formatDateBR(recurrenceUntil)} (${ids.length} ocorrências).`:`${course} foi alterado para ${newDate} das ${formatTimeBR(start_time)} às ${formatTimeBR(end_time)}. ${scopeLabel}.`);
    res.json({ok:true,ids,count:ids.length,edit_scope,recurring:convertToRecurring,recurrence_group_id:effectiveGroupId});
  } catch(e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("Editar marcação:",e);
    res.status(500).json({error:"Não foi possível editar a marcação."});
  } finally {
    client.release();
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
  if(!current || current.status !== "approved") return res.status(403).json({error:"Sem permissão."});
  const simpleCourse = isSimpleCourseName(b.course);
  if (simpleCourse) {
    if (Number(b.instructor_id) !== Number(current.id) && !isInstructionCoordinatorRole(current.role))
      return res.status(403).json({error:"Você só pode marcar como realizada uma marcação sua."});
    if (String(b.status).toLowerCase() === 'cancelled') return res.status(400).json({error:"Marcação cancelada não pode ser concluída."});
    // Cursos futuros de Recrutamento/Formação podem ser APROVADOS normalmente.
    // A restrição de data vale somente quando alguém tenta marcá-los como REALIZADOS.
    if (status === 'completed') {
      if (String(b.booking_date_key || b.date).slice(0,10) > new Date().toISOString().slice(0,10))
        return res.status(400).json({error:"O curso ainda não foi realizado."});
    } else if (status === 'confirmed') {
      // Aprovação é permitida mesmo quando o curso ainda é futuro.
      // A restrição de data existe somente para marcar como REALIZADO.
    } else {
      return res.status(400).json({error:"Recrutamento e Formação só podem ser aprovados ou marcados como realizados."});
    }
  } else if (!isInstructionCoordinatorRole(current.role)) {
    return res.status(403).json({error:"Sem permissão."});
  }

  // Aprovação de uma recorrência: uma única aprovação confirma todas as ocorrências
  // pendentes da mesma série e gera uma única mensagem no Discord.
  if (status === "confirmed" && b.recurrence_group_id) {
    const group = await query(`
      SELECT b.id,b.date,to_char(b.date,'YYYY-MM-DD') AS booking_date_key,b.start_time,b.end_time,
             b.course,b.instructor_id,b.created_by,b.status,u.name AS instructor_name
      FROM bookings b JOIN users u ON u.id=b.instructor_id
      WHERE b.recurrence_group_id=$1
      ORDER BY b.date,b.start_time,b.id`, [b.recurrence_group_id]);
    const pendingRows = group.rows.filter(row => String(row.status).toLowerCase() === 'pending');
    if (!pendingRows.length) return res.status(400).json({error:"Esta recorrência não possui ocorrências pendentes para aprovação."});

    await query("UPDATE bookings SET status='confirmed' WHERE recurrence_group_id=$1 AND status='pending'", [b.recurrence_group_id]);
    const first = group.rows[0];
    const last = group.rows[group.rows.length - 1];
    const approvedCount = pendingRows.length;
    await logAction(
      req.user.id,
      "RECORRENCIA_APROVADA",
      `${b.course} | ${b.instructor_name} | ${formatDateBR(first.booking_date_key || first.date)} a ${formatDateBR(last.booking_date_key || last.date)} | ${approvedCount} ocorrências`
    );

    await discordNotify(
      `🔄 **RECORRÊNCIA APROVADA — AGENDA**\n\n📚 **Curso:** ${b.course}\n👨‍🏫 **Instrutor:** ${b.instructor_name}\n📅 **De:** ${formatDateBR(first.booking_date_key || first.date)}\n📅 **Até:** ${formatDateBR(last.booking_date_key || last.date)}\n⏰ **Horário:** ${formatTimeBR(b.start_time)} - ${formatTimeBR(b.end_time)}\n🔁 **Recorrência:** semanal\n📌 **Ocorrências aprovadas:** ${approvedCount}\n🟢 **Status:** APROVADAS`,
      (isRecruitmentCourseName(b.course)
        ? "recruitmentApprovedBooking"
        : "approvedBooking")
    );

    const recipients = [...new Set(pendingRows.flatMap(row => [row.created_by, row.instructor_id]).filter(Boolean).map(Number))];
    if (recipients.length) {
      await notifyUsers(recipients, "success", "Recorrência aprovada", `${b.course} foi aprovada de ${formatDateBR(first.booking_date_key || first.date)} até ${formatDateBR(last.booking_date_key || last.date)}, com ${approvedCount} ocorrências.`);
    }
    try { for (const approvedRow of pendingRows) await ensureDiscordScheduledEventForBooking({...approvedRow,date_key:approvedRow.date_key||approvedRow.booking_date_key||approvedRow.date}); } catch (e) { console.error("Criação automática de eventos Discord na recorrência:", e.message); }
    return res.json({ok:true, recurring:true, recurrence_group_id:b.recurrence_group_id, count:approvedCount});
  }

  await query("UPDATE bookings SET status=$1 WHERE id=$2", [status,id]);
  await logAction(req.user.id,"STATUS_MARCACAO_ALTERADO",`${b.instructor_name} → ${status}`);
  await discordNotify(
    status === "confirmed"
      ? `✅ **AGENDAMENTO APROVADO**\n📚 **Curso:** ${b.course}\n👨‍🏫 **Instrutor:** ${b.instructor_name}\n📅 **Data:** ${formatDateBR(b.booking_date_key || b.date)}\n⏰ **Horário:** ${formatTimeBR(b.start_time)} - ${formatTimeBR(b.end_time)}\n🟢 **Status:** APROVADA`
      : (status === "completed" && simpleCourse)
        ? `🎓 **CURSO REALIZADO**\n📚 **Curso:** ${b.course}\n👨‍🏫 **Instrutor:** ${b.instructor_name}\n📅 **Data:** ${formatDateBR(b.booking_date_key || b.date)}\n⏰ **Horário:** ${formatTimeBR(b.start_time)} - ${formatTimeBR(b.end_time)}\n🟢 **Status:** REALIZADA`
        : `📌 **MARCAÇÃO ATUALIZADA**\n📚 **Curso:** ${b.course}\n👨‍🏫 **Instrutor:** ${b.instructor_name}\n📅 **Data:** ${formatDateBR(b.booking_date_key || b.date)}\n⏰ **Horário:** ${formatTimeBR(b.start_time)} - ${formatTimeBR(b.end_time)}\n🔹 **Status:** ${discordStatusBR(status)}`,
    status === "confirmed"
      ? (simpleCourse && isRecruitmentCourseName(b.course)
          ? "recruitmentApprovedBooking"
          : "approvedBooking")
      : "newBooking"
  );
  if (status === "confirmed") {
    try {
      const eventResult = await ensureDiscordScheduledEventForBooking({
        ...b,
        date_key: b.date_key || b.booking_date_key || b.date
      });
      if (!eventResult?.ok) {
        console.error(`[EVENTO DISCORD] Aprovação do curso não criou/reutilizou o evento | booking=${b.id} | ${eventResult?.reason||'motivo desconhecido'}`);
      } else {
        console.log(`[EVENTO DISCORD] Aprovação processada | booking=${b.id} | ${eventResult.created?'criado':eventResult.reused?'reutilizado':eventResult.alreadyCreated?'já existente':'ok'}`);
      }
    } catch (e) {
      console.error("Criação automática de evento Discord após aprovação no site:", e.message);
    }
  }
  if (status === "completed" && simpleCourse) {
    await notifyUsers([b.created_by, b.instructor_id], "success", "Curso realizado", `${b.course} foi marcado como realizado em ${formatDateBR(b.booking_date_key || b.date)}.`);
  } else if (status === "confirmed") {
    await notifyUsers([b.created_by, b.instructor_id], "success", "Agendamento aprovado", `${b.course} foi aprovado para ${formatDateBR(b.date)} das ${formatTimeBR(b.start_time)} às ${formatTimeBR(b.end_time)}.`);
  } else if (status === "cancelled") {
    await notifyUsers([b.created_by, b.instructor_id], "danger", "Agendamento recusado", `${b.course} em ${formatDateBR(b.booking_date_key || b.date)} foi recusado/cancelado.`);
  }
  res.json({ok:true});
});

app.get("/api/pending-bookings", auth, managerAuth, coordinator, async (req,res) => {
  const result = await query(`
    SELECT b.*,
           to_char(b.date, 'YYYY-MM-DD') AS booking_date_key,
           u.name AS instructor_name,
           u.rank AS instructor_rank,
           u.username AS instructor_username,
           CASE WHEN b.recurrence_group_id IS NOT NULL THEN TRUE ELSE FALSE END AS is_recurring,
           CASE WHEN b.recurrence_group_id IS NOT NULL THEN
             (SELECT COUNT(*)::int FROM bookings rb WHERE rb.recurrence_group_id=b.recurrence_group_id)
           ELSE 1 END AS recurrence_count,
           CASE WHEN b.recurrence_group_id IS NOT NULL THEN
             (SELECT to_char(MIN(rb.date), 'YYYY-MM-DD') FROM bookings rb WHERE rb.recurrence_group_id=b.recurrence_group_id)
           ELSE to_char(b.date, 'YYYY-MM-DD') END AS recurrence_start_date,
           CASE WHEN b.recurrence_group_id IS NOT NULL THEN
             (SELECT to_char(MAX(rb.date), 'YYYY-MM-DD') FROM bookings rb WHERE rb.recurrence_group_id=b.recurrence_group_id)
           ELSE to_char(b.date, 'YYYY-MM-DD') END AS recurrence_end_date,
           CASE WHEN b.recurrence_group_id IS NOT NULL THEN
             (SELECT COUNT(*)::int FROM bookings rb WHERE rb.recurrence_group_id=b.recurrence_group_id AND rb.status='pending')
           ELSE 1 END AS recurrence_pending_count
    FROM bookings b JOIN users u ON u.id=b.instructor_id
    WHERE b.status='pending'
      AND (b.recurrence_group_id IS NULL OR b.id = (
        SELECT MIN(rb.id) FROM bookings rb
        WHERE rb.recurrence_group_id=b.recurrence_group_id AND rb.status='pending'
      ))
    ORDER BY b.date,b.start_time,b.id`);
  res.json(result.rows);
});


app.get("/api/absences", auth, async (req,res) => {
  try {
    const current = await getCurrentUser(req.user.id);
    if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});
    const result = await query(`
      SELECT a.id,a.user_id,a.name,a.city_id,
             to_char(a.start_date,'YYYY-MM-DD') AS start_date,
             to_char(a.end_date,'YYYY-MM-DD') AS end_date,
             a.reason,a.created_at
      FROM absences a
      JOIN users u ON u.id=a.user_id
      WHERE u.status='approved'
      ORDER BY a.start_date ASC,a.end_date ASC,a.name ASC,a.id DESC
    `);
    res.json(result.rows);
  } catch(e) {
    console.error("GET /api/absences:",e);
    res.status(500).json({error:"Não foi possível carregar as ausências."});
  }
});

app.post("/api/absences", auth, async (req,res) => {
  try {
    const current = await getCurrentUser(req.user.id);
    if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});

    const startDate=String(req.body?.start_date||"").trim();
    const endDate=String(req.body?.end_date||"").trim();
    const reason=String(req.body?.reason||"").trim();
    if (!startDate || !endDate || !reason)
      return res.status(400).json({error:"Informe data de início, data de fim e razão da ausência."});
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate))
      return res.status(400).json({error:"Informe datas válidas."});
    if (endDate < startDate)
      return res.status(400).json({error:"A data final não pode ser anterior à data inicial."});

    const existing=await query(`
      SELECT id FROM absences
      WHERE user_id=$1 AND start_date <= $3::date AND end_date >= $2::date
      LIMIT 1
    `,[current.id,startDate,endDate]);
    if(existing.rowCount)
      return res.status(409).json({error:"Você já possui uma ausência registrada que cruza este período."});

    const result=await query(`
      INSERT INTO absences(user_id,name,city_id,start_date,end_date,reason)
      VALUES($1,$2,$3,$4::date,$5::date,$6)
      RETURNING id,user_id,name,city_id,
                to_char(start_date,'YYYY-MM-DD') AS start_date,
                to_char(end_date,'YYYY-MM-DD') AS end_date,reason,created_at
    `,[current.id,current.name||current.username||"",current.city_id||"",startDate,endDate,reason]);

    await logAction(req.user.id,"AUSENCIA_REGISTRADA",`${current.name||current.username} | ID ${current.city_id||"-"} | ${startDate} até ${endDate} | ${reason}`);
    res.status(201).json(result.rows[0]);
  } catch(e) {
    console.error("POST /api/absences:",e);
    res.status(500).json({error:"Não foi possível registrar a ausência."});
  }
});

app.delete("/api/absences/:id", auth, async (req,res) => {
  try {
    const current=await getCurrentUser(req.user.id);
    if (!current || current.status !== "approved") return res.status(403).json({error:"Usuário sem acesso aprovado."});
    const id=Number(req.params.id);
    const row=await query("SELECT id,user_id FROM absences WHERE id=$1",[id]);
    if(!row.rowCount) return res.status(404).json({error:"Registro de ausência não encontrado."});
    const manager=["coordenador","admin"].includes(current.role);
    if(!manager && Number(row.rows[0].user_id)!==Number(current.id))
      return res.status(403).json({error:"Você só pode excluir sua própria ausência."});
    await query("DELETE FROM absences WHERE id=$1",[id]);
    await logAction(req.user.id,"AUSENCIA_EXCLUIDA",`Registro ${id}`);
    res.json({ok:true});
  } catch(e) {
    console.error("DELETE /api/absences:",e);
    res.status(500).json({error:"Não foi possível excluir a ausência."});
  }
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
       WHERE a.enabled=TRUE AND u.status='approved' AND u.role IN ('instrutor','instrutor_recrutador')
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
    const manager = isInstructionCoordinatorRole(current.role);
    if (!manager && targetId !== Number(current.id)) return res.status(403).json({error:"Você só pode alterar sua própria disponibilidade."});
    const target = await query("SELECT id FROM users WHERE id=$1 AND status='approved' AND role IN ('instrutor','instrutor_recrutador','coordenador','admin')", [targetId]);
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
    const manager = isInstructionCoordinatorRole(current.role);
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
      SELECT b.*, to_char(b.date, 'YYYY-MM-DD') AS booking_date_key, u.name AS instructor_name
      FROM bookings b JOIN users u ON u.id=b.instructor_id
      WHERE b.id=$1`, [id]);
    if (!found.rowCount) return res.status(404).json({error:"Marcação não encontrada."});
    const b = found.rows[0];
    await query("DELETE FROM bookings WHERE id=$1", [id]);
    try { await logAction(req.user.id, "booking_deleted", `Marcação ${id} excluída`); } catch(e) { console.error("Falha ao registrar exclusão:", e.message); }
    const deletedDate = formatDateBR(b.booking_date_key || b.date);
    await discordNotify(
      `🗑️ **MARCAÇÃO EXCLUÍDA DA AGENDA**\n\n📚 **Curso:** ${b.course}\n👨‍🏫 **Instrutor:** ${b.instructor_name}\n📅 **Data:** ${deletedDate}\n⏰ **Horário:** ${formatTimeBR(b.start_time)} - ${formatTimeBR(b.end_time)}\n🔴 **Status:** EXCLUÍDA`,
      "newBooking"
    );
    await notifyUsers([b.created_by, b.instructor_id], "danger", "Marcação excluída", `${b.course} de ${deletedDate} foi excluída da agenda.`);
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
    const result = await query(`SELECT id,title,description,category,url,icon,section,course,material_order,updated_at FROM instruction_materials ORDER BY CASE section WHEN 'Manuais gerais' THEN 1 WHEN 'Link para provas dos alunos' THEN 2 WHEN 'Link manual por curso' THEN 3 WHEN 'Vídeo aulas' THEN 4 ELSE 5 END, material_order ASC, id ASC`);
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


/* ================= MATERIAL DE APOIO — RECRUTAMENTOS ================= */
app.get('/api/recruitment-materials', auth, recruitmentGuard, async (req,res)=>{
  try{
    const r=await query(`SELECT id,title,description,category,url,icon,material_order,active,updated_at,updated_by FROM cip_recruitment_materials ORDER BY material_order,id`);
    res.json({materials:r.rows});
  }catch(e){console.error('GET /api/recruitment-materials:',e);res.status(500).json({error:'Não foi possível carregar os materiais de apoio.'});}
});
app.post('/api/recruitment-materials', auth, recruitmentGuard, managerAuth, coordinator, async (req,res)=>{
  try{
    const title=String(req.body?.title||'').trim(), description=String(req.body?.description||'').trim(), category=String(req.body?.category||'Links úteis').trim()||'Links úteis', url=String(req.body?.url||'').trim(), icon=String(req.body?.icon||'🔗').trim()||'🔗';
    if(!title || !url) return res.status(400).json({error:'Informe o nome e o link do material.'});
    if(url !== '#' && !/^https?:\/\//i.test(url)) return res.status(400).json({error:'O link deve começar com http:// ou https://.'});
    const max=await query(`SELECT COALESCE(MAX(material_order),0)+1 AS next FROM cip_recruitment_materials`);
    const result=await query(`INSERT INTO cip_recruitment_materials(title,description,category,url,icon,material_order,active,updated_at,updated_by) VALUES($1,$2,$3,$4,$5,$6,TRUE,NOW(),$7) RETURNING *`,[title,description,category,url,icon,Number(max.rows[0].next),req.user.id]);
    await logAction(req.user.id,'MATERIAL_RECRUTAMENTO_CRIADO',`Material ${title} criado`);
    res.json({ok:true,material:result.rows[0]});
  }catch(e){console.error('POST /api/recruitment-materials:',e);res.status(500).json({error:'Não foi possível criar o material.'});}
});
app.put('/api/recruitment-materials/:id', auth, recruitmentGuard, managerAuth, coordinator, async (req,res)=>{
  try{
    const id=Number(req.params.id), title=String(req.body?.title||'').trim(), description=String(req.body?.description||'').trim(), category=String(req.body?.category||'Links úteis').trim()||'Links úteis', url=String(req.body?.url||'').trim(), icon=String(req.body?.icon||'🔗').trim()||'🔗', materialOrder=Math.max(1,Number(req.body?.material_order||1)), active=req.body?.active!==false;
    if(!Number.isInteger(id)||id<1) return res.status(400).json({error:'Material inválido.'});
    if(!title || !url) return res.status(400).json({error:'Informe o nome e o link do material.'});
    if(url !== '#' && !/^https?:\/\//i.test(url)) return res.status(400).json({error:'O link deve começar com http:// ou https://.'});
    const result=await query(`UPDATE cip_recruitment_materials SET title=$1,description=$2,category=$3,url=$4,icon=$5,material_order=$6,active=$7,updated_at=NOW(),updated_by=$8 WHERE id=$9 RETURNING *`,[title,description,category,url,icon,materialOrder,active,req.user.id,id]);
    if(!result.rowCount)return res.status(404).json({error:'Material não encontrado.'});
    await logAction(req.user.id,'MATERIAL_RECRUTAMENTO_ATUALIZADO',`Material ${title} atualizado`);
    res.json({ok:true,material:result.rows[0]});
  }catch(e){console.error('PUT /api/recruitment-materials:',e);res.status(500).json({error:'Não foi possível atualizar o material.'});}
});
app.delete('/api/recruitment-materials/:id', auth, recruitmentGuard, managerAuth, coordinator, async (req,res)=>{
  try{const id=Number(req.params.id);if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Material inválido.'});const result=await query(`DELETE FROM cip_recruitment_materials WHERE id=$1 RETURNING title`,[id]);if(!result.rowCount)return res.status(404).json({error:'Material não encontrado.'});await logAction(req.user.id,'MATERIAL_RECRUTAMENTO_EXCLUIDO',`Material ${result.rows[0].title} excluído`);res.json({ok:true});}
  catch(e){console.error('DELETE /api/recruitment-materials:',e);res.status(500).json({error:'Não foi possível excluir o material.'});}
});
async function recruitmentBankGuard(req,res,next){
  const internalRole=normalizeRecruitmentInternalRole(req.currentUser?.recruitment_internal_role);
  if(String(req.currentUser?.role||'').trim().toLowerCase()!=='admin' && !['coordenador','coordenador_recrutamentos'].includes(String(req.currentUser?.role||'').trim().toLowerCase()) && !['coordenador','braco_direito'].includes(internalRole)){
    return res.status(403).json({error:'Acesso ao Banco restrito a Administradores, Coordenadores e Braço-Direito.'});
  }
  next();
}
app.get('/api/recruitment-bank', auth, recruitmentGuard, recruitmentBankGuard, async (req,res)=>{
  try{
    const totals=await query(`SELECT
      COALESCE(SUM(amount) FILTER (WHERE movement_type='deposit'),0)::numeric(12,2) AS deposits,
      COALESCE(SUM(amount) FILTER (WHERE movement_type='withdrawal'),0)::numeric(12,2) AS withdrawals,
      COALESCE(SUM(CASE WHEN movement_type='deposit' THEN amount ELSE -amount END),0)::numeric(12,2) AS balance
      FROM cip_recruitment_bank_movements`);
    const rows=await query(`SELECT m.id,m.movement_type,m.amount,m.description,m.receipt_url,m.created_at,
      u.name AS created_by_name,u.role AS created_by_role,u.city_id AS created_by_city_id
      FROM cip_recruitment_bank_movements m LEFT JOIN users u ON u.id=m.created_by
      ORDER BY m.created_at DESC,m.id DESC`);
    res.json({summary:totals.rows[0],movements:rows.rows});
  }catch(e){console.error('GET /api/recruitment-bank:',e);res.status(500).json({error:'Não foi possível carregar o banco.'});}
});
app.post('/api/recruitment-bank', auth, recruitmentGuard, recruitmentBankGuard, async (req,res)=>{
  try{
    const movementType=req.body?.movement_type==='withdrawal'?'withdrawal':'deposit';
    const amount=Number(req.body?.amount);
    const description=String(req.body?.description||'').trim();
    const receiptUrl=String(req.body?.receipt_url||'').trim()||null;
    if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Informe um valor maior que zero.'});
    if(!description)return res.status(400).json({error:'Informe a descrição da movimentação.'});
    if(movementType==='withdrawal'){
      const b=await query(`SELECT COALESCE(SUM(CASE WHEN movement_type='deposit' THEN amount ELSE -amount END),0)::numeric AS balance FROM cip_recruitment_bank_movements`);
      if(amount>Number(b.rows[0].balance||0))return res.status(400).json({error:'Saldo insuficiente para realizar este saque.'});
    }
    const r=await query(`INSERT INTO cip_recruitment_bank_movements(movement_type,amount,description,receipt_url,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,movement_type,amount,description,receipt_url,created_at`,[movementType,amount,description,receiptUrl,req.user.id]);
    await logAction(req.user.id, movementType==='deposit'?'RECRUTAMENTO_BANCO_DEPOSITO':'RECRUTAMENTO_BANCO_SAQUE', `${movementType==='deposit'?'Depósito':'Saque'} de R$ ${amount.toFixed(2)} • ${description}`);
    const actor = req.currentUser?.name || req.user?.name || `Usuário ${req.user.id}`;
    const movementLabel = movementType === 'deposit' ? 'DEPÓSITO' : 'SAQUE';
    await discordNotify(
      `🏦 **MOVIMENTAÇÃO DO BANCO — ${movementLabel}**\n\n💰 **Valor:** R$ ${amount.toFixed(2)}\n📝 **Descrição:** ${description}\n👤 **Realizado por:** ${actor}\n🆔 **ID:** ${req.currentUser?.city_id || '—'}\n📎 **Comprovante:** ${receiptUrl || 'Não informado'}`,
      'recruitmentBank'
    );
    res.json({ok:true,movement:r.rows[0]});
  }catch(e){console.error('POST /api/recruitment-bank:',e);res.status(500).json({error:'Não foi possível registrar a movimentação.'});}
});

/* ================= RECRUTAMENTOS ================= */
const RECRUITMENT_ROLES = ['admin','coordenador','coordenador_instrucao','coordenador_recrutamentos','recrutador','instrutor_recrutador'];
function normalizeRecruitmentInternalRole(value){
  return String(value||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[\s-]+/g,'_');
}
async function recruitmentUser(req){
  const u=await getCurrentUser(req.user.id);
  if(!u || u.status!=='approved') return null;
  const role=String(u.role||'').trim().toLowerCase();
  const internal=normalizeRecruitmentInternalRole(u.recruitment_internal_role);
  // O cargo principal não bloqueia o módulo quando a função interna é Braço-Direito.
  if(RECRUITMENT_ROLES.includes(role) || internal==='braco_direito') return u;
  return null;
}
async function recruitmentGuard(req,res,next){
  try{ const u=await recruitmentUser(req); if(!u)return res.status(403).json({error:'Acesso restrito ao módulo Recrutamentos.'}); req.currentUser=u; next(); }
  catch(e){ console.error('Recruitment auth:',e); res.status(500).json({error:'Não foi possível validar o acesso.'}); }
}
const RECRUITMENT_QUESTIONS = [
 {id:1,type:'M',text:'Explique todas as 4 formas de legalidade de revista',criteria:[['Citou resultado positivo para teste residual/pólvora',0.25],['Citou fundada suspeita',0.25],['Citou flagrante e/ou confissão',0.25],['Citou o uso de equipamento restrito / ocultação facial',0.25]]},
 {id:2,type:'M',text:'Qual a função do P1 em uma viatura e no P3 que patente utiliza esse acento e qual a sua função?',criteria:[['P1 Responsavel pela manutenção da viatura',0.25],['P1 Responsavel pela Pilotagem',0.25],['P3 e a maior patente',0.25],['P3 é o olheiro da viatura',0.25]]},
 {id:3,type:'U',text:'Em uma abordagem de Cód. 3 onde exite risco, quantas viaturas já são suficientes no QTH para iniciar a abordagem?',criteria:[['Respondeu corretamente (3 Viaturas)',1.00],['Respondeu errado',0.00]]},
 {id:4,type:'U',text:'"Em uma abordagem de Cód. 2 o indivíduo deverá sair no veículo por ser uma abordagem de médio risco". Essa afirmação é VERDADEIRA ou FALSA? Justifique',criteria:[['Respondeu Verdadeira e justificou da forma certa',1.00],['Respondeu Verdadeira e não justificou / ou justificou de forma errada',0.50],['Respondeu Falso e justificou da forma certa',0.00]]},
 {id:5,type:'U',text:'Os códigos de 0-6 são utilizados para descrever o nível de gravidade de uma ocorrência. Sabendo disso, o que significa "Cód. 6" em uma QRU?',criteria:[['Respondeu corretamente (Investigando a Área)',1.00],['Respondeu errado',0.00]]},
 {id:6,type:'U',text:'Qual é a forma CORRETA de modular um acompanhamento a uma BF400 Azul com 2 rapazes, saindo de um trafico de entorpecentes na praia direção norte?',criteria:[['Modulou corretamente sem esquecer nenhum ponto',1.00],['Esqueceu de 1 ponto (Coloração / QTH / QRU / Direção / Nº Vagas )',0.66],['Esqueceu de 2 pontos (Coloração / QTH / QRU / Direção / Nº Vagas )',0.33],['Esqueceu de mais de 2 pontos ou modulou da forma errada',0.00]]},
 {id:7,type:'U',text:'Você modulou o inicio de uma abordagem de código 1, em um Caminhão de Lixeiro em Paleto e, quando a secundária chega, o veículo resolve evadir-se pela Paleto Boulevard, sentido Sul. Como você modularia esta nova situação?',criteria:[['Modulou da forma correta',1.00],['Esqueceu de 1 ponto (Coloração / QTH / QRU / Direção / Nº Vagas )',0.66],['Esqueceu de 2 pontos (Coloração / QTH / QRU / Direção / Nº Vagas )',0.33],['Esqueceu de mais de 2 pontos ou modulou da forma errada',0.00]]},
 {id:8,type:'M',text:'Qual o signicado dos seguintes codigos Qs:',criteria:[['QSM',0.20],['QRL',0.20],['QTX',0.20],['QRX',0.20],['QRR',0.20]]},
 {id:9,type:'U',text:'Você acabou de sair de serviço, mas seu carro está guardado na Garagem do Maze Bank Arena. Seria permitido usar uma viatura para locomoção até o local?',criteria:[['Respondeu que não seria permitido',1.00],['Respondeu que seria permitido',0.00]]},
 {id:10,type:'U',text:'Uma vez oficial, as punições se estendem até mesmo à aqueles que estão a paisana. Nesse sentido, é permitido portar equipamentos fora de serviço para benefício próprio, como algemas ou Chave Mestra? Justifique',criteria:[['Respondeu que não pode e justificou de forma correta',1.00],['Respondeu que não pode mas justificou de forma errada ou não justificou',0.50],['Respondeu que pode utilizar',0.00]]},
 {id:11,type:'M',text:'Durante uma abordagem de Cód. 2, você percebe uma Rebla se aproximando do local e disparando na sua direção, o criminoso está se evadindo, porém você é o único sobrevivente e seus colegas foram abatidos, como reagiria nessa situação, explique de forma detalhada!',criteria:[['Mencionou sobre colocar-se em segurança',0.25],['Pediu Prioridade / Apoio a Central',0.25],['Informa as características do criminoso / veículo',0.25],['Priorizar a sua vida até a chegada de apoio',0.25]]},
 {id:12,type:'U',text:'Durante uma abordagem de Cód. 2 verifico que há uma FEM envolvida na QRU, após realizar o chamado no CP verifico que não há PFEM/FOX em QRV. Qual o procedimento deve ser realizado a seguir?',criteria:[['Citou o Procedimento da Caixa',1.00],['Não Citou o Procedimento da Caixa / Revistaria ele próprio',0.00]]},
 {id:13,type:'M',text:'Você está realizando uma abordagem de Cód. 2 a um indivíduo e o mesmo está cooperando com a abordagem. Porém chegam ao local a namorada e o irmão do abordado e começam a atrapalhar a abordagem, como você reagiria nessa situação?',criteria:[['Dar ordem legal para se afastar',0.50],['Citar que caso não seja acatada, pode ser conduzir para a prisão',0.25],['Citar que colocaria o crime de desobediencia',0.25]]},
 {id:14,type:'U',text:'"Veículos com insulfilm escuro, onde o oficial não consiga verificar o interior deverão ser abordados em Cód. 1 por ser uma abordagem de baixo risco." Esta afirmação é verdadeira ou falsa? Justifique',criteria:[['Respondeu Falso',0.00],['Respondeu Verdadeiro, mas não justificou / ou justificou de forma errada',0.50],['Respondeu Verdadeiro e justificou da forma certa',1.00]]},
 {id:15,type:'M',text:'Suponha uma situação onde se aborda um civil mascarado, é realizado a abordagem Cód. 1, mas o mesmo se recusa a retirar a mascara e se torna agressivo, o que faria.',criteria:[['Citou que escalonava para Código 2',0.50],['Citou que poderia prender por ocultação facial',0.50]]},
 {id:16,type:'U',text:'Você está à paisana na praia quando testemunha um individuo traficando entorpecentes. Ele não notou sua presença. O que você faz?',criteria:[['Respondeu que faria um chamado detalhado para a policia',1.00],['Respondeu que prendia o mesmo ou não fez nada',0.00]]}
];
// Opção padrão para questões avaliadas por nota: permite registrar explicitamente que não houve resposta.
// Para questões de múltiplas respostas, esta opção é exclusiva e sempre vale 0.
for(const q of RECRUITMENT_QUESTIONS){
  if(!q.criteria.some(c=>c[2] === 'no_answer')){
    q.criteria.push(['Não respondeu',0.00,'no_answer']);
  }
}
// Corrige apenas a grafia de um termo importado do arquivo, sem alterar o critério.
RECRUITMENT_QUESTIONS[0].criteria[0][0]='Citou resultado positivo para teste residual/pólvora';

app.get('/api/recruitments/questions', auth, recruitmentGuard, (req,res)=>res.json(RECRUITMENT_QUESTIONS));
app.get('/api/recruitments/recruiters', auth, recruitmentGuard, async(req,res)=>{
 try{
  // A lista de recrutadores já devolve as métricas de presença em uma única consulta.
  // Isso evita N x M chamadas ao endpoint /presence no navegador.
  const r=await query(`
    SELECT
      u.id,u.name,u.username,u.city_id,u.city_phone,u.rank,u.role,u.status,u.avatar_data,
      COALESCE(u.recruitment_internal_role,CASE WHEN u.role='coordenador' THEN 'coordenador' ELSE 'avaliado' END) AS recruitment_internal_role,
      COUNT(pr.id) FILTER (WHERE pr.present=TRUE AND rec.official=TRUE)::int AS recruitment_count,
      to_char(MAX(rec.date) FILTER (WHERE pr.present=TRUE AND rec.official=TRUE),'YYYY-MM-DD') AS last_participation
    FROM users u
    LEFT JOIN cip_recruitment_presence pr ON pr.user_id=u.id
    LEFT JOIN cip_recruitments rec ON rec.id=pr.recruitment_id
    WHERE u.role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','recrutador','instrutor_recrutador')
      AND u.status='approved'
    GROUP BY u.id,u.name,u.username,u.city_id,u.city_phone,u.rank,u.role,u.status,u.avatar_data,u.recruitment_internal_role
    ORDER BY CASE COALESCE(u.recruitment_internal_role,'avaliado')
      WHEN 'supervisor_coordenadores' THEN 1
      WHEN 'coordenador' THEN 2
      WHEN 'braco_direito' THEN 3
      WHEN 'veterano' THEN 4
      WHEN 'efetivo' THEN 5
      WHEN 'estagiario' THEN 6
      WHEN 'avaliado' THEN 7
      ELSE 7 END, u.name
  `);
  res.json(r.rows);
 }catch(e){
  console.error('GET /api/recruitments/recruiters:',e);
  res.status(500).json({error:'Não foi possível carregar a equipe de recrutamento.'});
 }
});
app.get('/api/recruitments/presence/all', auth, recruitmentGuard, async(req,res)=>{
 try{
  // Retorna todas as presenças dos recrutamentos oficiais em uma única consulta.
  // A tela de Atuação Mensal não precisa mais fazer uma requisição por recrutamento.
  const r=await query(`
    SELECT
      pr.recruitment_id,
      pr.user_id,
      pr.present,
      r.recruitment_number,
      r.date AS date_key,
      r.start_time,
      r.end_time
    FROM cip_recruitment_presence pr
    JOIN cip_recruitments r ON r.id=pr.recruitment_id
    JOIN users u ON u.id=pr.user_id
    WHERE r.official=TRUE
      AND pr.present=TRUE
      AND u.status='approved'
      AND u.role IN ('recrutador','instrutor_recrutador','coordenador','coordenador_instrucao','coordenador_recrutamentos')
    ORDER BY r.date, r.id, u.name
  `);
  res.json(r.rows);
 }catch(e){
  console.error('GET /api/recruitments/presence/all:',e);
  res.status(500).json({error:'Não foi possível carregar as presenças dos recrutamentos.'});
 }
});
app.get('/api/recruitments/my-presence', auth, recruitmentGuard, async(req,res)=>{
 try{
  const r=await query(`SELECT recruitment_id FROM cip_recruitment_presence WHERE user_id=$1 AND present=TRUE`,[req.user.id]);
  res.json(r.rows.map(x=>Number(x.recruitment_id)));
 }catch(e){
  console.error('GET /api/recruitments/my-presence:',e);
  res.status(500).json({error:'Não foi possível carregar suas presenças.'});
 }
});
app.patch('/api/recruitments/recruiters/:id/internal-role', auth, recruitmentGuard, managerAuth, coordinator, async(req,res)=>{
  try{
    const id=Number(req.params.id);
    const allowed=['supervisor_coordenadores','coordenador','braco_direito','veterano','efetivo','estagiario','avaliado'];
    const rawInternalRole=String(req.body?.internal_role||'').trim().toLowerCase();
    const aliases={'supervisor de coordenadores':'supervisor_coordenadores','supervisor_coordenadores':'supervisor_coordenadores','supervisor-coordenadores':'supervisor_coordenadores','coordenador':'coordenador','braço-direito':'braco_direito','braco-direito':'braco_direito','braco_direito':'braco_direito','veterano':'veterano','efetivo':'efetivo','estagiário':'estagiario','estagiario':'estagiario','avaliado':'avaliado'};
    const internalRole=aliases[rawInternalRole]||rawInternalRole;
    if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Usuário inválido.'});
    if(!allowed.includes(internalRole))return res.status(400).json({error:'Cargo interno inválido.'});
    const target=await query(`SELECT id,name,role FROM users WHERE id=$1 AND role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','recrutador','instrutor_recrutador') AND status='approved'`,[id]);
    if(!target.rowCount)return res.status(404).json({error:'Integrante não encontrado.'});
    await query(`UPDATE users SET recruitment_internal_role=$1 WHERE id=$2`,[internalRole,id]);
    await logAction(req.user.id,'CARGO_INTERNO_RECRUTAMENTO_ALTERADO',`${target.rows[0].name}: ${internalRole}`);
    res.json({ok:true,internal_role:internalRole});
  }catch(e){console.error('PATCH cargo interno recrutamento:',e);res.status(500).json({error:'Não foi possível alterar o cargo interno.'});}
});
app.get('/api/recruitments', auth, recruitmentGuard, async (req,res)=>{
 try {
   await refreshRecruitmentCutoffs();
   // Não sincronizamos mais a Agenda Geral para dentro deste endpoint.
   // Fora da Agenda permanece somente em cip_recruitments e não cria/recebe
   // booking automaticamente.

   const r=await query(`SELECT r.*,to_char(r.date,'YYYY-MM-DD') AS date_key,u.name AS created_by_name,
   ru.name AS recruiter_name, bu.name AS instructor_name, b.id AS agenda_booking_id,
   (SELECT COUNT(*)::int FROM cip_recruitment_participants p WHERE p.recruitment_id=r.id) AS conscripts,
   (SELECT COUNT(*)::int FROM cip_recruitment_participants p WHERE p.recruitment_id=r.id AND p.status='submitted') AS pending_results,
   (SELECT COUNT(*)::int FROM cip_recruitment_presence pr WHERE pr.recruitment_id=r.id AND pr.present) AS presences
   FROM cip_recruitments r JOIN users u ON u.id=r.created_by
   LEFT JOIN users ru ON ru.id=r.recruiter_id
   LEFT JOIN bookings b ON b.id=r.booking_id
   LEFT JOIN users bu ON bu.id=b.instructor_id
   ORDER BY r.date DESC,r.start_time DESC,r.id DESC`);
   res.json(r.rows);
 } catch(e) {
   console.error('GET /api/recruitments:', e);
   res.status(500).json({error:'Não foi possível carregar os recrutamentos da Agenda.'});
 }
});
app.post('/api/recruitments', auth, recruitmentGuard, async(req,res)=>{
 try {
  const {date,start_time,end_time,notes,title,recruiter_id,official,authorized_by}=req.body||{};
  const d=normalizeDateKey(date);
  const isOfficial=official===true || String(official).toLowerCase()==='true' || String(official).toLowerCase()==='oficial';
  const recruiterId=Number(recruiter_id);
  if(!d||!start_time||!end_time)return res.status(400).json({error:'Informe data e horários.'});
  if(String(start_time)>=String(end_time))return res.status(400).json({error:'O horário de término deve ser maior que o início.'});
  if(!Number.isInteger(recruiterId)||recruiterId<1)return res.status(400).json({error:'Selecione o recrutador responsável.'});
  const recruiter=await query(`SELECT id,name,role FROM users WHERE id=$1 AND role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','recrutador','instrutor_recrutador') AND status='approved'`,[recruiterId]);
  if(!recruiter.rowCount)return res.status(400).json({error:'O recrutador selecionado não está disponível.'});
  if(!isOfficial && !String(authorized_by||'').trim())return res.status(400).json({error:'Informe quem autorizou o recrutamento fora da agenda.'});
  if((await query(`SELECT 1 FROM cip_recruitments WHERE date=$1 AND start_time=$2 AND status<>'cancelled' AND official=TRUE`,[d,start_time])).rowCount && isOfficial)
    return res.status(409).json({error:'Já existe um recrutamento oficial iniciando neste horário.'});
  if(isOfficial && (await query(`SELECT 1 FROM bookings WHERE date=$1 AND start_time=$2 AND status<>'cancelled'`,[d,start_time])).rowCount)
    return res.status(409).json({error:'Já existe uma marcação na Agenda Geral iniciando neste horário.'});

  const recruitmentTitle=String(title||'').trim().slice(0,160);
  const r=await query(`INSERT INTO cip_recruitments(recruitment_number,date,start_time,end_time,notes,title,status,created_by,official,recruiter_id,authorized_by)
    VALUES(NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[d,start_time,end_time,notes||'',recruitmentTitle,'pending',req.user.id,isOfficial,recruiterId,String(authorized_by||'').trim()||null]);
  const recruitmentId=r.rows[0].id;
  if(isOfficial){
    await assignNextRecruitmentNumber(recruitmentId);
  }
  if(isOfficial){
    const b=await query(`INSERT INTO bookings(instructor_id,date,start_time,end_time,notes,course,status,created_by) VALUES($1,$2,$3,$4,$5,'Recrutamento','pending',$6) RETURNING id`,[recruiterId,d,start_time,end_time,notes||'',req.user.id]);
    await query(`UPDATE cip_recruitments SET booking_id=$1 WHERE id=$2`,[b.rows[0].id,recruitmentId]);
  }
  const x=(await query(`SELECT r.*,to_char(r.date,'YYYY-MM-DD') AS date_key,ru.name AS recruiter_name FROM cip_recruitments r LEFT JOIN users ru ON ru.id=r.recruiter_id WHERE r.id=$1`,[recruitmentId])).rows[0];
  // Notificações/logs nunca podem impedir a criação do agendamento.
  // Se algum serviço externo estiver indisponível, o recrutamento continua salvo.
  try {
    const novoAgendamento = isOfficial
      ? `📅 **NOVO AGENDAMENTO DE RECRUTAMENTO**\n\n🎯 **Recrutamento Nº:** ${x.recruitment_number || 'Pendente'}\n📅 **Data:** ${formatDateBR(d)}\n⏰ **Horário:** ${formatTimeBR(start_time)} - ${formatTimeBR(end_time)}\n👮 **Recrutador:** ${recruiter.rows[0].name}\n🟡 **Status:** AGUARDANDO APROVAÇÃO\n⭐ **Tipo:** OFICIAL`
      : `📅 **NOVO AGENDAMENTO DE RECRUTAMENTO**\n\n📅 **Data:** ${formatDateBR(d)}\n⏰ **Horário:** ${formatTimeBR(start_time)} - ${formatTimeBR(end_time)}\n👮 **Recrutador:** ${recruiter.rows[0].name}\n✍️ **Autorizado por:** ${String(authorized_by).trim()}\n🟡 **Status:** AGUARDANDO APROVAÇÃO\n⭐ **Tipo:** FORA DA AGENDA`;
    await discordNotify(novoAgendamento, 'recruitmentNewBooking');
    if(isOfficial){
      await notifyManagers('booking','Novo recrutamento',`Recrutamento Nº ${x.recruitment_number} • ${formatDateBR(d)} às ${formatTimeBR(start_time)} • Recrutador: ${recruiter.rows[0].name}. Aguarda aprovação.`);
      await discordNotify(novoAgendamento.replace('🟡 **Status:** AGUARDANDO APROVAÇÃO','🟡 **Status:** PENDENTE DE APROVAÇÃO'), 'approvals', { components: approvalButtons("recruitment", recruitmentId) });
    } else {
      await discordNotify(novoAgendamento, 'approvals', { components: approvalButtons("recruitment", recruitmentId) });
    }
  } catch(e) { console.error('Falha na notificação do recrutamento (agendamento preservado):', e.message); }
  try {
    await logAction(req.user.id,'RECRUTAMENTO_CRIADO',`${isOfficial?'OFICIAL':'FORA DA AGENDA'} • ${x.recruitment_number||'—'} • ${d} ${start_time}-${end_time} • Recrutador: ${recruiter.rows[0].name}${authorized_by?` • Autorizado por: ${authorized_by}`:''}`);
  } catch(e) { console.error('Falha ao registrar log do recrutamento (agendamento preservado):', e.message); }
  res.json({ok:true,recruitment:x});
 }catch(e){
   console.error('POST /api/recruitments:',e);
   // Retorna a causa real para o frontend, em vez de mascarar todos os erros como o mesmo alerta.
   res.status(500).json({error:`Não foi possível criar o recrutamento: ${e.message || 'erro interno'}`});
 }
});
app.patch('/api/recruitments/:id/title', auth, recruitmentGuard, managerAuth, coordinator, async(req,res)=>{
 try{
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Recrutamento inválido.'});
  const title=String(req.body?.title||'').trim().slice(0,160);
  if(!title)return res.status(400).json({error:'Informe um título para o agendamento.'});
  const r=await query(`UPDATE cip_recruitments SET title=$1 WHERE id=$2 RETURNING id,title,booking_id,recruitment_number`,[title,id]);
  if(!r.rowCount)return res.status(404).json({error:'Recrutamento não encontrado.'});
  if(r.rows[0].booking_id){
    await query(`UPDATE bookings SET course=$1 WHERE id=$2`,[title,r.rows[0].booking_id]);
  }
  await logAction(req.user.id,'RECRUTAMENTO_TITULO_ALTERADO',`Recrutamento Nº ${r.rows[0].recruitment_number||'—'} • novo título: ${title}`);
  res.json({ok:true,recruitment:r.rows[0]});
 }catch(e){console.error('PATCH título recrutamento:',e);res.status(500).json({error:'Não foi possível alterar o título do agendamento.'});}
});
app.delete('/api/recruitments/:id', auth, recruitmentGuard, managerAuth, coordinator, async(req,res)=>{
 try{
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Recrutamento inválido.'});
  const r=await query('SELECT id,recruitment_number,booking_id,date,start_time FROM cip_recruitments WHERE id=$1',[id]);
  if(!r.rowCount)return res.status(404).json({error:'Recrutamento não encontrado.'});
  const rec=r.rows[0];
  await query('DELETE FROM cip_recruitments WHERE id=$1',[id]);
  // Se este recrutamento veio da Agenda Geral, remove também a marcação espelhada.
  if(rec.booking_id){ await query('DELETE FROM bookings WHERE id=$1',[rec.booking_id]); }
  await logAction(req.user.id,'RECRUTAMENTO_EXCLUIDO',`Recrutamento Nº ${rec.recruitment_number||'—'} excluído`);
  res.json({ok:true});
 }catch(e){console.error('DELETE /api/recruitments/:id:',e);res.status(500).json({error:'Não foi possível excluir o agendamento do recrutamento.'});}
});
app.patch('/api/recruitments/:id/status', auth, recruitmentGuard, async(req,res)=>{
 const id=Number(req.params.id), status=req.body?.status; if(!['confirmed','completed','cancelled','pending'].includes(status))return res.status(400).json({error:'Status inválido.'});
 const r=await query("SELECT *, (date > CURRENT_DATE) AS is_future FROM cip_recruitments WHERE id=$1",[id]); const rec=r.rows[0]; if(!rec)return res.status(404).json({error:'Recrutamento não encontrado.'});
 // A data é DATE do PostgreSQL. Comparar com CURRENT_DATE evita erro de tipo/fuso
 // horário e permite marcar como realizado normalmente no próprio dia do recrutamento.
 if(status==='completed' && rec.is_future)return res.status(400).json({error:'O recrutamento ainda não foi realizado.'});
 await query('UPDATE cip_recruitments SET status=$1 WHERE id=$2',[status,id]);
 if(rec.booking_id){
   const bookingStatus=status==='confirmed'?'confirmed':status==='completed'?'completed':status==='cancelled'?'cancelled':'pending';
   await query('UPDATE bookings SET status=$1 WHERE id=$2',[bookingStatus,rec.booking_id]);
 }
 if(status!=='pending'){
   try {
     if(status==='confirmed') {
       const agendaDiscord = await sendRecruitmentAgendaDiscordMessage(id);
       if (!agendaDiscord?.ok) console.error('Discord Agenda recrutamento aprovado:', agendaDiscord?.reason || 'falha ao enviar embed');
     } else {
       await updateRecruitmentAgendaDiscordMessage(id);
     }
   } catch(e) { console.error('Discord Agenda status recrutamento:',e.message); }
 }
 if(status==='confirmed'){
  await notifyUsers([rec.created_by], 'success','Recrutamento aprovado',`O Recrutamento Nº ${rec.recruitment_number} foi aprovado.`);
  try { scheduleRecruitmentThreeHourReminder(id); } catch(e) { console.error('Agendamento do aviso 3h:', e.message); }
}
 res.json({ok:true});
});
app.post('/api/recruitments/:id/presence', auth, recruitmentGuard, async(req,res)=>{
 const id=Number(req.params.id); const present=req.body?.present!==false; const r=await query('SELECT * FROM cip_recruitments WHERE id=$1',[id]); if(!r.rowCount)return res.status(404).json({error:'Recrutamento não encontrado.'});
 await query(`INSERT INTO cip_recruitment_presence(recruitment_id,user_id,present) VALUES($1,$2,$3) ON CONFLICT(recruitment_id,user_id) DO UPDATE SET present=EXCLUDED.present,marked_at=NOW()`,[id,req.user.id,present]);
 try { const updated=await updateRecruitmentAgendaDiscordMessage(id); if(!updated?.ok && !updated?.skipped) console.error('Discord Agenda presença:',updated.reason); } catch(e) { console.error('Discord Agenda presença:',e.message); }
 try { const updated24h=await updateRecruitment24HourDiscordMessage(id); if(!updated24h?.ok && !updated24h?.skipped) console.error('Discord aviso 24h presença:',updated24h.reason); } catch(e) { console.error('Discord aviso 24h presença:',e.message); }
 try { const updated3h=await updateRecruitmentThreeHourDiscordMessage(id); if(!updated3h?.ok && !updated3h?.skipped) console.error('Discord aviso 3h presença:',updated3h.reason); } catch(e) { console.error('Discord aviso 3h presença:',e.message); }
 res.json({ok:true,present});
});
app.get('/api/recruitments/:id/presence', auth, recruitmentGuard, async(req,res)=>{const r=await query(`SELECT pr.*,u.name,u.rank,u.role,u.city_id,u.avatar_data FROM cip_recruitment_presence pr JOIN users u ON u.id=pr.user_id WHERE pr.recruitment_id=$1 ORDER BY u.name`,[Number(req.params.id)]);res.json(r.rows)});
app.post('/api/recruitments/:id/presence/users', auth, recruitmentGuard, managerAuth, coordinator, async(req,res)=>{
 try{
  const recruitmentId=Number(req.params.id);
  const userId=Number(req.body?.user_id);
  if(!Number.isInteger(recruitmentId)||recruitmentId<1||!Number.isInteger(userId)||userId<1)return res.status(400).json({error:'Recrutamento ou recrutador inválido.'});
  const rec=await query('SELECT id,recruitment_number,date,official FROM cip_recruitments WHERE id=$1',[recruitmentId]);
  if(!rec.rowCount)return res.status(404).json({error:'Recrutamento não encontrado.'});
  const user=await query(`SELECT id,name,role,status FROM users WHERE id=$1 AND role IN ('coordenador','coordenador_instrucao','coordenador_recrutamentos','recrutador','instrutor_recrutador') AND status='approved'`,[userId]);
  if(!user.rowCount)return res.status(400).json({error:'O usuário selecionado não está cadastrado/aprovado como recrutador.'});
  await query(`INSERT INTO cip_recruitment_presence(recruitment_id,user_id,present) VALUES($1,$2,TRUE) ON CONFLICT(recruitment_id,user_id) DO UPDATE SET present=TRUE,marked_at=NOW()`,[recruitmentId,userId]);
  try { await updateRecruitmentAgendaDiscordMessage(recruitmentId); } catch(e) { console.error('Discord Agenda presença adicionada:',e.message); }
  try { await updateRecruitment24HourDiscordMessage(recruitmentId); } catch(e) { console.error('Discord aviso 24h presença adicionada:',e.message); }
  try { await updateRecruitmentThreeHourDiscordMessage(recruitmentId); } catch(e) { console.error('Discord aviso 3h presença adicionada:',e.message); }
  await logAction(req.user.id,'PRESENCA_RECRUTADOR_ADICIONADA',`Recrutamento Nº ${rec.rows[0].recruitment_number||'—'} • ${user.rows[0].name} • ${rec.rows[0].date}`);
  res.json({ok:true,user:user.rows[0]});
 }catch(e){console.error('POST presença recrutador:',e);res.status(500).json({error:'Não foi possível adicionar o recrutador ao recrutamento.'});}
});
app.post('/api/recruitments/:id/presence/:userId/remove', auth, recruitmentGuard, managerAuth, coordinator, async(req,res)=>{
 try{
  const recruitmentId=Number(req.params.id);
  const userId=Number(req.params.userId);
  if(!Number.isInteger(recruitmentId)||recruitmentId<1||!Number.isInteger(userId)||userId<1){
    return res.status(400).json({error:'Recrutamento ou usuário inválido.'});
  }
  const rec=await query(`SELECT id,recruitment_number,date FROM cip_recruitments WHERE id=$1 LIMIT 1`,[recruitmentId]);
  if(!rec.rowCount)return res.status(404).json({error:'Recrutamento não encontrado.'});
  const user=await query(`SELECT id,name,city_id FROM users WHERE id=$1 LIMIT 1`,[userId]);
  if(!user.rowCount)return res.status(404).json({error:'Usuário não encontrado.'});
  const existing=await query(`SELECT id,present FROM cip_recruitment_presence WHERE recruitment_id=$1 AND user_id=$2 LIMIT 1`,[recruitmentId,userId]);
  if(!existing.rowCount || existing.rows[0].present===false){
    return res.status(404).json({error:'Este usuário não está marcado como presente neste recrutamento.'});
  }

  await query(`UPDATE cip_recruitment_presence SET present=FALSE,marked_at=NOW() WHERE recruitment_id=$1 AND user_id=$2`,[recruitmentId,userId]);

  try { await updateRecruitmentAgendaDiscordMessage(recruitmentId); } catch(e) { console.error('Discord Agenda remoção de presença:',e.message); }
  try { await updateRecruitment24HourDiscordMessage(recruitmentId); } catch(e) { console.error('Discord aviso 24h remoção de presença:',e.message); }
  try { await updateRecruitmentThreeHourDiscordMessage(recruitmentId); } catch(e) { console.error('Discord aviso 3h remoção de presença:',e.message); }

  await logAction(
    req.user.id,
    'PRESENCA_RECRUTADOR_REMOVIDA',
    `Recrutamento Nº ${rec.rows[0].recruitment_number||'—'} • ${user.rows[0].name} • ${rec.rows[0].date}`
  );
  res.json({ok:true,user:user.rows[0]});
 }catch(e){
  console.error('POST remoção de presença:',e);
  res.status(500).json({error:'Não foi possível remover a presença do recrutador.'});
 }
});
app.post('/api/recruitments/:id/transfer-participants', auth, recruitmentGuard, managerAuth, coordinator, async(req,res)=>{
 try{
  const sourceId=Number(req.params.id);
  const targetId=Number(req.body?.target_recruitment_id);
  const participantIds=Array.isArray(req.body?.participant_ids)
    ? [...new Set(req.body.participant_ids.map(Number).filter(Number.isInteger))]
    : [];
  if(!Number.isInteger(sourceId)||sourceId<1||!Number.isInteger(targetId)||targetId<1||sourceId===targetId){
    return res.status(400).json({error:'Informe o recrutamento de origem e um destino diferente.'});
  }
  if(!participantIds.length)return res.status(400).json({error:'Selecione pelo menos um conscrito para transferir.'});
  const source=await query(`SELECT id,recruitment_number,date,start_time,end_time,status,title FROM cip_recruitments WHERE id=$1`,[sourceId]);
  if(!source.rowCount)return res.status(404).json({error:'Recrutamento de origem não encontrado.'});
  const target=await query(`SELECT id,recruitment_number,date,start_time,end_time,status,title FROM cip_recruitments WHERE id=$1`,[targetId]);
  if(!target.rowCount)return res.status(404).json({error:'Recrutamento de destino não encontrado.'});
  if(String(target.rows[0].status).toLowerCase()==='cancelled')return res.status(400).json({error:'O recrutamento de destino está cancelado.'});

  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const participants=await client.query(`SELECT id,name,city_id,status FROM cip_recruitment_participants WHERE recruitment_id=$1 AND id=ANY($2::int[]) FOR UPDATE`,[sourceId,participantIds]);
   if(participants.rowCount!==participantIds.length){
     throw Object.assign(new Error('Um ou mais conscritos selecionados não pertencem ao recrutamento de origem.'),{statusCode:404});
   }
   const duplicates=await client.query(`SELECT city_id FROM cip_recruitment_participants WHERE recruitment_id=$1 AND city_id=ANY($2::text[])`,[targetId,participants.rows.map(x=>String(x.city_id))]);
   if(duplicates.rowCount){
     const ids=duplicates.rows.map(x=>String(x.city_id));
     throw Object.assign(new Error(`O destino já possui conscrito(s) com ID: ${ids.join(', ')}. Nenhum conscrito foi transferido.`),{statusCode:409});
   }
   await client.query(`UPDATE cip_recruitment_participants SET recruitment_id=$1 WHERE recruitment_id=$2 AND id=ANY($3::int[])`,[targetId,sourceId,participantIds]);
   await client.query(`UPDATE cip_recruitment_participant_edits SET recruitment_id=$1 WHERE recruitment_id=$2 AND participant_id=ANY($3::int[])`,[targetId,sourceId,participantIds]);
   await client.query('COMMIT');
   try{await refreshRecruitmentCutoffs()}catch(e){console.error('Atualização de notas de corte após transferência:',e.message)}
   await logAction(req.user.id,'CONSCRITOS_TRANSFERIDOS_RECRUTAMENTO',`Recrutamento Nº ${source.rows[0].recruitment_number||'—'} → Nº ${target.rows[0].recruitment_number||'—'} • ${participants.rowCount} conscrito(s): ${participants.rows.map(x=>`${x.name} [${x.city_id}]`).join(', ')}`);
   res.json({ok:true,moved:participants.rowCount,source_recruitment_id:sourceId,target_recruitment_id:targetId});
  }catch(e){
   try{await client.query('ROLLBACK')}catch(_){}
   if(e.statusCode)return res.status(e.statusCode).json({error:e.message});
   if(e.code==='23505')return res.status(409).json({error:'Um dos conscritos já existe no recrutamento de destino. Nenhum conscrito foi transferido.'});
   throw e;
  }finally{client.release()}
 }catch(e){console.error('POST transferência de conscritos:',e);res.status(500).json({error:e.message||'Não foi possível transferir os conscritos.'});}
});
app.post('/api/recruitments/:id/participants', auth, recruitmentGuard, async(req,res)=>{
 const id=Number(req.params.id), name=String(req.body?.name||'').trim(), cityId=String(req.body?.city_id||'').replace(/\D/g,''); if(!name||!cityId)return res.status(400).json({error:'Informe nome e ID/passaporte do conscrito.'});
 try{const r=await query(`INSERT INTO cip_recruitment_participants(recruitment_id,name,city_id) VALUES($1,$2,$3) RETURNING id,name,city_id,status,score`,[id,name,cityId]);res.json({ok:true,participant:r.rows[0]})}catch(e){if(e.code==='23505')return res.status(409).json({error:'Este conscrito já está neste recrutamento.'});console.error(e);res.status(500).json({error:'Não foi possível inserir o conscrito.'})}
});
app.delete('/api/recruitments/participants/:id', auth, recruitmentGuard, async(req,res)=>{await query('DELETE FROM cip_recruitment_participants WHERE id=$1',[Number(req.params.id)]);res.json({ok:true})});
app.get('/api/recruitments/:id/participants', auth, recruitmentGuard, async(req,res)=>{try{const rid=Number(req.params.id);if(!Number.isInteger(rid)||rid<1)return res.status(400).json({error:'Recrutamento inválido.'});await refreshRecruitmentCutoffs();const r=await query(`SELECT p.*,r.recruitment_number,r.date,r.cutoff_score FROM cip_recruitment_participants p JOIN cip_recruitments r ON r.id=p.recruitment_id WHERE p.recruitment_id=$1 ORDER BY p.id`,[rid]);res.json(r.rows)}catch(e){console.error('GET participantes recrutamento:',e);res.status(500).json({error:'Não foi possível carregar os conscritos.'})}});
app.post('/api/recruitments/participants/:id/start', auth, recruitmentGuard, async(req,res)=>{const id=Number(req.params.id);const p=await query(`SELECT p.*,r.recruitment_number,r.cutoff_score,r.status AS recruitment_status FROM cip_recruitment_participants p JOIN cip_recruitments r ON r.id=p.recruitment_id WHERE p.id=$1`,[id]);if(!p.rowCount)return res.status(404).json({error:'Conscrito não encontrado.'});if(!['confirmed','completed'].includes(p.rows[0].recruitment_status))return res.status(400).json({error:'O recrutamento precisa estar aprovado.'});await query(`UPDATE cip_recruitment_participants SET started_at=COALESCE(started_at,NOW()) WHERE id=$1`,[id]);res.json({participant:p.rows[0],questions:RECRUITMENT_QUESTIONS,user:{name:req.currentUser.name,city_id:req.currentUser.city_id,role:req.currentUser.role}})});
app.post('/api/recruitments/participants/:id/submit', auth, recruitmentGuard, async(req,res)=>{
 const id=Number(req.params.id), answers=req.body?.answers||{}; const p=await query(`SELECT p.*,r.recruitment_number,r.cutoff_score,r.date FROM cip_recruitment_participants p JOIN cip_recruitments r ON r.id=p.recruitment_id WHERE p.id=$1`,[id]);if(!p.rowCount)return res.status(404).json({error:'Conscrito não encontrado.'});
 let score=0; for(const q of RECRUITMENT_QUESTIONS){const a=answers[String(q.id)];const selected=Array.isArray(a?.selected)?a.selected.map(Number).filter(Number.isInteger):[];if(!selected.length)return res.status(400).json({error:`A Questão ${q.id} não foi respondida.`});if(q.type==='U'&&selected.length!==1)return res.status(400).json({error:`A Questão ${q.id} aceita apenas uma resposta.`});if(q.type==='M'){const noAnswerIndexes=q.criteria.map((c,i)=>c[2]==='no_answer'?i:-1).filter(i=>i>=0);if(noAnswerIndexes.some(i=>selected.includes(i))){if(selected.length!==1)return res.status(400).json({error:`Na Questão ${q.id}, "Não respondeu" não pode ser combinado com outras opções.`});score+=0}else{score+=q.criteria.reduce((sum,c,i)=>sum+(selected.includes(i)?Number(c[1]):0),0)}}else{const idx=selected[0];if(idx<0||idx>=q.criteria.length)return res.status(400).json({error:`Resposta inválida na Questão ${q.id}.`});score+=Number(q.criteria[idx][1]||0)}} score=Math.round(score*100)/100;
 await query(`UPDATE cip_recruitment_participants SET answers=$1,score=$2,proof_completed=TRUE,status='pending',submitted_at=NOW() WHERE id=$3`,[JSON.stringify(answers),score,id]);
 await refreshRecruitmentCutoffs();
 res.json({ok:true,score,status:'pending',proof_completed:true});
});
app.post('/api/recruitments/:id/send-proofs', auth, recruitmentGuard, async(req,res)=>{
 try{
  const id=Number(req.params.id);
  const r=await query(`SELECT id,recruitment_number FROM cip_recruitments WHERE id=$1`,[id]);
  if(!r.rowCount)return res.status(404).json({error:'Recrutamento não encontrado.'});
  const totals=await query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER(WHERE proof_completed=TRUE OR status IN ('submitted','approved','rejected'))::int AS completed FROM cip_recruitment_participants WHERE recruitment_id=$1`,[id]);
  const total=Number(totals.rows[0].total), completed=Number(totals.rows[0].completed);
  if(total===0)return res.status(400).json({error:'Não há conscritos cadastrados neste recrutamento.'});
  if(completed!==total)return res.status(400).json({error:`Ainda há ${total-completed} conscrito(s) sem realizar a prova.`});
  await query(`UPDATE cip_recruitment_participants SET status='submitted' WHERE recruitment_id=$1 AND proof_completed=TRUE AND status='pending'`,[id]);
  await refreshRecruitmentCutoffs();
  const data=await query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER(WHERE status='submitted')::int AS sent FROM cip_recruitment_participants WHERE recruitment_id=$1`,[id]);
  await notifyManagers('result','Provas de recrutamento enviadas',`Recrutamento Nº ${r.rows[0].recruitment_number} • ${data.rows[0].sent} prova(s) enviadas para aprovação.`);
  if (Number(data.rows[0].sent) > 0) {
    const info = await query(`SELECT r.recruitment_number,r.date,to_char(r.date,'YYYY-MM-DD') AS date_key,r.start_time,r.end_time,r.cutoff_score,ru.name AS recruiter_name,COUNT(p.id)::int AS total,ROUND(AVG(p.score) FILTER (WHERE p.score IS NOT NULL),2) AS average_score FROM cip_recruitments r LEFT JOIN users ru ON ru.id=r.recruiter_id JOIN cip_recruitment_participants p ON p.recruitment_id=r.id WHERE r.id=$1 GROUP BY r.id,ru.name`,[id]);
    const x=info.rows[0];
    const pendingEmbed = `📝 **RESULTADO DE RECRUTAMENTO — AGUARDANDO APROVAÇÃO**\n\n🎯 **Recrutamento Nº:** ${x.recruitment_number || '—'}\n📅 **Data:** ${recruitmentDiscordDateTimestamp(x) || formatDateBR(x.date_key || x.date)}\n⏰ **Horário:** ${formatTimeBR(x.start_time)} - ${formatTimeBR(x.end_time)}\n👮 **Recrutador:** ${x.recruiter_name || '—'}\n\n📊 **Média das notas:** ${x.average_score!=null?formatScoreBR(x.average_score):'—'}\n🎯 **Nota de corte:** ${x.cutoff_score!=null?formatScoreBR(x.cutoff_score):'—'}\n👥 **Resultados:** ${x.total}\n\n🟡 **Status:** AGUARDANDO APROVAÇÃO\n\nUse os botões abaixo para aprovar ou reprovar o resultado.`;
    await discordNotify(pendingEmbed,'approvals',{components:approvalButtons('recruitment_result',id)});
  }
  res.json({ok:true,total:total,sent:Number(data.rows[0].sent)});
 }catch(e){console.error('POST /api/recruitments/:id/send-proofs:',e);res.status(500).json({error:'Não foi possível enviar as provas para aprovação.'});}
});
app.post('/api/recruitments/:id/send-proofs/resend', auth, recruitmentGuard, async(req,res)=>{
 try{
  if(!isRecruitmentCoordinatorRole(req.currentUser.role))return res.status(403).json({error:'Somente Coordenador, Coordenador de Instrução, Coordenador de Recrutamentos ou Administrador pode reenviar provas para aprovação.'});
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Recrutamento inválido.'});
  const info=await query(`
    SELECT r.id,r.recruitment_number,r.date,to_char(r.date,'YYYY-MM-DD') AS date_key,
           r.start_time,r.end_time,r.cutoff_score,ru.name AS recruiter_name,
           COUNT(p.id)::int AS total,
           ROUND(AVG(p.score) FILTER (WHERE p.score IS NOT NULL),2) AS average_score,
           COUNT(p.id) FILTER (WHERE p.status IN ('submitted','approved','rejected'))::int AS submitted
    FROM cip_recruitments r
    LEFT JOIN users ru ON ru.id=r.recruiter_id
    LEFT JOIN cip_recruitment_participants p ON p.recruitment_id=r.id
    WHERE r.id=$1
    GROUP BY r.id,ru.name
  `,[id]);
  if(!info.rowCount)return res.status(404).json({error:'Recrutamento não encontrado.'});
  const x=info.rows[0];
  if(Number(x.total)===0)return res.status(400).json({error:'Não há conscritos cadastrados neste recrutamento.'});
  if(Number(x.submitted)===0)return res.status(400).json({error:'Não há provas aguardando aprovação neste recrutamento.'});
  const pendingEmbed = `📝 **RESULTADO DE RECRUTAMENTO — AGUARDANDO APROVAÇÃO**\n\n🎯 **Recrutamento Nº:** ${x.recruitment_number || '—'}\n📅 **Data:** ${recruitmentDiscordDateTimestamp(x) || formatDateBR(x.date_key || x.date)}\n⏰ **Horário:** ${formatTimeBR(x.start_time)} - ${formatTimeBR(x.end_time)}\n👮 **Recrutador:** ${x.recruiter_name || '—'}\n\n📊 **Média das notas:** ${x.average_score!=null?formatScoreBR(x.average_score):'—'}\n🎯 **Nota de corte:** ${x.cutoff_score!=null?formatScoreBR(x.cutoff_score):'—'}\n👥 **Resultados:** ${x.total}\n\n🟡 **Status:** AGUARDANDO APROVAÇÃO\n\nUse os botões abaixo para aprovar ou reprovar o resultado.`;
  // O reenvio é apenas um teste: não altera status nem cria outro registro de lembrete.
  await discordNotify(pendingEmbed,'approvals',{components:approvalButtons('recruitment_result',id)});
  try{await logAction(req.currentUser.id,'RESULTADO_RECRUTAMENTO_REENVIADO_APROVACAO_DISCORD',`Recrutamento Nº ${x.recruitment_number||'—'} • ${x.submitted} prova(s) reenviadas para aprovação`)}catch(e){console.error('Log reenvio provas:',e.message)}
  res.json({ok:true,recruitment_number:x.recruitment_number,submitted:Number(x.submitted)});
 }catch(e){
  console.error('POST /api/recruitments/:id/send-proofs/resend:',e);
  res.status(500).json({error:e.message||'Não foi possível reenviar as provas para aprovação.'});
 }
});
app.get('/api/recruitments/results', auth, recruitmentGuard, async(req,res)=>{try{await refreshRecruitmentCutoffs();const r=await query(`SELECT p.*,r.recruitment_number,r.date,r.start_time,r.cutoff_score,r.official,r.recruiter_id,ru.name AS recruiter_name,u.name AS reviewed_by_name FROM cip_recruitment_participants p JOIN cip_recruitments r ON r.id=p.recruitment_id LEFT JOIN users ru ON ru.id=r.recruiter_id LEFT JOIN users u ON u.id=p.reviewed_by ORDER BY p.submitted_at DESC NULLS LAST,p.id DESC`);res.json(r.rows)}catch(e){console.error('GET /api/recruitments/results:',e);res.status(500).json({error:'Não foi possível carregar os resultados.'})}});
app.get('/api/recruitments/participants/:id/edits', auth, recruitmentGuard, async(req,res)=>{
 if(!isRecruitmentCoordinatorRole(req.currentUser.role))return res.status(403).json({error:'Somente Coordenador, Coordenador de Instrução, Coordenador de Recrutamentos ou Administrador pode consultar o histórico de alterações.'});
 const id=Number(req.params.id);
 const r=await query(`SELECT e.*,u.name AS changed_by_name FROM cip_recruitment_participant_edits e LEFT JOIN users u ON u.id=e.changed_by WHERE e.participant_id=$1 ORDER BY e.changed_at DESC,e.id DESC`,[id]);
 res.json(r.rows);
});
app.post('/api/recruitments/participants/:id/edit-identity', auth, recruitmentGuard, async(req,res)=>{
 if(!isRecruitmentCoordinatorRole(req.currentUser.role))return res.status(403).json({error:'Somente Coordenador, Coordenador de Instrução, Coordenador de Recrutamentos ou Administrador pode editar dados após a aprovação.'});
 const id=Number(req.params.id);
 const newName=String(req.body?.name||'').trim();
 const newCityId=String(req.body?.city_id||'').replace(/\D/g,'').trim();
 if(!newName||!newCityId)return res.status(400).json({error:'Informe o nome e o ID/passaporte.'});
 if(newName.length>120)return res.status(400).json({error:'O nome é muito longo.'});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const r=await client.query(`SELECT p.*,r.recruitment_number,r.date FROM cip_recruitment_participants p JOIN cip_recruitments r ON r.id=p.recruitment_id WHERE p.id=$1 FOR UPDATE`,[id]);
  if(!r.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Conscrito não encontrado.'});}
  const p=r.rows[0];
  const duplicate=await client.query(`SELECT id FROM cip_recruitment_participants WHERE recruitment_id=$1 AND city_id=$2 AND id<>$3 LIMIT 1`,[p.recruitment_id,newCityId,id]);
  if(duplicate.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'Este ID/passaporte já pertence a outro conscrito neste recrutamento.'});}
  const changedName=p.name!==newName,changedId=String(p.city_id)!==newCityId;
  if(!changedName&&!changedId){await client.query('ROLLBACK');return res.status(400).json({error:'Nenhuma alteração foi informada.'});}
  await client.query(`UPDATE cip_recruitment_participants SET name=$1,city_id=$2 WHERE id=$3`,[newName,newCityId,id]);
  await client.query(`INSERT INTO cip_recruitment_participant_edits(participant_id,recruitment_id,old_name,old_city_id,new_name,new_city_id,changed_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,p.recruitment_id,p.name,p.city_id,newName,newCityId,req.user.id]);
  await client.query('COMMIT');
  const actor=req.currentUser?.name||'Usuário';
  const msg=`🔄 **DADOS DO CONSCRITO ATUALIZADOS**\n📋 **Recrutamento Nº ${p.recruitment_number}**\n👤 **Nome anterior:** ${p.name}\n🪪 **ID anterior:** ${p.city_id}\n\n✅ **Nome atualizado:** ${newName}\n🪪 **ID atualizado:** ${newCityId}\n📊 **Nota:** ${p.score!=null?formatScoreBR(p.score):'—'}\n📌 **Status:** ${String(p.status||'').toUpperCase()}\n👮 **Alterado por:** ${actor}\n🕐 **Data:** ${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}`;
  try{await discordNotify(msg,'recruitmentResults')}catch(e){console.error('Discord atualização de dados:',e.message)}
  await logAction(req.user.id,'DADOS_CONSCRITO_ATUALIZADOS',`Recrutamento Nº ${p.recruitment_number} • ${p.name} (${p.city_id}) → ${newName} (${newCityId})`);
  res.json({ok:true,participant:{...p,name:newName,city_id:newCityId},discordNotified:true});
 }catch(e){try{await client.query('ROLLBACK')}catch{};console.error('Editar dados conscrito:',e);res.status(500).json({error:'Não foi possível atualizar os dados do conscrito.'});}finally{client.release()}
});
app.post('/api/recruitments/results/:id/review', auth, recruitmentGuard, async(req,res)=>{
 if(!isRecruitmentCoordinatorRole(req.currentUser.role))return res.status(403).json({error:'Somente Coordenador, Coordenador de Instrução, Coordenador de Recrutamentos ou Administrador pode aprovar resultados.'});
 const id=Number(req.params.id),status=req.body?.status,note=String(req.body?.note||'').trim();
 if(!['approved','rejected'].includes(status))return res.status(400).json({error:'Decisão inválida.'});
 const r=await query(`SELECT p.*,r.recruitment_number,r.cutoff_score FROM cip_recruitment_participants p JOIN cip_recruitments r ON r.id=p.recruitment_id WHERE p.id=$1`,[id]);
 if(!r.rowCount)return res.status(404).json({error:'Resultado não encontrado.'});
 const participant=r.rows[0];
 const finalStatus=status;
 await query(`UPDATE cip_recruitment_participants SET status=$1,reviewed_at=NOW(),reviewed_by=$2,review_note=$3 WHERE id=$4`,[finalStatus,req.user.id,note,id]);
 try{await logAction(req.user.id,'RESULTADO_RECRUTAMENTO_LANCADO',`Recrutamento Nº ${r.rows[0].recruitment_number||'—'} • Conscrito ID ${r.rows[0].city_id} • ${finalStatus.toUpperCase()}`)}catch(e){console.error('Log resultado recrutamento:',e.message)}
 try{await sendRecruitmentResultSummary(r.rows[0].recruitment_id)}catch(e){console.error('Bot Discord - resultado do recrutamento:',e.message)}
 res.json({ok:true});
});
app.post('/api/recruitments/:id/results/review-all', auth, recruitmentGuard, async(req,res)=>{
 if(!isRecruitmentCoordinatorRole(req.currentUser.role))return res.status(403).json({error:'Somente Coordenador, Coordenador de Instrução, Coordenador de Recrutamentos ou Administrador pode aprovar resultados.'});
 const recruitmentId=Number(req.params.id),status=req.body?.status,note=String(req.body?.note||'').trim();
 if(!['approved','rejected'].includes(status))return res.status(400).json({error:'Decisão inválida.'});
 const r=await query(`SELECT id,recruitment_number FROM cip_recruitments WHERE id=$1`,[recruitmentId]);
 if(!r.rowCount)return res.status(404).json({error:'Recrutamento não encontrado.'});
 await refreshRecruitmentCutoffs();
 const updated=await query(`
   UPDATE cip_recruitment_participants p
   SET status=CASE
       WHEN p.score IS NOT NULL AND p.score >= r.cutoff_score THEN 'approved'
       WHEN p.score IS NOT NULL THEN 'rejected'
       ELSE $1
     END,
     reviewed_at=NOW(),
     reviewed_by=$2,
     review_note=$3
   FROM cip_recruitments r
   WHERE p.recruitment_id=$4 AND p.status='submitted' AND r.id=p.recruitment_id
   RETURNING p.id
 `,[status,req.user.id,note,recruitmentId]);
 try{await logAction(req.user.id,'RESULTADO_RECRUTAMENTO_LANCADO',`Recrutamento Nº ${r.rows[0].recruitment_number||'—'} • ${updated.rowCount} resultado(s) revisado(s)`)}catch(e){console.error('Log resultado recrutamento:',e.message)}
 try{await sendRecruitmentResultSummary(recruitmentId)}catch(e){console.error('Bot Discord - resultado do recrutamento:',e.message)}
 res.json({ok:true,updated:updated.rowCount,recruitment_number:r.rows[0].recruitment_number});
});
app.post('/api/recruitments/:id/results/resend', auth, recruitmentGuard, async(req,res)=>{
 try{
  if(!isRecruitmentCoordinatorRole(req.currentUser.role))return res.status(403).json({error:'Somente Coordenador, Coordenador de Instrução, Coordenador de Recrutamentos ou Administrador pode reenviar resultados ao Discord.'});
  const recruitmentId=Number(req.params.id);
  if(!Number.isInteger(recruitmentId)||recruitmentId<1)return res.status(400).json({error:'Recrutamento inválido.'});
  const r=await query(`
    SELECT r.id,r.recruitment_number,r.status,COUNT(p.id)::int AS total,
           COUNT(p.id) FILTER (WHERE p.status IN ('approved','rejected'))::int AS reviewed
    FROM cip_recruitments r
    LEFT JOIN cip_recruitment_participants p ON p.recruitment_id=r.id
    WHERE r.id=$1
    GROUP BY r.id
  `,[recruitmentId]);
  if(!r.rowCount)return res.status(404).json({error:'Recrutamento não encontrado.'});
  const rec=r.rows[0];
  if(Number(rec.total)===0)return res.status(400).json({error:'Não há conscritos cadastrados neste recrutamento.'});
  if(Number(rec.reviewed)!==Number(rec.total))return res.status(400).json({error:'O resultado só pode ser reenviado quando todos os conscritos estiverem aprovados ou reprovados.'});
  const result=await sendRecruitmentResultSummary(recruitmentId,{forceResend:true});
  await logAction(req.user.id,'RESULTADO_RECRUTAMENTO_REENVIADO_DISCORD',`Recrutamento Nº ${rec.recruitment_number||'—'} reenviado ao Discord`);
  res.json({ok:true,...result,recruitment_number:rec.recruitment_number});
 }catch(e){
  console.error('POST /api/recruitments/:id/results/resend:',e);
  res.status(500).json({error:e.message||'Não foi possível reenviar o resultado ao Discord.'});
 }
});
app.get('/api/instruction-notices/preview', auth, async(req,res)=>{
  try{
    if(!isInstructionCoordinatorRole(req.user.role)) return res.status(403).json({error:'Somente Coordenadores de Instrução e Administradores podem gerenciar avisos.'});
    const notice=await buildInstructionWeeklyNotice();
    const message=`${notice.message}\n\n📢 **AVISO SEMANAL — ORGANIZAÇÃO DA AGENDA**\n\nA nova semana está começando. Organizem-se com antecedência e **marquem seus cursos na Agenda** para que a equipe consiga se organizar.\n\n📅 **Período:** ${formatDateBR(notice.todayKey)} até ${formatDateBR(notice.endDate)}\n📚 **Cursos já agendados:** ${notice.total}\n\n✅ **Quem ainda não marcou seu curso, aproveite para organizar e registrar na Agenda.**\n📌 Antes de divulgar um curso, confira se a marcação está aprovada.\n\n**Boa semana e bons cursos!**`;
    const status=await query(`SELECT week_key,sent_at,message_id FROM cip_instruction_weekly_notices ORDER BY sent_at DESC LIMIT 1`);
    res.json({ok:true,message,lastSent:status.rows[0]||null});
  }catch(e){console.error('GET /api/instruction-notices/preview:',e);res.status(500).json({error:'Não foi possível gerar o aviso.'});}
});
app.post('/api/instruction-notices/send', auth, async(req,res)=>{
  try{
    if(!isInstructionCoordinatorRole(req.user.role)) return res.status(403).json({error:'Somente Coordenadores de Instrução e Administradores podem enviar avisos.'});
    const result=await sendInstructionWeeklyNotice({force:true,userId:req.user.id});
    if(!result?.ok){
      if(result?.rateLimited)return res.status(429).json({error:result.reason||'Discord limitou o envio.',retryAfter:result.retryAfter});
      return res.status(502).json({error:result?.reason||'Não foi possível enviar o aviso ao Discord.'});
    }
    await logAction(req.user.id,'AVISO_SEMANAL_INSTRUTORES_ENVIADO_DISCORD',`Aviso semanal dos instrutores enviado manualmente${result.week_key?` • ${result.week_key}`:''}`);
    res.json({ok:true,message:'Aviso enviado ao Discord com sucesso.',...result});
  }catch(e){console.error('POST /api/instruction-notices/send:',e);res.status(500).json({error:e.message||'Não foi possível enviar o aviso.'});}
});

app.get('/api/recruitments/reports', auth, recruitmentGuard, async(req,res)=>{const r=await query(`SELECT r.id,r.recruitment_number,r.date,r.status,r.cutoff_score,COUNT(p.id)::int AS conscripts,ROUND(AVG(p.score) FILTER(WHERE p.score IS NOT NULL),2) AS average_score,COUNT(p.id) FILTER (WHERE p.score IS NOT NULL AND p.score >= r.cutoff_score)::int AS approved,COUNT(p.id) FILTER (WHERE p.score IS NOT NULL AND p.score < r.cutoff_score)::int AS rejected FROM cip_recruitments r LEFT JOIN cip_recruitment_participants p ON p.recruitment_id=r.id WHERE r.official=TRUE GROUP BY r.id ORDER BY r.date DESC,r.id DESC`);res.json(r.rows)});

// Teste manual do aviso de 24h. Somente Coordenador/Administrador.
// O envio usa exatamente o mesmo texto/canal do aviso automático, mas NÃO grava
// o lembrete como enviado, para não impedir o disparo real quando chegar a janela de 24h.
app.post('/api/recruitments/:id/reminders/24h-test', auth, recruitmentGuard, async(req,res)=>{
  try{
    if(!isRecruitmentCoordinatorRole(req.currentUser.role))return res.status(403).json({error:'Somente Coordenador, Coordenador de Instrução, Coordenador de Recrutamentos ou Administrador pode testar o aviso de 24h.'});
    const id=Number(req.params.id);
    if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Recrutamento inválido.'});
    const r=await query(`SELECT r.*,to_char(r.date,'YYYY-MM-DD') AS date_key,b.status AS booking_status,b.course
      FROM cip_recruitments r
      LEFT JOIN bookings b ON b.id=r.booking_id
      WHERE r.id=$1`,[id]);
    if(!r.rowCount)return res.status(404).json({error:'Recrutamento não encontrado.'});
    const x=r.rows[0];
    if(x.status==='cancelled')return res.status(400).json({error:'Não é possível testar o aviso de um recrutamento cancelado.'});
    if(x.official!==true)return res.status(400).json({error:'O aviso de 24h é destinado aos recrutamentos oficiais da Agenda.'});
    const greeting=getSaoPauloGreeting();
    const embed=await buildRecruitment24HourEmbed({
      ...x,
      date_key:x.date_key || normalizeDateKey(x.date)
    });
    const result=await discordNotify(`**${greeting} <@&1534527435347853325>!**`,'recruitmentAgenda',{embed});
    if(!result?.ok){
      if(result?.rateLimited)return res.status(429).json({error:`Discord limitou o envio. Tente novamente em ${result.retryAfter||'alguns segundos'}.`,retryAfter:result.retryAfter});
      return res.status(502).json({error:result?.reason||'Não foi possível enviar o aviso ao Discord. Verifique DISCORD_BOT_TOKEN e as permissões do Bot no canal.'});
    }
    await logAction(req.user.id,'TESTE_AVISO_24H_RECRUTAMENTO',`Teste do aviso 24h • Recrutamento Nº ${x.recruitment_number||'—'}`);
    res.json({ok:true,recruitment_number:x.recruitment_number,message:'Aviso de 24h enviado ao Discord para teste. O lembrete automático não foi marcado como enviado.'});
  }catch(e){
    console.error('POST /api/recruitments/:id/reminders/24h-test:',e);
    res.status(500).json({error:e.message||'Não foi possível testar o aviso de 24h.'});
  }
});


async function buildInstructionWeeklyNotice(){
  const rows=await query(`
    SELECT b.date,to_char(b.date,'YYYY-MM-DD') AS date_key,b.start_time,b.end_time,b.course,
           u.name AS instructor_name,b.status
    FROM bookings b
    JOIN users u ON u.id=b.instructor_id
    WHERE b.date >= ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
      AND b.date <= ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '6 days')::date
      AND LOWER(TRIM(COALESCE(b.course,''))) NOT IN ('recrutamento')
      AND LOWER(COALESCE(b.status,'')) IN ('confirmed','approved','pending')
    ORDER BY b.date,b.start_time,b.id
    LIMIT 15
  `);
  const todayKey=new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
  const endDate=new Date(Date.now()+6*86400000).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
  const total=rows.rowCount;
  const greeting=getSaoPauloGreeting();
  const message=`**${greeting} <@&${DISCORD_ROLE_INSTRUTORES_ID}>!**`;
  return { message, rows: rows.rows, total, todayKey, endDate };
}

function getCipPublicBaseUrl(){
  return String(process.env.CIP_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/,'');
}

function getInstructionNoticeLogoUrl(){
  const base=String(process.env.CIP_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/,'');
  return base ? `${base}/CIP.webp` : null;
}

function buildInstructionWeeklyEmbed(data){
  const {total=0,todayKey,endDate}=data||{};
  const fields=[
    {name:'📅 Período',value:`${formatDateBR(todayKey)} até ${formatDateBR(endDate)}`,inline:true},
    {name:'📚 Cursos já agendados',value:String(total),inline:true},
    {
      name:'📌 Organização',
      value:'✅ Quem ainda não marcou seu curso, aproveite para organizar e registrar na Agenda.\n\n📌 Antes de divulgar um curso, confira se a marcação está aprovada.',
      inline:false
    }
  ];

  const embed={
    title:'📢 AVISO SEMANAL — ORGANIZAÇÃO DA AGENDA',
    description:'A nova semana está começando. Organizem-se com antecedência e **marquem seus cursos na Agenda** para que a equipe consiga se organizar.',
    color:0xF1C40F,
    fields,
    footer:{text:'CIP • Sistema de Gestão'},
    timestamp:new Date().toISOString()
  };
  const logoUrl=getInstructionNoticeLogoUrl();
  if(logoUrl) embed.thumbnail={url:logoUrl};
  // Banner institucional do aviso semanal aos instrutores.
  if(logoUrl) embed.image={url:`${getCipPublicBaseUrl()}/aviso-instrutores.png`};
  return embed;
}

async function sendInstructionWeeklyNotice(options={}){
  const force=options?.force===true;
  const now=new Date();
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',weekday:'long',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hour12:false}).formatToParts(now);
  const get=k=>parts.find(p=>p.type===k)?.value||'';
  const weekday=get('weekday');
  const hour=Number(get('hour'));
  if(!force && (weekday!=='Sunday' || hour<18)) return {ok:true,skipped:true,reason:'Fora da janela do aviso semanal.'};
  const weekKey=`${get('year')}-${get('month')}-${get('day')}`;
  const existing=await query(`SELECT week_key,message_id,sent_at FROM cip_instruction_weekly_notices WHERE week_key=$1 LIMIT 1`,[weekKey]);
  if(existing.rowCount && !force) return {ok:true,alreadySent:true,week_key:weekKey};
  const data=await buildInstructionWeeklyNotice();
  const embed=buildInstructionWeeklyEmbed(data);
  const result=await discordNotify(data.message,'instructionNotices',{embed});
  if(!result?.ok) return result;
  await query(`INSERT INTO cip_instruction_weekly_notices(week_key,message_id,sent_by) VALUES($1,$2,$3) ON CONFLICT (week_key) DO UPDATE SET sent_at=NOW(),message_id=EXCLUDED.message_id,sent_by=EXCLUDED.sent_by`,[weekKey,result.messageId||null,options?.userId||null]);
  return {ok:true,week_key:weekKey,messageId:result.messageId||null,forced:force};
}

async function sendInstructionWeeklyNoticeAutomatic(){
  try{
    const result=await sendInstructionWeeklyNotice();
    if(result?.ok && !result?.skipped && !result?.alreadySent) console.log(`[INSTRUTORES AVISO] Aviso semanal enviado | semana=${result.week_key}`);
    else if(result?.skipped) console.log(`[INSTRUTORES AVISO] Fora da janela automática.`);
    return result;
  }catch(e){ console.error('[INSTRUTORES AVISO] Falha no aviso semanal:',e.message); return {ok:false,error:e.message}; }
}

// Agendador dedicado do aviso semanal. O horário é calculado em
// America/Sao_Paulo, sem depender do fuso do servidor. A rotina dispara
// exatamente na janela das 18:00 e faz tentativas de segurança por 15 minutos.
// A tabela cip_instruction_weekly_notices garante idempotência.
function scheduleInstructionWeeklyNotice(){
  const tz='America/Sao_Paulo';
  const getNowParts=()=>{
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:tz,weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(new Date());
    const get=k=>parts.find(p=>p.type===k)?.value||'';
    return {weekday:get('weekday'),year:Number(get('year')),month:Number(get('month')),day:Number(get('day')),hour:Number(get('hour')),minute:Number(get('minute')),second:Number(get('second'))};
  };
  const msUntilNextSunday18=()=>{
    const now=new Date();
    const p=getNowParts();
    // JS weekday: Sunday=0. Calcula o próximo domingo às 18:00 usando
    // um pequeno avanço por minutos e converte pelo timezone de Sao Paulo.
    const target=new Date(now.getTime()+7*24*60*60*1000);
    const dayMap={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
    const currentDow=dayMap[p.weekday] ?? 0;
    let days=(7-currentDow)%7;
    if(days===0 && (p.hour>18 || (p.hour===18 && p.minute>=0))) days=7;
    // Para America/Sao_Paulo (UTC-03 atualmente), criar a data pelo ISO
    // e calcular o alvo com Intl. O fallback abaixo cobre o agendamento inicial.
    const base=new Date(now);
    base.setHours(base.getHours()+days*24);
    base.setMinutes(0,0,0);
    // Ajusta a hora local do processo para representar 18:00 em Sao Paulo.
    const localHour=Number(new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'2-digit',hour12:false}).format(base));
    const delta=18-localHour;
    base.setHours(base.getHours()+delta);
    return Math.max(1000,base.getTime()-now.getTime());
  };
  const scheduleNext=()=>{
    const delay=msUntilNextSunday18();
    console.log(`[INSTRUTORES AVISO] Próximo disparo automático calculado em ${Math.round(delay/60000)} min (18:00 America/Sao_Paulo).`);
    setTimeout(async()=>{
      console.log('[INSTRUTORES AVISO] Janela das 18:00 iniciada.');
      for(let i=0;i<=15;i++){
        const r=await sendInstructionWeeklyNoticeAutomatic();
        if(r?.ok && !r?.skipped) break;
        if(i<15) await new Promise(resolve=>setTimeout(resolve,60*1000));
      }
      scheduleNext();
    },delay);
  };
  scheduleNext();
}


// ===== AVISO SEMANAL DOS RECRUTADORES =====
async function buildRecruitmentWeeklyNotice(){
  const rows=await query(`
    SELECT r.id,r.recruitment_number,r.date,to_char(r.date,'YYYY-MM-DD') AS date_key,
           r.start_time,r.end_time,r.status,r.title,u.name AS recruiter_name,
           (SELECT COUNT(*)::int FROM cip_recruitment_presence pr
            WHERE pr.recruitment_id=r.id AND pr.present=TRUE) AS presences
    FROM cip_recruitments r
    LEFT JOIN users u ON u.id=r.recruiter_id
    WHERE r.official=TRUE
      AND r.date >= ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
      AND r.date <= ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '6 days')::date
      AND LOWER(COALESCE(r.status,'')) IN ('pending','confirmed','completed')
    ORDER BY r.date,r.start_time,r.id
    LIMIT 20
  `);
  const todayKey=new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
  const endDate=new Date(Date.now()+6*86400000).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
  const greeting=getSaoPauloGreeting();
  return {
    message:`**${greeting} <@&${DISCORD_ROLE_RECRUTADORES_ID}>!**`,
    rows:rows.rows,total:rows.rowCount,todayKey,endDate
  };
}

function buildRecruitmentWeeklyEmbed(data){
  const {total=0,todayKey,endDate,rows=[]}=data||{};
  const fields=[
    {name:'📅 Período',value:`${formatDateBR(todayKey)} até ${formatDateBR(endDate)}`,inline:true},
    {name:'📚 Recrutamentos agendados',value:String(total),inline:true},
    {
      name:'📌 ORGANIZAÇÃO',
      value:'✅ Confira a Agenda com antecedência, organize sua participação e mantenha os recrutamentos preparados.\n\n📌 Antes de realizar o recrutamento, confira a marcação, o horário e a equipe escalada.',
      inline:false
    }
  ];
  if(rows.length){
    const preview=rows.slice(0,8).map(r=>`• **Nº ${r.recruitment_number||'—'}** — ${formatDateBR(r.date_key||r.date)} • ${formatTimeBR(r.start_time)}–${formatTimeBR(r.end_time)} • ${r.recruiter_name||'—'}`).join('\n');
    fields.push({name:'📋 PRÓXIMOS RECRUTAMENTOS',value:preview.slice(0,1024),inline:false});
  }
  const embed={
    title:'📢 AVISO AOS RECRUTADORES',
    description:'Mantenham o foco e a organização! Nesta semana, reforçamos a importância da **preparação, presença e alinhamento** da equipe para que os recrutamentos ocorram com excelência.',
    color:0xF1C40F,
    fields,
    footer:{text:'CIP • Agenda de Recrutamentos • 1º BPM'},
    timestamp:new Date().toISOString()
  };
  const base=getCipPublicBaseUrl();
  const logo=base?`${base}/CIP.webp`:null;
  if(logo) embed.thumbnail={url:logo};
  if(base) embed.image={url:`${base}/aviso-recrutadores.png`};
  return embed;
}

async function sendRecruitmentWeeklyNotice(options={}){
  const force=options?.force===true;
  const now=new Date();
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',weekday:'long',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hour12:false}).formatToParts(now);
  const get=k=>parts.find(p=>p.type===k)?.value||'';
  const weekday=get('weekday'),hour=Number(get('hour'));
  if(!force && (weekday!=='Sunday'||hour<18)) return {ok:true,skipped:true,reason:'Fora da janela do aviso semanal dos recrutadores.'};
  const weekKey=`${get('year')}-${get('month')}-${get('day')}`;
  const existing=await query(`SELECT week_key,message_id,sent_at FROM cip_recruitment_weekly_notices WHERE week_key=$1 LIMIT 1`,[weekKey]);
  if(existing.rowCount&&!force)return {ok:true,alreadySent:true,week_key:weekKey};
  const data=await buildRecruitmentWeeklyNotice();
  const embed=buildRecruitmentWeeklyEmbed(data);
  const result=await discordNotify(data.message,'recruitmentAgenda',{embed});
  if(!result?.ok)return result;
  await query(`INSERT INTO cip_recruitment_weekly_notices(week_key,message_id,sent_by) VALUES($1,$2,$3) ON CONFLICT (week_key) DO UPDATE SET sent_at=NOW(),message_id=EXCLUDED.message_id,sent_by=EXCLUDED.sent_by`,[weekKey,result.messageId||null,options?.userId||null]);
  return {ok:true,week_key:weekKey,messageId:result.messageId||null,forced:force};
}

function scheduleRecruitmentWeeklyNotice(){
  const tz='America/Sao_Paulo';
  const parts=()=>new Intl.DateTimeFormat('en-US',{timeZone:tz,weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(new Date());
  const getNow=()=>{const p=parts(),g=k=>p.find(x=>x.type===k)?.value||'';return {weekday:g('weekday'),hour:Number(g('hour')),minute:Number(g('minute'))};};
  const calc=()=>{
    const now=new Date(),p=getNow(),map={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
    let days=(7-(map[p.weekday]??0))%7;
    if(days===0&&(p.hour>18||(p.hour===18&&p.minute>=0)))days=7;
    const target=new Date(now.getTime()+days*86400000);
    target.setHours(target.getHours()+(18-Number(new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'2-digit',hour12:false}).format(target))));
    target.setMinutes(0,0,0);
    return Math.max(1000,target.getTime()-now.getTime());
  };
  const scheduleNext=()=>{const delay=calc();console.log(`[RECRUTADORES AVISO] Próximo disparo calculado em ${Math.round(delay/60000)} min (18:00 America/Sao_Paulo).`);setTimeout(async()=>{for(let i=0;i<=15;i++){const r=await sendRecruitmentWeeklyNotice();if(r?.ok&&!r?.skipped)break;if(i<15)await waitMs(60000);}scheduleNext();},delay);};
  scheduleNext();
}

// ===== AVISO AUTOMÁTICO DE 3 HORAS — RECRUTAMENTOS =====
// Cada recrutamento confirmado recebe um timer individual para o horário exato
// de 3 horas antes. Isso evita consultas frequentes ao banco e mantém o aviso
// leve para o Render. A tabela de lembretes garante que o envio não seja duplicado.
const recruitmentThreeHourTimers = new Map();

async function buildRecruitmentThreeHourEmbed(row) {
  const dateKey = String(row?.date_key || normalizeDateKey(row?.date) || '').slice(0,10);
  const startTime = String(row?.start_time || '').slice(0,8);
  const endTime = String(row?.end_time || '').slice(0,8);
  const dateTs = discordDateRelative(dateKey, startTime) || formatDateBR(dateKey);
  const timeBR = `${formatTimeBR(startTime)} - ${formatTimeBR(endTime)}`;
  const presencesResult = await query(`SELECT COUNT(*)::int AS count FROM cip_recruitment_presence WHERE recruitment_id=$1 AND present=TRUE`, [Number(row.id)]);
  const presences = Math.max(0, Number(presencesResult.rows[0]?.count) || 0);
  return {
    title: `📢 AVISO DE RECRUTAMENTO`,
    description: `O **Recrutamento Nº ${row.recruitment_number || '—'}** começará em aproximadamente **3 horas**.\n\n📅 **Data:** ${dateTs}\n⏰ **Horário:** ${timeBR}\n📍 **Local:** DP Principal (Palomino)\n📻 **Rádio:** RECPOL`,
    color: 0xF1C40F,
    fields: [
      { name: '👥 PRESENÇAS CONFIRMADAS', value: `**${presences}** participante${presences===1?'':'s'}\n\`${recruitmentPresenceBar(presences)}\``, inline: false },
      { name: '📌 PARTICIPAÇÃO', value: presences ? `🟢 **${presences}** presença${presences===1?'':'s'} registrada${presences===1?'':'s'}.` : '🟡 **Nenhuma presença registrada ainda.**', inline: false },
      { name: '📌 IMPORTANTE', value: 'Confira sua disponibilidade e esteja preparado para o horário do recrutamento.', inline: false }
    ],
    footer: { text: 'CIP • Sistema de Gestão • Aviso automático de recrutamento' },
    timestamp: new Date().toISOString()
  };
}

async function sendRecruitmentThreeHourReminder(recruitmentId) {
  const id = Number(recruitmentId);
  if (!Number.isInteger(id) || id < 1) return { ok:false, skipped:true, reason:'Recrutamento inválido.' };
  const r = await query(`
    SELECT r.*,to_char(r.date,'YYYY-MM-DD') AS date_key,b.status AS booking_status,b.course
    FROM cip_recruitments r
    LEFT JOIN bookings b ON b.id=r.booking_id
    WHERE r.id=$1
  `,[id]);
  if (!r.rowCount) return { ok:false, skipped:true, reason:'Recrutamento não encontrado.' };
  const x = r.rows[0];
  if (String(x.status).toLowerCase() !== 'confirmed' || x.official !== true || !['confirmed','approved'].includes(String(x.booking_status || '').toLowerCase())) {
    return { ok:true, skipped:true, reason:'Recrutamento não está confirmado/oficial.' };
  }
  const already = await query(`SELECT 1 FROM cip_recruitment_reminders WHERE recruitment_id=$1 AND reminder_type='3h' LIMIT 1`,[id]);
  if (already.rowCount) return { ok:true, skipped:true, alreadySent:true };

  const greeting = getSaoPauloGreeting();
  const mention = `<@&${DISCORD_ROLE_RECRUTADORES_ID}>`;
  const embed = await buildRecruitmentThreeHourEmbed(x);
  const result = await discordNotify(`**${greeting} ${mention}!**`,'recruitmentAgenda',{embed});
  if (!result?.ok) {
    console.error(`[RECRUTAMENTO ALERTA 3H] Não enviado | id=${id} nº=${x.recruitment_number||'—'} | ${result?.reason||'erro no Discord'}`);
    return result;
  }
  await query(`INSERT INTO cip_recruitment_reminders(recruitment_id,reminder_type,message_id) VALUES($1,'3h',$2) ON CONFLICT (recruitment_id,reminder_type) DO UPDATE SET message_id=COALESCE(cip_recruitment_reminders.message_id,EXCLUDED.message_id)`,[id,result.messageId||null]);
  console.log(`[RECRUTAMENTO ALERTA 3H] Aviso enviado | id=${id} nº=${x.recruitment_number||'—'} data=${x.date_key} horário=${formatTimeBR(x.start_time)} - ${formatTimeBR(x.end_time)}`);
  return { ok:true, sent:true, recruitment_id:id, messageId:result.messageId||null };
}

async function updateRecruitmentThreeHourDiscordMessage(recruitmentId) {
  const id = Number(recruitmentId);
  if (!Number.isInteger(id) || id < 1) return {ok:false, skipped:true, reason:'Recrutamento inválido.'};
  const token = String(process.env.DISCORD_BOT_TOKEN || '').trim();
  if (!token) return {ok:false, skipped:true, reason:'DISCORD_BOT_TOKEN não configurado.'};
  const r = await query(`SELECT r.*,to_char(r.date,'YYYY-MM-DD') AS date_key,b.status AS booking_status FROM cip_recruitments r LEFT JOIN bookings b ON b.id=r.booking_id WHERE r.id=$1 LIMIT 1`, [id]);
  if (!r.rowCount) return {ok:false, skipped:true, reason:'Recrutamento não encontrado.'};
  const x = r.rows[0];
  const rr = await query(`SELECT message_id FROM cip_recruitment_reminders WHERE recruitment_id=$1 AND reminder_type='3h' LIMIT 1`, [id]);
  let messageId = String(rr.rows[0]?.message_id || '').trim();
  const channelId = discordChannelId('recruitmentAgenda');
  if (!messageId) {
    try {
      const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=100`, {headers:{'Authorization':`Bot ${token}`}});
      if (response.ok) {
        const messages = await response.json();
        const needle = `RECRUTAMENTO Nº ${x.recruitment_number || '—'}`.toUpperCase();
        const found = (Array.isArray(messages) ? messages : []).find(m => Array.isArray(m?.embeds) && m.embeds.some(e => String(e.title || '').toUpperCase() === '📢 AVISO DE RECRUTAMENTO' && String(e.description || '').toUpperCase().includes(needle)));
        messageId = String(found?.id || '').trim();
        if (messageId) await query(`UPDATE cip_recruitment_reminders SET message_id=$1 WHERE recruitment_id=$2 AND reminder_type='3h'`, [messageId,id]);
      }
    } catch(e) { console.warn('Busca do embed 3h legado:', e.message); }
  }
  if (!messageId) return {ok:false, skipped:true, reason:'Aviso 3h ainda não enviado.'};
  const embed = await buildRecruitmentThreeHourEmbed(x);
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {method:'PATCH', headers:{'Authorization':`Bot ${token}`,'Content-Type':'application/json'}, body:JSON.stringify({embeds:[embed]})});
  if (response.ok) return {ok:true,messageId,channelId,presences:embed.fields?.[0]?.value || ''};
  if (response.status === 404) await query(`UPDATE cip_recruitment_reminders SET message_id=NULL WHERE recruitment_id=$1 AND reminder_type='3h'`, [id]);
  return {ok:false,reason:`Não foi possível atualizar o aviso 3h (HTTP ${response.status}).`};
}

function scheduleRecruitmentThreeHourReminder(recruitmentId) {
  const id = Number(recruitmentId);
  if (!Number.isInteger(id) || id < 1) return;
  const existing = recruitmentThreeHourTimers.get(id);
  if (existing) clearTimeout(existing);

  (async()=>{
    try {
      const r = await query(`SELECT id,recruitment_number,date,to_char(date,'YYYY-MM-DD') AS date_key,start_time,end_time,status,official FROM cip_recruitments WHERE id=$1 LIMIT 1`,[id]);
      if (!r.rowCount) return;
      const x = r.rows[0];
      if (String(x.status).toLowerCase() !== 'confirmed' || x.official !== true) return;
      const unix = discordUnixTimestamp(x.date_key || x.date, x.start_time);
      if (!Number.isFinite(unix)) return;
      const targetMs = unix * 1000 - (3 * 60 * 60 * 1000);
      const nowMs = Date.now();
      const delay = targetMs - nowMs;
      // Em caso de reinício do Render até 15 minutos depois do horário previsto,
      // recupera o aviso. Depois disso, não envia um aviso atrasado.
      if (delay < -(15 * 60 * 1000)) return;
      const fireDelay = Math.max(1000, delay);
      const timer = setTimeout(async()=>{
        recruitmentThreeHourTimers.delete(id);
        try { await sendRecruitmentThreeHourReminder(id); }
        catch(e) { console.error(`[RECRUTAMENTO ALERTA 3H] Falha no envio id=${id}:`,e.message); }
      }, fireDelay);
      recruitmentThreeHourTimers.set(id,timer);
      console.log(`[RECRUTAMENTO ALERTA 3H] Agendado | nº=${x.recruitment_number||'—'} para ${x.date_key} ${formatTimeBR(x.start_time)} (em ${Math.max(0,Math.round(fireDelay/60000))} min)`);
    } catch(e) {
      console.error(`[RECRUTAMENTO ALERTA 3H] Falha ao agendar id=${id}:`,e.message);
    }
  })();
}

async function scheduleAllRecruitmentThreeHourReminders() {
  try {
    const r = await query(`SELECT id FROM cip_recruitments WHERE status='confirmed' AND official=TRUE AND (date + start_time) > (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo') ORDER BY date,start_time,id`);
    for (const row of r.rows) scheduleRecruitmentThreeHourReminder(row.id);
  } catch(e) {
    console.error('[RECRUTAMENTO ALERTA 3H] Falha ao carregar agendamentos:',e.message);
  }
}

async function buildRecruitment24HourEmbed(row) {
  const dateKey = String(row?.date_key || normalizeDateKey(row?.date) || '').slice(0,10);
  const startTime = String(row?.start_time || '').slice(0,8);
  const endTime = String(row?.end_time || '').slice(0,8);
  const dateTs = discordDateRelative(dateKey, startTime) || formatDateBR(dateKey);
  const timeBR = `${formatTimeBR(startTime)} - ${formatTimeBR(endTime)}`;
  const presencesResult = await query(
    `SELECT COUNT(*)::int AS count FROM cip_recruitment_presence WHERE recruitment_id=$1 AND present=TRUE`,
    [Number(row.id)]
  );
  const presences = Math.max(0, Number(presencesResult.rows[0]?.count) || 0);

  return {
    title: '📢 AVISO DE RECRUTAMENTO',
    description:
      `Amanhã teremos o **Recrutamento Nº ${row.recruitment_number || '—'}**, das **${timeBR}**, na **DP Principal (Palomino)**.\n\n` +
      `📅 **Data:** ${dateTs}\n` +
      `📻 **Rádio:** RECPOL\n\n` +
      `✅ **Registre sua presença na Agenda caso possa participar.**\n` +
      `A lista de presença será utilizada para definir os escalados do recrutamento.`,
    color: 0xF1C40F,
    fields: [
      {
        name: '👥 PRESENÇAS CONFIRMADAS',
        value: `**${presences}** participante${presences===1?'':'s'}\n\`${recruitmentPresenceBar(presences)}\``,
        inline: false
      },
      {
        name: '📌 PARTICIPAÇÃO',
        value: presences
          ? `🟢 **${presences}** presença${presences===1?'':'s'} registrada${presences===1?'':'s'}.`
          : '🟡 **Nenhuma presença registrada ainda.**',
        inline: false
      },
      {
        name: '📌 IMPORTANTE',
        value: 'Confira sua disponibilidade e esteja preparado para o horário do recrutamento.',
        inline: false
      }
    ],
    footer: { text: 'CIP • Sistema de Gestão • Aviso automático de recrutamento' },
    timestamp: new Date().toISOString()
  };
}

async function updateRecruitment24HourDiscordMessage(recruitmentId) {
  const id = Number(recruitmentId);
  if (!Number.isInteger(id) || id < 1) return {ok:false, skipped:true, reason:'Recrutamento inválido.'};

  const token = String(process.env.DISCORD_BOT_TOKEN || '').trim();
  if (!token) return {ok:false, skipped:true, reason:'DISCORD_BOT_TOKEN não configurado.'};

  const r = await query(`
    SELECT r.id,r.recruitment_number,r.date,to_char(r.date,'YYYY-MM-DD') AS date_key,
           r.start_time,r.end_time,r.status,r.official
    FROM cip_recruitments r
    WHERE r.id=$1
    LIMIT 1
  `,[id]);
  if (!r.rowCount) return {ok:false, skipped:true, reason:'Recrutamento não encontrado.'};

  const x = r.rows[0];
  const messageResult = await query(
    `SELECT message_id FROM cip_recruitment_reminders
     WHERE recruitment_id=$1 AND reminder_type='24h'
     LIMIT 1`,
    [id]
  );
  let messageId = String(messageResult.rows[0]?.message_id || '').trim();
  if (!messageId) return {ok:false, skipped:true, reason:'Aviso 24h ainda não enviado.'};

  const channelId = discordChannelId('recruitmentAgenda');
  const embed = await buildRecruitment24HourEmbed(x);

  const response = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    {
      method:'PATCH',
      headers:{
        'Authorization':`Bot ${token}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({embeds:[embed]})
    }
  );

  if (response.ok) {
    return {ok:true,messageId,channelId,presences:embed.fields?.[0]?.value || ''};
  }

  if (response.status===404) {
    await query(
      `UPDATE cip_recruitment_reminders
       SET message_id=NULL
       WHERE recruitment_id=$1 AND reminder_type='24h'`,
      [id]
    );
  }

  const body = await response.text().catch(()=> '');
  return {
    ok:false,
    reason:`Não foi possível atualizar o aviso 24h (HTTP ${response.status}).`,
    detail:body.slice(0,300)
  };
}

async function sendRecruitmentReminders(){
  try{
    // Regra oficial: avisar UMA VEZ POR DIA, às 15:00 (America/Sao_Paulo),
    // sobre todos os recrutamentos oficiais aprovados que acontecerão AMANHÃ.
    // Não usamos uma janela móvel de 24h: o objetivo é "um dia antes".
    const tz='America/Sao_Paulo';
    const now=new Date();
    const tomorrowParts=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now.getTime()+24*60*60*1000));
    const tomorrowKey=`${tomorrowParts.find(p=>p.type==='year')?.value}-${tomorrowParts.find(p=>p.type==='month')?.value}-${tomorrowParts.find(p=>p.type==='day')?.value}`;

    const r=await query(`SELECT r.*,to_char(r.date,'YYYY-MM-DD') AS date_key,b.status AS booking_status,b.course
      FROM cip_recruitments r
      JOIN bookings b ON b.id=r.booking_id
      WHERE r.status='confirmed' AND r.official=TRUE
        AND REGEXP_REPLACE(LOWER(TRIM(COALESCE(b.course,''))), '[^a-z0-9]+', '', 'g') LIKE 'recrutamento%'
        AND LOWER(COALESCE(b.status,'')) IN ('confirmed','approved')
        AND r.date::date = $1::date
      ORDER BY r.date,r.start_time,r.id`,[tomorrowKey]);

    if(!r.rowCount){ console.log(`[RECRUTAMENTO ALERTA] Nenhum recrutamento oficial para amanhã | data=${tomorrowKey}`); return {ok:true,skipped:true,reason:'nenhum_recrutamento_amanha',date:tomorrowKey}; }
    console.log(`[RECRUTAMENTO ALERTA] Encontrados ${r.rowCount} recrutamento(s) oficial(is) para amanhã | data=${tomorrowKey}`);

    for(const x of r.rows){
      const greeting=getSaoPauloGreeting();
      const embed=await buildRecruitment24HourEmbed(x);
      const discordResult=await discordNotify(`**${greeting} <@&1534527435347853325>!**`,'recruitmentAgenda',{embed});
      if(!discordResult?.ok){
        console.error(`[RECRUTAMENTO ALERTA] Aviso do dia anterior NÃO enviado | id=${x.id} nº=${x.recruitment_number} | ${discordResult?.reason||'erro no Discord'}`);
        continue;
      }

      await query(`INSERT INTO cip_recruitment_reminders(recruitment_id,reminder_type) VALUES($1,'24h') ON CONFLICT (recruitment_id,reminder_type) DO NOTHING`,[x.id]);
      console.log(`[RECRUTAMENTO ALERTA] Aviso do dia anterior enviado | id=${x.id} nº=${x.recruitment_number} data=${dateBR} horário=${timeBR}`);
    }
    return {ok:true,sent:true,date:tomorrowKey,count:r.rowCount};
  }catch(e){
    console.error('Lembrete recrutamento:',e.message);
    return {ok:false,reason:e.message};
  }
}
function scheduleRecruitmentDailyReminder(){
  // Mesmo padrão do aviso de 3h: agenda um timer individual para cada
  // recrutamento confirmado/oficial e recupera após reinício do Render.
  const scheduleOne=async(recruitmentId)=>{
    const id=Number(recruitmentId);
    if(!Number.isInteger(id)||id<1)return;
    try{
      const r=await query(`SELECT id,recruitment_number,date,to_char(date,'YYYY-MM-DD') AS date_key,start_time,end_time,status,official FROM cip_recruitments WHERE id=$1 LIMIT 1`,[id]);
      if(!r.rowCount)return;
      const x=r.rows[0];
      if(String(x.status).toLowerCase()!=='confirmed'||x.official!==true)return;
      const unix=discordUnixTimestamp(x.date_key||x.date,x.start_time);
      if(!Number.isFinite(unix))return;
      // Aviso de 1 dia antes: exatamente 24 horas antes do início.
      const targetMs=unix*1000-(24*60*60*1000);
      const nowMs=Date.now();
      const delay=targetMs-nowMs;
      // Se o Render voltar até 15 minutos após o horário previsto, recupera o aviso.
      if(delay<-(15*60*1000))return;
      const fireDelay=Math.max(1000,delay);
      const timer=setTimeout(async()=>{
        try{
          const result=await sendRecruitmentReminders();
          if(result?.sent) console.log(`[RECRUTAMENTO ALERTA 24H] Aviso enviado | id=${id} nº=${x.recruitment_number||'—'}`);
        }catch(e){
          console.error(`[RECRUTAMENTO ALERTA 24H] Falha no envio id=${id}:`,e.message);
        }
      },fireDelay);
      console.log(`[RECRUTAMENTO ALERTA 24H] Agendado | nº=${x.recruitment_number||'—'} para ${x.date_key} ${formatTimeBR(x.start_time)} (em ${Math.max(0,Math.round(fireDelay/60000))} min)`);
    }catch(e){
      console.error(`[RECRUTAMENTO ALERTA 24H] Falha ao agendar id=${id}:`,e.message);
    }
  };

  const scheduleAll=async()=>{
    try{
      const r=await query(`SELECT id FROM cip_recruitments WHERE status='confirmed' AND official=TRUE AND (date + start_time) > (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo') ORDER BY date,start_time,id`);
      for(const row of r.rows) await scheduleOne(row.id);
    }catch(e){
      console.error('[RECRUTAMENTO ALERTA 24H] Falha ao carregar agendamentos:',e.message);
    }
  };

  scheduleAll().catch(e=>console.error('[RECRUTAMENTO ALERTA 24H] Inicialização:',e.message));
}
app.get('/api/recruitments/number-diagnostic', auth, recruitmentGuard, managerAuth, async(req,res)=>{
  try {
    const rows=await diagnosticRecruitmentNumbers();
    res.json({ok:true,read_only:true,rows});
  } catch(e) {
    console.error('[RECRUTAMENTO DIAGNÓSTICO API] Falha:',e.message);
    res.status(500).json({error:'Não foi possível gerar o diagnóstico.'});
  }
});

app.get("/api/version", (req,res) => {
  res.json({
    version: "3.5.0",
    passwordRecovery: true,
    forcedPasswordChange: true
  });
});


async function start() {
  try {
    await initDb();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Instrutores rodando na porta ${PORT}`);
      // Diagnóstico inicial somente leitura para recuperar o histórico com segurança.
      printRecruitmentNumberDiagnostic().catch(e => console.error('[RECRUTAMENTO DIAGNÓSTICO] Inicial:', e.message));
      // O aviso de recrutamento é diário: às 15:00, procura recrutamentos de amanhã.
      scheduleRecruitmentDailyReminder();
      scheduleAllRecruitmentThreeHourReminders();
      sendInstructionWeeklyNoticeAutomatic().catch(e => console.error('Aviso semanal inicial:', e.message));
      sendPendingRecruitmentResultNotifications().catch(e => console.error('Resultados recrutamento iniciais:', e.message));
      // Atualiza embeds antigos da Agenda para o padrão de timestamp data + hora + relativo.
      syncRecruitmentAgendaDiscordMessages().catch(e => console.error('Sincronização dos embeds da Agenda:', e.message));
      processDiscordResultOutbox().catch(e => console.error('Fila Discord inicial:', e.message));
      // Aviso semanal dos instrutores: agendador dedicado em America/Sao_Paulo.
      // O próprio agendador faz até 16 tentativas (18:00–18:15) e encerra
      // a rotina quando o aviso é enviado. Em caso de reinício do serviço,
      // a verificação inicial recupera a semana pendente sem manter um
      // setInterval permanente consultando o banco depois do envio.
      scheduleInstructionWeeklyNotice();
      // Aviso semanal dos recrutadores: domingo às 18:00, America/Sao_Paulo.
      scheduleRecruitmentWeeklyNotice();
      // Avisos automáticos dos Eventos Agendados do Discord: todos os dias às 15:00.
      scheduleDiscordCourseAnnouncements();

      // Resultados pendentes continuam sendo verificados separadamente, sem acordar
      // a rotina de avisos de recrutamento a cada poucos minutos.
      setInterval(() => {
        sendPendingRecruitmentResultNotifications().catch(e => console.error('Resultados recrutamento periódicos:', e.message));
      }, 60 * 60 * 1000);
      // Reprocessa resultados pendentes a cada minuto, sempre respeitando Retry-After.
      setInterval(() => {
        processDiscordResultOutbox().catch(e => console.error('Fila Discord periódica:', e.message));
      }, 60 * 1000);
    });
  } catch (e) {
    console.error("Falha ao iniciar:", e);
    process.exit(1);
  }
}

start();
