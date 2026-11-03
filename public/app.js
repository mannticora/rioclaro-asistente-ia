const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const messages = document.querySelector("#messages");
const typingIndicator = document.querySelector("#typing-indicator");
const formError = document.querySelector("#form-error");
const chips = document.querySelector("#chips");

let conversationId = null;

function appendMessage(text, sender, sources = []) {
  const article = document.createElement("article");
  article.className = `message ${sender}-message`;

  if (sender === "assistant") {
    const avatar = document.createElement("span");
    avatar.className = "message-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "R";

    const content = document.createElement("div");
    content.className = "message-content";

    const author = document.createElement("p");
    author.className = "message-author";
    author.textContent = "Río Claro ";

    const role = document.createElement("span");
    role.textContent = "Asistente IA";
    author.append(role);

    const messageText = document.createElement("p");
    messageText.className = "message-text";
    messageText.textContent = text;

    content.append(author, messageText);

    if (sources.length > 0) {
      const sourcesLine = document.createElement("p");
      sourcesLine.className = "message-sources";
      sourcesLine.textContent = `Fuentes: ${sources.join(", ")}`;
      content.append(sourcesLine);
    }

    article.append(avatar, content);
  } else {
    const messageText = document.createElement("p");
    messageText.className = "message-text";
    messageText.textContent = text;
    article.append(messageText);
  }

  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
  article.scrollIntoView({ block: "end", behavior: "smooth" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  formError.hidden = true;

  if (!message) {
    formError.textContent = "Escribe una consulta antes de enviar.";
    formError.hidden = false;
    input.focus();
    return;
  }

  if (message.length > 2000) {
    formError.textContent = "La consulta no puede superar los 2000 caracteres.";
    formError.hidden = false;
    input.focus();
    return;
  }

  appendMessage(message, "user");
  input.value = "";
  input.style.height = "auto";
  sendButton.disabled = true;
  typingIndicator.hidden = false;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        conversation_id: conversationId,
      }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Chat request failed.");
    }

    conversationId = data.conversation_id;
    appendMessage(data.reply, "assistant", Array.isArray(data.sources) ? data.sources : []);
  } catch {
    appendMessage("No fue posible obtener una respuesta. Inténtalo de nuevo.", "assistant");
  } finally {
    sendButton.disabled = false;
    typingIndicator.hidden = true;
    input.focus();
  }
});

chips.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  input.value = chip.textContent.trim();
  form.requestSubmit();
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  formError.hidden = true;
});
