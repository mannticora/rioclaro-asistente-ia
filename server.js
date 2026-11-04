import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import express from "express";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { TextAnalysisClient } from "@azure/ai-language-text";
import DocumentIntelligence, {
  getLongRunningPoller,
  isUnexpected,
} from "@azure-rest/ai-document-intelligence";

/*

AIProjectClient: agentes de Microsoft Foundry (chat con conocimiento de Río Claro)
DocumentIntelligence: lectura de facturas (modelo prebuilt-invoice)
DefaultAzureCredential: en local usa tu sesión de `az login`; en Azure usa la
identidad administrada de la app. No hay llaves en el código.

*/

const app = express();
const port = Number(process.env.PORT) || 3000;
const agentName = process.env.FOUNDRY_AGENT_NAME;
const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
const docintelEndpoint = process.env.DOCINTEL_ENDPOINT;
const languageEndpoint = process.env.LANGUAGE_ENDPOINT;
const publicDirectory = path.join(import.meta.dirname, "public");
const foundryConfigured = Boolean(agentName && projectEndpoint);

// Una factura se marca para revisión humana si algún campo tiene menos confianza que esto.
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE ?? 0.8);
// Proveedor y folio se leen con menos confianza en facturas de formato libre; el total y la fecha siguen exigiendo MIN_CONFIDENCE.
const MIN_CONFIDENCE_TEXT = Number(process.env.MIN_CONFIDENCE_TEXT ?? 0.45);

const credential = new DefaultAzureCredential();
let openAIClient;
let documentClient;
let languageClient;

function logFailure(label, error) {
  const message = error instanceof Error ? error.message : "Unknown error.";
  const safeMessage = message
    .replaceAll(projectEndpoint ?? "", "[project endpoint]")
    .replaceAll(docintelEndpoint ?? "", "[document endpoint]")
    .replaceAll(agentName ?? "", "[agent name]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[token redacted]")
    .slice(0, 500);

  console.error(label, {
    name: error?.name,
    code: error?.code,
    statusCode: error?.statusCode ?? error?.status,
    message: safeMessage,
  });
}

// Extrae los nombres de los documentos que el agente citó (File search).
function extractSources(result) {
  const names = new Set();
  for (const item of result?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const part of item.content ?? []) {
      for (const annotation of part?.annotations ?? []) {
        const name = annotation?.filename ?? annotation?.file_name ?? annotation?.title;
        if (name && typeof name === "string") {
          names.add(name);
        }
      }
    }
  }
  return [...names];
}

if (foundryConfigured) {
  const projectClient = new AIProjectClient(projectEndpoint, credential);
  openAIClient = projectClient.getOpenAIClient();
}

if (docintelEndpoint) {
  documentClient = DocumentIntelligence(docintelEndpoint, credential);
}

if (languageEndpoint) {
  languageClient = new TextAnalysisClient(languageEndpoint, credential);
}

/* ---------- Almacén sencillo de facturas (archivo JSON) ---------- */

const dataDirectory = process.env.DATA_DIR
  || (process.env.WEBSITE_SITE_NAME ? "/home/data" : path.join(import.meta.dirname, "data"));
const invoicesFile = path.join(dataDirectory, "facturas.json");

function loadInvoices() {
  try {
    return JSON.parse(fs.readFileSync(invoicesFile, "utf8"));
  } catch {
    return [];
  }
}

function saveInvoices(list) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(invoicesFile, JSON.stringify(list, null, 2));
}

const normalize = (value) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "");

/* ---------- Lectura de facturas con Document Intelligence ---------- */

async function analyzeInvoice(buffer) {
  const initial = await documentClient
    .path("/documentModels/{modelId}:analyze", "prebuilt-invoice")
    .post({
      contentType: "application/json",
      body: { base64Source: buffer.toString("base64") },
    });

  if (isUnexpected(initial)) {
    const error = new Error(initial.body?.error?.message ?? "Document Intelligence error.");
    error.statusCode = Number(initial.status);
    throw error;
  }

  const poller = getLongRunningPoller(documentClient, initial);
  const finished = await poller.pollUntilDone();
  return finished.body.analyzeResult;
}

function readField(doc, name, pick, threshold = MIN_CONFIDENCE) {
  const field = doc?.fields?.[name];
  if (!field) {
    return { valor: null, confianza: 0, dudoso: true };
  }
  const raw = pick(field);
  const valor = raw === undefined || raw === null || raw === "" ? null : raw;
  const confianza = Number((field.confidence ?? 0).toFixed(2));
  return { valor, confianza, dudoso: valor === null || confianza < threshold };
}

