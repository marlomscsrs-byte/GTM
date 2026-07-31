
/* =========================================================
   PORTAL G.T.M. — ABAS E FORMULÁRIO DE REGISTRO
========================================================= */
const portalButtons = [...document.querySelectorAll("[data-view]")];
const portalViews = [...document.querySelectorAll("[data-view-panel]")];
const manualTools = document.getElementById("manualTools");
const accessManual = document.getElementById("accessManual");
const prisonForm = document.getElementById("prisonForm");
const registrationMessage = document.getElementById("registrationMessage");

// Cole aqui a URL do Web App responsável por salvar a prisão e enviar ao Discord.
// Enquanto estiver vazia, o formulário valida os campos e mantém o registro em modo de demonstração.
const REGISTRATION_API_URL =
  "https://script.google.com/macros/s/AKfycbxyLa4TCEOF1JLC8nQ5jDp_NDXDKTUoj0i4-HtQHzMqLjIwqjTYhqM7BOVGclocFMpb/exec";

function openPortalView(viewName, scroll = true) {
  portalViews.forEach(view => view.classList.toggle("active", view.dataset.viewPanel === viewName));
  portalButtons.forEach(button => button.classList.toggle("active", button.dataset.view === viewName));
  const isManual = viewName === "manual";
  if (manualTools) manualTools.hidden = !isManual;
  document.body.classList.toggle("manual-open", isManual);
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  closeMenu();
}

portalButtons.forEach(button => {
  if (button.tagName === "BUTTON") button.addEventListener("click", () => openPortalView(button.dataset.view));
});
accessManual?.addEventListener("click", () => openPortalView("manual"));

function enviarRegistroPorJsonp(dados) {
  return new Promise((resolve, reject) => {
    const callbackName =
      "gtmRegistro_" + Date.now() + "_" +
      Math.random().toString(36).slice(2);

    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      limpar();
      reject(new Error(
        "A API não respondeu. Confirme se a implantação foi atualizada e está liberada para qualquer pessoa."
      ));
    }, 30000);

    function limpar() {
      window.clearTimeout(timeout);
      script.remove();
      try {
        delete window[callbackName];
      } catch (_) {
        window[callbackName] = undefined;
      }
    }

    window[callbackName] = resultado => {
      limpar();
      resolve(resultado || {});
    };

    script.onerror = () => {
      limpar();
      reject(new Error(
        "Não foi possível conectar ao Google Apps Script. Verifique a implantação do Web App."
      ));
    };

    const parametros = new URLSearchParams({
      acao: "registrarPrisao",
      callback: callbackName,
      pilotId: dados.pilotId || "",
      date: dados.date || "",
      qru: dados.qru || "",
      involved: dados.involved || "",
      vehicle: dados.vehicle || "",
      photoUrl: dados.photoUrl || "",
      _: String(Date.now())
    });

    script.src = `${REGISTRATION_API_URL}?${parametros.toString()}`;
    script.async = true;
    document.head.appendChild(script);
  });
}

