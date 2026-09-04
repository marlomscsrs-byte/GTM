async function checkInitialSetup() {
  try {
    const r = await fetch('/api/setup/status');
    const data = await r.json();
    if (data.needsSetup) {
      const modal = document.getElementById('setup-modal');
      if (modal) modal.classList.remove('hidden');
    }
  } catch (e) {
    console.error('Falha ao verificar configuração inicial', e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  checkInitialSetup();
  const form = document.getElementById('setup-form');
  if (!form) return;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const error = document.getElementById('setup-error');
    error.textContent = '';
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      const r = await fetch('/api/setup/admin', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Erro ao criar administrador');
      alert('Administrador criado com sucesso. Agora faça login.');
      document.getElementById('setup-modal').classList.add('hidden');
      form.reset();
    } catch (e) {
      error.textContent = e.message;
    }
  });
});

const login = document.getElementById("login");
const app = document.getElementById("app");
const page = document.getElementById("page");
let token = localStorage.getItem("gtm_token");
let currentUser = JSON.parse(localStorage.getItem("gtm_user") || "null");

async function api(url, options={}) {
  options.headers = {...options.headers, Authorization: `Bearer ${token}`};
  const r = await fetch(url, options);
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error || "Erro");
  return data;
}

document.getElementById("form").onsubmit = async e => {
  e.preventDefault();
  const error = document.getElementById("error");
  error.textContent = "";
  try {
    const data = await fetch("/api/auth/login", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({username:username.value,password:password.value})
    }).then(async r => {
      const d=await r.json(); if(!r.ok) throw new Error(d.error); return d;
    });
    token=data.token; currentUser=data.user;
    localStorage.setItem("gtm_token",token);
    localStorage.setItem("gtm_user",JSON.stringify(currentUser));
    openApp();
  } catch(err) { error.textContent=err.message; }
};