function buildRecord(filename, analysis, existing) {
  const doc = analysis?.documents?.[0];

  const campos = {
    proveedor: readField(doc, "VendorName", (f) => f.valueString ?? f.content, MIN_CONFIDENCE_TEXT),
    folio: readField(doc, "InvoiceId", (f) => f.valueString ?? f.content, MIN_CONFIDENCE_TEXT),
    fecha: readField(doc, "InvoiceDate", (f) => f.valueDate ?? f.content),
    total: readField(doc, "InvoiceTotal", (f) => f.valueCurrency?.amount ?? f.content),
  };
  // Río Claro opera en pesos: el modelo interpreta "$" como USD, así que fijamos la moneda.
  const moneda = process.env.INVOICE_CURRENCY ?? "MXN";

  const confianzas = Object.values(campos).map((c) => c.confianza);
  const confianzaMinima = Math.min(...confianzas);
  const motivos = [];
  let estado = "pendiente_aprobacion";

  // 1) Lectura dudosa: no inventamos nada, pedimos a una persona que revise.
  const dudosos = Object.entries(campos).filter(([, c]) => c.dudoso).map(([nombre]) => nombre);
  if (!doc || dudosos.length > 0) {
    estado = "revision_humana";
    motivos.push(
      !doc
        ? "No se pudo leer la factura con seguridad."
        : `Campos con lectura dudosa o ausente: ${dudosos.join(", ")}.`,
    );
    motivos.push("No se inventó ningún dato: una persona debe verificar contra el documento original.");
  }

  // 2) Posible duplicado: mismo proveedor y folio, o mismo proveedor, fecha y total.
  const vendorKey = normalize(campos.proveedor.valor);
  const idKey = normalize(campos.folio.valor);
  const totalKey = campos.total.valor === null ? "" : String(campos.total.valor);
  const dateKey = String(campos.fecha.valor ?? "");

  const original = vendorKey
    ? existing.find((other) => {
        if (other.estado === "rechazada") return false;
        const sameVendor = normalize(other.campos.proveedor.valor) === vendorKey;
        if (!sameVendor) return false;
        const sameId = idKey && normalize(other.campos.folio.valor) === idKey;
        const sameAmountAndDate = totalKey
          && String(other.campos.total.valor) === totalKey
          && String(other.campos.fecha.valor ?? "") === dateKey;
        return sameId || sameAmountAndDate;
      })
    : null;

  if (original) {
    estado = "posible_duplicado";
    motivos.unshift(
      `Coincide con una factura ya registrada (${original.archivo}) del mismo proveedor. El pago queda bloqueado.`,
    );
  }

  return {
    id: crypto.randomUUID(),
    archivo: filename,
    creadaEn: new Date().toISOString(),
    campos,
    moneda,
    confianzaMinima,
    estado,
    motivos,
    duplicadaDe: original?.id ?? null,
    decididaPor: null,
    decididaEn: null,
  };
}

app.use(express.json({ limit: "16kb" }));
app.use(express.static(publicDirectory));

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

/* ---------- Chat con el agente ---------- */

app.post("/api/chat", async (request, response) => {
  const message = typeof request.body?.message === "string"
    ? request.body.message.trim()
    : "";

  if (!message || message.length > 2000) {
    response.status(422).json({ error: "El mensaje debe tener entre 1 y 2000 caracteres." });
    return;
  }

  const suppliedConversationId = request.body?.conversation_id;
  if (suppliedConversationId != null && typeof suppliedConversationId !== "string") {
    response.status(422).json({ error: "El identificador de conversación no es válido." });
    return;
  }

  if (!openAIClient) {
    response.status(502).json({ error: "No fue posible procesar la solicitud de chat." });
    return;
  }

  try {
    const conversationId = suppliedConversationId?.trim()
      || (await openAIClient.conversations.create()).id;
    const result = await openAIClient.responses.create(
      {
        conversation: conversationId,
        input: message,
      },
      {
        body: {
          agent_reference: { name: agentName, type: "agent_reference" },
        },
      },
    );

    response.json({
      reply: result.output_text,
      conversation_id: conversationId,
      sources: extractSources(result),
    });
  } catch (error) {
    logFailure("Foundry request failed", error);
    response.status(502).json({ error: "No fue posible procesar la solicitud de chat." });
  }
});

/* ---------- Facturas ---------- */

const ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png"];

app.get("/api/facturas", (_request, response) => {
  const list = loadInvoices().sort((a, b) => b.creadaEn.localeCompare(a.creadaEn));
  response.json({ facturas: list, umbral: MIN_CONFIDENCE });
});

