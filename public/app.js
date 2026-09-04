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
  if(name==="efetivo") return efetivoPage();
  if(name==="ocorrencias") return tablePage(title,sub,"/api/ocorrencias",["protocolo","tipo","titulo","local","status"]);
  if(name==="admin") return adminPage();
  page.innerHTML=`<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div></div>
  <div class="section"><h3>EM CONSTRUÇÃO</h3><p style="color:#6d7e90;font-size:11px">Este módulo já está previsto na arquitetura do banco PostgreSQL. A próxima etapa adicionará os formulários e operações CRUD.</p></div>`;
}

async function dashboard(){
  try{
    const d=await api("/api/dashboard");
    page.innerHTML=`<div class="hero"><span class="over">BEM-VINDO AO PORTAL GTM</span><h1>Boa noite, ${escapeHtml(currentUser?.nome||"Operador")}!</h1><p>“Controle hoje, resultados amanhã.”</p></div>
    <div class="stats">
      ${stat(d.stats.efetivo,"EFETIVO ATIVO","Integrantes")} ${stat(d.stats.ocorrencias,"OCORRÊNCIAS","Últimos 7 dias")} ${stat(d.stats.servicos,"SERVIÇOS HOJE","Programados")} ${stat(d.stats.cursos,"CURSOS","Ativos")} ${stat(d.stats.motocicletas,"MOTOCICLETAS","Frota ativa")} ${stat(d.stats.online,"USUÁRIOS ONLINE","Agora")}
    </div>
    <div class="section"><h3>ATIVIDADES RÁPIDAS</h3><div class="actions">
      ${action("▣","Nova ocorrência","Registrar no sistema","ocorrencias")}
      ${action("◆","Nova ação","Adicionar atividade","escala")}
      ${action("◷","Escala semanal","Visualizar / editar","escala")}
      ${action("♙","Efetivo","Gerenciar integrantes","efetivo")}
      ${action("◇","Cursos","Cadastrar / acompanhar","cursos")}
      ${action("♢","Frota","Controle de motocicletas","frota")}
      ${action("▤","Relatórios","Estatísticas e dados","relatorios")}
      ${action("⚙","Administração","Contas e usuários","admin")}
    </div></div>
    <div class="two"><div class="section"><h3>STATUS OPERACIONAL</h3><div class="rows">
      <div class="row"><span>Efetivo ativo</span><b>${d.stats.efetivo}</b></div>
      <div class="row"><span>Serviços hoje</span><b>${d.stats.servicos}</b></div>
      <div class="row"><span>Motocicletas disponíveis</span><b>${d.stats.motocicletas}</b></div>
    </div></div><div class="section"><h3>ACESSO</h3><div class="rows"><div class="row"><span>Usuário</span><small>${escapeHtml(currentUser?.username||"-")}</small></div><div class="row"><span>Perfil</span><small>${escapeHtml(currentUser?.patente||"Piloto")}</small></div><div class="row"><span>Permissão</span><small>${currentUser?.role === 'admin' ? 'COMANDO' : 'OPERADOR'}</small></div><div class="row"><span>Sessão</span><span class="pill">ATIVA</span></div></div></div></div>`;
  }catch(e){ page.innerHTML=`<div class="section"><h3>Banco de dados indisponível</h3><p style="color:#718395;font-size:11px">${escapeHtml(e.message)}</p></div>`}
}

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