const registerModal = document.getElementById("register-modal");
const registerForm = document.getElementById("register-form");
document.getElementById("open-register")?.addEventListener("click",()=>{
  registerModal?.classList.remove("hidden");
  document.getElementById("register-error").textContent="";
});
document.getElementById("close-register")?.addEventListener("click",()=>registerModal?.classList.add("hidden"));
registerModal?.addEventListener("click",e=>{ if(e.target===registerModal) registerModal.classList.add("hidden"); });
registerForm?.addEventListener("submit", async e=>{
  e.preventDefault();
  const error=document.getElementById("register-error"); error.textContent="";
  const body=Object.fromEntries(new FormData(registerForm).entries());
  try{
    const r=await fetch("/api/auth/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const data=await r.json();
    if(!r.ok) throw new Error(data.error||"Não foi possível enviar o cadastro.");
    registerModal.classList.add("hidden"); registerForm.reset();
    alert("Cadastro enviado com sucesso! Aguarde a aprovação do Comando para receber acesso ao Portal GTM.");
  }catch(err){ error.textContent=err.message; }
});

document.getElementById("logout").onclick=()=>{
  localStorage.removeItem("gtm_token"); localStorage.removeItem("gtm_user");
  location.reload();
};

document.querySelectorAll("#nav button").forEach(b=>b.onclick=()=>loadPage(b.dataset.page));

async function openApp(){
  login.classList.add("hidden"); app.classList.remove("hidden");
  document.getElementById("name").textContent=currentUser?.nome||"Operador";
  document.getElementById("rank").textContent=currentUser?.patente||"Piloto";
  loadPage("dashboard");
}

async function loadPage(name){
  document.querySelectorAll("#nav button").forEach(b=>b.classList.toggle("active",b.dataset.page===name));
  const titles={
    dashboard:["Painel operacional","Visão geral do GTM"],
    ocorrencias:["Ocorrências","Registro e histórico operacional"],
    efetivo:["Efetivo","Quadro oficial de integrantes da unidade"],
    escala:["Escala","Serviços e plantões"],
    cursos:["Cursos","Treinamentos e certificações"],
    frota:["Frota","Motocicletas e manutenção"],
    manual:["Manual","Procedimentos operacionais"],
    relatorios:["Relatórios","Estatísticas e indicadores"],
    admin:["Administração","Usuários, contas e configurações"]
  };
  const [title,sub]=titles[name]||titles.dashboard;
  if(name==="dashboard") return dashboard();
  if(name==="escala") return servicePage();
  if(name==="efetivo") return efetivoPage();
  if(name==="ocorrencias") return qruPage();
  if(name==="admin") return adminPage();
  if(name==="manual") return manualPage();
  page.innerHTML=`<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div></div>
  <div class="section"><h3>EM CONSTRUÇÃO</h3><p style="color:#6d7e90;font-size:11px">Este módulo já está previsto na arquitetura do banco PostgreSQL. A próxima etapa adicionará os formulários e operações CRUD.</p></div>`;
}

async function dashboard(){
  try{
    const [d,p,statusRanking,recentEvents,recentRecords]=await Promise.all([
      api("/api/dashboard"),
      api("/api/ponto/status"),
      api("/api/ranking?period=week"),
      api("/api/dashboard/eventos"),
      api("/api/ocorrencias")
    ]);
    const s=d.stats||{};
    const nome=escapeHtml(currentUser?.nome||"Operador");
    const patente=escapeHtml(currentUser?.patente||"Integrante GTM");
    const active=!!p.current;
    const weekHours=Number(p.week?.hours||0);
    const totalHours=Number(p.total?.hours||0);
    const team=p.team||[];
    const ranking=Array.isArray(statusRanking)?statusRanking:[];
    page.innerHTML=`
      <div class="dashboard-hero ${active?'on-duty':''}">
        <div class="hero-copy">
          <span class="over">CENTRAL OPERACIONAL</span>
          <h1>Bom dia, ${nome}!</h1>
          <p>“Toda missão bem executada começa com uma boa preparação.”</p>
          <small>${patente} • painel pessoal</small>
        </div>
        <div class="hero-metrics">
          ${heroMetric(p.week?.points?.toFixed?.(1)||'0.0','PONTOS DA SEMANA','1 ponto / hora')}
          ${heroMetric(formatHours(weekHours),'HORAS DA SEMANA','serviço registrado')}
          ${heroMetric(p.total?.points?.toFixed?.(1)||'0.0','PONTOS TOTAIS','1 ponto / hora')}
          ${heroMetric(formatHours(totalHours),'HORAS TOTAIS','histórico')}
        </div>
        <button class="service-button ${active?'service-stop':''}" onclick="toggleService()">↪ ${active?'Encerrar serviço':'Iniciar serviço'}</button>
      </div>

      <div class="dashboard-grid">
        <section class="quick-panel">
          <div class="panel-heading"><div><span class="eyebrow">ATALHOS</span><h2>Ações principais</h2></div></div>
          <div class="quick-grid">
            ${dashboardAction('▤','Nova QRU','Registrar ocorrência','ocorrencias')}
            ${dashboardAction('◇','Nova ação','Adicionar atividade','acoes')}
            ${dashboardAction('♟','Ranking','Ver classificação','relatorios')}
            ${dashboardAction('▥','Setor pessoal','Solicitações','pessoal')}
            ${dashboardAction('⚑','Avisos','Comunicados','comunicados')}
            ${dashboardAction('♙','Hierarquia','Estrutura da unidade','efetivo')}
          </div>
        </section>

        <aside class="side-panel">
          <div class="panel-heading"><div><span class="eyebrow">DESTAQUE</span><h2>Top semanal</h2></div></div>
          ${ranking.length ? ranking.slice(0,5).map((m,i)=>rankRow(String(i+1).padStart(2,'0'),m.nome||'Integrante',Number(m.pontos||0).toFixed(1),m.patente||'Integrante')).join('') : '<div class="dashboard-empty-rank">Ainda não há pontuação registrada nesta semana.</div>'}
        </aside>

        <section class="status-panel">
          <div class="panel-heading"><div><span class="eyebrow">STATUS OPERACIONAL</span><h2>Equipe em serviço</h2></div><span class="live-dot">● ${team.length?'ATIVA':'AGUARDANDO'}</span></div>
          ${team.length?team.slice(0,6).map(m=>`<div class="team-service-row"><div class="team-avatar">${escapeHtml((m.nome||'?').charAt(0).toUpperCase())}</div><div><b>${escapeHtml(m.nome)}</b><small>${escapeHtml(m.patente||'Integrante')}</small></div><span><i></i> Em serviço<br><small>${formatTime(m.entrada)}</small></span></div>`).join(''):`<div class="service-empty"><div class="service-icon">◉</div><div><b>Nenhum integrante em serviço</b><small>Inicie seu serviço pelo botão acima quando estiver de plantão.</small></div><button class="outline-btn" onclick="toggleService()">${active?'Encerrar':'Iniciar serviço'}</button></div>`}
        </section>
      </div>

      <section class="dashboard-events-panel">
        <div class="dashboard-section-heading"><div><h2>◷ Próximos eventos</h2><p>Confirme sua participação nos eventos da corporação</p></div></div>
        ${Array.isArray(recentEvents) && recentEvents.length ? recentEvents.map(ev=>eventRow(ev)).join('') : '<div class="dashboard-empty-events">Nenhum evento próximo.</div>'}
      </section>

      <section class="dashboard-records-panel">
        <div class="dashboard-section-heading"><div><h2>▤ Registros Recentes</h2></div></div>
        <div class="records-table">
          <div class="records-head"><span>CÓDIGO</span><span>TÍTULO</span><span>TIPO</span><span>DETALHES</span><span>PTS</span></div>
          ${Array.isArray(recentRecords) && recentRecords.length ? recentRecords.slice(0,6).map(r=>recordRow(r)).join('') : '<div class="dashboard-empty-records">Nenhum registro recente.</div>'}
        </div>
      </section>`;
  }catch(e){ page.innerHTML=`<div class="section"><h3>Banco de dados indisponível</h3><p style="color:#718395;font-size:11px">${escapeHtml(e.message)}</p></div>`}
}

async function toggleService(){
  try{
    const status=await api('/api/ponto/status');
    const endpoint=status.current?'/api/ponto/encerrar':'/api/ponto/iniciar';
    const data=await api(endpoint,{method:'POST',headers:{'Content-Type':'application/json'}});
    alert(data.message||'Operação concluída.');
    await dashboard();
  }catch(e){ alert(e.message); }
}

async function servicePage(){
  try{
    const [p,h]=await Promise.all([
      api('/api/ponto/status'),
      api('/api/ponto/historico')
    ]);
    const active=!!p.current;
    const weekHours=Number(p.week?.hours||0);
    const totalHours=Number(p.total?.hours||0);
    const weekTurns=Number(p.week?.turns||0);
    const totalTurns=Number(p.total?.turns||h.length||0);
    const displayTeam=Array.isArray(p.team)?p.team:[];
    page.innerHTML=`
      <div class="service-page">
        <section class="service-hero ${active?'service-hero-active':''}">
          <div class="service-hero-copy">
            <span class="eyebrow">CONTROLE DE TURNO</span>
            <h1>${active?'Serviço em andamento':'Pronto para iniciar?'}</h1>
            <p>${active?`Ponto iniciado às ${formatTime(p.current.entrada)} • ${formatDurationFrom(p.current.entrada)} em serviço.`:'Inicie o ponto para registrar oficialmente seu período de serviço.'}</p>
          </div>
          <button class="service-main-button ${active?'service-stop':''}" onclick="toggleService()">${active?'■ Encerrar serviço':'↪ Iniciar serviço'}</button>
        </section>

        <section class="service-kpis">
          <div class="service-kpi"><div class="kpi-icon">●</div><div><small>Em serviço agora</small><b>${displayTeam.length || (active?1:0)}</b></div></div>
          <div class="service-kpi"><div class="kpi-icon">◷</div><div><small>Minha semana</small><b>${formatHours(weekHours)}</b></div></div>
          <div class="service-kpi"><div class="kpi-icon">↪</div><div><small>Turnos na semana</small><b>${weekTurns}</b></div></div>
          <div class="service-kpi"><div class="kpi-icon">▦</div><div><small>Histórico total</small><b>${totalTurns}</b></div></div>
        </section>

        <section class="service-columns">
          <div class="service-live-panel">
            <div class="service-panel-head"><div><span class="eyebrow">AO VIVO</span><h2>Oficiais em serviço</h2></div><span class="service-count">${displayTeam.length || (active?1:0)}</span></div>
            <div class="service-live-list">
              ${displayTeam.length ? displayTeam.map(r=>`
                <div class="service-person">
                  <div class="service-person-avatar">${escapeHtml((r.nome||'?').charAt(0).toUpperCase())}</div>
                  <div class="service-person-info"><b>${escapeHtml(r.nome||'Integrante')}</b><small>${escapeHtml(r.patente||'GTM')} • ID ${escapeHtml(r.matricula||'—')}</small></div>
                  <div class="service-person-status"><span>● Em serviço</span><small>${formatTime(r.entrada)}</small></div>
                </div>`).join('') : `<div class="service-empty-large"><div class="service-empty-icon">◷</div><div><b>Nenhum oficial em serviço</b><small>Quando um integrante iniciar o ponto, ele aparecerá aqui.</small></div></div>`}
            </div>
          </div>

          <div class="service-history-panel">
            <div class="service-panel-head"><div><span class="eyebrow">HISTÓRICO</span><h2>Meus turnos</h2></div><span class="service-count">${totalTurns}</span></div>
            <div class="service-history-list">
              ${h.slice(0,12).map(r=>`<div class="service-history-item">
                <span class="history-dot"></span>
                <div class="history-main"><b>${formatLongDate(r.entrada)}</b><small>${formatTime(r.entrada)} → ${r.saida?formatTime(r.saida):'em andamento'}</small></div>
                <strong>${formatHours(Number(r.horas||0))}</strong>
                <span class="history-status ${r.status==='em_servico'?'history-live':'history-done'}">${r.status==='em_servico'?'Em serviço':'Concluído'}</span>
              </div>`).join('') || `<div class="service-empty-large"><div class="service-empty-icon">▦</div><div><b>Nenhum turno registrado</b><small>Seu histórico aparecerá aqui após o primeiro ponto.</small></div></div>`}
            </div>
          </div>
        </section>

        <section class="service-total-bar">
          <div><span class="eyebrow">MEU DESEMPENHO</span><b>${formatHours(totalHours)}</b><small>horas registradas no histórico</small></div>
          <div><b>${Number(p.total?.points||0).toFixed(1)}</b><small>pontos acumulados</small></div>
          <div><b>${Number(p.week?.points||0).toFixed(1)}</b><small>pontos nesta semana</small></div>
        </section>
      </div>`;
  }catch(e){ page.innerHTML=`<div class="section"><h3>Não foi possível carregar o serviço</h3><p style="color:#718395;font-size:11px">${escapeHtml(e.message)}</p></div>`; }
}

function formatLongDate(value){
  if(!value) return '—';
  return new Date(value).toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric'}).replace('.',' de');
}

function formatHours(hours){
  const h=Math.max(0,Number(hours)||0);
  const whole=Math.floor(h), mins=Math.round((h-whole)*60);
  if(mins===60) return `${whole+1}h 00m`;
  return `${whole}h ${String(mins).padStart(2,'0')}m`;
}
function formatTime(value){return value?new Date(value).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}):'—';}
function formatDateTime(value){return value?new Date(value).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'—';}
function formatDurationFrom(value){
  const ms=Math.max(0,Date.now()-new Date(value).getTime());
  return formatHours(ms/3600000);
}