app.post(
  "/api/facturas",
  express.raw({ type: () => true, limit: "8mb" }),
  async (request, response) => {
    const contentType = (request.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.includes(contentType)) {
      response.status(415).json({ error: "Sube un PDF, JPG o PNG." });
      return;
    }
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      response.status(422).json({ error: "El archivo está vacío." });
      return;
    }
    if (!documentClient) {
      response.status(502).json({ error: "El lector de facturas no está configurado." });
      return;
    }

    let filename = "factura";
    try {
      filename = decodeURIComponent(request.get("x-filename") ?? "factura").slice(0, 120);
    } catch {
      filename = "factura";
    }

    try {
      const analysis = await analyzeInvoice(request.body);
      const list = loadInvoices();
      const record = buildRecord(filename, analysis, list);
      list.push(record);
      saveInvoices(list);
      response.status(201).json({ factura: record });
    } catch (error) {
      logFailure("Document Intelligence request failed", error);
      response.status(502).json({ error: "No fue posible leer la factura. Inténtalo de nuevo." });
    }
  },
);

function decide(estadoFinal) {
  return (request, response) => {
    const list = loadInvoices();
    const invoice = list.find((item) => item.id === request.params.id);
    if (!invoice) {
      response.status(404).json({ error: "No se encontró la factura." });
      return;
    }

    const person = typeof request.body?.persona === "string" ? request.body.persona.trim() : "";
    if (person.length < 2 || person.length > 80) {
      response.status(422).json({ error: "Escribe el nombre de la persona que decide (2 a 80 caracteres)." });
      return;
    }

    if (invoice.estado === "aprobada" || invoice.estado === "rechazada") {
      response.status(409).json({ error: "Esta factura ya tiene una decisión." });
      return;
    }
    if (estadoFinal === "aprobada" && invoice.estado === "posible_duplicado") {
      response.status(409).json({ error: "Una factura marcada como posible duplicado no se puede aprobar." });
      return;
    }

    invoice.estado = estadoFinal;
    invoice.decididaPor = person;
    invoice.decididaEn = new Date().toISOString();
    saveInvoices(list);
    response.json({ factura: invoice });
  };
}

app.post("/api/facturas/:id/aprobar", decide("aprobada"));
app.post("/api/facturas/:id/rechazar", decide("rechazada"));

// Solo para pruebas y demostraciones: vacía la lista de facturas.
app.post("/api/facturas/reset", (request, response) => {
  if (request.body?.confirmar !== "si") {
    response.status(422).json({ error: "Falta la confirmación." });
    return;
  }
  saveInvoices([]);
  response.json({ ok: true });
});


/* ---------- Quejas con análisis de sentimiento (Azure AI Language) ---------- */

const complaintsFile = path.join(dataDirectory, "quejas.json");
const BRANCHES = ["Guadalajara", "Zapopan", "León", "Querétaro", "Aguascalientes"];
// Frases demasiado genéricas para considerar que dos quejas son "la misma".
const GENERIC_PHRASES = new Set(["pedido", "cliente", "problema", "favor", "gracias", "queja", "hola", "servicio"]);
const FIRST_RESPONSE_MINUTES = 15;

function loadComplaints() {
  try {
    return JSON.parse(fs.readFileSync(complaintsFile, "utf8"));
  } catch {
    return [];
  }
}

function saveComplaints(list) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(complaintsFile, JSON.stringify(list, null, 2));
}

async function analyzeComplaint(text) {
  const [sentiment] = await languageClient.analyze(
    "SentimentAnalysis",
    [{ id: "1", text, language: "es" }],
  );
  if (!sentiment || sentiment.error) {
    throw new Error(sentiment?.error?.message ?? "Language service error.");
  }

  const [phrases] = await languageClient.analyze(
    "KeyPhraseExtraction",
    [{ id: "1", text, language: "es" }],
  );

  const scores = sentiment.confidenceScores ?? {};
  return {
    sentimiento: sentiment.sentiment,
    confianza: {
      positivo: Number((scores.positive ?? 0).toFixed(2)),
      neutral: Number((scores.neutral ?? 0).toFixed(2)),
      negativo: Number((scores.negative ?? 0).toFixed(2)),
    },
    frasesClave: phrases && !phrases.error ? (phrases.keyPhrases ?? []).slice(0, 8) : [],
  };
}

