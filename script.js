const progress = document.getElementById("readingProgress");
const backToTop = document.getElementById("backToTop");
const sidebar = document.getElementById("sidebar");
const mobileMenu = document.getElementById("mobileMenu");
const backdrop = document.getElementById("backdrop");
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const toast = document.getElementById("toast");
const navLinks = [...document.querySelectorAll("#navigation a")];

function updateScrollUI(){
  const max = document.documentElement.scrollHeight - innerHeight;
  progress.style.width = `${max > 0 ? (scrollY / max) * 100 : 0}%`;
  backToTop.classList.toggle("visible", scrollY > 650);
}
addEventListener("scroll", updateScrollUI, {passive:true});
updateScrollUI();

function closeMenu(){
  sidebar.classList.remove("open");
  backdrop.classList.remove("show");
  mobileMenu.setAttribute("aria-expanded","false");
}
mobileMenu.addEventListener("click",()=>{
  const open = sidebar.classList.toggle("open");
  backdrop.classList.toggle("show",open);
  mobileMenu.setAttribute("aria-expanded",String(open));
});
backdrop.addEventListener("click",closeMenu);
navLinks.forEach(a=>a.addEventListener("click",closeMenu));
backToTop.addEventListener("click",()=>scrollTo({top:0,behavior:"smooth"}));

const targets = [...document.querySelectorAll("[data-title]")];
const observer = new IntersectionObserver(entries=>{
  const visible = entries.filter(e=>e.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];
  if(!visible) return;
  const id = visible.target.id;
  navLinks.forEach(a=>a.classList.toggle("active",a.getAttribute("href")===`#${id}`));
},{rootMargin:"-20% 0px -65% 0px",threshold:[0,.15,.4]});
targets.forEach(t=>observer.observe(t));

const searchable = targets.map(el=>({
  id:el.id,
  title:el.dataset.title || el.querySelector("h2,h3")?.textContent || el.id,
  text:el.innerText.replace(/\s+/g," ").trim()
}));

function showToast(message){
  toast.textContent=message;
  toast.classList.add("show");
  setTimeout(()=>toast.classList.remove("show"),1600);
}

function renderResults(query){
  const q=query.trim().toLocaleLowerCase("pt-BR");
  if(!q){searchResults.hidden=true;searchResults.innerHTML="";return}
  const matches=searchable.filter(item=>
    item.title.toLocaleLowerCase("pt-BR").includes(q) ||
    item.text.toLocaleLowerCase("pt-BR").includes(q)
  ).slice(0,8);

  searchResults.innerHTML=matches.length
    ? matches.map(item=>{
        const lower=item.text.toLocaleLowerCase("pt-BR");
        const index=lower.indexOf(q);
        const snippet=index>=0
          ? item.text.slice(Math.max(0,index-38),Math.min(item.text.length,index+90))
          : item.text.slice(0,110);
        return `<a href="#${item.id}"><strong>${item.title}</strong><small>…${snippet}…</small></a>`;
      }).join("")
    : `<a href="#" onclick="return false"><strong>Nenhum resultado</strong><small>Tente outra palavra.</small></a>`;
  searchResults.hidden=false;
}
searchInput.addEventListener("input",e=>renderResults(e.target.value));
searchResults.addEventListener("click",e=>{
  const a=e.target.closest("a[href^='#']");
  if(!a)return;
  searchResults.hidden=true;
  searchInput.value="";
  showToast("Seção localizada");
  closeMenu();
});
document.addEventListener("click",e=>{
  if(!e.target.closest(".search-box")&&!e.target.closest(".search-results"))searchResults.hidden=true;
});
document.addEventListener("keydown",e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){
    e.preventDefault();
    if(innerWidth<=900){
      sidebar.classList.add("open");
      backdrop.classList.add("show");
    }
    searchInput.focus();
  }
  if(e.key==="Escape"){
    searchResults.hidden=true;
    closeMenu();
  }
});