function heroMetric(n,label,sub){return `<div class="hero-metric"><label>${label}</label><b>${n}</b><small>${sub}</small></div>`}
function dashboardAction(icon,title,sub,target){return `<button class="dashboard-action" onclick="loadPage('${target}')"><div class="dash-icon">${icon}</div><strong>${title}</strong><small>${sub}</small></button>`}
function eventRow(ev){
  const date=new Date(ev.data_evento);
  const when=date.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})+' • '+date.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const confirmed=ev.minha_participacao==='confirmado';
  return `<div class="dashboard-event-row"><div class="event-date"><b>${escapeHtml(when)}</b><small>${escapeHtml(ev.local||'Local não informado')}</small></div><div class="event-main"><b>${escapeHtml(ev.titulo)}</b><small>${escapeHtml(ev.descricao||'Evento da corporação')}</small></div><button class="event-confirm ${confirmed?'confirmed':''}" ${confirmed?'disabled':''} onclick="confirmEvent('${escapeHtml(ev.id)}',this)">${confirmed?'✓ Participação confirmada':'Confirmar participação'}</button></div>`;
}

async function confirmEvent(id,button){
  try{ const data=await api('/api/dashboard/eventos/'+id+'/participar',{method:'POST'}); button.classList.add('confirmed'); button.disabled=true; button.textContent='✓ Participação confirmada'; }
  catch(e){ alert(e.message); }
}

function recordRow(r){
  return `<div class="record-row"><span class="record-code">${escapeHtml(r.protocolo||'—')}</span><strong>${escapeHtml(r.titulo||'R.O')}</strong><span><em>QRU</em></span><span class="record-detail">R.O</span><strong class="record-points">3</strong></div>`;
}

function rankRow(pos,title,value,sub){return `<div class="rank-row"><span class="rank-pos">${pos}</span><div><b>${title}</b><small>${sub}</small></div><strong>${value}</strong></div>`}