function buildComplaint({ cliente, sucursal, pedido, mensaje }, analysis, existing) {
  const clientKey = normalize(cliente);
  const orderKey = normalize(pedido);
  const phraseKeys = new Set(
    analysis.frasesClave.map(normalize).filter((phrase) => phrase && !GENERIC_PHRASES.has(phrase)),
  );

  // Misma queja repetida: mismo cliente y mismo pedido, o al menos una frase clave en común.
  const related = existing.filter((other) => {
    if (normalize(other.cliente) !== clientKey) return false;
    const sameOrder = orderKey && normalize(other.pedido) === orderKey;
    const sharedPhrase = other.frasesClave.some((phrase) => phraseKeys.has(normalize(phrase)));
    return sameOrder || sharedPhrase;
  });

  const motivos = [];
  const escalada = related.length >= 1;
  if (escalada) {
    motivos.push(
      `Queja repetida (${related.length + 1} veces del mismo cliente): se escala a la persona gerente de ${sucursal}, según la política de atención.`,
    );
  }
  if (analysis.sentimiento === "negative" || analysis.sentimiento === "mixed") {
    motivos.push(`Sentimiento ${analysis.sentimiento === "negative" ? "negativo" : "mixto"}: dar seguimiento prioritario.`);
  }
  motivos.push(`Primera respuesta de una persona en máximo ${FIRST_RESPONSE_MINUTES} minutos en horario de atención.`);

  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    creadaEn: new Date(now).toISOString(),
    responderAntes: new Date(now + FIRST_RESPONSE_MINUTES * 60 * 1000).toISOString(),
    cliente,
    sucursal,
    pedido: pedido || null,
    mensaje,
    ...analysis,
    relacionadasCon: related.map((item) => item.id),
    escalada,
    motivos,
    estado: "abierta",
    atendidaPor: null,
    atendidaEn: null,
  };
}

app.get("/api/quejas", (_request, response) => {
  const list = loadComplaints().sort((a, b) => b.creadaEn.localeCompare(a.creadaEn));
  const porSucursal = Object.fromEntries(BRANCHES.map((name) => [name, { total: 0, negativas: 0 }]));
  for (const item of list) {
    if (!porSucursal[item.sucursal]) continue;
    porSucursal[item.sucursal].total += 1;
    if (item.sentimiento === "negative") porSucursal[item.sucursal].negativas += 1;
  }
  response.json({
    quejas: list,
    resumen: {
      total: list.length,
      abiertas: list.filter((item) => item.estado === "abierta").length,
      negativas: list.filter((item) => item.sentimiento === "negative").length,
      escaladas: list.filter((item) => item.escalada).length,
      porSucursal,
    },
  });
});

app.post("/api/quejas", async (request, response) => {
  const clean = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const data = {
    cliente: clean(request.body?.cliente, 80),
    sucursal: clean(request.body?.sucursal, 30),
    pedido: clean(request.body?.pedido, 40),
    mensaje: clean(request.body?.mensaje, 1000),
  };

  if (data.cliente.length < 2) {
    response.status(422).json({ error: "Escribe el nombre del cliente." });
    return;
  }
  if (!BRANCHES.includes(data.sucursal)) {
    response.status(422).json({ error: "Elige la sucursal que surtió el pedido." });
    return;
  }
  if (data.mensaje.length < 10) {
    response.status(422).json({ error: "Describe la queja con al menos 10 caracteres." });
    return;
  }
  if (!languageClient) {
    response.status(502).json({ error: "El análisis de quejas no está configurado." });
    return;
  }

  try {
    const analysis = await analyzeComplaint(data.mensaje);
    const list = loadComplaints();
    const complaint = buildComplaint(data, analysis, list);
    list.push(complaint);
    saveComplaints(list);
    response.status(201).json({ queja: complaint });
  } catch (error) {
    logFailure("Language request failed", error);
    response.status(502).json({ error: "No fue posible analizar la queja. Inténtalo de nuevo." });
  }
});

app.post("/api/quejas/reset", (request, response) => {
  if (request.body?.confirmar !== "si") {
    response.status(422).json({ error: "Falta la confirmación." });
    return;
  }
  saveComplaints([]);
  response.json({ ok: true });
});

app.post("/api/quejas/:id/cerrar", (request, response) => {
  const list = loadComplaints();
  const complaint = list.find((item) => item.id === request.params.id);
  if (!complaint) {
    response.status(404).json({ error: "No se encontró la queja." });
    return;
  }
  const person = typeof request.body?.persona === "string" ? request.body.persona.trim() : "";
  if (person.length < 2 || person.length > 80) {
    response.status(422).json({ error: "Escribe el nombre de la persona que da seguimiento (2 a 80 caracteres)." });
    return;
  }
  if (complaint.estado === "cerrada") {
    response.status(409).json({ error: "Esta queja ya está cerrada." });
    return;
  }
  complaint.estado = "cerrada";
  complaint.atendidaPor = person;
  complaint.atendidaEn = new Date().toISOString();
  saveComplaints(list);
  response.json({ queja: complaint });
});

app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({ error: "El cuerpo de la solicitud no contiene JSON válido." });
    return;
  }
  if (error?.type === "entity.too.large") {
    response.status(413).json({ error: "El archivo es demasiado grande (máximo 8 MB)." });
    return;
  }

  response.status(500).json({ error: "Ocurrió un error interno." });
});

app.listen(port, () => {
  console.log(`Servidor escuchando en el puerto ${port}.`);
});
