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