function stat(n,label,sub){return `<div class="stat"><label>${label}</label><b>${n}</b><small>● ${sub}</small></div>`}
function action(icon,title,sub,target){return `<button class="action" onclick="loadPage('${target}')"><div class="ico">${icon}</div><strong>${title}</strong><small>${sub}</small></button>`}

async function efetivoPage(){
  try{
    const rows=await api("/api/efetivo");
    const grupos=["Comando","Sub-Comando","Supervisor","Piloto Oficial","Probatório"];
    const total=rows.length;
    const ativos=rows.filter(r=>r.ativo).length;
    const contas=rows.filter(r=>r.usuario_id).length;
    const agrupados={};
    grupos.forEach(g=>agrupados[g]=[]);
    rows.forEach(r=>(agrupados[r.unidade] ||= []).push(r));

    page.innerHTML=`<div class="page-head"><div><h1>Efetivo</h1><p>Quadro oficial da G.T.M. • ${total} integrante(s) aprovados</p></div>
      <div class="efetivo-kpis"><span>${ativos} ativos</span><span>${total-ativos} inativos</span><span>${contas}/${total} contas vinculadas</span></div></div>
      <div class="section"><div class="efetivo-note"><b>Cadastro automático</b><span>O Efetivo começa vazio. Cada membro solicita sua conta informando ID, patente e telefone da cidade; após a aprovação do Comando, o sistema cria e vincula o registro automaticamente.</span></div></div>
      ${grupos.filter(g=>agrupados[g]?.length).map(g=>efetivoGrupo(g,agrupados[g])).join("")}`;
  }catch(e){
    page.innerHTML=`<div class="section"><h3>Não foi possível carregar o efetivo</h3><p style="color:#718395;font-size:11px">${escapeHtml(e.message)}</p></div>`;
  }
}

function efetivoGrupo(grupo, rows){
  return `<div class="section efetivo-section"><div class="group-title"><h3>${escapeHtml(grupo)}</h3><span>${rows.length} integrante(s)</span></div>
    <div class="table-wrap"><table class="table efetivo-table"><thead><tr><th>ID</th><th>NOME</th><th>PATENTE</th><th>TELEFONE</th><th>STATUS</th><th>CONTA</th></tr></thead><tbody>
    ${rows.map(r=>`<tr>
      <td><b>${escapeHtml(r.matricula || '—')}</b></td>
      <td><strong>${escapeHtml(r.nome)}</strong></td>
      <td>${escapeHtml(r.patente || '—')}</td>
      <td>${escapeHtml(r.telefone_cidade || '—')}</td>
      <td><span class="status ${r.ativo?'status-active':'status-inactive'}">${escapeHtml(r.status || (r.ativo?'Ativo':'Inativo'))}</span></td>
      <td><span class="account-linked">● ${escapeHtml(r.username || '—')}</span></td>
    </tr>`).join("")}
    </tbody></table></div></div>`;
}

async function adminPage(){
  if(currentUser?.role !== 'admin'){
    page.innerHTML=`<div class="section"><h3>ACESSO RESTRITO</h3><p style="color:#718395;font-size:11px">Somente o comando pode administrar contas e usuários.</p></div>`;
    return;
  }
  try{
    const [pending, rows]=await Promise.all([
      api('/api/admin/cadastros-pendentes'),
      api('/api/admin/usuarios')
    ]);
    page.innerHTML=`<div class="page-head"><div><h1>Administração</h1><p>Aprovação de novos cadastros, contas de acesso e vínculo com o efetivo.</p></div>
      ${pending.length?`<span class="pending-badge">${pending.length} aguardando aprovação</span>`:''}</div>
    <div class="section approval-section"><div class="section-title-row"><div><h3>SOLICITAÇÕES DE CADASTRO</h3><p class="section-sub">O integrante só entra no Efetivo depois que o Comando aprovar.</p></div><span class="pill">COMANDO</span></div>
      ${pending.length ? `<div class="approval-list">${pending.map(r=>`<div class="approval-card" id="pending-${escapeAttr(r.id)}">
        <div class="approval-main"><div class="approval-avatar">${escapeHtml((r.nome||'?').charAt(0).toUpperCase())}</div><div><b>${escapeHtml(r.nome)}</b><small>ID ${escapeHtml(r.matricula||'—')} • ${escapeHtml(r.patente||'—')}</small><small>Telefone: ${escapeHtml(r.telefone_cidade||'—')} • Usuário: ${escapeHtml(r.username)}</small></div></div>
        <div class="approval-actions"><button class="btn approve" onclick="processCadastro('${escapeAttr(r.id)}','aprovar')">✓ Aprovar</button><button class="btn reject" onclick="processCadastro('${escapeAttr(r.id)}','recusar')">✕ Recusar</button></div>
      </div>`).join('')}</div>` : `<div class="empty-state"><b>Nenhuma solicitação pendente</b><span>Quando um integrante criar uma conta, o pedido aparecerá aqui.</span></div>`}
    </div>
    <div class="section"><div class="section-title-row"><div><h3>CONTAS DO SISTEMA</h3><p class="section-sub">Somente cadastros aprovados aparecem vinculados ao efetivo.</p></div></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>USUÁRIO</th><th>NOME</th><th>ID</th><th>PATENTE</th><th>TELEFONE</th><th>PERFIL</th><th>STATUS</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td><b>${escapeHtml(r.username)}</b></td><td>${escapeHtml(r.nome)}</td><td>${escapeHtml(r.matricula||'—')}</td><td>${escapeHtml(r.patente||'—')}</td><td>${escapeHtml(r.telefone_cidade||'—')}</td><td>${r.role==='admin'?'Comando':'Operador'}</td><td><span class="status ${r.status_cadastro==='aprovado'&&r.ativo?'status-active':r.status_cadastro==='pendente'?'status-pending':'status-inactive'}">${r.status_cadastro==='aprovado'&&r.ativo?'Aprovado':r.status_cadastro==='pendente'?'Pendente':'Recusado'}</span></td></tr>`).join('')}
    </tbody></table></div></div>`;
  }catch(e){ page.innerHTML=`<div class="section"><h3>Não foi possível carregar a administração</h3><p style="color:#718395;font-size:11px">${escapeHtml(e.message)}</p></div>`; }
}

async function processCadastro(id, action){
  try{
    const data=await api(`/api/admin/cadastros/${encodeURIComponent(id)}/${action}`,{method:'POST'});
    alert(data.message || 'Operação concluída.');
    await adminPage();
  }catch(e){ alert(e.message); }
}

function manualPage(){
  page.innerHTML=`
  <div class="manual-portal">
    <div class="page-head manual-head">
      <div><span class="eyebrow">DOCUMENTO OFICIAL • G.T.M.</span><h1>Manual de Conduta</h1><p>Procedimentos, regras, funções e padrões operacionais do Grupamento Tático de Motocicletas.</p></div>
      <div class="manual-badge"><img src="assets/GTM.png" alt="G.T.M."><span>G.T.M.<small>Manual oficial</small></span></div>
    </div>
    <div class="manual-layout">
      <aside class="manual-index">
        <div class="manual-index-title">ÍNDICE</div>
        <a href="#manual-introducao">01 · Introdução</a>
        <a href="#manual-regras">02 · Regras</a>
        <a href="#manual-funcoes">03 · Funções</a>
        <a href="#manual-modulacao">04 · Modulação</a>
        <a href="#manual-posicionamento">05 · Posicionamento</a>
        <a href="#manual-encerramento">Encerramento</a>
      </aside>
      <article class="manual-document">
        <div class="manual-cover">
          <img src="assets/GTM.png" alt="Logo G.T.M.">
          <div><span>GRUPAMENTO TÁTICO DE MOTOCICLETAS</span><h2>Manual de Conduta — G.T.M.</h2><p>Documento integrado ao Portal Operacional</p></div>
        </div>
        <article class="content-shell portal-view" data-view-panel="manual" id="manualContent">
