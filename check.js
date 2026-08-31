
let token=localStorage.getItem("instrutores_token")||"";
let me=null;
let instructorRows=[];
let adminEditingUserId=null;
let instructorFilter="all";
let presenceTimer=null;
const $=id=>document.getElementById(id);
function authTab(x){$("loginBox").classList.toggle("hidden",x!=="login");$("regBox").classList.toggle("hidden",x!=="register");$("tLogin").classList.toggle("active",x==="login");$("tReg").classList.toggle("active",x==="register")}
async function api(url,opt={}){opt.headers={...(opt.headers||{}), "Content-Type":"application/json",...(token?{"Authorization":"Bearer "+token}:{})};const r=await fetch(url,opt);const text=await r.text();let d={};try{d=text?JSON.parse(text):{}}catch{}if(!r.ok)throw Error(d.error||`Erro HTTP ${r.status}`);return d}
function maskCityPhone(el){let v=String(el.value||"").replace(/\D/g,"").slice(0,6);el.value=v.length>3?v.slice(0,3)+"-"+v.slice(3):v}
async function register(){try{const cityId=$("rcityid").value.replace(/\D/g,"");const cityPhone=$("rcityphone").value.replace(/\D/g,"");if(!/^\d+$/.test(cityId))throw Error("Informe um ID na cidade válido.");if(!/^\d{6}$/.test(cityPhone))throw Error("Informe o telefone da cidade no formato 000-000.");const d=await api("/api/auth/register",{method:"POST",body:JSON.stringify({name:$("rname").value,username:$("rusername").value,password:$("rpass").value,discord:$("rdiscord").value,city_id:cityId,city_phone:cityPhone})});$("regMsg").textContent=d.message;$("regMsg").classList.remove("hidden")}catch(e){$("regMsg").textContent=e.message;$("regMsg").classList.remove("hidden")}}
$("rcityid").addEventListener("input",e=>{e.target.value=e.target.value.replace(/\D/g,"")});$("rcityphone").addEventListener("input",e=>maskCityPhone(e.target));
async function login(){try{const d=await api("/api/auth/login",{method:"POST",body:JSON.stringify({username:$("email").value,password:$("pass").value})});token=d.token;localStorage.setItem("instrutores_token",token);me=d.user;enter()}catch(e){alert(e.message)}}
async function enter(){
  $("auth").classList.add("hidden");$("app").classList.remove("hidden");$("app").style.display="block";
  $("meName").textContent=me?.name||"Usuário";
  $("meRole").textContent=roleLabel(me?.role);
  $("topProfileName").textContent=me?.name||"Usuário";
  $("topProfileRole").textContent=roleLabel(me?.role);
  if(me?.avatar_data){ $("topProfileAvatar").innerHTML=`<img src="${me.avatar_data}" alt="">`; }
  else { $("topProfileAvatar").textContent=initials(me?.name||"?"); }
  renderMeAvatar(me?.avatar_data);
  const manager=["coordenador","admin"].includes(me?.role);
  const rulesEditBtn=$("rulesEditBtn");
  if(rulesEditBtn) rulesEditBtn.classList.toggle("show",manager);
  loadInstructionRules();

  // Todos os módulos continuam visíveis no menu para manter a navegação padronizada.
  // As regras de acesso permanecem protegidas pelo servidor e pelo guard de navegação abaixo.
  const managerOnly=["relatorios","aprovacoes"];
  const visibility={
    dashboard:true,
    instrutores:true,
    disponibilidade:true,
    relatorios:true,
    resultados:true,
    aprovacoes:true,
    marcacoes:true,
    perfil:true,
    materiais:true
  };
  Object.entries(visibility).forEach(([id,show])=>{
    const btn=document.querySelector(`.nav button[onclick*="go('${id}'"]`);
    if(btn){
      btn.style.display=show?"flex":"none";
      if(!manager && managerOnly.includes(id)){
        btn.classList.add("nav-restricted");
        btn.setAttribute("title","Acesso restrito a Coordenadores e Administradores");
        btn.setAttribute("aria-disabled","true");
      }
    }
  });

  // Os grupos CONTROLE/SISTEMA continuam visíveis.
  document.querySelectorAll(".nav .nav-control").forEach(section=>{
    section.style.display="block";
  });
  $("addUserBtn").style.display=manager?"inline-block":"none";

  document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
  const initial="dashboard";
  $(initial).classList.add("active");
  document.querySelectorAll(".nav button").forEach(b=>b.classList.remove("active"));
  const initialBtn=document.querySelector(`.nav button[onclick*="go('${initial}'"]`);
  if(initialBtn) initialBtn.classList.add("active");
  $("title").textContent=titles[initial][0];
  $("subtitle").textContent=titles[initial][1];
  document.querySelectorAll("[id='todayText']").forEach(el=>el.textContent=new Date().toLocaleDateString("pt-BR",{day:"2-digit",month:"long",year:"numeric"}));

  if(manager) await loadAll();
  else { await loadAll(); await loadBookings(); }
  await loadNotifications();
  startNotificationPolling();
  startPendingPolling();
  setupPresenceUI();
  startPresence();
}
function renderPresence(list){
  const rows=Array.isArray(list)?list:[];
  const online=rows.filter(x=>x.online);
  const count=$("presenceCount"); if(count)count.textContent=online.length+" online";
  const box=$("presenceList"); if(!box)return;
  box.innerHTML=rows.length?rows.map(u=>{
    const name=u.name||"Usuário";
    const role=roleLabel(u.role)+(u.rank?" • "+u.rank:"");
    return `<div class="presence-item"><div class="presence-avatar">${u.avatar_data?`<img src="${escAttr(u.avatar_data)}" alt="">`:esc(initials(name))}</div><div class="presence-info"><b>${esc(name)}</b><small>${esc(role)}</small></div><div class="presence-status ${u.online?"":"offline"}"><i></i>${u.online?"Online":"Offline"}</div></div>`;
  }).join(""):"<div class='presence-empty'>Nenhum usuário cadastrado.</div>";
  const upd=$("presenceUpdated"); if(upd)upd.textContent="Atualizado agora";
}
async function loadPresence(){
  if(!token)return;
  try{const rows=await api("/api/presence");renderPresence(rows);}catch(e){console.warn("Presença:",e.message)}
}
async function sendPresenceHeartbeat(){
  if(!token)return;
  try{await api("/api/presence/heartbeat",{method:"POST",body:"{}"});}catch(e){console.warn("Heartbeat:",e.message)}
}
function startPresence(){
  if(presenceTimer)clearInterval(presenceTimer);
  sendPresenceHeartbeat(); loadPresence();
  presenceTimer=setInterval(()=>{sendPresenceHeartbeat();loadPresence()},30000);
}
function setupPresenceUI(){
  const btn=$("presenceBtn"),panel=$("presencePanel");
  if(!btn||!panel)return;
  btn.onclick=async(e)=>{e.stopPropagation();const show=!panel.classList.contains("show");panel.classList.toggle("show",show);btn.setAttribute("aria-expanded",show?"true":"false");if(show)await loadPresence();};
  document.addEventListener("click",e=>{if(!e.target.closest(".presence-wrap")){panel.classList.remove("show");btn.setAttribute("aria-expanded","false");}});
}
function logout(){if(window.notificationTimer)clearInterval(window.notificationTimer);if(window.pendingTimer)clearInterval(window.pendingTimer);if(presenceTimer)clearInterval(presenceTimer);if(token){fetch("/api/presence/offline",{method:"POST",keepalive:true,headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},body:"{}"}).catch(()=>{});}localStorage.removeItem("instrutores_token");token="";location.reload()}
async function boot(){if(!token)return;try{me=await api("/api/me");enter()}catch{localStorage.removeItem("instrutores_token")}}

document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&token)sendPresenceHeartbeat();});
window.addEventListener("beforeunload",()=>{if(!token)return;try{navigator.sendBeacon("/api/presence/offline",new Blob([JSON.stringify({})],{type:"application/json"}));}catch{}});
const titles={dashboard:["Dashboard","Visão geral do Corpo de Instrutores."],marcacoes:["MARCAÇÕES","Controle de agenda e cursos"],instrutores:["INSTRUTORES","Equipe cadastrada"],disponibilidade:["DISPONIBILIDADE","Horários disponíveis"],materiais:["MATERIAIS DE APOIO","Regras, uniformes e materiais para instrutores"],relatorios:["RELATÓRIOS","Indicadores e desempenho"],perfil:["MEU PERFIL","Dados da sua conta"],resultados:["RESULTADOS","Notas e resultados dos cursos"],aprovacoes:["APROVAÇÕES","Cadastros e marcações aguardando aprovação"]};

function roleLabel(role){return role==="admin"?"Administrador":role==="coordenador"?"Coordenador":"Instrutor"}
function initials(name){return String(name||"?").trim().split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase()||"?"}
function renderAvatarElement(el, data, name){
  if(!el)return;
  if(data){
    el.innerHTML=`<img src="${escAttr(data)}" alt="Foto de ${escAttr(name||"usuário")}">`;
  }else{
    el.innerHTML=`<span class="avatar-fallback">${esc(initials(name))}</span>`;
  }
}
function renderMeAvatar(data){
  renderAvatarElement($("meAvatar"),data,me?.name);
}
function formatCityPhone(value){
  const digits=String(value||"").replace(/\D/g,"").slice(0,6);
  if(digits.length<=3)return digits;
  return digits.slice(0,3)+"-"+digits.slice(3);
}
function bindAdminUserPhoneMask(){const el=$("euCityPhone");if(!el||el.dataset.masked)return;el.dataset.masked="1";el.addEventListener("input",()=>{let v=el.value.replace(/\D/g,"").slice(0,6);el.value=v.length>3?v.slice(0,3)+"-"+v.slice(3):v})}