prisonForm?.addEventListener("submit", async event => {
  event.preventDefault();
  registrationMessage.className = "";
  registrationMessage.textContent = "Enviando registro...";

  const formData = Object.fromEntries(
    new FormData(prisonForm).entries()
  );

  if (!/^https:\/\//i.test(formData.photoUrl || "")) {
    registrationMessage.textContent =
      "Informe um link de foto iniciado por https://";
    registrationMessage.className = "registration-error";
    return;
  }

  if (!REGISTRATION_API_URL) {
    registrationMessage.textContent =
      "A URL da API de registros ainda não foi configurada.";
    registrationMessage.className = "registration-error";
    return;
  }

  const submitButton = prisonForm.querySelector("button[type='submit']");
  if (submitButton) submitButton.disabled = true;

  try {
    const result = await enviarRegistroPorJsonp(formData);

    if (result.success === false || result.sucesso === false) {
      throw new Error(
        result.message || result.mensagem ||
        "Não foi possível enviar o registro."
      );
    }

    registrationMessage.textContent =
      result.message || result.mensagem ||
      "Registro enviado com sucesso.";
    registrationMessage.className = "registration-success";
    prisonForm.reset();
  } catch (error) {
    registrationMessage.textContent =
      error.message || "Erro ao enviar o registro.";
    registrationMessage.className = "registration-error";
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

const progress = document.getElementById("readingProgress");
const backToTop = document.getElementById("backToTop");
const sidebar = document.getElementById("sidebar");
const mobileMenu = document.getElementById("mobileMenu");
const backdrop = document.getElementById("backdrop");
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const toast = document.getElementById("toast");
const navLinks = [...document.querySelectorAll("#navigation a[href^='#']")];

/* =========================================================
   BARRA DE PROGRESSO E BOTÃO VOLTAR AO TOPO
========================================================= */

function updateScrollUI() {
  const max =
    document.documentElement.scrollHeight - window.innerHeight;

  const percentual =
    max > 0
      ? (window.scrollY / max) * 100
      : 0;

  if (progress) {
    progress.style.width = `${percentual}%`;
  }

  if (backToTop) {
    backToTop.classList.toggle(
      "visible",
      window.scrollY > 650
    );
  }
}

window.addEventListener(
  "scroll",
  updateScrollUI,
  { passive: true }
);

updateScrollUI();

/* =========================================================
   MENU MOBILE
========================================================= */

function closeMenu() {
  if (sidebar) {
    sidebar.classList.remove("open");
  }

  if (backdrop) {
    backdrop.classList.remove("show");
  }

  if (mobileMenu) {
    mobileMenu.setAttribute(
      "aria-expanded",
      "false"
    );
  }
}

if (mobileMenu) {
  mobileMenu.addEventListener("click", () => {
    const open =
      sidebar?.classList.toggle("open") || false;

    backdrop?.classList.toggle(
      "show",
      open
    );

    mobileMenu.setAttribute(
      "aria-expanded",
      String(open)
    );
  });
}

backdrop?.addEventListener(
  "click",
  closeMenu
);

navLinks.forEach(link => {
  link.addEventListener(
    "click",
    closeMenu
  );
});

backToTop?.addEventListener(
  "click",
  () => {
    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  }
);

/* =========================================================
   MARCAÇÃO DA SEÇÃO ATIVA NO MENU
========================================================= */

const targets = [
  ...document.querySelectorAll("[data-title]")
];

const observer = new IntersectionObserver(
  entries => {
    const visible = entries
      .filter(entry => entry.isIntersecting)
      .sort(
        (a, b) =>
          b.intersectionRatio -
          a.intersectionRatio
      )[0];

    if (!visible) {
      return;
    }

    const id = visible.target.id;

    navLinks.forEach(link => {
      link.classList.toggle(
        "active",
        link.getAttribute("href") === `#${id}`
      );
    });
  },
  {
    rootMargin: "-20% 0px -65% 0px",
    threshold: [0, 0.15, 0.4]
  }
);

targets.forEach(target => {
  observer.observe(target);
});

/* =========================================================
   PESQUISA DO MANUAL
========================================================= */

const searchable = targets.map(element => ({
  id: element.id,

  title:
    element.dataset.title ||
    element.querySelector("h2,h3")?.textContent ||
    element.id,

  text: element.innerText
    .replace(/\s+/g, " ")
    .trim()
}));

function showToast(message) {
  if (!toast) {
    return;
  }

  toast.textContent = message;
  toast.classList.add("show");

  window.setTimeout(() => {
    toast.classList.remove("show");
  }, 1600);
}

function renderResults(query) {
  if (!searchResults) {
    return;
  }

  const q = query
    .trim()
    .toLocaleLowerCase("pt-BR");

  if (!q) {
    searchResults.hidden = true;
    searchResults.innerHTML = "";
    return;
  }

  const matches = searchable
    .filter(item => {
      const title =
        item.title.toLocaleLowerCase("pt-BR");

      const text =
        item.text.toLocaleLowerCase("pt-BR");

      return (
        title.includes(q) ||
        text.includes(q)
      );
    })
    .slice(0, 8);

  if (matches.length) {
    searchResults.innerHTML = matches
      .map(item => {
        const lower =
          item.text.toLocaleLowerCase("pt-BR");

        const index =
          lower.indexOf(q);

        const snippet =
          index >= 0
            ? item.text.slice(
                Math.max(0, index - 38),
                Math.min(
                  item.text.length,
                  index + 90
                )
              )
            : item.text.slice(0, 110);

        return `
          <a href="#${item.id}">
            <strong>${item.title}</strong>
            <small>…${snippet}…</small>
          </a>
        `;
      })
      .join("");
  } else {
    searchResults.innerHTML = `
      <a href="#" onclick="return false">
        <strong>Nenhum resultado</strong>
        <small>Tente outra palavra.</small>
      </a>
    `;
  }

  searchResults.hidden = false;
}

searchInput?.addEventListener(
  "input",
  event => {
    renderResults(event.target.value);
  }
);

searchResults?.addEventListener(
  "click",
  event => {
    const link =
      event.target.closest("a[href^='#']");

    if (!link) {
      return;
    }

    searchResults.hidden = true;

    if (searchInput) {
      searchInput.value = "";
    }

    showToast("Seção localizada");
    closeMenu();
  }
);

document.addEventListener(
  "click",
  event => {
    const clicouNaPesquisa =
      event.target.closest(".search-box") ||
      event.target.closest(".search-results");

    if (
      !clicouNaPesquisa &&
      searchResults
    ) {
      searchResults.hidden = true;
    }
  }
);

document.addEventListener(
  "keydown",
  event => {
    const abriuPesquisa =
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "k";

    if (abriuPesquisa) {
      event.preventDefault();

      if (
        window.innerWidth <= 900 &&
        sidebar &&
        backdrop
      ) {
        sidebar.classList.add("open");
        backdrop.classList.add("show");
      }

      searchInput?.focus();
    }

    if (event.key === "Escape") {
      if (searchResults) {
        searchResults.hidden = true;
      }

      closeMenu();
    }
  }
);

/* =========================================================
   EFETIVO G.T.M. — GOOGLE SHEETS / APPS SCRIPT
========================================================= */

const EFFECTIVE_API_URL =
  "https://script.google.com/macros/s/AKfycbxyLa4TCEOF1JLC8nQ5jDp_NDXDKTUoj0i4-HtQHzMqLjIwqjTYhqM7BOVGclocFMpb/exec";

const effectivePanel =
  document.getElementById("effectivePanel");

const effectiveToggle =
  document.getElementById("effectiveToggle");

const effectiveClose =
  document.getElementById("effectiveClose");

const effectiveList =
  document.getElementById("effectiveList");

const effectiveSearch =
  document.getElementById("effectiveSearch");

const effectiveTotal =
  document.getElementById("effectiveTotal");

const effectiveActive =
  document.getElementById("effectiveActive");

const effectiveUpdated =
  document.getElementById("effectiveUpdated");

let effectiveMembers = [];

/*
 * Ordem oficial de exibição no painel.
 */
const cargoOrder = [
  "Comando",
  "Sub-Comando",
  "Capitão",
  "Piloto Oficial",
  "Piloto Probatório"
];

/* =========================================================
   FUNÇÕES AUXILIARES DO EFETIVO
========================================================= */

function normalizeEffective(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    );
}

function normalizeCargoName(cargo) {
  const normalized =
    normalizeEffective(cargo);

  const mapa = {
    "comando": "Comando",

    "sub comando": "Sub-Comando",
    "subcomando": "Sub-Comando",

    "capitao": "Capitão",
    "supervisor": "Capitão",

    "piloto oficial": "Piloto Oficial",
    "pilotos oficiais": "Piloto Oficial",

    "piloto probatorio": "Piloto Probatório",
    "pilotos probatorios": "Piloto Probatório"
  };

  return mapa[normalized] || String(cargo || "").trim();
}

function effectiveInitials(name) {
  return String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join("")
    .toUpperCase() || "GT";
}

function effectiveStatusClass(status) {
  const value =
    normalizeEffective(status);

  if (
    value === "ativo" ||
    value.includes("servico")
  ) {
    return "status-active";
  }

  if (
    value === "inativo" ||
    value === "afastado"
  ) {
    return "status-inactive";
  }

  return "status-other";
}

function cargoIndex(cargo) {
  const cargoPadronizado =
    normalizeCargoName(cargo);

  const normalized =
    normalizeEffective(cargoPadronizado);

  const index =
    cargoOrder.findIndex(item => {
      return (
        normalizeEffective(item) === normalized
      );
    });

  return index === -1
    ? 999
    : index;
}

/* =========================================================
   RENDERIZAÇÃO DO EFETIVO
========================================================= */

function renderEffective(data) {
  if (
    !effectiveList ||
    !effectiveTotal ||
    !effectiveActive
  ) {
    return;
  }

  const query =
    normalizeEffective(
      effectiveSearch?.value
    );

  const dadosPadronizados = data.map(item => ({
    ...item,

    cargo:
      normalizeCargoName(item.cargo),

    nome:
      String(item.nome || "").trim(),

    patente:
      String(item.patente || "").trim(),

    status:
      String(item.status || "").trim(),

    id:
      String(item.id || "").trim()
  }));

  const filtered =
    dadosPadronizados.filter(item => {
      if (!query) {
        return true;
      }

      const textoPesquisa =
        normalizeEffective(
          [
            item.nome,
            item.id,
            item.patente,
            item.cargo,
            item.status
          ].join(" ")
        );

      return textoPesquisa.includes(query);
    });

  effectiveTotal.textContent =
    dadosPadronizados.length;

  effectiveActive.textContent =
    dadosPadronizados.filter(item => {
      return (
        normalizeEffective(item.status) ===
        "ativo"
      );
    }).length;

  if (!filtered.length) {
    effectiveList.innerHTML = `
      <div class="effective-empty">
        Nenhum oficial encontrado.
      </div>
    `;

    return;
  }

  const groups = filtered.reduce(
    (accumulator, item) => {
      const cargo =
        item.cargo || "Sem cargo";

      if (!accumulator[cargo]) {
        accumulator[cargo] = [];
      }

      accumulator[cargo].push(item);

      return accumulator;
    },
    {}
  );

  /*
   * Ordena os grupos pela ordem definida em cargoOrder.
   */
  const sortedGroups =
    Object.keys(groups).sort(
      (cargoA, cargoB) => {
        const ordemA =
          cargoIndex(cargoA);

        const ordemB =
          cargoIndex(cargoB);

        if (ordemA !== ordemB) {
          return ordemA - ordemB;
        }

        return cargoA.localeCompare(
          cargoB,
          "pt-BR",
          {
            sensitivity: "base"
          }
        );
      }
    );

  effectiveList.innerHTML =
    sortedGroups
      .map(cargo => {
        /*
         * Ordena os integrantes pelo nome dentro de cada grupo.
         */
        const integrantes =
          groups[cargo].sort(
            (a, b) =>
              a.nome.localeCompare(
                b.nome,
                "pt-BR",
                {
                  sensitivity: "base"
                }
              )
          );

        const membrosHtml =
          integrantes
            .map(member => {
              const id =
                member.id || "-";

              const status =
                member.status ||
                "Sem status";

              const patente =
                member.patente ||
                "Sem patente";

              return `
                <div
                  class="effective-member"
                  title="ID ${id} · ${status}"
                >
                  <div class="effective-avatar">
                    ${effectiveInitials(member.nome)}
                  </div>

                  <div class="effective-member-info">
                    <span class="effective-member-name">
                      ${member.nome}
                    </span>

                    <span class="effective-member-meta">
                      ${patente}
                      ${
                        member.id
                          ? ` · ID ${member.id}`
                          : ""
                      }
                    </span>
                  </div>

                  <i
                    class="effective-member-status ${effectiveStatusClass(member.status)}"
                  ></i>
                </div>
              `;
            })
            .join("");

        return `
          <section class="effective-group">
            <h3 class="effective-group-title">
              ${cargo}
            </h3>

            ${membrosHtml}
          </section>
        `;
      })
      .join("");
}

/* =========================================================
   CARREGAMENTO DA API
========================================================= */

async function loadEffective() {
  try {
    if (effectiveUpdated) {
      effectiveUpdated.textContent =
        "Consultando planilha...";
    }

    const response = await fetch(
      `${EFFECTIVE_API_URL}?t=${Date.now()}`,
      {
        cache: "no-store"
      }
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const payload =
      await response.json();

    if (payload.sucesso === false) {
      throw new Error(
        payload.mensagem ||
        "A API retornou um erro."
      );
    }

    const dadosRecebidos =
      Array.isArray(payload)
        ? payload
        : payload.dados || [];

    effectiveMembers =
      dadosRecebidos.map(item => ({
        ...item,
        cargo:
          normalizeCargoName(item.cargo)
      }));

    renderEffective(
      effectiveMembers
    );

    if (effectiveUpdated) {
      effectiveUpdated.textContent =
        payload.atualizadoEm
          ? `Atualizado em ${payload.atualizadoEm}`
          : "Dados atualizados";
    }

  } catch (error) {
    console.error(
      "Erro ao carregar efetivo:",
      error
    );

    if (effectiveList) {
      effectiveList.innerHTML = `
        <div class="effective-error">
          Não foi possível carregar o efetivo.
          Confirme se a implantação do Apps Script
          permite acesso para “Qualquer pessoa”.
        </div>
      `;
    }

    if (effectiveTotal) {
      effectiveTotal.textContent = "—";
    }

    if (effectiveActive) {
      effectiveActive.textContent = "—";
    }

    if (effectiveUpdated) {
      effectiveUpdated.textContent =
        "Falha na atualização";
    }
  }
}

/* =========================================================
   EVENTOS DO PAINEL
========================================================= */

effectiveSearch?.addEventListener(
  "input",
  () => {
    renderEffective(
      effectiveMembers
    );
  }
);

effectiveToggle?.addEventListener(
  "click",
  () => {
    if (!effectivePanel) {
      return;
    }

    const open =
      effectivePanel.classList.toggle(
        "open"
      );

    effectiveToggle.setAttribute(
      "aria-expanded",
      String(open)
    );
  }
);

effectiveClose?.addEventListener(
  "click",
  () => {
    effectivePanel?.classList.remove(
      "open"
    );

    effectiveToggle?.setAttribute(
      "aria-expanded",
      "false"
    );
  }
);

/* =========================================================
   INICIALIZAÇÃO
========================================================= */

loadEffective();

/*
 * Atualiza o efetivo a cada 5 minutos.
 *
 * 300000 milissegundos = 5 minutos.
 */
window.setInterval(
  loadEffective,
  300000
);