<section class="manual-section" data-title="1. Introdução" id="introducao">
<div class="section-heading">
<span class="section-number">01</span>
<div><p>APRESENTAÇÃO</p><h2>1. Introdução</h2></div>
</div>
<p>O manual de conduta do 2ºESQ/GTM tem como objetivo centralizar toda informação necessária para conscritos, estagiários e pilotos oficiais da G.T.M., para a melhor absorção de conhecimento dos procedimentos e regras do grupamento.</p>
<p>O 2ºESQ/GTM tem prioridade em acompanhamentos à motocicletas. Caso o acompanhamento seja contra um veículo quatro rodas a prioridade é da G.R.R., salvo exceções de veículos de pequeno porte, ou caso a primária peça para a unidade G.T.M. manter a primária do acompanhamento;</p>
</section>
<section class="manual-section" data-title="2. Regras" id="regras">
<div class="section-heading">
<span class="section-number">02</span>
<div><p>NORMAS DA UNIDADE</p><h2>2.Regras</h2></div>
</div>
<ol class="rules-list">
<li>Toda e qualquer queda, o oficial do grupamento deverá dar QTA, caso volte a QRU poderá ser retirado de suas funções como oficial da G.T.M.;</li>
<li>A utilização das motos Africa Twin e MT-07 é exclusivamente proibida para as demais unidades e membros não pertencentes à unidade G.T.M.;</li>
<li>É totalmente proibido a utilização da manobra Roadblock(utilização da moto como barreira para dificultar a passagem);</li>
<li>É proibido empinar a motocicleta;</li>
<li>Fica proibido o patrulhamento diário com garupa, cada membro da unidade deve utilizar a sua motocicleta. Salvo em algumas situações(Ex.: Cidade em Cód. Vermelho) e com autorização prévia do COMANDO da unidade;</li>
<li>Estagiários somente poderão patrulhar na presença de algum Piloto Oficial. Sendo assim, fica estritamente proibida a patrulha de 2 estagiários;</li>
<li>Em acompanhamento a veículo quatro rodas, a unidade G.T.M. deve se manter na função de unidade secundária da QRU;</li>
<li>Caso vá prestar concurso/formulário de outro Grupamento operacional, como COE, GRR ou GRA, deverá pedir baixa do G.T.M.;</li>
</ol>
</section>
<section class="manual-section" data-title="3. Funções" id="funcoes">
<div class="section-heading">
<span class="section-number">03</span>
<div><p>COMPOSIÇÃO DA UNIDADE</p><h2>3.Funções</h2></div>
</div>
<p>Uma unidade G.T.M. pode ser composta por até três motocicletas, onde cada uma tem sua função:</p>
<div class="role-grid">
<div class="role-card" data-title="Moto Primária (P1)" id="p1">
<span>P1</span>
<h3>1 - Moto Primária(P1):</h3>
<p>Tem como principal função a coordenação da Unidade em que está, é quem decide o destino da unidade, a quem abordar e quais ocorrências assumir. A moto primária é sempre composta pelo Piloto mais experiente da unidade.</p>
<p>Nos acompanhamentos, tem como função manter sempre o visual do veículo em que está acompanhando e, caso esteja sozinho, também exerce a função de modular a QRU.</p>
</div>
<div class="role-card" data-title="Moto Secundária (P2)" id="p2">
<span>P2</span>
<h3>2 - Moto Secundária(P2):</h3>
<p>Tem como principal função o auxílio ao coordenador, ou seja, irá assumir toda e qualquer responsabilidade atribuída ao mesmo, seja abordagem, modulação ou qualquer outra ordem, também é responsável pelo cuidado do perímetro durante determinadas ocasiões.</p>
<p>Nos acompanhamentos, tem como principal função a modulação. Também é responsável pelo adiantamento nos becos e sempre deve estar em alerta para assumir caso aconteça algo com o P1.</p>
</div>
<div class="role-card" data-title="Moto Terciária (P3)" id="p3">
<span>P3</span>
<h3>3 - Moto Terciária(P3):</h3>
<p>Tem como principal função cuidar da retaguarda da unidade durante o patrulhamento. Geralmente composta pelo Piloto mais inexperiente ou estagiário, tem obrigação de acatar toda e qualquer ordem dada pelo coordenador da unidade.</p>
<p>Nos acompanhamentos, sua principal função é o adiantamento de becos. Sempre atento e auxiliando o P1 e P2.</p>
</div>
</div>
</section>
<section class="manual-section" data-title="4. Modulação" id="modulacao">
<div class="section-heading">
<span class="section-number">04</span>
<div><p>COMUNICAÇÃO OPERACIONAL</p><h2>4. Modulação</h2></div>
</div>
<p>Parte vital do trabalho militar dentro do DPJ, a modulação é algo muito prezado dentro do 2ºESQ/GTM, por isso alguns padrões são criados para que a qualidade da mesma seja mantida dentro do grupamento.</p>
<div class="topic-block" data-title="4.1 Comunicação no /pr" id="pr">
<h3>4.1 - Comunicação no /pr</h3>
<p>O chat da polícia é utilizado para passarmos informações que não são necessárias serem passadas na rádio, segue alguns exemplos da utilização do /pr pela GTM.</p>
<div class="radio-example"><small>Entrada em serviço</small><p>QAP Central, 3° Sargento Neto (Comando 2°ESQ/GTM-DPJ) iniciando serviço!</p></div>
<div class="radio-example"><small>Saída de serviço</small><p>QAP Central, 3° Sargento Neto (Comando 2°ESQ/GTM-DPJ) indo de QTX!</p></div>
</div>
<div class="topic-block" data-title="4.2 Comunicação na Central" id="central">
<h3>4.2 - Comunicação na Central</h3>
<p>A modulação deverá ser curta e breve na central, para que os GTMs tenham foco no acompanhamento, modulando apenas o necessário, é papel do piloto julgar quando é necessário a modulação durante o acompanhamento.</p>
<div class="radio-example"><small>Modulação de deslocamento</small><p>QAP Central, Unidade GTM, QTI do Caixa Eletrônico, (X) metros/km.</p></div>
<p>Estabelecer a comunicação na central, informar a unidade que está a caminho (2 motos = Equipe e 3 motos = 1 Unidade), caso esteja sozinho informe que uma GTM está QTI.</p>
<div class="radio-example"><small>Modulação de Acompanhamento</small><p>QAP Central, Akuma na praça, sentido Sport Race;</p></div>
<p>Estabeleça o contato com a central, informe QTH atual, informe QTH futuro, caso mude o rumo corrija a informação.</p>
</div>
</section>
<section class="manual-section" data-title="5. Posicionamento" id="posicionamento">
<div class="section-heading">
<span class="section-number">05</span>
<div><p>PADRÕES OPERACIONAIS</p><h2>5. Posicionamento</h2></div>
</div>
<div class="topic-block" data-title="5.1 Durante patrulhamento" id="patrulhamento">
<h3>5.1 - Durante patrulhamento</h3>
<p>A formação de uma unidade do Grupamento Tático de Motocicletas consiste em até 3 motos. Independente se duas ou três, todas devem manter o formato “serrote” onde a primeira moto fica sempre à direita da via, a segunda deve manter um pouco atrás e para a esquerda, e caso tenha a terceira, ela se mantém atrás da segunda moto, alinhada com a primeira moto.</p>

