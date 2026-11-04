const form = document.querySelector("#complaint-form");
const submitButton = document.querySelector("#submit-button");
const formStatus = document.querySelector("#form-status");
const agentInput = document.querySelector("#agent");
const listElement = document.querySelector("#complaint-list");
const summaryElement = document.querySelector("#summary");
const branchesElement = document.querySelector("#branches");
const resetButton = document.querySelector("#reset-button");

const SENTIMENTS = {
  negative: ["😠", "Negativo"],
  mixed: ["😕", "Mixto"],
  neutral: ["😐", "Neutral"],
  positive: ["🙂", "Positivo"],
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(iso) {
  return new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
}

async function closeComplaint(id) {
  const persona = agentInput.value.trim();
  if (persona.length < 2) {
    formStatus.textContent = "Escribe primero quién da seguimiento (sección 2).";
    agentInput.focus();
    return;
  }
  const response = await fetch(`/api/quejas/${id}/cerrar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona }),
  });
  const data = await response.json();
  formStatus.textContent = response.ok ? "Queja cerrada." : data.error || "No se pudo cerrar.";
  await loadComplaints();
}

function renderSummary(summary) {
  summaryElement.replaceChildren();
  const stats = [
    ["Total", summary.total],
    ["Abiertas", summary.abiertas],
    ["Negativas", summary.negativas],
    ["Escaladas", summary.escaladas],
  ];
  for (const [label, value] of stats) {
    const stat = el("div", "stat");
    stat.append(el("b", "", String(value)), el("span", "", label));
    summaryElement.append(stat);
  }

  branchesElement.replaceChildren();
  const head = el("tr");
  for (const title of ["Sucursal", "Quejas", "Negativas"]) head.append(el("th", "", title));
  branchesElement.append(head);
  for (const [name, counts] of Object.entries(summary.porSucursal)) {
    const row = el("tr");
    row.append(el("td", "", name), el("td", "", String(counts.total)), el("td", "", String(counts.negativas)));
    branchesElement.append(row);
  }
}

function renderComplaint(item) {
  const [icon, label] = SENTIMENTS[item.sentimiento] ?? ["•", item.sentimiento];
  const card = el("article", "card");

  const head = el("div", "invoice-head");
  head.append(
    el("span", "", `${icon} ${label}${item.escalada ? " · 🔺 Escalada" : ""}${item.estado === "cerrada" ? " · ✅ Cerrada" : ""}`),
    el("span", "", `${item.cliente} · ${item.sucursal}${item.pedido ? ` · ${item.pedido}` : ""}`),
  );
  card.append(head, el("p", "msg", item.mensaje));

  if (item.frasesClave.length > 0) {
    const tags = el("div", "tags");
    for (const phrase of item.frasesClave) tags.append(el("span", "tag", phrase));
    card.append(tags);
  }

  const scores = item.confianza;
  card.append(
    el(
      "p",
      "note",
      `Confianza del análisis: positivo ${Math.round(scores.positivo * 100)}% · neutral ${Math.round(scores.neutral * 100)}% · negativo ${Math.round(scores.negativo * 100)}%.`,
    ),
  );

  const reasons = el("ul", "reasons");
  for (const reason of item.motivos) reasons.append(el("li", "", reason));
  card.append(reasons);
  card.append(el("p", "note", `Registrada ${formatTime(item.creadaEn)}. Primera respuesta antes de ${formatTime(item.responderAntes)}.`));

  if (item.atendidaPor) {
    card.append(el("p", "note", `Cerrada por ${item.atendidaPor} el ${formatTime(item.atendidaEn)}.`));
  } else {
    const actions = el("div", "actions");
    const close = el("button", "send-button", "Cerrar queja");
    close.type = "button";
    close.addEventListener("click", () => closeComplaint(item.id));
    actions.append(close);
    card.append(actions);
  }
  return card;
}

async function loadComplaints() {
  const response = await fetch("/api/quejas");
  const data = await response.json();
  renderSummary(data.resumen);
  listElement.replaceChildren();
  if (data.quejas.length === 0) {
    listElement.append(el("p", "note", "Aún no hay quejas registradas."));
    return;
  }
  for (const item of data.quejas) listElement.append(renderComplaint(item));
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  formStatus.textContent = "Analizando la queja…";
  try {
    const response = await fetch("/api/quejas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cliente: document.querySelector("#cliente").value,
        sucursal: document.querySelector("#sucursal").value,
        pedido: document.querySelector("#pedido").value,
        mensaje: document.querySelector("#mensaje").value,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo registrar.");
    formStatus.textContent = "Queja registrada. Una persona dará seguimiento.";
    document.querySelector("#mensaje").value = "";
    await loadComplaints();
  } catch (error) {
    formStatus.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

resetButton.addEventListener("click", async () => {
  if (!window.confirm("¿Vaciar todas las quejas registradas? Solo para pruebas.")) return;
  await fetch("/api/quejas/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmar: "si" }),
  });
  await loadComplaints();
});

loadComplaints();
