// School Letters website. Plain JS, no build step.
// All server text is inserted with textContent, never innerHTML.

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") showLogin();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const today = () => new Date().toLocaleDateString("en-CA");

function prettyDate(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

// --- login --------------------------------------------------------------------

function showLogin() {
  $("loading").hidden = true;
  $("app").hidden = true;
  $("login").hidden = false;
  $("password").focus();
}

async function showApp(me) {
  $("loading").hidden = true;
  $("login").hidden = true;
  $("app").hidden = false;
  $("no-llm").hidden = me.llmConfigured;
  if (me.calendarPath) {
    $("calendar").hidden = false;
    $("calendar-url").value = location.origin + me.calendarPath;
  }
  $("question").focus();
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { password: $("password").value } });
    $("password").value = "";
    showApp(await api("/api/me"));
  } catch (err) {
    $("login-error").textContent = err.message;
  }
});

$("logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: {} }).catch(() => {});
  $("answers").replaceChildren();
  showLogin();
});

// --- tabs -------------------------------------------------------------------------

const loaders = { dates: loadDates, letters: loadLetters };

for (const tab of document.querySelectorAll("[role=tab]")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll("[role=tab]")) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      $(`tab-${t.dataset.tab}`).hidden = !on;
    }
    loaders[tab.dataset.tab]?.();
  });
}

// --- ask ----------------------------------------------------------------------------

// Turns "[2026-10-12-update.txt]" citations into small labels.
function withCitations(text) {
  const frag = document.createDocumentFragment();
  for (const part of text.split(/(\[[^\]\n]+\.(?:txt|md)\])/i)) {
    frag.append(/^\[.+\]$/.test(part) ? el("span", { className: "cite", textContent: part.slice(1, -1) }) : part);
  }
  return frag;
}

function sourcesList(sources) {
  if (!sources.length) return null;
  return el("details", {},
    el("summary", { textContent: `From ${new Set(sources.map((s) => s.letterId)).size} letter(s)` }),
    ...sources.map((s) => el("blockquote", {}, el("div", { className: "small muted", textContent: `${s.letterId} · sent ${prettyDate(s.sentDate)}` }), s.text)),
  );
}

$("ask-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = $("question").value.trim();
  if (!question) return;
  const answer = el("p", { className: "answer muted", textContent: "Thinking…" });
  const card = el("article", { className: "card qa" }, el("p", { className: "q", textContent: question }), answer);
  $("answers").prepend(card);
  $("question").value = "";
  const button = e.submitter;
  button.disabled = true;
  try {
    const res = await api("/api/ask", { method: "POST", body: { question } });
    answer.classList.remove("muted");
    if (res.answer) answer.replaceChildren(withCitations(res.answer));
    else answer.textContent = res.sources.length ? "Here are the parts of letters that look relevant:" : "Nothing in the letters matches that question.";
    const src = sourcesList(res.sources);
    if (src) {
      if (!res.answer) src.open = true;
      card.append(src);
    }
  } catch (err) {
    answer.className = "answer error";
    answer.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

// Enter sends, Shift+Enter adds a new line.
$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("ask-form").requestSubmit();
  }
});

// --- dates ----------------------------------------------------------------------------

async function loadDates() {
  const list = $("events");
  try {
    const { events } = await api("/api/upcoming?days=42");
    list.replaceChildren(...events.map((ev) => {
      const when = prettyDate(ev.date) + (ev.endDate ? ` – ${prettyDate(ev.endDate)}` : "") + (ev.startTime ? `, ${ev.startTime}` : "");
      return el("li", { className: `event ${ev.kind}` },
        el("div", { className: "when", textContent: when }),
        el("div", {},
          el("strong", { textContent: (ev.kind === "deadline" ? "Due: " : "") + ev.title }),
          ev.location ? el("div", { className: "small muted", textContent: ev.location }) : null,
          ev.actions?.length ? el("ul", { className: "actions" }, ...ev.actions.map((a) => el("li", { textContent: a }))) : null,
          el("div", { className: "small muted", textContent: ev.letterId }),
        ),
      );
    }));
    if (!events.length) list.replaceChildren(el("li", { className: "muted", textContent: "Nothing in the next 6 weeks." }));
  } catch (err) {
    list.replaceChildren(el("li", { className: "error", textContent: err.message }));
  }
}

$("refresh").addEventListener("click", async (e) => {
  e.target.disabled = true;
  e.target.textContent = "Reading letters…";
  try {
    const res = await api("/api/sync", { method: "POST", body: {} });
    if (res.warning) alert(res.warning);
    await loadDates();
  } catch (err) {
    alert(err.message);
  } finally {
    e.target.disabled = false;
    e.target.textContent = "Refresh dates";
  }
});

$("copy-calendar").addEventListener("click", async (e) => {
  await navigator.clipboard.writeText($("calendar-url").value);
  e.target.textContent = "Copied";
  setTimeout(() => (e.target.textContent = "Copy"), 1500);
});

// --- letters ----------------------------------------------------------------------------

async function loadLetters() {
  const list = $("letters");
  try {
    const { letters } = await api("/api/letters");
    list.replaceChildren(...letters.map((l) => {
      const del = el("button", { className: "link danger", textContent: "Delete" });
      del.addEventListener("click", async () => {
        if (!confirm(`Delete "${l.title}"? Its dates will be removed too.`)) return;
        try {
          await api(`/api/letters/${encodeURIComponent(l.id)}`, { method: "DELETE" });
          loadLetters();
        } catch (err) {
          alert(err.message);
        }
      });
      return el("li", { className: "letter" },
        el("div", {},
          el("strong", { textContent: l.title }),
          el("div", { className: "small muted", textContent: `Sent ${prettyDate(l.sentDate)} · ${l.id}` }),
          l.preview ? el("p", { className: "small", textContent: l.preview }) : null,
        ),
        del,
      );
    }));
    if (!letters.length) list.replaceChildren(el("li", { className: "muted", textContent: "No letters yet. Add one above." }));
  } catch (err) {
    list.replaceChildren(el("li", { className: "error", textContent: err.message }));
  }
}

$("sent-date").value = today();

$("letter-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  let text = await file.text();
  // Use a "Date: YYYY-MM-DD" first line for the sent date, if the file has one.
  const m = text.match(/^\s*date:\s*(\d{4}-\d{2}-\d{2})\s*\r?\n/i);
  if (m) {
    $("sent-date").value = m[1];
    text = text.slice(m[0].length);
  }
  $("letter-text").value = text.trim();
});

$("letter-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("letter-status");
  const button = e.submitter;
  button.disabled = true;
  status.className = "muted";
  status.textContent = "Saving and reading dates…";
  try {
    const res = await api("/api/letters", { method: "POST", body: { text: $("letter-text").value, sentDate: $("sent-date").value } });
    status.textContent = res.warning ?? `Saved as ${res.id}. Its dates are now on the Dates tab.`;
    $("letter-text").value = "";
    $("letter-file").value = "";
    $("sent-date").value = today();
    loadLetters();
  } catch (err) {
    status.className = "error";
    status.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

// --- start ------------------------------------------------------------------------------

api("/api/me")
  .then((me) => (me.authenticated ? showApp(me) : showLogin()))
  .catch(() => showLogin());