<p>Este padrão deve sempre ser mantido, visando a segurança de todas as motos em qualquer tipo de situação. Nesta formação, é possível realizar qualquer tipo de manobra sem que a outra corra risco.</p>
</div>
<div class="topic-block" data-title="5.2 Durante abordagem" id="abordagem">
<h3>5.2 - Durante abordagem</h3>
<p>Antes de qualquer abordagem, o P1 irá decidir a quem abordar e o P2 irá modular enquanto o P1 dá a voz e realiza os primeiros procedimentos, e o P3 fará o perímetro.</p>
<p>Durante a abordagem, as motos realizarão uma formação em “L”, onde a primeira moto posicionará na lateral do veículo, a segunda na diagonal e a terceira logo atrás do veículo, sempre de olho na retaguarda. Segue o exemplo na imagem abaixo:</p>

<p>Vale ressaltar que esta formação deve ser seguida à risca, pois garantirá a segurança de todos os membros da unidade e dará liberdade para efetuar qualquer disparo se necessário, evitando qualquer fogo amigo. No caso de fuga da abordagem, todas as motos estão bem posicionadas evitando qualquer tipo de atraso no seu embarque.</p>
</div>
<div class="topic-block" data-title="5.2.1 Durante abordagem de alto risco" id="alto-risco">
<h3>5.2.1 - Durante abordagem de alto risco</h3>
<p>O posicionamento será no mesmo padrão em “L” (citado acima), porém as motos irão ficar rotacionando no próprio eixo e apontando arma. Sempre em movimento, nunca parado.</p>
</div>
<div class="topic-block" data-title="5.3 Estacionamento" id="estacionamento">
<h3>5.3 - Estacionamento</h3>
<p>Ao efetuar o estacionamento das motocicletas, todas deverão manter com as duas rodas no mesmo lugar (Ex.: Roda dianteira na rua, roda traseira também. Roda dianteira na calçada, roda traseira também) e não com uma roda na rua e a outra na calçada. Assim como mostra a imagem abaixo:</p>

<p>Esse padrão deve ser sempre seguido.</p>
</div>
</section>
<section class="closing-section" data-title="Encerramento" id="encerramento">

