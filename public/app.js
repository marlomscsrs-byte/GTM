
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
    efetivo:["Efetivo","Quadro de integrantes da unidade"],
    escala:["Escala","Serviços e plantões"],
    cursos:["Cursos","Treinamentos e certificações"],
    frota:["Frota","Motocicletas e manutenção"],
    manual:["Manual","Procedimentos operacionais"],
    relatorios:["Relatórios","Estatísticas e indicadores"],
    admin:["Administração","Usuários, permissões e configurações"]
  };
  const [title,sub]=titles[name]||titles.dashboard;
  if(name==="dashboard") return dashboard();
  if(name==="efetivo") return tablePage(title,sub,"/api/efetivo",["nome","matricula","patente","status","unidade"]);
  if(name==="ocorrencias") return tablePage(title,sub,"/api/ocorrencias",["protocolo","tipo","titulo","local","status"]);
  page.innerHTML=`<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div><button class="btn">+ Nova ação</button></div>
  <div class="section"><h3>Em construção</h3><p style="color:#6d7e90;font-size:11px">Este módulo já está previsto na arquitetura do banco PostgreSQL. A próxima etapa adicionará os formulários e operações CRUD.</p></div>`;
}

async function dashboard(){
  try{
    const d=await api("/api/dashboard");
    page.innerHTML=`<div class="hero"><span class="over">BEM-VINDO AO PORTAL GTM</span><h1>Boa noite, ${currentUser?.nome||"Operador"}!</h1><p>“Controle hoje, resultados amanhã.”</p></div>
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
      ${action("▰","Comunicados","Enviar para o efetivo","admin")}
    </div></div>
    <div class="two"><div class="section"><h3>STATUS OPERACIONAL</h3><div class="rows">
      <div class="row"><span>Efetivo ativo</span><b>${d.stats.efetivo}</b></div>
      <div class="row"><span>Serviços hoje</span><b>${d.stats.servicos}</b></div>
      <div class="row"><span>Motocicletas disponíveis</span><b>${d.stats.motocicletas}</b></div>
    </div></div><div class="section"><h3>ACESSO</h3><div class="rows"><div class="row"><span>Usuário</span><small>${currentUser?.username||"-"}</small></div><div class="row"><span>Perfil</span><small>${currentUser?.patente||"Piloto"}</small></div><div class="row"><span>Sessão</span><span class="pill">ATIVA</span></div></div></div></div>`;
  }catch(e){ page.innerHTML=`<div class="section"><h3>Banco de dados indisponível</h3><p style="color:#718395;font-size:11px">${e.message}</p></div>`}
}
function stat(n,label,sub){return `<div class="stat"><label>${label}</label><b>${n}</b><small>● ${sub}</small></div>`}
function action(icon,title,sub,target){return `<button class="action" onclick="loadPage('${target}')"><div class="ico">${icon}</div><strong>${title}</strong><small>${sub}</small></button>`}
async function tablePage(title,sub,url,cols){
  try{
    const rows=await api(url);
    page.innerHTML=`<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div><button class="btn">+ Novo registro</button></div>
    <div class="section"><table class="table"><thead><tr>${cols.map(c=>`<th>${c.toUpperCase()}</th>`).join("")}</tr></thead><tbody>
    ${rows.map(r=>`<tr>${cols.map(c=>`<td>${r[c]??"—"}</td>`).join("")}</tr>`).join("")||`<tr><td colspan="${cols.length}">Nenhum registro encontrado.</td></tr>`}
    </tbody></table></div>`;
  }catch(e){page.innerHTML=`<div class="section"><h3>Não foi possível carregar</h3><p style="color:#718395;font-size:11px">${e.message}</p></div>`}
}
if(token && currentUser) openApp();