$("profileCityPhone")?.addEventListener("input",e=>{e.target.value=formatCityPhone(e.target.value)});
$("profileCityId")?.addEventListener("input",e=>{e.target.value=e.target.value.replace(/\D/g,"").slice(0,12)});
async function loadProfile(){
  try{
    const p=await api("/api/me");
    me=p;
    $("profileName").value=p.name||"";
    $("profileUsername").value=p.username||"";
    $("profileCityId").value=p.city_id||"";
    $("profileCityPhone").value=formatCityPhone(p.city_phone||"");
    $("profileDiscord").value=p.discord||"";
    $("profileRank").value=p.rank||"Sd.";
    $("profileNotificationPreference").value=p.notification_preference||"all";
    $("profileRole").value=roleLabel(p.role);
    $("profileDisplayName").textContent=p.name||"—";
    $("profileDisplayRole").textContent=roleLabel(p.role);
    $("profileActiveStat").textContent=$("kActive")?.textContent||"0";
    $("profileCoursesStat").textContent=$("kCompleted")?.textContent||"0";
    renderAvatarElement($("profileAvatar"),p.avatar_data,p.name);
    $("profileAvatar").dataset.pendingPhoto="";
    renderMeAvatar(p.avatar_data);
    $("profilePassword").value="";
    $("profilePasswordConfirm").value="";
    $("profileMsg").classList.add("hidden");
  }catch(e){
    // Mantém os dados básicos do usuário logado visíveis mesmo se uma preferência/API opcional falhar.
    const p=me||{};
    $("profileName").value=p.name||"";
    $("profileUsername").value=p.username||"";
    $("profileCityId").value=p.city_id||"";
    $("profileCityPhone").value=formatCityPhone(p.city_phone||"");
    $("profileDiscord").value=p.discord||"";
    $("profileRank").value=p.rank||"Sd.";
    $("profileRole").value=roleLabel(p.role);
    $("profileDisplayName").textContent=p.name||"—";
    $("profileDisplayRole").textContent=roleLabel(p.role);
    renderAvatarElement($("profileAvatar"),p.avatar_data,p.name);
    alert(e.message);
  }
}
function openProfile(){
  document.querySelectorAll(".page").forEach(x=>x.classList.remove("active"));
  $("perfil").classList.add("active");
  document.querySelectorAll(".nav button").forEach(x=>x.classList.remove("active"));
  $("title").textContent=titles.perfil[0];
  $("subtitle").textContent=titles.perfil[1];
  loadProfile();
}
function goBackFromProfile(){
  const btn=[...document.querySelectorAll(".nav button")].find(x=>String(x.getAttribute("onclick")||"").includes("go('dashboard'"));
  if(btn)go("dashboard",btn);
}
function chooseProfilePhoto(){$("profilePhotoInput").click()}
function removeProfilePhoto(){
  if(!confirm("Remover sua foto de perfil?"))return;
  saveProfile(true);
}
async function handleProfilePhoto(event){
  const file=event.target.files?.[0];
  if(!file)return;
  if(!["image/png","image/jpeg","image/webp"].includes(file.type)){alert("Use PNG, JPG ou WEBP.");event.target.value="";return}
  if(file.size>750*1024){alert("A foto deve ter no máximo 750 KB.");event.target.value="";return}
  const reader=new FileReader();
  reader.onload=()=>{renderAvatarElement($("profileAvatar"),reader.result,me?.name);$("profileAvatar").dataset.pendingPhoto=reader.result};
  reader.readAsDataURL(file);
}
async function saveProfile(removePhoto=false){
  const name=$("profileName").value.trim();
  const city_id=$("profileCityId").value.replace(/\D/g,"").trim();
  const city_phone=$("profileCityPhone").value.replace(/\D/g,"").trim();
  const discord=$("profileDiscord").value.trim();
  const rank=$("profileRank").value;
  if(!/^\d+$/.test(city_id)){alert("Informe um ID na cidade válido.");return}
  if(!/^\d{6}$/.test(city_phone)){alert("Informe o telefone da cidade no formato 000-000.");return}
  const notification_preference=$("profileNotificationPreference").value;
  const password=$("profilePassword").value;
  const confirmation=$("profilePasswordConfirm").value;
  if(!name){alert("Informe seu nome.");return}
  if(password && password.length<6){alert("A nova senha precisa ter pelo menos 6 caracteres.");return}
  if(password!==confirmation){alert("As senhas não conferem.");return}
  const pendingPhoto=$("profileAvatar").dataset.pendingPhoto;
  const body={name,city_id,city_phone,discord,rank,notification_preference};
  if(removePhoto)body.avatar_data=null;
  else if(pendingPhoto)body.avatar_data=pendingPhoto;
  if(password)body.password=password;
  try{
    const p=await api("/api/me",{method:"PUT",body:JSON.stringify(body)});
    me=p;
    $("profileAvatar").dataset.pendingPhoto="";
    renderAvatarElement($("profileAvatar"),p.avatar_data,p.name);
    renderMeAvatar(p.avatar_data);
    $("meName").textContent=p.name;
    $("meRole").textContent=roleLabel(p.role);
    $("profileDisplayName").textContent=p.name;
    $("profileDisplayRole").textContent=roleLabel(p.role);
    $("profileActiveStat").textContent=$("kActive")?.textContent||"0";
    $("profileCoursesStat").textContent=$("kCompleted")?.textContent||"0";
    $("profilePassword").value="";$("profilePasswordConfirm").value="";
    $("profileMsg").textContent="Perfil atualizado com sucesso.";
    $("profileMsg").classList.remove("hidden");
    setTimeout(()=>$("profileMsg").classList.add("hidden"),2500);
  }catch(e){alert(e.message)}
}
let notificationOpen=false;
async function loadNotifications(){
  if(!token)return;
  try{
    const d=await api("/api/notifications");
    const items=Array.isArray(d.items)?d.items:[];
    const count=Number(d.unread)||0;
    const badge=$("notificationCount");
    badge.textContent=count>99?"99+":String(count);
    badge.classList.toggle("show",count>0);
    $("notificationList").innerHTML=items.length?items.map(n=>{
      const icon=n.type==="success"?"✓":n.type==="danger"?"!":n.type==="result"?"★":"•";
      const cls=n.read_at?"":"unread";
      return `<div class="notification-item ${esc(n.type||"info")} ${cls}" data-id="${Number(n.id)}"><div class="ntop"><span class="nicon">${icon}</span><div><div class="ntitle">${esc(n.title)}</div><div class="nmessage">${esc(n.message)}</div><div class="ntime">${formatNotificationDate(n.created_at)}</div></div></div></div>`;
    }).join(""):"<div class='notification-empty'>Você está em dia. Nenhuma notificação.</div>";
    document.querySelectorAll("#notificationList .notification-item").forEach(el=>el.addEventListener("click",async()=>{const id=Number(el.dataset.id);try{await api("/api/notifications/"+id+"/read",{method:"PATCH"});await loadNotifications()}catch(e){}}));
  }catch(e){console.warn("Notificações:",e.message)}
}
function formatNotificationDate(value){
  if(!value)return "";
  const d=new Date(value);
  if(Number.isNaN(d.getTime()))return String(value);
  return d.toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
}
async function markAllNotificationsRead(){try{await api("/api/notifications/read-all",{method:"POST"});await loadNotifications()}catch(e){alert(e.message)}}
function startNotificationPolling(){
  if(window.notificationTimer)clearInterval(window.notificationTimer);
  window.notificationTimer=setInterval(loadNotifications,20000);
}

// Atualiza automaticamente os contadores e a lista de aprovações sem exigir F5.
async function refreshPendingDashboard(){
  if(!token || !["coordenador","admin"].includes(String(me?.role||"").toLowerCase())) return;
  try{
    const [users,bookings]=await Promise.all([
      api("/api/pending-users"),
      api("/api/pending-bookings")
    ]);
    const pendingUsers=Array.isArray(users)?users:[];
    const pendingBookings=Array.isArray(bookings)?bookings:[];
    const total=pendingUsers.length+pendingBookings.length;

    // Card "Pendentes" do Dashboard
    if($("kPendingAll")) $("kPendingAll").textContent=total;

    // Bloco "Aprovações pendentes" do Dashboard
    renderApprovalDashboard(pendingUsers,pendingBookings);

    // Contadores da página de Aprovações, se ela estiver aberta.
    if($("pc")) $("pc").textContent=pendingUsers.length+" pendentes";
    if($("bc")) $("bc").textContent=pendingBookings.length+" pendentes";

    // Se a página de aprovações estiver ativa, atualiza seu conteúdo completo.
    if($("aprovacoes")?.classList.contains("active")){
      renderApprovalsPage(pendingUsers,pendingBookings);
    }
  }catch(e){ console.warn("Atualização automática de aprovações:",e.message); }
}

function startPendingPolling(){
  if(window.pendingTimer)clearInterval(window.pendingTimer);
  if(!["coordenador","admin"].includes(String(me?.role||"").toLowerCase())) return;
  refreshPendingDashboard();
  window.pendingTimer=setInterval(refreshPendingDashboard,10000);
}
function toggleNotifications(){notificationOpen=!notificationOpen;$("notificationPanel").classList.toggle("show",notificationOpen);$("notificationBtn").setAttribute("aria-expanded",notificationOpen?"true":"false")}
$("notificationBtn").addEventListener("click",e=>{e.stopPropagation();toggleNotifications()});
document.addEventListener("click",e=>{if(notificationOpen&&!e.target.closest(".notification-wrap")){notificationOpen=false;$("notificationPanel").classList.remove("show");$("notificationBtn").setAttribute("aria-expanded","false")}});