<blockquote>“Se você fugir, eu corro atrás. Se você me enfrentar, eu luto com você. Se atirar em mim, eu atiro de volta.’’</blockquote>
<p>Manual de Conduta do Grupamento Tático de Motocicletas<br/>criado por Brito<br/>desenvolvido para a Cidade Villa</p>
</section>
</article>
      </article>
    </div>
  </div>`;

  const content=page.querySelector('.manual-document');
  const map=[
    ['introducao','manual-introducao'],['regras','manual-regras'],['funcoes','manual-funcoes'],
    ['modulacao','manual-modulacao'],['posicionamento','manual-posicionamento'],['encerramento','manual-encerramento']
  ];
  map.forEach(([oldId,newId])=>{ const el=content.querySelector('#'+oldId); if(el) el.id=newId; });
}


const QRU_TYPES = [
  'ATM/Registradora','Venda de Droga','Fuga de Abordagem','Roubo de Veículo/Viatura',
  'Assalto a Mão Armada','Sequestro','Cod 5','Invasão de Propriedade','Porte Ilegal de Arma',
  'Fuga da Prisão','Corrida Ilegal','Roubo de Porta Mala','Resgate','Outros'
];

async function qruPage(){
  try{
    const officers = await api('/api/efetivo');
    let selected = [];
    let photoUrl = '';
    page.innerHTML = `
      <div class="qru-head">
        <div><span class="eyebrow">ATIVIDADE OPERACIONAL</span><h1>Registrar QRU</h1><p>${new Date().toLocaleDateString('pt-BR')}</p></div>
        <div class="qru-head-actions"><button class="btn secondary" onclick="loadPage('dashboard')">Cancelar</button><button class="btn" onclick="submitQRU()">Registrar QRU</button></div>
      </div>
      <section class="qru-section">
        <div class="qru-section-title"><span>TIPO DE QRU *</span><small>Selecione uma categoria</small></div>
        <div class="qru-type-grid">${QRU_TYPES.map((t,i)=>`<button type="button" class="qru-type ${i===0?'selected':''}" data-type="${escapeAttr(t)}" onclick="selectQRUType(this)">${escapeHtml(t)}</button>`).join('')}</div>
      </section>
      <section class="qru-section">
        <div class="qru-section-title"><span>DADOS DA OCORRÊNCIA</span><small>Preencha os dados abaixo para montar o relato automaticamente.</small></div>
        <div class="qru-form-grid">
          <label>Modelo do veículo<input id="qru-veiculo" placeholder="Ex.: Supra"></label>
          <label>Itens apreendidos<input id="qru-itens" placeholder="Ex.: Dinheiro Sujo"></label>
          <label>Passaporte do indivíduo<input id="qru-passaporte" placeholder="Ex.: 3936"></label>
        </div>
      </section>
      <section class="qru-section qru-report-section">
        <div class="qru-section-title"><span>TÍTULO E RELATO</span><small>O título e o relato são preenchidos automaticamente conforme o tipo selecionado.</small></div>
        <label class="qru-title-field">Título<input id="qru-titulo" placeholder="Selecione um tipo para preencher automaticamente"></label>
        <label class="qru-report-field">Relato gerado automaticamente<textarea id="qru-preview" class="qru-preview" rows="14" readonly></textarea></label>
      </section>
      <section class="qru-section">
        <div class="qru-section-title"><span>FOTO DO QRU <em>(OPCIONAL)</em></span><small>PNG, JPG ou link</small></div>
        <div class="qru-photo-row"><input id="qru-foto" placeholder="Cole o link da imagem (opcional)" onchange="photoUrl=this.value"><label class="qru-upload">↥ Upload<input type="file" accept="image/png,image/jpeg" onchange="previewQRUPhoto(this)"></label><button class="btn secondary" type="button" onclick="document.getElementById('qru-foto').value='';photoUrl='';window.qruPhotoData=''">Limpar</button></div>
        <div id="qru-photo-preview" class="qru-photo-preview">Nenhuma imagem selecionada</div>
      </section>
      <section class="qru-section">
        <div class="qru-section-title"><span>OFICIAIS ENVOLVIDOS *</span><small>Selecione quem participou da ocorrência.</small></div>
        <div id="qru-selected" class="qru-selected"></div>
        <input id="qru-search" class="qru-search" placeholder="⌕ Buscar por nome ou ID..." oninput="filterQRUOfficers(this.value)">
        <div id="qru-officers" class="qru-officer-list">${renderQRUOfficers(officers, selected)}</div>
        <div class="qru-selected-count" id="qru-selected-count">0 oficial(is) selecionado(s)</div>
      </section>
      <div class="qru-bottom-actions"><button class="btn secondary" onclick="loadPage('dashboard')">Cancelar</button><button class="btn" onclick="submitQRU()">Registrar QRU</button></div>`;
    window.qruOfficers = officers; window.qruSelected = selected; window.qruPhotoUrl = photoUrl;
    document.getElementById('qru-veiculo').addEventListener('input', updateQRUPreview);
    document.getElementById('qru-itens').addEventListener('input', updateQRUPreview);
    document.getElementById('qru-passaporte').addEventListener('input', updateQRUPreview);
    document.getElementById('qru-titulo').addEventListener('input', updateQRUPreview);
    selectQRUType(document.querySelector('.qru-type.selected'));
  }catch(e){ page.innerHTML=`<div class="section"><h3>Não foi possível carregar o formulário</h3><p style="color:#718395;font-size:11px">${escapeHtml(e.message)}</p></div>`; }
}

function selectedQRUType(){ return document.querySelector('.qru-type.selected')?.dataset.type || 'Outros'; }
function selectQRUType(btn){
  if(!btn)return;
  document.querySelectorAll('.qru-type').forEach(x=>x.classList.remove('selected')); btn.classList.add('selected');
  const title=document.getElementById('qru-titulo');
  if(title) title.value = `R.O - ${btn.dataset.type}`;
  updateQRUPreview();
}
function renderQRUOfficers(rows, selected){
  const q=(document.getElementById('qru-search')?.value||'').toLowerCase().trim();
  return rows.filter(r=>!q || `${r.nome} ${r.matricula}`.toLowerCase().includes(q)).map(r=>`<button type="button" class="qru-officer ${selected.some(x=>x.id===r.id)?'picked':''}" onclick="toggleQRUOfficer('${escapeAttr(r.id)}')"><b>${escapeHtml(r.nome)}</b><span>ID: ${escapeHtml(r.matricula||'—')}</span></button>`).join('') || `<div class="qru-empty">Nenhum integrante encontrado.</div>`;
}
function filterQRUOfficers(){ document.getElementById('qru-officers').innerHTML=renderQRUOfficers(window.qruOfficers||[],window.qruSelected||[]); }
function toggleQRUOfficer(id){
  const rows=window.qruOfficers||[], selected=window.qruSelected||[]; const row=rows.find(r=>r.id===id); if(!row)return;
  const i=selected.findIndex(x=>x.id===id); if(i>=0) selected.splice(i,1); else selected.push(row);
  window.qruSelected=selected;
  document.getElementById('qru-selected').innerHTML=selected.map(r=>`<span class="qru-chip">${escapeHtml(r.nome)} <button type="button" onclick="toggleQRUOfficer('${escapeAttr(r.id)}')">×</button></span>`).join('');
  document.getElementById('qru-selected-count').textContent=`${selected.length} oficial(is) selecionado(s)`;
  filterQRUOfficers(); updateQRUPreview();
}
function previewQRUPhoto(input){
  const file=input.files?.[0]; if(!file)return; if(file.size>5*1024*1024){alert('A imagem deve ter no máximo 5 MB.');input.value='';return;}
  const reader=new FileReader(); reader.onload=()=>{ window.qruPhotoData=reader.result; document.getElementById('qru-photo-preview').innerHTML=`<img src="${reader.result}" alt="Foto do QRU">`; }; reader.readAsDataURL(file);
}
function buildQRUReport(){
  const type=selectedQRUType();
  const itens=document.getElementById('qru-itens')?.value.trim()||'Nenhum item informado.';
  const veiculo=document.getElementById('qru-veiculo')?.value.trim()||'Não informado.';
  const passaporte=document.getElementById('qru-passaporte')?.value.trim()||'Não informado.';

  // Modelo oficial informado pelo comando.
  // O texto é o mesmo para todas as QRUs; somente o tipo selecionado,
  // o passaporte, os itens apreendidos e o modelo do veículo são dinâmicos.
  const title=`R.O - ${type}`;
  const report=`🎖️ 1° Departamento de Polícia Militar - Villa (1° BPM - Villa) 🎖️

