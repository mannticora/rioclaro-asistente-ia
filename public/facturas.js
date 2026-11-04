const uploadForm = document.querySelector("#upload-form");
const fileInput = document.querySelector("#file-input");
const analyzeButton = document.querySelector("#analyze-button");
const uploadStatus = document.querySelector("#upload-status");
const listElement = document.querySelector("#invoice-list");
const approverInput = document.querySelector("#approver");
const resetButton = document.querySelector("#reset-button");

const STATES = {
  pendiente_aprobacion: ["🟢", "Lectura confiable: lista para que una persona la apruebe"],
  revision_humana: ["🟡", "Requiere revisión humana (lectura dudosa)"],
  posible_duplicado: ["🔴", "Posible duplicado: pago bloqueado"],
  aprobada: ["✅", "Aprobada para pago"],
  rechazada: ["⛔", "Rechazada"],
};

const FIELD_LABELS = { proveedor: "Proveedor", folio: "Folio", fecha: "Fecha", total: "Total" };

function formatValue(name, field, currency) {
  if (field.valor === null || field.valor === undefined) {
    return "No se pudo leer";
  }
  if (name === "total" && typeof field.valor === "number") {
    return new Intl.NumberFormat("es-MX", { style: "currency", currency: currency || "MXN" }).format(field.valor);
  }
  return String(field.valor);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function decide(id, action) {
  const persona = approverInput.value.trim();
  if (persona.length < 2) {
    uploadStatus.textContent = "Escribe primero el nombre de quien revisa (sección 2).";
    approverInput.focus();
    return;
  }
  const response = await fetch(`/api/facturas/${id}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona }),
  });
  const data = await response.json();
  uploadStatus.textContent = response.ok ? "Decisión registrada." : data.error || "No se pudo registrar.";
  await loadInvoices();
}

function renderInvoice(invoice) {
  const [icon, label] = STATES[invoice.estado] ?? ["•", invoice.estado];
  const card = el("article", "card");

  const head = el("div", "invoice-head");
  head.append(el("span", "", `${icon} ${label}`), el("span", "", invoice.archivo));
  card.append(head);

  const grid = el("div", "grid");
  for (const [name, field] of Object.entries(invoice.campos)) {
    const cell = el("div", "cell");
    cell.append(el("small", "", FIELD_LABELS[name] ?? name));
    cell.append(el("span", field.dudoso ? "doubt" : "", formatValue(name, field, invoice.moneda)));
    const confidence = `Confianza ${Math.round(field.confianza * 100)}%${field.dudoso ? " (dudoso)" : ""}`;
    cell.append(el("small", "", confidence));
    grid.append(cell);
  }
  card.append(grid);

  if (invoice.motivos.length > 0) {
    const reasons = el("ul", "reasons");
    for (const reason of invoice.motivos) reasons.append(el("li", "", reason));
    card.append(reasons);
  }

  if (invoice.decididaPor) {
    const when = new Date(invoice.decididaEn).toLocaleString("es-MX");
    card.append(el("p", "note", `Decisión de ${invoice.decididaPor} el ${when}.`));
  }

  if (invoice.estado !== "aprobada" && invoice.estado !== "rechazada") {
    const actions = el("div", "actions");
    const approve = el("button", "send-button", "Aprobar pago");
    approve.type = "button";
    approve.disabled = invoice.estado === "posible_duplicado";
    approve.addEventListener("click", () => decide(invoice.id, "aprobar"));
    const reject = el("button", "ghost", "Rechazar");
    reject.type = "button";
    reject.addEventListener("click", () => decide(invoice.id, "rechazar"));
    actions.append(approve, reject);
    card.append(actions);
  }

  return card;
}

async function loadInvoices() {
  const response = await fetch("/api/facturas");
  const data = await response.json();
  listElement.replaceChildren();
  if (!data.facturas || data.facturas.length === 0) {
    listElement.append(el("p", "note", "Aún no hay facturas registradas."));
    return;
  }
  for (const invoice of data.facturas) listElement.append(renderInvoice(invoice));
}

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) {
    uploadStatus.textContent = "Elige un archivo primero.";
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    uploadStatus.textContent = "El archivo supera los 8 MB.";
    return;
  }

  analyzeButton.disabled = true;
  uploadStatus.textContent = "Leyendo la factura…";
  try {
    const response = await fetch("/api/facturas", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "x-filename": encodeURIComponent(file.name),
      },
      body: file,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo leer la factura.");
    uploadStatus.textContent = "Factura leída. Revisa el resultado abajo.";
    fileInput.value = "";
    await loadInvoices();
  } catch (error) {
    uploadStatus.textContent = error.message;
  } finally {
    analyzeButton.disabled = false;
  }
});

resetButton.addEventListener("click", async () => {
  if (!window.confirm("¿Vaciar todas las facturas registradas? Solo para pruebas.")) return;
  await fetch("/api/facturas/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmar: "si" }),
  });
  await loadInvoices();
});

loadInvoices();