function renderRuleText(text){
  return esc(text).replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>");
}
async function loadInstructionRules(){
  try{
    const d=await api("/api/instruction-rules");
    const rules=Array.isArray(d.rules)?d.rules:[];
    const list=$("instructionRulesList");
    if(!list)return;
    list.innerHTML=rules.length?rules.map(r=>`<div class="rule-item"><span>•</span><p>${renderRuleText(r.content)}</p></div>`).join(""):"<div class='rule-item'><span>•</span><p>Nenhuma regra cadastrada.</p></div>";
    if($("rulesEditorText")) $("rulesEditorText").value=rules.map(r=>r.content).join("\n");
  }catch(e){
    const list=$("instructionRulesList");
    if(list)list.innerHTML=`<div class="rule-item"><span>•</span><p>Não foi possível carregar as regras.</p></div>`;
    console.warn("Regras de instrução:",e.message);
  }
  const rb=$("rulesEditBtn"), ub=$("uniformEditBtn");
  if(rb)rb.classList.toggle("show",isManager());
  if(ub)ub.classList.toggle("show",isManager());
}
function openRulesEditor(){
  if(!["coordenador","admin"].includes(String(me?.role||"").toLowerCase()))return;
  loadInstructionRules().finally(()=>{
    $("rulesEditorMsg").textContent="";
    $("rulesEditorModal").classList.add("show");
  });
}
function closeRulesEditor(){$("rulesEditorModal")?.classList.remove("show");}
async function saveInstructionRules(){
  const msg=$("rulesEditorMsg");
  const rules=String($("rulesEditorText")?.value||"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(!rules.length){msg.textContent="Informe pelo menos uma regra.";return;}
  try{
    msg.textContent="Salvando...";
    const d=await api("/api/instruction-rules",{method:"PUT",body:JSON.stringify({rules})});
    const returned=Array.isArray(d.rules)?d.rules:[];
    $("instructionRulesList").innerHTML=returned.map(r=>`<div class="rule-item"><span>•</span><p>${renderRuleText(r.content)}</p></div>`).join("");
    $("rulesEditorText").value=returned.map(r=>r.content).join("\n");
    msg.textContent="Regras salvas com sucesso.";
    setTimeout(closeRulesEditor,500);
  }catch(e){msg.textContent=e.message||"Não foi possível salvar as regras.";}
}

let materialsCache=[];
function escapeAttr(v){return esc(String(v??''));}
function renderMaterials(data){
  const box=$("supportMaterialsList"); if(!box)return; materialsCache=Array.isArray(data)?data:[];
  const order=['Manuais gerais','Link para provas dos alunos','Link manual por curso']; const groups={}; order.forEach(x=>groups[x]=[]); materialsCache.forEach(m=>(groups[m.section||'Manuais gerais']??=(groups[m.section||'Manuais gerais']||[])).push(m));
  let html='';
  if(groups['Manuais gerais'].length){html+=`<div class="materials-clean-section"><div class="materials-clean-title">📚 MANUAIS GERAIS</div>${groups['Manuais gerais'].map(m=>`<div class="materials-link-row"><div class="material-link-info"><b>${esc(m.title)}</b>${m.description?`<div style="margin-top:4px;color:#748a9d;font-size:9px">${esc(m.description)}</div>`:''}</div><a class="btn gray material-open-btn" href="${escapeAttr(m.url)}" target="_blank" rel="noopener noreferrer">🔗 Abrir</a></div>`).join('')}</div>`;}
  for(const section of ['Link para provas dos alunos','Link manual por curso']){const items=groups[section]||[];if(!items.length)continue;html+=`<div class="materials-clean-section"><div class="materials-clean-title">${section==='Link para provas dos alunos'?'📝':'📚'} ${esc(section)}</div>${items.sort((a,b)=>(a.material_order||0)-(b.material_order||0)).map(m=>`<div class="materials-course-group"><div class="materials-course-name">${esc(m.course||m.title)}</div><a class="btn gray material-open-btn" href="${escapeAttr(m.url)}" target="_blank" rel="noopener noreferrer">🔗 Abrir</a></div>`).join('')}</div>`;}
  box.innerHTML=html||`<div class="material-loading">Nenhum material cadastrado.</div>`; const mb=$("materialsEditBtn");if(mb)mb.classList.toggle('show',isManager());
}
async function loadInstructionMaterials(){try{const d=await api('/api/instruction-materials');renderMaterials(d.materials||[])}catch(e){const box=$("supportMaterialsList");if(box)box.innerHTML='<div class="material-loading">Não foi possível carregar os materiais.</div>';console.warn('Materiais:',e.message)}const mb=$("materialsEditBtn");if(mb)mb.classList.toggle('show',isManager())}
function materialRowHtml(m={}){const sections=['Manuais gerais','Link para provas dos alunos','Link manual por curso'];const courses=['','Abordagem','Acompanhamento','Modulação'];return `<div class="material-editor-row" data-id="${m.id||''}"><div class="field material-icon-field"><label>Ícone</label><input class="material-editor-icon" maxlength="4" value="${escapeAttr(m.icon||'🔗')}"></div><div class="field material-title-field"><label>Nome</label><input class="material-editor-title" maxlength="120" value="${escapeAttr(m.title||'')}" placeholder="Nome"></div><div class="field material-desc-field"><label>Descrição</label><input class="material-editor-desc" maxlength="240" value="${escapeAttr(m.description||'')}" placeholder="Opcional"></div><div class="field material-cat-field"><label>Categoria</label><select class="material-editor-category"><option>Manuais e Apostilas</option><option>Formulários</option><option>Links úteis</option><option>Outros</option></select></div><div class="field material-editor-section"><label>Seção</label><select class="material-editor-section-value">${sections.map(c=>`<option ${String(m.section||'Manuais gerais')===c?'selected':''}>${c}</option>`).join('')}</select></div><div class="field material-editor-course"><label>Curso</label><select class="material-editor-course-value">${courses.map(c=>`<option value="${escapeAttr(c)}" ${String(m.course||'')===c?'selected':''}>${c||'—'}</option>`).join('')}</select></div><div class="field material-url-field"><label>Link</label><input class="material-editor-url" type="url" value="${escapeAttr(m.url||'')}" placeholder="https://..."></div><button class="btn outline material-delete-btn" type="button" onclick="removeMaterialEditorRow(this)">🗑️</button></div>`}
function addMaterialEditorRow(m={}){$('materialsEditorRows')?.insertAdjacentHTML('beforeend',materialRowHtml(m))}
function removeMaterialEditorRow(btn){btn.closest('.material-editor-row')?.remove()}
function openMaterialsEditor(){if(!isManager())return;loadInstructionMaterials().finally(()=>{const rows=$("materialsEditorRows");if(!rows)return;rows.innerHTML='';materialsCache.forEach(m=>addMaterialEditorRow(m));addMaterialEditorRow();$("materialsEditorMsg").textContent='';$("materialsEditorModal").classList.add('show')})}
function closeMaterialsEditor(){$("materialsEditorModal")?.classList.remove('show')}
async function saveMaterialsEditor(){if(!isManager())return;const msg=$("materialsEditorMsg");const rows=[...document.querySelectorAll('#materialsEditorRows .material-editor-row')];try{msg.textContent='Salvando...';const kept=[];for(const row of rows){const id=Number(row.dataset.id||0);const title=row.querySelector('.material-editor-title').value.trim();const description=row.querySelector('.material-editor-desc').value.trim();const category=row.querySelector('.material-editor-category').value.trim();const section=row.querySelector('.material-editor-section-value').value.trim();const course=row.querySelector('.material-editor-course-value').value.trim();const url=row.querySelector('.material-editor-url').value.trim();const icon=row.querySelector('.material-editor-icon').value.trim()||'🔗';if(!title&&!url)continue;if(!title||!url)throw new Error('Preencha nome e link de todos os materiais.');const payload={title,description,category,url,icon,section,course};if(id){await api('/api/instruction-materials/'+id,{method:'PUT',body:JSON.stringify(payload)});kept.push(id)}else{const d=await api('/api/instruction-materials',{method:'POST',body:JSON.stringify(payload)});kept.push(Number(d.material.id))}}for(const m of materialsCache){if(!kept.includes(Number(m.id)))await api('/api/instruction-materials/'+m.id,{method:'DELETE'})}await loadInstructionMaterials();msg.textContent='Materiais salvos com sucesso.';setTimeout(closeMaterialsEditor,500)}catch(e){msg.textContent=e.message||'Não foi possível salvar os materiais.'}}

function showMaterialTab(tab,btn){const map={regras:"materialTabRegras",uniformes:"materialTabUniformes",apoio:"materialTabApoio"};document.querySelectorAll(".material-tab-panel").forEach(x=>x.classList.remove("active"));document.querySelectorAll(".materials-tab").forEach(x=>x.classList.remove("active"));const panel=$(map[tab]);if(panel)panel.classList.add("active");if(btn)btn.classList.add("active")}
async function copyUniform(id,btn){const text=$(id)?.textContent?.trim()||"";try{await navigator.clipboard.writeText(text);const old=btn.textContent;btn.textContent="✓ Copiado";setTimeout(()=>btn.textContent=old,1400)}catch{alert("Não foi possível copiar automaticamente. Selecione e copie o comando manualmente.")}}
let uniformImages={female:null,male:null};
function isManager(){return ["coordenador","admin"].includes(String(me?.role||"").toLowerCase())}
function setUniformImage(gender,data){const id=gender==='female'?'uniformFemale':'uniformMale';const wrap=$(id+'ImageWrap');const actions=$(id+'ImageActions');if(!wrap)return;uniformImages[gender]=data||null;if(data){wrap.innerHTML=`<img src="${data}" alt="Imagem do fardamento ${gender==='female'?'feminino':'masculino'}">`;actions.innerHTML=`<button class="btn gray" type="button" onclick="openUniformEditor('${gender}')">🖼️ Alterar imagem</button><button class="btn gray" type="button" onclick="removeUniformImage('${gender}')">🗑️ Remover</button>`;}else{wrap.innerHTML=`<div class="uniform-image-placeholder"><div>👕<b>Imagem do uniforme</b><span>Nenhuma imagem cadastrada.</span></div></div>`;actions.innerHTML=`<button class="btn gray" type="button" onclick="openUniformEditor('${gender}')">🖼️ Adicionar imagem</button>`;}}
function loadUniformData(){return api('/api/instruction-uniforms').then(d=>{const list=Array.isArray(d.uniforms)?d.uniforms:[];for(const u of list){const g=u.gender==='female'?'female':'male';const cmd=$(g==='female'?'uniformFemale':'uniformMale');if(cmd&&u.command)cmd.textContent=u.command;setUniformImage(g,u.image_data||null);}}).catch(e=>console.warn('Uniformes:',e.message))}
function openUniformEditor(focusGender){if(!isManager())return;loadUniformData().finally(()=>{const f=$("uniformFemale"),m=$("uniformMale");$("uniformFemaleEditor").value=f?.textContent?.trim()||'';$("uniformMaleEditor").value=m?.textContent?.trim()||'';$("uniformEditorMsg").textContent='';for(const g of ['female','male']){const prev=$(g==='female'?'uniformFemalePreview':'uniformMalePreview');prev.innerHTML=uniformImages[g]?`<img src="${uniformImages[g]}" alt="Pré-visualização">`:'<span>Nenhuma imagem selecionada.</span>';const file=$(g==='female'?'uniformFemaleFile':'uniformMaleFile');if(file)file.value='';}$("uniformEditorModal").classList.add('show');if(focusGender){setTimeout(()=>$(focusGender==='female'?'uniformFemaleFile':'uniformMaleFile')?.click(),120);}})}
function closeUniformEditor(){$("uniformEditorModal")?.classList.remove('show')}
function previewUniformFile(gender,input){const file=input.files?.[0];if(!file)return;if(!['image/jpeg','image/png','image/webp'].includes(file.type)){input.value='';return alert('Use uma imagem JPG, PNG ou WEBP.')}if(file.size>2*1024*1024){input.value='';return alert('A imagem deve ter no máximo 2 MB.')}const reader=new FileReader();reader.onload=()=>{const prev=$(gender==='female'?'uniformFemalePreview':'uniformMalePreview');prev.innerHTML=`<img src="${reader.result}" alt="Pré-visualização">`;input.dataset.imageData=reader.result;};reader.readAsDataURL(file)}
function removeUniformImage(gender){if(!isManager())return;if(confirm('Remover a imagem deste uniforme?')){uniformImages[gender]=null;setUniformImage(gender,null);saveUniformGender(gender,null,true)}}
async function saveUniformGender(gender,imageOverride){const cmd=$(gender==='female'?'uniformFemale':'uniformMale')?.textContent?.trim()||'';try{await api('/api/instruction-uniforms/'+gender,{method:'PUT',body:JSON.stringify({command:cmd,image_data:imageOverride})});}catch(e){console.warn(e.message)}}
async function saveUniforms(){const msg=$("uniformEditorMsg");if(!isManager())return;const payload=[['female','uniformFemaleEditor','uniformFemaleFile'],['male','uniformMaleEditor','uniformMaleFile']];try{msg.textContent='Salvando...';for(const [gender,editId,fileId] of payload){const command=$(editId).value.trim();if(!command)throw new Error(`Informe o comando do uniforme ${gender==='female'?'feminino':'masculino'}.`);const file=$(fileId);let imageData=uniformImages[gender]||null;if(file?.dataset?.imageData)imageData=file.dataset.imageData;await api('/api/instruction-uniforms/'+gender,{method:'PUT',body:JSON.stringify({command,image_data:imageData})});}msg.textContent='Uniformes salvos com sucesso.';await loadUniformData();setTimeout(closeUniformEditor,500);}catch(e){msg.textContent=e.message||'Não foi possível salvar os uniformes.'}}

function go(id,btn){
  const manager=["coordenador","admin"].includes(me?.role);
  const managerOnly=["relatorios","aprovacoes"];
  if(!manager && managerOnly.includes(id)){ go("marcacoes",document.querySelector(`.nav button[onclick*="go('marcacoes'"]`)); return; }
  document.querySelectorAll(".page").forEach(x=>x.classList.remove("active"));
  $(id).classList.add("active");
  document.querySelectorAll(".nav button").forEach(x=>x.classList.remove("active"));
  if(btn)btn.classList.add("active");
  $("title").textContent=titles[id][0];$("subtitle").textContent=titles[id][1];
  if(id==="aprovacoes")loadApprovals();
  if(id==="marcacoes")loadBookings();
  if(id==="instrutores")loadInstructors();
  if(id==="resultados")loadResults();
  if(id==="relatorios")loadReports();
  if(id==="materiais"){loadInstructionRules();loadUniformData();loadInstructionMaterials();}
  if(id==="disponibilidade")loadAvailability();
}
const availabilityDays={0:"Domingo",1:"Segunda-feira",2:"Terça-feira",3:"Quarta-feira",4:"Quinta-feira",5:"Sexta-feira",6:"Sábado"};
let availabilityCache=[];
function availabilityTime(v){return String(v||"").slice(0,5)}
function availabilityDayOrder(a,b){return (Number(a.weekday)-Number(b.weekday)+7)%7}
function availabilitySlotHtml(x, canDelete=true){
  const day=availabilityDays[Number(x.weekday)]||"Dia";
  return `<div class="availability-slot"><div class="availability-slot-day"><b>${day}</b><span>${availabilityTime(x.start_time)} – ${availabilityTime(x.end_time)}</span></div>${canDelete?`<button class="availability-delete" type="button" title="Remover horário" onclick="deleteAvailability(${Number(x.id)})">×</button>`:""}</div>`;
}
function renderMyAvailability(rows){
  const box=$("myAvailabilityList"); if(!box)return;
  const mine=rows.filter(x=>Number(x.instructor_id)===Number(me?.id)).sort((a,b)=>Number(a.weekday)-Number(b.weekday)||availabilityTime(a.start_time).localeCompare(availabilityTime(b.start_time)));
  box.innerHTML=mine.length?mine.map(x=>availabilitySlotHtml(x,true)).join(""):`<div class="availability-empty"><span>○</span><b>Nenhum horário cadastrado</b><small>Adicione seus horários semanais acima.</small></div>`;
}
function renderAvailabilityTeam(rows){
  const box=$("availabilityTeam"); if(!box)return;
  const grouped=new Map();
  rows.forEach(x=>{const id=Number(x.instructor_id);if(!Number.isFinite(id)||id<=0)return; if(!grouped.has(id))grouped.set(id,{id,name:x.instructor_name||"Instrutor",rank:x.instructor_rank||"Instrutor",slots:[]}); if(x.id)grouped.get(id).slots.push(x)});
  const people=[...grouped.values()].sort((a,b)=>String(a.name).localeCompare(String(b.name),"pt-BR"));
  $("availabilityInstructorCount").textContent=people.length+" "+(people.length===1?"instrutor":"instrutores");
  if(!people.length){box.innerHTML=`<div class="availability-empty team-empty"><span>◷</span><b>Nenhuma disponibilidade cadastrada</b><small>Os horários informados pelos instrutores aparecerão aqui.</small></div>`;return;}
  box.innerHTML=people.map(person=>{
    const slots=person.slots.sort((a,b)=>Number(a.weekday)-Number(b.weekday)||availabilityTime(a.start_time).localeCompare(availabilityTime(b.start_time)));
    const byDay=new Map();slots.forEach(x=>{if(!byDay.has(Number(x.weekday)))byDay.set(Number(x.weekday),[]);byDay.get(Number(x.weekday)).push(x)});
    return `<article class="availability-person"><div class="availability-person-head"><div class="availability-avatar">${esc(initials(person.name))}</div><div><b>${esc(person.name)}</b><small>${esc(person.rank)}</small></div><span class="availability-status">${slots.length} ${slots.length===1?"horário":"horários"}</span></div><div class="availability-week">${[1,2,3,4,5,6,0].map(day=>{const daySlots=byDay.get(day)||[];return `<div class="availability-day ${daySlots.length?"has-slots":""}"><strong>${availabilityDays[day].slice(0,3).toUpperCase()}</strong>${daySlots.length?daySlots.map(x=>`<span>${availabilityTime(x.start_time)}–${availabilityTime(x.end_time)}</span>`).join(""):`<em>—</em>`}</div>`}).join("")}</div></article>`;
  }).join("");
}
async function loadAvailability(){
  try{
    const rows=await api("/api/availability");
    availabilityCache=Array.isArray(rows)?rows:[];
    renderMyAvailability(availabilityCache);
    renderAvailabilityTeam(availabilityCache);
    const mine=availabilityCache.filter(x=>Number(x.instructor_id)===Number(me?.id));
    $("availabilityEditorSubtitle").textContent=me?.role==="instrutor"?"Seus horários recorrentes ficam visíveis para a coordenação.":"Selecione seus horários recorrentes. A equipe é exibida ao lado.";
  }catch(e){
    console.error("Disponibilidade:",e);
    if($("myAvailabilityList"))$("myAvailabilityList").innerHTML=`<div class="availability-empty"><b>Não foi possível carregar.</b><small>${esc(e.message||"Erro ao consultar disponibilidade.")}</small></div>`;
    if($("availabilityTeam"))$("availabilityTeam").innerHTML=`<div class="availability-empty"><b>Não foi possível carregar a equipe.</b></div>`;
  }
}
async function saveAvailability(){
  const weekday=Number($("availabilityDay").value); const start=$("availabilityStart").value; const end=$("availabilityEnd").value;
  if(!start||!end)return alert("Informe o horário inicial e final.");
  if(start>=end)return alert("O horário final deve ser maior que o horário inicial.");
  try{await api("/api/availability",{method:"POST",body:JSON.stringify({weekday,start_time:start,end_time:end,instructor_id:Number(me?.id)})});await loadAvailability();alert("Horário de disponibilidade adicionado.");}
  catch(e){alert(e.message)}
}
async function deleteAvailability(id){
  if(!confirm("Remover este horário de disponibilidade?"))return;
  try{await api("/api/availability/"+Number(id),{method:"DELETE"});await loadAvailability();}
  catch(e){alert(e.message)}
}

function reportDateDaysAgo(days){const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()-days);return d}
function reportDateKey(value){
  const s=String(value||"").slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d=new Date(s+"T00:00:00");
  return Number.isNaN(d.getTime())?null:d;
}
async function loadReports(){
  try{
    const [bookings,results,users]=await Promise.all([api("/api/bookings"),api("/api/course-results"),api("/api/users")]);
    rankingBookings=Array.isArray(bookings)?bookings:[];
    rankingUsers=Array.isArray(users)?users:[];
    renderInstructorRanking();

    const now=new Date();
    const cutoff=reportDateDaysAgo(30);
    now.setHours(23,59,59,999);

    // Relatórios consideram a data em que o curso aconteceu.
    // Cursos futuros não entram nos indicadores dos últimos 30 dias.
    const recent=(Array.isArray(bookings)?bookings:[]).filter(b=>{
      const d=reportDateKey(b.date);
      return d && d>=cutoff && d<=now;
    });

    // Uma marcação CONFIRMADA/APROVADA ainda não é um curso concluído.
    // O backend muda para COMPLETED quando o resultado é lançado.
    const done=recent.filter(b=>String(b.status||"").toLowerCase()==="completed").length;
    const cancelled=recent.filter(b=>String(b.status||"").toLowerCase()==="cancelled").length;
    const total=recent.length;

    // Para a taxa, só entram cursos que já deveriam ter acontecido.
    // Cancelamentos ficam fora do denominador.
    const eligible=recent.filter(b=>String(b.status||"").toLowerCase()!=="cancelled").length;
    const completion=eligible?Math.round((done/eligible)*100):0;

    // A média considera somente resultados de cursos dentro do mesmo período.
    const allResults=Array.isArray(results)?results:[];
    const recentResults=allResults.filter(r=>{
      const d=reportDateKey(r.date);
      return d && d>=cutoff && d<=now;
    });
    const scores=[];
    recentResults.forEach(r=>(Array.isArray(r.participants)?r.participants:[]).forEach(p=>{
      const n=Number(String(p.score??"").replace(",","."));
      if(Number.isFinite(n))scores.push(n);
    }));
    const avg=scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null;

    // Usa a data/hora real da aprovação do cadastro.
    // Antes o relatório contava TODOS os usuários atualmente aprovados.
    const approvedCount=(Array.isArray(users)?users:[]).filter(u=>{
      if(String(u.status||"").toLowerCase()!=="approved") return false;
      if(!u.approved_at) return false;
      const approvedAt=new Date(u.approved_at);
      return !Number.isNaN(approvedAt.getTime()) && approvedAt>=cutoff && approvedAt<=now;
    }).length;

    $("reportBookings").textContent=total;
    $("reportDone").textContent=done;
    $("reportCancelled").textContent=cancelled;
    $("reportApprovedUsers").textContent=approvedCount;
    $("reportCompletion").textContent=completion+"%";
    $("reportCompletionSub").textContent=done+" concluídas de "+eligible+" previstas";
    $("reportAverage").textContent=avg===null?"—":avg.toLocaleString("pt-BR",{minimumFractionDigits:1,maximumFractionDigits:1});
    $("reportAverageSub").textContent=scores.length+" avaliações registradas";
    $("reportBookingsBar").style.width=Math.min(100,total?Math.max(8,total*4):0)+"%";
    $("reportCompletionBar").style.width=completion+"%";
    $("reportAverageBar").style.width=(avg===null?0:Math.min(100,avg*10))+"%";
    const p=me||{};
    if($("reportsUserName"))$("reportsUserName").textContent=p.name||"Usuário";
    if($("reportsAvatar"))renderAvatarElement($("reportsAvatar"),p.avatar_data,p.name);
  }catch(e){console.warn("Relatórios:",e.message)}
}
function exportReports(){
  const rows=[['Indicador','Valor'],['Marcações últimos 30 dias',$('reportBookings').textContent],['Marcações concluídas',$('reportDone').textContent],['Marcações canceladas',$('reportCancelled').textContent],['Solicitações aprovadas',$('reportApprovedUsers').textContent],['Taxa de conclusão',$('reportCompletion').textContent],['Avaliação média',$('reportAverage').textContent]];
  const csv=rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(';')).join('\n');
  const blob=new Blob(['\\ufeff'+csv],{type:'text/csv;charset=utf-8;'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='relatorio-instrutores.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);
}

async function loadAll(){
  try{
    const d=await api("/api/dashboard");
    const k=d?.kpis||{};
    $("kActive").textContent=Number(k.active)||0;
    $("kPendingAll").textContent=(Number(k.pending)||0)+(Number(k.pendingBookings)||0);
    $("kWeek").textContent=Number(k.week)||0;
    const completedTotal=Number(k.completedMonth)||0;
    $("kCompleted").textContent=completedTotal;
    $("activeBreakdown").innerHTML=`<i></i>${Number(k.active)||0} membros ativos`;
    $("weekBreakdown").textContent=`${Number(k.bookingsToday)||0} aprovadas hoje`;
    $("completedBreakdown").textContent=`${completedTotal} cursos realizados`;

    // The dashboard calendar must use ALL bookings, not the dashboard KPI
    // "next" list (which is intentionally limited to 8 records).
    // This guarantees that an approved course appears in the correct day/week,
    // even when it is later in the schedule.
    let allBookings=[];
    try{
      const bookingResponse=await api("/api/bookings");
      allBookings=Array.isArray(bookingResponse)?bookingResponse:[];
    }catch(err){
      console.error("Falha ao carregar todas as marcações:",err);
    }

    // If the full endpoint fails for any reason, use the dashboard's
    // server-side "next" list. It now includes approved bookings too.
    const bookingSource=allBookings.length ? allBookings : (Array.isArray(d?.next)?d.next:[]);
    const todayLocal=localDateKey(new Date());

    const upcoming=bookingSource
      .filter(x=>["approved","confirmed","completed"].includes(String(x.status||"").toLowerCase()))
      .filter(x=>String(x.date||"").slice(0,10) >= todayLocal)
      .sort((a,b)=>{
        const da=String(a.date||"").slice(0,10)+" "+String(a.start_time||"");
        const db=String(b.date||"").slice(0,10)+" "+String(b.start_time||"");
        return da.localeCompare(db);
      })
      .slice(0,4);

        $("nextList").innerHTML=upcoming
      .map(x=>{
        const ds=String(x.date||"").slice(0,10);
        const parts=ds.split("-");
        const day=parts[2]||"--";
        const monthNames={"01":"JAN","02":"FEV","03":"MAR","04":"ABR","05":"MAI","06":"JUN","07":"JUL","08":"AGO","09":"SET","10":"OUT","11":"NOV","12":"DEZ"};
        const mon=monthNames[parts[1]]||parts[1]||"";
        const place=x.room||x.location||x.place||x.sala||"";
        return `<div class="next-booking">
          <div class="next-date"><strong>${esc(day)}</strong><span>${esc(mon)}</span></div>
          <div class="next-info">
            <b>${esc(x.course||"Curso")}</b>
            <span class="next-instructor">Instrutor: ${esc(x.instructor_name||"Não informado")}</span>
            <span class="next-meta">
              <span class="next-meta-item"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>${esc(x.start_time||"--:--")} – ${esc(x.end_time||"--:--")}</span>
              ${place ? `<span class="next-meta-item"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-5.2 7-11a7 7 0 1 0-14 0c0 5.8 7 11 7 11Z"></path><circle cx="12" cy="10" r="2.2"></circle></svg>${esc(place)}</span>` : ""}
            </span>
          </div>
          <span class="status ${statusClass(x.status)}">${String(x.status||"").toLowerCase()==="confirmed"?"CONFIRMADA":statusLabel(x.status)}</span>
        </div>`;
      })
      .join("")||"<p class='muted'>Sem marcações.</p>";

    window.__calendarBookings=bookingSource;
    drawCalendar(window.__calendarBookings);
    $("summaryActive").textContent=Number(k.active)||0;
    $("summaryMonth").textContent=Number(k.monthBookings)||0;
    $("summaryCompleted").textContent=completedTotal;
    if($("summaryCourses")) $("summaryCourses").textContent=Number(k.courses)||0;

    // These are secondary panels; a failure here must never break the calendar.
    try{ await loadInstructors(); }catch(e){ console.error("Falha ao carregar equipe:",e); }
    try{ await loadBookings(); }catch(e){ console.error("Falha ao carregar marcações:",e); }

    if(["coordenador","admin"].includes(me?.role)){
      try{
        const [users,bookings]=await Promise.all([api("/api/pending-users"),api("/api/pending-bookings")]);
        renderApprovalDashboard(users,bookings);
      }catch(e){ console.error("Falha ao carregar aprovações:",e); }
    }else if($("dashboardApprovals")){
      $("dashboardApprovals").style.display="none";
    }
  }catch(e){
    console.error("Falha ao carregar dashboard:",e);
    // Keep the UI usable even if a non-critical dashboard request fails.
    if($("nextList")) $("nextList").innerHTML="<p class='muted'>Não foi possível carregar as marcações.</p>";
    if($("calendar")) drawCalendar(window.__calendarBookings||[]);
  }
}
function localDateKey(d){
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,"0");
  const day=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

let calendarWeekOffset = 0;

function startOfWeek(d){
  const x=new Date(d);
  x.setHours(12,0,0,0);
  const day=x.getDay();
  const diff=day===0 ? -6 : 1-day;
  x.setDate(x.getDate()+diff);
  return x;
}

function formatWeekRange(monday){
  const sunday=new Date(monday);
  sunday.setDate(sunday.getDate()+6);
  const opts={day:"2-digit",month:"2-digit"};
  return `${monday.toLocaleDateString("pt-BR",opts)} – ${sunday.toLocaleDateString("pt-BR",opts)}`;
}

function drawCalendar(items){
  const c=$("calendar");
  if(!c) return;

  const visible=(items||[]).filter(b=>{
    const st=String(b.status||"").toLowerCase();
    return ["approved","confirmed","completed"].includes(st);
  });

  const base=startOfWeek(new Date());
  base.setDate(base.getDate()+(calendarWeekOffset*7));

  const rangeEl=$("cpiWeekRange");
  const rangeText=formatWeekRange(base).replace(" – "," a ");
  if(rangeEl) rangeEl.textContent=rangeText;

  // Dashboard calendar is intentionally compact: one column per day and
  // only the actual courses. There is no artificial 00:00–23:00 grid.
  let h="";

  for(let i=0;i<7;i++){
    const d=new Date(base);
    d.setDate(base.getDate()+i);
    const ds=localDateKey(d);
    const dayName=d.toLocaleDateString("pt-BR",{weekday:"short"}).replace(".","").toUpperCase();
    const dayDate=d.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"});

    const matches=visible
      .filter(b=>String(b.date).slice(0,10)===ds)
      .sort((a,b)=>String(a.start_time||"").localeCompare(String(b.start_time||"")));

    h+=`<div class="day-column">`;
    h+=`<div class="day-head"><b>${dayName}</b><span>${dayDate}</span></div>`;
    h+=`<div class="day-events">`;

    if(!matches.length){
      h+=`<div class="empty-day">Sem eventos<br>agendados</div>`;
    }else{
      matches.forEach((x,idx)=>{
        const colors=["","g","p","o"];
        const cls=colors[(i+idx)%colors.length];
        const time=esc(String(x.start_time||"").slice(0,5));
        const course=esc(x.course||"Curso");
        const instructor=esc(x.instructor_name||"Instrutor");
        const room=x.room ? ` • ${esc(x.room)}` : "";
        h+=`<div class="event ${cls}">
          <div class="event-main">
            <span class="event-time">${time}</span>
            <span class="event-course">${course}</span>
          </div>
          <span class="event-detail">${instructor}${room}</span>
        </div>`;
      });
    }

    h+=`</div></div>`;
  }

  c.innerHTML=h;
}

function changeCalendarWeek(delta){
  calendarWeekOffset += delta;
  drawCalendar(window.__calendarBookings || []);
}

function goCalendarToday(){
  calendarWeekOffset=0;
  drawCalendar(window.__calendarBookings || []);
}

document.addEventListener("DOMContentLoaded",()=>{
  const prev=$("weekPrev"), next=$("weekNext"), compactToday=$("weekTodayCompact");
  if(prev) prev.onclick=()=>changeCalendarWeek(-1);
  if(next) next.onclick=()=>changeCalendarWeek(1);
  if(compactToday) compactToday.onclick=goCalendarToday;
});

async function loadBookings(){
  const d=await api("/api/bookings");
  const manager=["coordenador","admin"].includes(String(me?.role||"").toLowerCase());
  $("bookings").innerHTML=d.map(x=>{
    const status=String(x.status||"").toLowerCase();
    let actions="—";
    if(manager){
      // Depois de aprovada, a marcação não pode mais ser aprovada/recusada novamente.
      // Fica somente a opção de exclusão para Coordenador e Administrador.
      if(status==="confirmed" || status==="completed"){
        actions=`<button class="btn danger" onclick="deleteBooking(${x.id})">Excluir</button>`;
      }else if(status==="pending"){
        actions=`<button class="btn gray" onclick="setStatus(${x.id},'confirmed')">Aprovar</button> <button class="btn red" onclick="setStatus(${x.id},'cancelled')">Recusar</button> <button class="btn danger" onclick="deleteBooking(${x.id})">Excluir</button>`;
      }else{
        actions=`<button class="btn danger" onclick="deleteBooking(${x.id})">Excluir</button>`;
      }
    }
    return `<tr><td>${x.date}</td><td>${x.start_time} - ${x.end_time}</td><td>${esc(x.instructor_name)}</td><td><span class="status ${statusClass(x.status)}">${statusLabel(x.status)}</span></td><td>${actions}</td></tr>`;
  }).join("")||"<tr><td colspan='6'>Sem marcações.</td></tr>";
}
async function loadInstructors(){
  const manager=["coordenador","admin"].includes(me.role);
  const d=await api(manager?"/api/users":"/api/instructors");
  instructorRows=Array.isArray(d)?d:[];
  const total=instructorRows.length;
  const active=instructorRows.filter(x=>x.status==="approved").length;
  const attention=instructorRows.filter(x=>x.status==="approved" && instructorNeedsAttention(x)).length;
  const inactive=instructorRows.filter(x=>x.status!=="approved").length;
  $("instTotal").textContent=total; $("instActive").textContent=active; $("instAttention").textContent=attention; $("instInactive").textContent=inactive;
  renderInstructors();
}
function instructorNeedsAttention(x){
  if(x.status!=="approved") return false;
  const base=x.last_course_date ? new Date(String(x.last_course_date)+"T23:59:59") : (x.approved_at ? new Date(x.approved_at) : null);
  if(!base || Number.isNaN(base.getTime())) return false;
  return ((Date.now()-base.getTime())/(1000*60*60*24)) >= 14;
}
function daysSinceLastCourse(x){
  const base=x.last_course_date ? new Date(String(x.last_course_date)+"T23:59:59") : (x.approved_at ? new Date(x.approved_at) : null);
  if(!base || Number.isNaN(base.getTime())) return null;
  return Math.max(0,Math.floor((Date.now()-base.getTime())/(1000*60*60*24)));
}
function fmtCourseDate(v){
  if(!v) return "Nunca";
  const d=new Date(String(v)+"T12:00:00");
  if(Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit",year:"2-digit"});
}
function instructorSituation(x){
  if(x.status!=="approved") return {key:"inactive",label:"INATIVO"};
  if(instructorNeedsAttention(x)) return {key:"attention",label:"ATENÇÃO"};
  return {key:"active",label:"ATIVO"};
}
function setInstructorFilter(filter,btn){
  instructorFilter=filter;
  document.querySelectorAll(".instructor-kpi").forEach(x=>x.classList.remove("active"));
  if(btn)btn.classList.add("active");
  renderInstructors();
}
function renderInstructors(){
  const search=String($("instructorSearch")?.value||"").trim().toLowerCase();
  let rows=instructorRows.filter(x=>{
    const s=instructorSituation(x).key;
    const matchFilter=instructorFilter==="all" || (instructorFilter==="active"&&s==="active") || (instructorFilter==="attention"&&s==="attention") || (instructorFilter==="inactive"&&s==="inactive");
    const hay=`${x.name||""} ${x.username||""} ${x.rank||""} ${x.role||""} ${x.city_id||""} ${x.city_phone||""}`.toLowerCase();
    return matchFilter && (!search || hay.includes(search));
  });
  const labels={all:"Todos os instrutores",active:"Instrutores ativos",attention:"Sem atuação há 14+ dias",inactive:"Instrutores inativos"};
  $("instructorFilterLabel").textContent=labels[instructorFilter]||labels.all;
  $("userCount").textContent=rows.length+" usuários";
  if(!rows.length){$("instructors").innerHTML=`<tr><td colspan="9"><div class="instructor-empty">Nenhum instrutor encontrado para este filtro.</div></td></tr>`;return;}
  const manager=["coordenador","admin"].includes(me.role);
  $("instructors").innerHTML=rows.map(x=>{
    const sit=instructorSituation(x); const days=daysSinceLastCourse(x);
    const avatar=x.avatar_data?`<img src="${escAttr(x.avatar_data)}" alt="">`:esc(initials(x.name||"?"));
    const role=x.role==="admin"?"Administrador":x.role==="coordenador"?"Coordenador":"Instrutor";
    const lastText=x.last_course_date?fmtCourseDate(x.last_course_date):"Nunca aplicou";
    const lastSub=x.last_course_date?(days===0?"Hoje":days===1?"Há 1 dia":`Há ${days} dias`):(x.approved_at?"Aguardando primeira atuação":"Sem registro");
    const attention=sit.key==="attention"?`<div class="attention-note">${days===14?"14 dias sem curso":`Há ${days} dias sem curso`}</div>`:"";
    const avail=Number(x.availability_count||0)>0?`<span class="availability-mini">● Configurada</span>`:`<span class="availability-mini none">○ Não configurada</span>`;
    const cityId=x.city_id?esc(x.city_id):"—";
    const cityPhone=x.city_phone?esc(formatCityPhone(x.city_phone)):"—";
    const actions=manager?`<div class="instructor-actions">${x.role==="admin"?`<span class="badge coord">Administrador</span>`:`<select class="role-select" onchange="changeRole(${x.id},this.value)" ${x.id===me.id?"disabled":""}><option value="instrutor" ${x.role==="instrutor"?"selected":""}>Instrutor</option><option value="coordenador" ${x.role==="coordenador"?"selected":""}>Coordenador</option></select>`}<button class="btn gray" onclick="editUser(${x.id})">Editar</button><button class="btn gray" onclick="resetPassword(${x.id},'${escAttr(x.name)}')">Senha</button>${x.id!==me.id?`<button class="btn ${x.status==="approved"?"red":"green"}" onclick="toggleUserStatus(${x.id},'${x.status==="approved"?"rejected":"approved"}')">${x.status==="approved"?"Desativar":"Ativar"}</button>${x.role!=="admin"?`<button class="btn danger" onclick="deleteUser(${x.id},'${escAttr(x.name)}')">Excluir</button>`:""}`:""}</div>`:"—";
    return `<tr class="${sit.key==='inactive'?'inactive-row':''}"><td><div class="instructor-main"><span class="instructor-avatar">${avatar}</span><span class="instructor-name"><b>${esc(x.name)}</b><span>@${esc(x.username)} · ${role}</span></span></div></td><td>${esc(x.rank||"—")}</td><td><span class="city-id-cell">${cityId}</span></td><td><span class="city-phone-cell">${cityPhone}</span></td><td><span class="course-count">${Number(x.completed||0)} <small>realizados</small></span></td><td><div class="activity-cell"><b>${lastText}</b><small>${lastSub}</small>${attention}</div></td><td>${avail}</td><td><span class="situation ${sit.key}"><i class="situation-dot"></i>${sit.label}</span></td><td>${actions}</td></tr>`;
  }).join("");
}


function statusLabel(status){
  return ({
    confirmed:"APROVADA",
    approved:"APROVADO",
    pending:"PENDENTE",
    cancelled:"RECUSADA",
    rejected:"RECUSADO",
    completed:"REALIZADA"
  })[String(status||"").toLowerCase()] || String(status||"").toUpperCase();
}
function statusClass(status){
  const s=String(status||"").toLowerCase();
  if(s==="confirmed"||s==="approved"||s==="completed") return "ok";
  if(s==="pending") return "pending";
  if(s==="cancelled"||s==="rejected") return "cancel";
  return "pending";
}

function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function escAttr(v){return String(v??"").replace(/'/g,"&#39;").replace(/"/g,"&quot;")}
function openUserModal(){
  if(!["coordenador","admin"].includes(me.role)) return alert("Apenas administradores e coordenadores podem gerenciar usuários.");
  $("uName").value="";$("uUsername").value="";$("uPassword").value="";$("uDiscord").value="";$("uRole").value="instrutor";$("uRank").value="Sd.";$("userMsg").classList.add("hidden");
  $("userModal").classList.add("show");
}
function closeUserModal(){$("userModal").classList.remove("show")}
async function createAdminUser(){
  try{
    const d=await api("/api/admin/users",{method:"POST",body:JSON.stringify({
      name:$("uName").value,username:$("uUsername").value,password:$("uPassword").value,
      role:$("uRole").value,rank:$("uRank").value,discord:$("uDiscord").value
    })});
    $("userMsg").textContent=`@${d.user.username} criado e liberado.`;
    $("userMsg").classList.remove("hidden");
    await loadInstructors(); await loadAll();
    setTimeout(closeUserModal,700);
  }catch(e){$("userMsg").textContent=e.message;$("userMsg").classList.remove("hidden")}
}
async function changeRole(id,role){
  if(!confirm(`Alterar o cargo para ${role==="coordenador"?"Coordenador":"Instrutor"}?`)) {await loadInstructors();return}
  try{await api("/api/admin/users/"+id+"/role",{method:"PATCH",body:JSON.stringify({role})});await loadInstructors();await loadAll()}
  catch(e){alert(e.message);await loadInstructors()}
}
async function editUser(id){
  if(!["coordenador","admin"].includes(me.role)) return alert("Apenas administradores e coordenadores podem gerenciar usuários.");
  const x=instructorRows.find(u=>Number(u.id)===Number(id));
  if(!x) return alert("Usuário não encontrado na lista.");
  adminEditingUserId=Number(id);
  bindAdminUserPhoneMask();
  $("adminUserEditTitle").textContent=`Editar ${x.role==="admin"?"administrador":"instrutor"}`;
  $("adminUserEditSubtitle").textContent=`@${x.username||"—"} · dados completos da conta`;
  $("adminUserName").textContent=x.name||"—";
  $("adminUserRole").textContent=x.role==="admin"?"Administrador":x.role==="coordenador"?"Coordenador":"Instrutor";
  $("adminUserAvatar").innerHTML=x.avatar_data?`<img src="${escAttr(x.avatar_data)}" alt="">`:esc(initials(x.name||"?"));
  const sit=instructorSituation(x);
  $("adminUserStatus").className=`situation ${sit.key}`;
  $("adminUserStatus").innerHTML=`<i class="situation-dot"></i>${sit.label}`;
  $("adminUserCompleted").textContent=Number(x.completed||0);
  $("adminUserBookings").textContent=Number(x.bookings||0);
  $("adminUserAvailability").textContent=Number(x.availability_count||0);
  $("euName").value=x.name||""; $("euUsername").value=x.username||""; $("euCityId").value=x.city_id||"";
  $("euCityPhone").value=formatCityPhone(x.city_phone||""); $("euRank").value=x.rank||"Sd."; $("euRole").value=x.role==="coordenador"?"coordenador":"instrutor"; $("euRole").disabled=x.role==="admin" || x.id===me.id; $("euDiscord").value=x.discord||"";
  $("euEmail").textContent=x.email||"Não informado";
  $("euCreatedAt").textContent=formatDateTime(x.created_at);
  $("euApprovedAt").textContent=formatDateTime(x.approved_at);
  $("euLastCourse").textContent=x.last_course_date?fmtCourseDate(x.last_course_date):"Nunca aplicou";
  $("adminUserMsg").classList.add("hidden");
  $("adminUserEditModal").classList.add("show");
}
function closeAdminUserModal(){adminEditingUserId=null;$("adminUserEditModal").classList.remove("show")}
async function saveAdminUserProfile(){
  if(!adminEditingUserId)return;
  try{
    const cityId=$("euCityId").value.replace(/\D/g,"");
    const cityPhone=$("euCityPhone").value.replace(/\D/g,"");
    if(!/^\d+$/.test(cityId))throw Error("Informe um ID na cidade válido.");
    if(!/^\d{6}$/.test(cityPhone))throw Error("Informe o telefone da cidade no formato 000-000.");
    const body={name:$("euName").value.trim(),username:$("euUsername").value.trim(),rank:$("euRank").value,discord:$("euDiscord").value.trim(),city_id:cityId,city_phone:cityPhone};
    if(!$("euRole").disabled)body.role=$("euRole").value;
    await api("/api/admin/users/"+adminEditingUserId+"/profile",{method:"PATCH",body:JSON.stringify(body)});
    await loadInstructors(); await loadAll();
    closeAdminUserModal();
  }catch(e){$("adminUserMsg").textContent=e.message;$("adminUserMsg").classList.remove("hidden")}
}
function formatDateTime(v){if(!v)return"—";const d=new Date(v);if(Number.isNaN(d.getTime()))return"—";return d.toLocaleString("pt-BR",{dateStyle:"short",timeStyle:"short"})}


async function toggleUserStatus(id,status){
  const label=status==="approved"?"ativar":"bloquear";
  if(!confirm(`Deseja ${label} este usuário?`))return;
  try{await api("/api/admin/users/"+id+"/status",{method:"PATCH",body:JSON.stringify({status})});await loadInstructors();await loadAll()}
  catch(e){alert(e.message)}
}
async function deleteUser(id,name){
  if(id===me.id)return alert("Você não pode excluir seu próprio acesso.");
  const ok=confirm(`Excluir definitivamente o usuário "${name}"?\n\nEsta ação remove a conta e os registros diretamente vinculados a ela. Não poderá ser desfeita.`);
  if(!ok)return;
  try{
    await api("/api/admin/users/"+id,{method:"DELETE"});
    await loadInstructors();
    await loadAll();
    alert("Usuário excluído com sucesso.");
  }catch(e){alert(e.message)}
}

async function resetPassword(id,name){
  const password=prompt(`Nova senha para ${name} (mínimo 6 caracteres):`);
  if(password===null)return;
  if(password.length<6)return alert("A senha precisa ter pelo menos 6 caracteres.");
  try{await api("/api/admin/users/"+id+"/password",{method:"PATCH",body:JSON.stringify({password})});alert("Senha alterada com sucesso.")}
  catch(e){alert(e.message)}
}
function renderApprovalsPage(users,bookings){
  const pendingUsers=Array.isArray(users)?users:[];
  const pendingBookings=Array.isArray(bookings)?bookings:[];
  const total=pendingUsers.length+pendingBookings.length;
  if($("approvalTotal")) $("approvalTotal").textContent=total;
  if($("approvalUsersTotal")) $("approvalUsersTotal").textContent=pendingUsers.length;
  if($("approvalBookingsTotal")) $("approvalBookingsTotal").textContent=pendingBookings.length;
  if($("approvalDistribution")) $("approvalDistribution").textContent=`${pendingUsers.length} / ${pendingBookings.length}`;
  if($("pc")) $("pc").textContent=pendingUsers.length+" pendentes";
  if($("bc")) $("bc").textContent=pendingBookings.length+" pendentes";

  const userHtml=pendingUsers.map(x=>`<article class="approval-modern approval-user">
    <div class="approval-modern-icon user-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3"></circle><path d="M5 20c.8-3.3 3.1-5 7-5s6.2 1.7 7 5"></path></svg></div>
    <div class="approval-modern-body">
      <div class="approval-modern-title"><div><strong>${esc(x.name)}</strong><span>Novo instrutor</span></div><span class="approval-status pending-status">PENDENTE</span></div>
      <div class="approval-modern-meta"><span>@${esc(x.username)}</span><span>Discord: ${esc(x.discord||"—")}</span></div>
    </div>
    <div class="approval-modern-actions user-actions-modern">
      <select class="role-select" id="rank-${x.id}" aria-label="Patente de ${esc(x.name)}"><option>Sd.</option><option>Cb.</option><option>3º Sgt.</option><option>2º Sgt.</option><option>1º Sgt.</option><option>STen.</option><option>Ten.</option><option>Outro</option></select>
      <button class="btn green" onclick="approve(${x.id})">✓ Aprovar</button>
      <button class="btn red" onclick="reject(${x.id})">✕ Recusar</button>
    </div>
  </article>`).join("");
  $("approvalList").innerHTML=userHtml||`<div class="approval-empty-modern"><div class="empty-icon">✓</div><strong>Nenhum cadastro pendente</strong><span>Não há novos instrutores aguardando aprovação.</span></div>`;

  const bookingHtml=pendingBookings.map(x=>`<article class="approval-modern approval-booking">
    <div class="approval-modern-icon course-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M16 2v4M8 2v4M3 10h18M12 13v5M9.5 15.5h5"></path></svg></div>
    <div class="approval-modern-body">
      <div class="approval-modern-title"><div><strong>${esc(x.course||"Curso não informado")}</strong><span>Instrutor: ${esc(`${x.instructor_rank||""} ${x.instructor_name||""}`).trim()}</span></div><span class="approval-status pending-status">PENDENTE</span></div>
      <div class="approval-booking-meta"><span>◷ ${esc(x.date||"—")}</span><span>${esc(x.start_time||"—")} - ${esc(x.end_time||"—")}</span><span>⌖ ${esc(x.room||x.sala||"Sala não informada")}</span><span>${esc(x.notes||"Sem observação")}</span></div>
      <div class="approval-modern-meta"><span>Solicitado por: ${esc(x.requester_name||x.created_by_name||"Administrador")}</span><span>@${esc(x.instructor_username||"—")}</span></div>
    </div>
    <div class="approval-modern-actions booking-actions-modern">
      <button class="btn green" onclick="setStatus(${x.id},'confirmed');loadApprovals()">✓ Aprovar curso</button>
      <button class="btn red" onclick="setStatus(${x.id},'cancelled');loadApprovals()">✕ Recusar</button>
    </div>
  </article>`).join("");
  $("bookingApprovalList").innerHTML=bookingHtml||`<div class="approval-empty-modern"><div class="empty-icon">✓</div><strong>Nenhuma marcação pendente</strong><span>Não há cursos aguardando aprovação.</span></div>`;
}

async function loadApprovals(){
  if(!["coordenador","admin"].includes(me.role))return;
  const [users,bookings]=await Promise.all([api("/api/pending-users"),api("/api/pending-bookings")]);
  $("pc").textContent=users.length+" pendentes";
  $("bc").textContent=bookings.length+" pendentes";
  renderApprovalsPage(users,bookings);
  renderApprovalDashboard(users,bookings);
}
async function approve(id){const rank=$("rank-"+id).value;await api("/api/users/"+id+"/approve",{method:"POST",body:JSON.stringify({rank})});await loadApprovals();await loadAll()}
async function reject(id){if(!confirm("Recusar este cadastro?"))return;await api("/api/users/"+id+"/reject",{method:"POST"});await loadApprovals();await loadAll()}


let courseResultsCache=[];
let editingResultBookingId=null;

async function loadResults(){
  try{
    const data=await api("/api/course-results");
    courseResultsCache=Array.isArray(data)?data:[];
    const grid=$("resultsGrid"); if(!grid)return;
    const completed=courseResultsCache.filter(x=>!!x.result_id);
    const allParticipants=completed.flatMap(x=>Array.isArray(x.participants)?x.participants:[]);
    const scores=allParticipants.map(p=>Number(p.score)).filter(Number.isFinite);
    const approvedTotal=scores.filter(v=>v>=6).length;
    const average=scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null;
    $("resultsCoursesTotal").textContent=completed.length;
    $("resultsParticipantsTotal").textContent=scores.length;
    $("resultsAverage").textContent=average===null?"—":average.toFixed(1).replace(".",",");
    $("resultsApprovalRate").textContent=scores.length?Math.round((approvedTotal/scores.length)*100)+"%":"—";
    const recent=courseResultsCache.slice(0,10);
    grid.innerHTML=recent.map(x=>{
      const participants=Array.isArray(x.participants)?x.participants:[];
      const scores=participants.map(p=>Number(p.score)).filter(Number.isFinite);
      const approved=participants.filter(p=>p.result==="approved").length;
      const reproved=participants.filter(p=>p.result==="reproved").length;
      const done=!!x.result_id;
      const avg=scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null;
      return `<div class="result-card">
        <div class="result-card-head"><div><h3>${esc(x.course||"Curso")}</h3><div class="result-meta"><span>👨‍🏫 ${esc(x.instructor_name||"—")}</span><span>📅 ${formatDateFull(x.date)}</span><span>⏰ ${x.start_time}-${x.end_time}</span></div></div><span class="result-state ${done?"done":"wait"}">${done?"RESULTADO LANÇADO":"AGUARDANDO RESULTADO"}</span></div>
        <div class="result-summary">${done?`<div class="result-summary-main"><span class="result-average">${avg!==null?avg.toFixed(1).replace(".",","):"—"}</span><span class="result-average-label">média de pontuação</span><span>·</span><b>${participants.length}</b> participantes · <span style="color:#31e0a1">${approved} aprovados</span> · <span style="color:#ff7180">${reproved} reprovados</span></div>`:"Curso realizado/aprovado aguardando lançamento das notas."}</div>
        <div class="result-actions"><button class="btn ${done?"gray":""}" onclick="openResultModal(${x.id})">${done?"Ver / editar resultado":"Lançar resultado"}</button></div>
      </div>`;
    }).join("") || `<div class="result-empty" style="grid-column:1/-1">Nenhum curso realizado encontrado.</div>`;
  }catch(e){
    console.error(e);
    if($("resultsGrid")) $("resultsGrid").innerHTML=`<div class="result-empty" style="grid-column:1/-1">${esc(e.message||"Não foi possível carregar os cursos.")}</div>`;
  }
}
function formatDateFull(v){const s=String(v||"").slice(0,10);if(!s)return "";const [y,m,d]=s.split("-");return `${d}/${m}/${y}`}
function openResultModal(bookingId){
  const x=courseResultsCache.find(v=>Number(v.id)===Number(bookingId));
  if(!x)return alert("Curso não encontrado.");
  editingResultBookingId=Number(bookingId);
  $("resultModalCourse").textContent=`${x.course||"Curso"} · ${x.instructor_name||""} · ${formatDateFull(x.date)} · ${x.start_time}-${x.end_time}`;
  $("participantRows").innerHTML="";
  const list=Array.isArray(x.participants)?x.participants:[];
  (list.length?list:[{name:"",score:""}]).forEach(p=>addParticipantRow(p.name,p.score));
  $("resultMsg").classList.add("hidden");
  updateResultTotals();
  $("resultModal").classList.add("show");
}
function closeResultModal(){$("resultModal").classList.remove("show");editingResultBookingId=null}
function addParticipantRow(name="",score=""){
  const row=document.createElement("div");row.className="participant-row";
  row.innerHTML=`<div class="field" style="margin:0"><label>Nome</label><input class="p-name" placeholder="Nome do participante" value="${escAttr(name)}"></div><div class="field" style="margin:0"><label>Nota</label><input class="p-score" type="number" min="0" max="10" step="0.01" placeholder="0,0" value="${score!==""?escAttr(score):""}"></div><div><label style="display:block;font-size:11px;color:#87a6c4;margin-bottom:7px">Resultado</label><div class="participant-result">—</div></div><button class="btn danger" type="button" title="Remover" onclick="this.closest('.participant-row').remove();updateResultTotals()">×</button>`;
  $("participantRows").appendChild(row);
  const input=row.querySelector(".p-score");input.addEventListener("input",()=>updateParticipantResult(row));
  updateParticipantResult(row);
}
function updateParticipantResult(row){
  const el=row.querySelector(".participant-result"), v=Number(String(row.querySelector(".p-score").value||"").replace(",","."));
  el.className="participant-result";
  if(Number.isFinite(v)&&row.querySelector(".p-score").value!==""){if(v>=6){el.classList.add("approved");el.textContent="APROVADO"}else{el.classList.add("reproved");el.textContent="REPROVADO"}}else el.textContent="—";
  updateResultTotals();
}
function updateResultTotals(){
  if(!$("resultTotals"))return;
  const scores=[...document.querySelectorAll("#participantRows .p-score")].map(i=>Number(String(i.value||"").replace(",","."))).filter(Number.isFinite);
  const approved=scores.filter(v=>v>=6).length,reproved=scores.filter(v=>v<6).length;
  $("resultTotals").innerHTML=`<span>Total: <b>${scores.length}</b></span><span style="color:#31e0a1">Aprovados: <b>${approved}</b></span><span style="color:#ff7180">Reprovados: <b>${reproved}</b></span>`;
}
async function saveCourseResult(){
  const rows=[...document.querySelectorAll("#participantRows .participant-row")];
  const participants=rows.map(r=>({name:r.querySelector(".p-name").value.trim(),score:r.querySelector(".p-score").value}));
  if(!participants.length)return alert("Adicione pelo menos um participante.");
  if(participants.some(p=>!p.name))return alert("Preencha o nome de todos os participantes.");
  if(participants.some(p=>p.score==="" || !Number.isFinite(Number(String(p.score).replace(",","."))) || Number(String(p.score).replace(",","."))<0 || Number(String(p.score).replace(",","."))>10))return alert("As notas devem estar entre 0 e 10.");
  try{
    const r=await api(`/api/course-results/${editingResultBookingId}`,{method:"POST",body:JSON.stringify({participants})});
    closeResultModal();
    await loadResults();
    await loadAll();
    alert(`Resultado salvo. ${r.approved} aprovado(s) e ${r.reproved} reprovado(s).`);
  }catch(e){alert(e.message)}
}

async function loadLogs(){if(!["coordenador","admin"].includes(me.role))return;const d=await api("/api/logs");$("logs").innerHTML=d.map(x=>`<tr><td>${x.created_at}</td><td>${x.name||"Sistema"}</td><td>${x.action}</td><td>${x.details||""}</td></tr>`).join("")}
async function deleteBooking(id){
  if(!["coordenador","admin"].includes(me.role)){alert("Somente administradores e coordenadores podem excluir marcações.");return}
  if(!confirm("Excluir esta marcação definitivamente?\n\nEsta ação não poderá ser desfeita.")) return;
  try { await api("/api/bookings/"+id,{method:"DELETE"}); await loadAll(); await loadBookings(); alert("Marcação excluída com sucesso."); }
  catch(e){ alert(e.message); }
}
async function setStatus(id,status){try{await api("/api/bookings/"+id+"/status",{method:"POST",body:JSON.stringify({status})});await loadAll()}catch(e){alert(e.message)}}
async function openBooking(){const ins=await api("/api/instructors");$("bInstructor").innerHTML=ins.map(x=>`<option value="${x.id}">${esc(x.name)} — ${x.role==="coordenador"?"Coordenador":"Instrutor"}</option>`).join("");$("bInstructor").disabled=false;$("bDate").value=localDateKey(new Date());$("modal").classList.add("show")}
function closeBooking(){$("modal").classList.remove("show")}
async function createBooking(){try{const start=$("bStart").value;if(!start)return alert("Informe o horário.");const [hh,mm]=start.split(":").map(Number);const total=hh*60+mm+60;if(total>24*60)return alert("O horário de início deve permitir uma duração de 1 hora.");const end=`${String(Math.floor(total/60)%24).padStart(2,"0")}:${String(total%60).padStart(2,"0")}`;await api("/api/bookings",{method:"POST",body:JSON.stringify({instructor_id:Number($("bInstructor").value),course:$("bCourse").value,date:$("bDate").value,start_time:start,end_time:end,notes:$("bNotes").value})});closeBooking();await loadAll();alert("Marcação criada. Se o webhook estiver configurado, o Discord também receberá a notificação.")}catch(e){alert(e.message)}}
if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();


(function(){
  function bindCalendarButtons(){
    const today=document.getElementById('weekTodayCompact');
    const prev=document.getElementById('weekPrev');
    const next=document.getElementById('weekNext');

    if(today){
      today.onclick=function(e){
        e.preventDefault();
        e.stopPropagation();
        if(typeof window.goCalendarToday==="function") window.goCalendarToday();
      };
    }

    if(prev){
      prev.onclick=function(e){
        e.preventDefault();
        e.stopPropagation();
        if(typeof window.changeCalendarWeek==="function") window.changeCalendarWeek(-1);
      };
    }

    if(next){
      next.onclick=function(e){
        e.preventDefault();
        e.stopPropagation();
        if(typeof window.changeCalendarWeek==="function") window.changeCalendarWeek(1);
      };
    }
  }

  document.addEventListener('DOMContentLoaded',bindCalendarButtons);
  setTimeout(bindCalendarButtons,300);
  setTimeout(bindCalendarButtons,1000);
})();


document.addEventListener('DOMContentLoaded',function(){
  const t=document.getElementById('title');
  if(t) t.textContent='PAINEL DE CONTROLE';
});


(function(){
  function bindLoginEnter(){
    const user=document.getElementById('email');
    const pass=document.getElementById('pass');
    if(!user||!pass)return;
    [user,pass].forEach(function(input){
      input.addEventListener('keydown',function(e){
        if(e.key==='Enter' && !e.shiftKey){
          e.preventDefault();
          if(!document.getElementById('loginBox').classList.contains('hidden')) login();
        }
      });
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',bindLoginEnter);
  else bindLoginEnter();
})();