📋 Relato:
Após o acionamento das equipes policiais para atendimento da ocorrência, foi iniciado acompanhamento tático ao veículo suspeito (${veiculo}). Durante a intervenção, o indivíduo envolvido na ocorrência desobedeceu às ordens legais de parada e empreendeu fuga, transitando por diferentes vias e expondo terceiros a risco.

As equipes mantiveram comunicação operacional contínua, realizaram o acompanhamento de forma coordenada e adotaram os procedimentos necessários para preservar a segurança da população e dos agentes envolvidos. Após o cerco e a contenção do veículo, a Polícia obteve êxito na abordagem e na prisão do indivíduo, encerrando a ocorrência sem novas intercorrências.

🕵️ Detidos:
• ${passaporte === 'Não informado.' ? 'Não informado.' : `Passaporte: ${passaporte}`}

🔫 Itens Apreendidos:
• ${itens}

🚗 Modelo do veículo:
• ${veiculo}

🔍 Observações:
O detido e os materiais apreendidos foram encaminhados à autoridade competente para a adoção das providências legais cabíveis. A ocorrência foi finalizada com êxito pelas equipes policiais.`;

  const titleEl=document.getElementById('qru-titulo');
  if(titleEl) titleEl.value=title;
  return report;
}
function updateQRUPreview(){
  const el=document.getElementById('qru-preview');
  if(el) el.value=buildQRUReport();
}
async function submitQRU(){
  const selected=window.qruSelected||[]; if(!selected.length){alert('Selecione pelo menos um oficial envolvido.');return;}
  const titulo=document.getElementById('qru-titulo')?.value.trim()||`QRU — ${selectedQRUType()}`;
  const payload={tipo:selectedQRUType(),titulo,local:'Villa',dados:{departamento:document.getElementById('qru-departamento')?.value||'',veiculo:document.getElementById('qru-veiculo')?.value||'',itens:document.getElementById('qru-itens')?.value||'',passaporte:document.getElementById('qru-passaporte')?.value||'',observacoes:document.getElementById('qru-obs')?.value||'',oficiais:selected.map(x=>({id:x.id,nome:x.nome,matricula:x.matricula,patente:x.patente})),foto_url:document.getElementById('qru-foto')?.value||'',foto_data:window.qruPhotoData||''},descricao:document.getElementById('qru-preview')?.value||''};
  try{ const r=await api('/api/ocorrencias',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); alert(`QRU ${r.protocolo} registrada com sucesso.`); loadPage('ocorrencias'); }
  catch(e){alert(e.message);}
}

async function tablePage(title,sub,url,cols){
  try{
    const rows=await api(url);
    page.innerHTML=`<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div><button class="btn">+ Novo registro</button></div>
    <div class="section"><table class="table"><thead><tr>${cols.map(c=>`<th>${c.toUpperCase()}</th>`).join("")}</tr></thead><tbody>
    ${rows.map(r=>`<tr>${cols.map(c=>`<td>${escapeHtml(r[c]??"—")}</td>`).join("")}</tr>`).join("")||`<tr><td colspan="${cols.length}">Nenhum registro encontrado.</td></tr>`}
    </tbody></table></div>`;
  }catch(e){page.innerHTML=`<div class="section"><h3>Não foi possível carregar</h3><p style="color:#718395;font-size:11px">${escapeHtml(e.message)}</p></div>`}
}

function escapeHtml(value){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function escapeAttr(value){return escapeHtml(value).replace(/`/g,'&#96;');}

if(token && currentUser) openApp();