// ===== EFETIVO G.T.M. — GOOGLE SHEETS / APPS SCRIPT =====
const EFFECTIVE_API_URL = "https://script.google.com/macros/s/AKfycbwUwvyBujs0PUXhlq_703EiTBCGPqNkvMWOZzqizgKk43PHvpUnwxMEuI6_BI4Aj3mV/exec";
const effectivePanel = document.getElementById("effectivePanel");
const effectiveToggle = document.getElementById("effectiveToggle");
const effectiveClose = document.getElementById("effectiveClose");
const effectiveList = document.getElementById("effectiveList");
const effectiveSearch = document.getElementById("effectiveSearch");
const effectiveTotal = document.getElementById("effectiveTotal");
const effectiveActive = document.getElementById("effectiveActive");
const effectiveUpdated = document.getElementById("effectiveUpdated");
let effectiveMembers = [];

const cargoOrder = [
  "Comando",
  "Sub-Comando",
  "Capitão",
  "Piloto Oficial",
  "Piloto Probatório"
];
function normalizeEffective(value){return String(value||"").trim().toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g,"")}
function effectiveInitials(name){return String(name||"").split(/\s+/).filter(Boolean).slice(0,2).map(p=>p[0]).join("").toUpperCase()||"GT"}
function effectiveStatusClass(status){const value=normalizeEffective(status);if(value==="ativo"||value.includes("servico"))return"status-active";if(value==="inativo"||value==="afastado")return"status-inactive";return"status-other"}
function cargoIndex(cargo){const normalized=normalizeEffective(cargo);const index=cargoOrder.findIndex(item=>normalizeEffective(item)===normalized);return index===-1?999:index}
function renderEffective(data){
  const query=normalizeEffective(effectiveSearch?.value);
  const filtered=data.filter(item=>!query||normalizeEffective(`${item.nome} ${item.id} ${item.patente} ${item.cargo} ${item.status}`).includes(query));
  effectiveTotal.textContent=data.length;
  effectiveActive.textContent=data.filter(item=>normalizeEffective(item.status)==="ativo").length;
  if(!filtered.length){effectiveList.innerHTML='<div class="effective-empty">Nenhum oficial encontrado.</div>';return}
  const groups=filtered.reduce((acc,item)=>{const cargo=item.cargo||"Sem cargo";(acc[cargo]??=[]).push(item);return acc},{});
  const sorted=Object.keys(groups).sort((a,b)=>cargoIndex(a)-cargoIndex(b)||a.localeCompare(b,"pt-BR"));
  effectiveList.innerHTML=sorted.map(cargo=>`<section class="effective-group"><h3 class="effective-group-title">${cargo}</h3>${groups[cargo].map(member=>`<div class="effective-member" title="ID ${member.id||'-'} · ${member.status||'Sem status'}"><div class="effective-avatar">${effectiveInitials(member.nome)}</div><div class="effective-member-info"><span class="effective-member-name">${member.nome}</span><span class="effective-member-meta">${member.patente||'Sem patente'}${member.id?` · ID ${member.id}`:''}</span></div><i class="effective-member-status ${effectiveStatusClass(member.status)}"></i></div>`).join("")}</section>`).join("");
}
async function loadEffective(){
  try{
    effectiveUpdated.textContent="Consultando planilha...";
    const response=await fetch(`${EFFECTIVE_API_URL}?t=${Date.now()}`,{cache:"no-store"});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const payload=await response.json();
    if(payload.sucesso===false)throw new Error(payload.mensagem||"A API retornou um erro.");
    effectiveMembers=Array.isArray(payload)?payload:(payload.dados||[]);
    renderEffective(effectiveMembers);
    effectiveUpdated.textContent=payload.atualizadoEm?`Atualizado em ${payload.atualizadoEm}`:"Dados atualizados";
  }catch(error){
    console.error("Erro ao carregar efetivo:",error);
    effectiveList.innerHTML='<div class="effective-error">Não foi possível carregar o efetivo. Confirme se a implantação do Apps Script permite acesso para “Qualquer pessoa”.</div>';
    effectiveTotal.textContent="—";effectiveActive.textContent="—";effectiveUpdated.textContent="Falha na atualização";
  }
}
effectiveSearch?.addEventListener("input",()=>renderEffective(effectiveMembers));
effectiveToggle?.addEventListener("click",()=>{const open=effectivePanel.classList.toggle("open");effectiveToggle.setAttribute("aria-expanded",String(open))});
effectiveClose?.addEventListener("click",()=>{effectivePanel.classList.remove("open");effectiveToggle?.setAttribute("aria-expanded","false")});
loadEffective();
setInterval(loadEffective,300000);
