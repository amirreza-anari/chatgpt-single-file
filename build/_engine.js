<script>
"use strict";
/* =========================================================================
   ChatGPT clone — one file, no dependencies, no build step.
   Visual tokens measured from the live chatgpt.com UI over CDP.
   ========================================================================= */

const LS_KEY = "chatgpt-clone:v2";
const DEFAULTS = {
  apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini",
  system: "You are a helpful assistant.", temperature: 1, maxTokens: "", theme: "dark",
  models: [], think: "off"
};
const THINK_PROMPTS = {
  low: "Think briefly before answering: weigh the obvious options, then answer.",
  medium: "Think carefully before answering: consider alternatives and check your reasoning before you reply.",
  high: "Think deeply before answering: break the problem down, state your assumptions, check each step, and verify the result before you reply."
};

let state = { settings: {...DEFAULTS}, chats: [], activeId: null };
let controller = null, streaming = false, renderQueued = false;
let attachments = [];                 // [{name, kind:"text"|"image", text?, dataUrl?}]
let composerNode = null;             // held by reference, never re-looked-up

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const $ = (id) => document.getElementById(id);

/* ================================ state ================================ */
function load(){
  try{
    const raw = localStorage.getItem(LS_KEY) || localStorage.getItem("chatgpt-clone:v1");
    if(raw){
      const p = JSON.parse(raw);
      state.settings = {...DEFAULTS, ...(p.settings || {})};
      state.chats = Array.isArray(p.chats) ? p.chats : [];
      state.activeId = p.activeId || null;
    ensureModels();
    }
  }catch(e){ console.warn("Could not read saved state:", e); }
  state.chats = state.chats.filter(c => c && Array.isArray(c.messages));
  if(!state.chats.length) state.chats = [newChat()];
  if(!state.chats.some(c => c.id === state.activeId)) state.activeId = state.chats[0].id;
}
function save(){
  try{
    localStorage.setItem(LS_KEY, JSON.stringify({
      settings: state.settings,
      chats: state.chats.map(c => ({ id:c.id, title:c.title, createdAt:c.createdAt, messages:c.messages })),
      activeId: state.activeId
    }));
  }catch(e){ toast("Could not save (storage full or blocked)"); }
}
const newChat = () => ({ id: uid(), title: "New chat", createdAt: Date.now(), messages: [] });
const activeChat = () => state.chats.find(c => c.id === state.activeId) || state.chats[0];

/* ==========================================================================
   Markdown — escape first, shelter code, then inline, then blocks.
   ========================================================================== */
function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
const PH = "\u0001";
const rePlaceholder = new RegExp(PH + "(C|I)(\\d+)" + PH, "g");

function renderMarkdown(src){
  if(!src) return "";
  let text = String(src).replace(/[\u0000\u0001\u0002]/g, "");
  text = esc(text);

  const blocks = [];
  const pushBlock = (lang, code) => {
    blocks.push({ lang:(lang||"").trim().replace(/^\{|\}$/g,""), code: code.replace(/\n+$/, "") });
    return PH + "C" + (blocks.length - 1) + PH;
  };
  text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m, lang, code) => pushBlock(lang, code));
  // an unterminated fence (still arriving mid-stream) renders as a code block
  text = text.replace(/```([^\n`]*)\n?([\s\S]*)$/, (m, lang, code) => pushBlock(lang, code));

  const inlines = [];
  text = text.replace(/`([^`\n]+)`/g, (m, code) => { inlines.push(code); return PH + "I" + (inlines.length - 1) + PH; });

  text = text
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  const html = renderBlocks(text.split("\n"), blocks);
  return html.replace(rePlaceholder, (m, kind, idx) =>
    kind === "I" ? '<code class="inline">' + inlines[+idx] + "</code>" : codeBlockHtml(blocks[+idx]));
}

/* Block pass. Its lines arrive already escaped and inline-formatted, so a
   nested call (blockquote) must NOT escape or inline-process them again. */
function renderBlocks(lines, blocks){
  const out = [];
  let i = 0, para = [];
  const flushPara = () => { if(para.length){ out.push("<p>" + para.join("<br>") + "</p>"); para = []; } };

  while(i < lines.length){
    const line = lines[i];
    if(!line.trim()){ flushPara(); i++; continue; }
    let m;

    if((m = line.match(/^\s*```?\s*$/))){ flushPara(); i++; continue; }
    if((m = line.match(new RegExp("^\\s*" + PH + "C(\\d+)" + PH + "\\s*$")))){
      flushPara(); out.push(codeBlockHtml(blocks[+m[1]])); i++; continue;
    }
    if((m = line.match(/^(#{1,6})\s+(.*)$/))){
      flushPara();
      const lv = Math.min(m[1].length, 4);
      out.push("<h" + lv + ">" + m[2].replace(/\s+#+\s*$/, "") + "</h" + lv + ">");
      i++; continue;
    }
    if(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)){ flushPara(); out.push("<hr>"); i++; continue; }
    if(/^\s*&gt;/.test(line)){
      flushPara();
      const buf = [];
      while(i < lines.length && (/^\s*&gt;/.test(lines[i]) || (buf.length && lines[i].trim()))){
        buf.push(lines[i].replace(/^\s*&gt;\s?/, "")); i++;
      }
      out.push("<blockquote>" + renderBlocks(buf, blocks) + "</blockquote>");
      continue;
    }
    if(isTableStart(lines, i)){
      flushPara();
      const tbl = [];
      while(i < lines.length && lines[i].includes("|") && lines[i].trim()){ tbl.push(lines[i]); i++; }
      out.push(tableHtml(tbl));
      continue;
    }
    if(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(line)){
      flushPara();
      const items = [];
      while(i < lines.length && /^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(lines[i])){
        const raw = lines[i];
        const ind = raw.match(/^\s*/)[0].replace(/\t/g, "    ").length;
        const om = raw.match(/^\s*(\d{1,9})[.)]\s+(.*)$/);
        items.push({ indent: ind, ordered: !!om, num: om ? +om[1] : null, text: om ? om[2] : raw.replace(/^\s*[-*+]\s+/, "") });
        i++;
      }
      out.push(listHtml(items));
      continue;
    }
    para.push(line.replace(/\s+$/, ""));
    i++;
  }
  flushPara();
  return out.join("\n");
}
function codeBlockHtml(b){
  if(!b) return "";
  const lang = b.lang || "text";
  return '<div class="code-wrap"><div class="code-head"><span>' + esc(lang) + '</span>'
       + '<button type="button" class="copy" data-copy><svg width="13" height="13"><use href="#i-copy"/></svg>Copy</button></div>'
       + '<pre><code data-lang="' + esc(lang) + '">' + b.code + "</code></pre></div>";
}
function isTableStart(lines, i){
  if(!lines[i] || !lines[i].includes("|")) return false;
  const nxt = lines[i + 1];
  return !!nxt && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(nxt) && nxt.includes("-");
}
function tableHtml(rows){
  const cells = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/)
    .map(c => c.trim().replace(/\\\|/g, "|"));
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  let h = "<table><thead><tr>" + head.map(c => "<th>" + c + "</th>").join("") + "</tr></thead><tbody>";
  h += body.map(r => "<tr>" + head.map((_, k) => "<td>" + (r[k] ?? "") + "</td>").join("") + "</tr>").join("");
  return h + "</tbody></table>";
}
function listHtml(items){
  const min = Math.min(...items.map(it => it.indent));
  const groups = []; let cur = null;
  for(const it of items){
    if(it.indent <= min + 1){ cur = { ordered: it.ordered, num: it.num, text: it.text, kids: [] }; groups.push(cur); }
    else if(cur) cur.kids.push(it);
  }
  const start = groups.length && groups[0].ordered && groups[0].num && groups[0].num !== 1
    ? ' start="' + groups[0].num + '"' : "";
  const tag = groups[0] && groups[0].ordered ? "ol" : "ul";
  const rendered = groups.map(g => {
    const inner = g.kids.length ? listHtml(g.kids) : "";
    const text = inner ? g.text.split(/\n{2,}/).map(p => "<p>" + p + "</p>").join("") : g.text;
    return "<li>" + text + inner + "</li>";
  }).join("");
  return tag === "ol" ? "<ol" + start + ">" + rendered + "</ol>" : "<ul>" + rendered + "</ul>";
}

/* ==========================================================================
   Transport
   ========================================================================== */
async function callAPI(messages, onDelta, signal){
  const s = state.settings;
  const base = (s.baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, "");
  const url = base + "/chat/completions";
  if(!s.apiKey.trim()) throw new Error("NO_KEY");

  const payload = { model: s.model || DEFAULTS.model, messages, stream: true, temperature: Number(s.temperature) };
  if(String(s.maxTokens).trim() && !isNaN(+s.maxTokens)) payload.max_tokens = +s.maxTokens;

  let res;
  try{
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.apiKey.trim() },
      body: JSON.stringify(payload),
      signal
    });
  }catch(err){
    if(err && err.name === "AbortError") throw err;
    // A CORS refusal and an unreachable host look identical to fetch(). Probe
    // the host with a plain request to find out which one it really is.
    let reachable = false;
    try{
      const opts = { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: "{}" };
      if(typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(8000);
      await fetch(url, opts);
      reachable = true;
    }catch(e2){ reachable = false; }
    const e = new Error(reachable ? "CORS" : "NETWORK");
    e.detail = reachable
      ? "The host answered a plain request, so it is running — but it refused the browser's CORS preflight.\n"
      + "Request:  OPTIONS " + url + "\n"
      + "Needs:    Access-Control-Allow-Origin: *   (or the exact page origin)\n"
      + "          Access-Control-Allow-Headers: authorization, content-type\n"
      : "No response from " + url + "\n";
    throw e;
  }

  if(!res.ok){
    let detail = "";
    try{ detail = await res.text(); }catch(e){}
    const e = new Error("HTTP " + res.status + " " + res.statusText);
    e.status = res.status; e.detail = detail.slice(0, 1200);
    throw e;
  }

  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if(ctype.includes("application/json") || !res.body){
    // provider ignored stream:true — read the whole answer at once
    const data = await res.json();
    if(data.error) throw new Error("API: " + (data.error.message || JSON.stringify(data.error)));
    const text = data.choices?.[0]?.message?.content ?? "";
    if(text) onDelta(text);
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  while(true){
    const { done, value } = await reader.read();
    if(done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for(const raw of lines){
      const line = raw.trim();
      if(!line || line.startsWith(":") || !line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if(data === "[DONE]") return;
      let j;
      try{ j = JSON.parse(data); }catch(e){ continue; }
      if(j.error) throw new Error("API: " + (j.error.message || JSON.stringify(j.error)));
      const d = j.choices && j.choices[0];
      const piece = d && ((d.delta && d.delta.content) || (d.message && d.message.content) || d.text);
      if(piece) onDelta(piece);
      if(d && d.finish_reason === "error") throw new Error("The model stopped with an error.");
    }
  }
}

/* ==========================================================================
   Render
   ========================================================================== */
const view = () => $("view");

function renderAll(){ renderSidebar(); renderMain(); placeComposer(); syncChrome(); }

function renderSidebar(){
  const list = $("chatList");
  list.innerHTML = "";
  if(!state.chats.length){ list.innerHTML = '<div class="sb-empty">No chats yet</div>'; return; }
  // an empty chat is not a conversation: the real sidebar only lists chats with turns
  const shown = state.chats.filter(c => c.messages.length);
  if(!shown.length) list.innerHTML = '<div class="sb-empty">No chats yet</div>';
  $("newChatBtn").classList.toggle("active", !activeChat().messages.length);
  for(const c of shown){
    const el = document.createElement("div");
    el.className = "chat-item" + (c.id === state.activeId ? " active" : "");
    el.innerHTML = '<span class="title"></span><span class="acts">' +
      '<button type="button" data-act="rename" title="Rename"><svg width="14" height="14"><use href="#i-pen"/></svg></button>' +
      '<button type="button" data-act="delete" title="Delete"><svg width="14" height="14"><use href="#i-trash"/></svg></button></span>';
    el.querySelector(".title").textContent = c.title;
    el.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]");
      if(act){
        e.stopPropagation();
        if(act.dataset.act === "delete") deleteChat(c.id); else startRename(el, c);
        return;
      }
      if(c.id !== state.activeId){ abortStream(); state.activeId = c.id; save(); renderAll(); focusInput(); }
      else if(window.innerWidth <= 820) closeSidebar();
    });
    list.appendChild(el);
  }
}
function startRename(el, chat){
  const titleEl = el.querySelector(".title");
  const input = document.createElement("input");
  input.value = chat.title;
  titleEl.replaceWith(input);
  input.focus(); input.select();
  const commit = (ok) => { if(ok && input.value.trim()) chat.title = input.value.trim().slice(0,120); save(); renderSidebar(); };
  input.addEventListener("keydown", e => {
    if(e.key === "Enter"){ e.preventDefault(); commit(true); }
    if(e.key === "Escape"){ e.preventDefault(); commit(false); }
  });
  input.addEventListener("blur", () => commit(true));
  input.addEventListener("click", e => e.stopPropagation());
}
function deleteChat(id){
  const idx = state.chats.findIndex(c => c.id === id);
  if(idx < 0) return;
  state.chats.splice(idx, 1);
  if(!state.chats.length) state.chats.push(newChat());
  if(state.activeId === id){ abortStream(); state.activeId = state.chats[Math.max(0, idx - 1)].id; }
  save(); renderAll(); toast("Chat deleted");
}

function msgHtml(m){
  if(m.role === "user"){
    const imgs = (m.images && m.images.length)
      ? '<div class="bub-imgs">' + m.images.map((u, i) => '<img src="' + u + '" alt="Attached image ' + (i + 1) + '">').join("") + "</div>"
      : "";
    const txt = String(m.content || "").trim() ? '<div class="bub-text">' + esc(m.content).replace(/\n/g, "<br>") + "</div>" : "";
    return '<div class="msg user" data-id="' + m.id + '">' +
      '<div class="bubble' + (imgs && !txt ? " only-img" : "") + '">' + imgs + txt + "</div>" +
      '<div class="msg-actions"><button type="button" data-a="edit" title="Edit"><svg><use href="#i-edit"/></svg></button></div></div>';
  }
  const body = m.error ? errorHtml(m.error)
    : '<div class="md">' + (m.streaming && !m.content
        ? '<span class="pend"></span>'
        : renderMarkdown(m.content) + (m.streaming ? '<span class="pend pend-inline"></span>' : "")) + "</div>";
  const actions = m.error ? "" :
    '<div class="msg-actions">'
    + '<button type="button" data-a="copy" title="Copy"><svg><use href="#i-copy"/></svg></button>'
    + '<button type="button" data-a="regen" title="Regenerate"><svg><use href="#i-redo"/></svg></button>'
    + "</div>";
  return '<div class="msg assistant" data-id="' + m.id + '"><div class="body">' + body + actions + "</div></div>";
}
function errorHtml(err){
  const msg = (err && err.message) ? err.message : "Something went wrong.";
  let title = "Something went wrong", hint = "", code = "", fixes = "";
  if(msg === "NO_KEY"){
    title = "No API key set";
    hint = "Open Settings and paste an API key to start chatting.";
    fixes = '<button type="button" data-fix="settings">Open settings</button>';
  } else if(msg === "CORS"){
    title = "This endpoint refuses browser requests (CORS)";
    hint = "The host is reachable, but it refused the browser's CORS preflight, so your request was never sent. "
         + "That has to be fixed on the server: it must answer <code>OPTIONS</code> with an <code>Access-Control-Allow-Origin</code> header. "
         + "A local model server usually has a CORS/allowed-origins setting to switch on. "
         + "Hosted providers such as OpenAI and OpenRouter already allow this.";
    code = err.detail || "";
    fixes = '<button type="button" data-fix="settings">Check the base URL</button>'
          + '<button type="button" data-fix="retry">Try again</button>';
  } else if(msg === "NETWORK"){
    title = "Could not reach the API";
    hint = "Nothing answered at that address. Check that the server is running, the port is right, "
         + "and the base URL includes the version path (for example <code>/v1</code>).";
    code = err.detail || "";
    fixes = '<button type="button" data-fix="settings">Check settings</button>'
          + '<button type="button" data-fix="retry">Try again</button>';
  } else if(/^HTTP 401|^HTTP 403/.test(msg)){
    title = "The API rejected your key";
    hint = "The key is missing, wrong, or has no access to this model.";
    code = err.detail || "";
    fixes = '<button type="button" data-fix="settings">Open settings</button>';
  } else if(/^HTTP 404/.test(msg)){
    title = "Endpoint not found (404)";
    hint = "The base URL is usually the folder containing <code>/chat/completions</code> — for OpenAI that is <code>https://api.openai.com/v1</code>.";
    code = err.detail || "";
    fixes = '<button type="button" data-fix="settings">Open settings</button>';
  } else if(/^HTTP 429/.test(msg)){
    title = "Rate limited or out of quota";
    hint = "Wait a moment, or check your plan and billing with the provider.";
    code = err.detail || "";
  } else if(msg.startsWith("HTTP")){
    hint = "The provider returned an error. Raw response below.";
    code = err.detail || "";
  } else if(msg.startsWith("API:")){
    hint = msg.slice(4).trim();
  }
  return '<div class="error-box"><b>' + esc(title) + "</b>"
    + (hint ? '<div class="hint">' + hint + "</div>" : "")
    + (code ? "<pre>" + esc(code) + "</pre>" : "")
    + (fixes ? '<div class="fix">' + fixes + "</div>" : "")
    + "</div>";
}

function renderMain(){
  const chat = activeChat();
  const box = view();
  if(!chat.messages.length){
    box.className = "stage";
    box.innerHTML = '<div class="hero"><h1 class="greet"></h1>'
      + '<div class="composer-hold" id="composerHold"></div>'
      + '</div>';
    box.querySelector(".greet").textContent = GREETING;
    return;
  }
  box.className = "thread";
  box.innerHTML = '<div class="thread-inner">' + chat.messages.map(msgHtml).join("") + "</div>";
}
/* The composer is one node: inside the centered hero while the chat is empty,
   in the bottom slot once it has messages. It must be moved by REFERENCE:
   renderMain() rebuilds #view, which destroys the hero holder and detaches the
   composer with it, so a getElementById lookup at this point returns null and
   the composer would be lost for good. */
function placeComposer(){
  const node = composerNode;
  if(!node) return;
  const hold = $("composerHold");
  const host = $("composerHost");
  if(hold){ if(node.parentElement !== hold) hold.appendChild(node); }
  else if(host){ if(node.parentElement !== host) host.appendChild(node); }
}

function syncChrome(){
  const s = state.settings;
  document.documentElement.dataset.theme = s.theme;
  // footer: which model answers, and whether there is a key behind it
  const key = !!String(s.apiKey || "").trim();
  const pick = $("modelPickName");
  if(pick) pick.textContent = s.model || DEFAULTS.model;
  const stat = $("modelStat");
  if(stat){
    const name = s.model || DEFAULTS.model;
    stat.classList.toggle("off", !key);
    stat.title = key ? name + " via " + s.baseUrl : "Add an API key to start";
    $("mName").textContent = name;
    $("mSub").textContent = key ? "Connected" : "No API key";
    $("modelStat").dataset.initial = (name || "?").trim().charAt(0).toUpperCase();   // collapsed-rail monogram
  }
  // the real app only offers Share once there is something to share
  if($("exportBtn")) $("exportBtn").style.display = activeChat().messages.length ? "" : "none";
}

/* ==========================================================================
   Sending
   ========================================================================== */
function buildRequest(chat){
  const msgs = [];
  let sys = (state.settings.system || "").trim();
  const think = THINK_PROMPTS[state.settings.think || "off"];
  if(think) sys = (sys ? sys + String.fromCharCode(10, 10) : "") + think;
  if(sys) msgs.push({ role: "system", content: sys });
  for(const m of chat.messages){
    if(m.error || m.streaming) continue;
    const text = String(m.content || "");
    const imgs = m.images || [];
    if(!text.trim() && !imgs.length) continue;
    if(imgs.length){
      const parts = [];
      if(text.trim()) parts.push({ type: "text", text });
      for(const url of imgs) parts.push({ type: "image_url", image_url: { url } });
      msgs.push({ role: m.role, content: parts });
    } else {
      msgs.push({ role: m.role, content: text });
    }
  }
  return msgs;
}
async function runStream(chat, assistantMsg){
  streaming = true;
  controller = new AbortController();
  setSendingUI(true);
  let acc = "", errored = false;
  try{
    await callAPI(buildRequest(chat), (piece) => {
      acc += piece;
      assistantMsg.content = acc;
      patchStreamingMessage(assistantMsg);
    }, controller.signal);
  }catch(err){
    if(err && err.name === "AbortError"){
      if(!acc) chat.messages = chat.messages.filter(m => m.id !== assistantMsg.id);
      else assistantMsg.content = acc + "\n\n_(stopped)_";
    } else {
      errored = true;
      if(!acc) chat.messages = chat.messages.filter(m => m.id !== assistantMsg.id);
      chat.messages.push({ id: uid(), role: "assistant", content: "",
        error: { message: (err && err.message) || String(err), detail: (err && err.detail) || "" }, ts: Date.now() });
      if(err && (err.message === "NO_KEY" || /^HTTP 40[13]/.test(err.message))) openSettings();
    }
  }finally{
    streaming = false; controller = null; setSendingUI(false);
    const live = chat.messages.find(m => m.id === assistantMsg.id);
    if(live){
      live.streaming = false;
      if(!live.content && !errored) chat.messages = chat.messages.filter(m => m.id !== live.id);
    }
    save(); renderMain(); placeComposer(); renderSidebar(); scrollToBottom(true);
  }
}
/* Throttled patch of just the in-flight message: re-rendering the whole thread
   on every token is quadratic and visibly stutters. */
function patchStreamingMessage(msg){
  if(renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if(!msg.streaming) return;      // a late frame must never mark a finished message
    const target = document.querySelector('.msg[data-id="' + msg.id + '"] .md');
    if(!target) return;
    const stick = isNearBottom();
    target.innerHTML = msg.content
      ? renderMarkdown(msg.content) + '<span class="pend pend-inline"></span>'
      : '<span class="pend"></span>';
    if(stick) scrollToBottom();
  });
}
function send(){
  const input = $("input");
  const text = input.value.trim();
  if((!text && !attachments.length) || streaming) return;
  const chat = activeChat();
  const files = attachments.filter(a => a.kind !== "image");
  const imgs = attachments.filter(a => a.kind === "image").map(a => a.dataUrl);
  const withFiles = files.length
    ? (text ? text + "\n\n" : "") + files.map(a => "**" + a.name + "**\n\n```\n" + a.text.replace(/```/g, "`\u200b``") + "\n```").join("\n\n")
    : text;
  if(!chat.messages.length) chat.title = titleFor(text || (attachments[0] && attachments[0].name) || "Image");
  chat.messages.push({ id: uid(), role: "user", content: withFiles, images: imgs.length ? imgs : undefined, ts: Date.now() });
  input.value = ""; attachments = []; renderAttachments(); autoGrow(); updateSendState();
  const assistantMsg = { id: uid(), role: "assistant", content: "", streaming: true, ts: Date.now() };
  chat.messages.push(assistantMsg);
  save(); renderMain(); placeComposer(); renderSidebar(); scrollToBottom(true);
  runStream(chat, assistantMsg);
}
function titleFor(text){
  const t = text.replace(/\s+/g, " ").trim();
  return (t.length > 48 ? t.slice(0, 48).trimEnd() + "…" : t) || "New chat";
}
function regenerate(msgId){
  if(streaming) return;
  const chat = activeChat();
  const idx = chat.messages.findIndex(m => m.id === msgId);
  if(idx < 0) return;
  chat.messages = chat.messages.slice(0, idx);
  const assistantMsg = { id: uid(), role: "assistant", content: "", streaming: true, ts: Date.now() };
  chat.messages.push(assistantMsg);
  save(); renderMain(); placeComposer(); scrollToBottom(true);
  runStream(chat, assistantMsg);
}
function abortStream(){
  if(controller){ try{ controller.abort(); }catch(e){} }
  streaming = false; setSendingUI(false);
}
function setSendingUI(on){
  const btn = $("sendBtn");
  if(!btn) return;
  btn.classList.toggle("stop", on);
  btn.innerHTML = on
    ? '<svg width="20" height="20"><use href="#i-stop"/></svg>'
    : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19.5V5"/><path d="M5.5 11.5l6.5-6.5 6.5 6.5"/></svg>';
  btn.title = on ? "Stop generating" : "Send";
  if(on){ btn.disabled = false; } else { updateSendState(); }
}

/* ============================ composer helpers ============================ */
function autoGrow(){
  const el = $("input");
  if(!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 220) + "px";
}
function updateSendState(){
  const el = $("input"), btn = $("sendBtn");
  if(!el || !btn) return;
  const has = !!(el.value.trim().length || attachments.length);
  if(!streaming){
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19.5V5"/><path d="M5.5 11.5l6.5-6.5 6.5 6.5"/></svg>';
    btn.title = "Send";
    btn.setAttribute("aria-label", "Send message");
    btn.disabled = !has;
  } else {
    btn.disabled = false;
  }
}
/* Downscale to 1024 px on the long edge: vision models do not need more, and the
   data URL ends up inside localStorage with the chat. */
function readImage(file){
  return new Promise((resolve, reject) => {
    const blobUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try{
        const max = 1024;
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * k));
        const h = Math.max(1, Math.round(img.naturalHeight * k));
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);   // JPEG has no alpha
        ctx.drawImage(img, 0, 0, w, h);
        let q = 0.85, data = c.toDataURL("image/jpeg", q);
        while(data.length > 900000 && q > 0.45){ q -= 0.1; data = c.toDataURL("image/jpeg", q); }
        URL.revokeObjectURL(blobUrl);
        resolve({ name: file.name, kind: "image", dataUrl: data, w, h });
      }catch(err){ URL.revokeObjectURL(blobUrl); reject(err); }
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error("not an image")); };
    img.src = blobUrl;
  });
}
function renderAttachments(){
  const row = $("attachRow");
  if(!row) return;
  row.innerHTML = "";
  attachments.forEach((a, i) => {
    const chip = document.createElement("span");
    const isImg = a.kind === "image";
    chip.className = "attach-chip" + (isImg ? " img" : "");
    chip.innerHTML = (isImg ? '<img alt="">' : "") + '<b></b><button type="button" aria-label="Remove attachment"><svg width="13" height="13"><use href="#i-x"/></svg></button>';
    if(isImg) chip.querySelector("img").src = a.dataUrl;
    chip.querySelector("b").textContent = a.name;
    chip.querySelector("button").addEventListener("click", () => { attachments.splice(i, 1); renderAttachments(); updateSendState(); });
    row.appendChild(chip);
  });
}
function scrollToBottom(instant){
  const sc = $("scroll");
  if(instant){
    const prev = sc.style.scrollBehavior;
    sc.style.scrollBehavior = "auto";
    sc.scrollTop = sc.scrollHeight;
    sc.style.scrollBehavior = prev || "";
  } else sc.scrollTop = sc.scrollHeight;
}
function isNearBottom(){
  const sc = $("scroll");
  return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
}

/* ============================ sidebar / modals ============================ */
function openSidebar(){ $("sidebar").classList.remove("collapsed", "rail"); if(window.matchMedia("(max-width: 820px)").matches) $("scrim").classList.add("on"); }
function closeSidebar(){
  $("sidebar").classList.add("collapsed"); $("scrim").classList.remove("on");
}
function applyLayout(){
  const narrow = window.matchMedia("(max-width: 820px)").matches;
  $("openSidebarBtn").style.display = narrow ? "" : "none";
  const sb = $("sidebar");
  if(narrow){
    sb.classList.remove("rail");
    sb.classList.add("collapsed");
    $("scrim").classList.remove("on");
  } else {
    sb.classList.remove("collapsed");
    $("scrim").classList.remove("on");
  }
}
function openSettings(pane){
  const s = state.settings;
  $("sKey").value = s.apiKey; $("sBase").value = s.baseUrl;
  $("sSystem").value = s.system; $("sTemp").value = s.temperature;
  $("sTempVal").textContent = Number(s.temperature).toFixed(1);
  $("sMaxtok").value = s.maxTokens ?? "";
  $("sTheme").value = s.theme || "dark";
  $("settingsModal").classList.add("on");
  showPane(pane || "model");
  ensureModels(); renderModelSettings();
  setTimeout(() => { if(pane === "appearance") return; (s.apiKey ? $("sBase") : $("sKey")).focus(); }, 40);
}
function closeSettings(){ $("settingsModal").classList.remove("on"); }
function readSettingsForm(){
  return {
    apiKey: $("sKey").value.trim(),
    baseUrl: $("sBase").value.trim() || DEFAULTS.baseUrl,
    system: $("sSystem").value,
    temperature: +$("sTemp").value,
    maxTokens: $("sMaxtok").value.trim()
  };
}
function saveSettings(){
  Object.assign(state.settings, readSettingsForm());
  ensureModels();
  save(); syncChrome(); renderMain(); placeComposer(); renderModelMenu(); renderModelSettings();
  closeSettings(); toast("Settings saved"); focusInput();
  if(state.settings.apiKey.trim() && state.settings.system.trim() && !activeChat().messages.length){ /* ready */ }
}
/* Probe the configured endpoint the same way the app will, and report the
   answer in plain words — including the CORS case. */
async function testConnection(){
  const cfg = readSettingsForm();
  const model = state.settings.model || DEFAULTS.model;   // readSettingsForm has no model field
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const btn = $("testConnBtn");
  btn.disabled = true; btn.textContent = "Testing…";
  const finish = (t) => { btn.disabled = false; btn.textContent = "Test connection"; toast(t); };
  /* Same body a real message sends — a probe built differently can 400 on a
     provider that answers messages fine (missing model, max_tokens too small). */
  const payload = (stream) => {
    const body = { model, messages: [{ role: "user", content: "ping" }], stream: !!stream };
    if(isFinite(cfg.temperature)) body.temperature = cfg.temperature;
    if(cfg.maxTokens) body.max_tokens = +cfg.maxTokens;
    return body;
  };
  const post = (stream) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (cfg.apiKey || "none") },
    body: JSON.stringify(payload(stream))
  });
  const why = async (res) => {          // the provider's own words beat our guess
    try{
      const raw = await res.text();
      try{
        const j = JSON.parse(raw);
        const m = (j.error && (j.error.message || j.error.type)) || j.message || j.detail;
        if(m) return String(m).slice(0, 200);
      }catch(e){ if(raw) return raw.slice(0, 200); }
    }catch(e){}
    return "";
  };
  try{
    let res = await post(false);
    let detail = res.ok ? "" : await why(res);
    if(!res.ok && res.status === 400 && /stream/i.test(detail)){   // streaming-only endpoints
      res = await post(true);
      detail = res.ok ? "" : await why(res);
    }
    if(res.ok) finish("Connected — " + model + " answered.");
    else if(res.status === 401 || res.status === 403) finish("Reachable, but this key was rejected (" + res.status + ")" + (detail ? ": " + detail : "."));
    else if(res.status === 404) finish("Reachable, but /chat/completions was not found — check the base URL.");
    else finish("Reachable, but the provider returned HTTP " + res.status + (detail ? ": " + detail : "."));
  }catch(err){
    let reachable = false;
    try{
      const o = { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: "{}" };
      if(AbortSignal.timeout) o.signal = AbortSignal.timeout(6000);
      await fetch(url, o); reachable = true;
    }catch(e2){ reachable = false; }
    finish(reachable
      ? "Server is up, but it blocks browser requests (CORS). Enable CORS on it, or use a provider that allows it."
      : "Nothing answered at " + url + " — check the host, port and /v1 path.");
  }
}
/* ---- models: one list, one current pick, shown in the top bar ---- */
function ensureModels(){
  const s = state.settings;
  if(!Array.isArray(s.models)) s.models = [];
  s.models = s.models.filter(m => typeof m === "string" && m.trim()).map(m => m.trim());
  if(s.model && !s.models.includes(s.model)) s.models.unshift(s.model);
  if(!s.models.length && DEFAULTS.model) s.models = [DEFAULTS.model];
  if(!s.model) s.model = s.models[0];
}
function setModel(name){
  if(!name) return;
  state.settings.model = name;
  ensureModels(); save(); syncChrome(); renderModelMenu(); renderModelSettings();
}
function addModel(name){
  name = String(name || "").trim();
  if(!name) return;
  ensureModels();
  if(!state.settings.models.includes(name)) state.settings.models.push(name);
  state.settings.model = name;
  save(); syncChrome(); renderModelMenu(); renderModelSettings();
  toast("Added " + name);
}
function removeModel(name){
  const s = state.settings;
  s.models = s.models.filter(m => m !== name);
  if(!s.models.length){
    ensureModels();
    toast("Keep at least one model");
  } else if(s.model === name){
    s.model = s.models[0];
  }
  save(); syncChrome(); renderModelMenu(); renderModelSettings();
}
function renderModelMenu(){
  const menu = $("modelMenu");
  if(!menu) return;
  ensureModels();
  const s = state.settings;
  menu.innerHTML = s.models.map(m =>
    '<button type="button" class="mp-item" data-model="' + esc(m) + '"><span class="n">' + esc(m) + "</span>"
    + (m === s.model ? '<svg><use href="#i-check"/></svg>' : "") + "</button>").join("")
    + '<div class="mp-sep"></div>'
    + '<button type="button" class="mp-item" id="mpManage"><span class="n">Manage models…</span></button>';
  menu.querySelectorAll("[data-model]").forEach(b => b.addEventListener("click", () => { setModel(b.dataset.model); closeModelMenu(); }));
  $("mpManage").addEventListener("click", () => { closeModelMenu(); openSettings("model"); });
}
function openModelMenu(){
  renderModelMenu();
  $("modelMenu").classList.add("on");
  $("modelPickBtn").setAttribute("aria-expanded", "true");
}
function closeModelMenu(){
  const m = $("modelMenu");
  if(!m) return;
  m.classList.remove("on");
  $("modelPickBtn").setAttribute("aria-expanded", "false");
}
function renderModelSettings(){
  const list = $("modelList");
  if(!list) return;
  ensureModels();
  const s = state.settings;
  list.innerHTML = s.models.map(m =>
    '<div class="mrow"><span class="n">' + esc(m) + "</span>"
    + (m === s.model
        ? '<span class="tag">in use</span>'
        : '<button type="button" data-use="' + esc(m) + '">Use</button>')
    + '<button type="button" data-del="' + esc(m) + '" title="Remove model" aria-label="Remove ' + esc(m) + '">'
    + '<svg width="15" height="15"><use href="#i-x"/></svg></button></div>').join("")
    || '<div class="mrow"><span class="n" style="color:var(--text-3)">No models yet — add one below.</span></div>';
  list.querySelectorAll("[data-use]").forEach(b => b.addEventListener("click", () => setModel(b.dataset.use)));
  list.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => removeModel(b.dataset.del)));
}

/* ============================ export / clipboard / toast ============================ */
function exportChat(){
  const chat = activeChat();
  if(!chat.messages.length) return toast("Nothing to export yet");
  const md = "# " + chat.title + "\n\n" + chat.messages.map(m =>
    (m.role === "user" ? "## You\n\n" : "## ChatGPT\n\n") +
    (m.error ? "_[error: " + m.error.message + "]_" : m.content)).join("\n\n---\n\n");
  const blob = new Blob([md], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (chat.title.replace(/[^\w\s-]/g, "").trim().slice(0, 60).replace(/\s+/g, "-").toLowerCase() || "chat") + ".md";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("Exported as Markdown");
}
async function copyText(text, btn){
  try{ await navigator.clipboard.writeText(text); }
  catch(e){
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try{ document.execCommand("copy"); }catch(e2){ toast("Copy failed — select the text manually"); }
    ta.remove();
  }
  if(btn){
    const html = btn.innerHTML;
    btn.innerHTML = '<svg width="13" height="13"><use href="#i-check"/></svg>Copied';
    setTimeout(() => { btn.innerHTML = html; }, 1300);
  }
}
let toastTimer = null;
function toast(msg){
  const t = $("toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 2600);
}
function focusInput(){ if(window.innerWidth > 820 && $("input")) $("input").focus(); }

/* ================================ edit ================================ */
function startEdit(wrap, msg, chat){
  const body = wrap.querySelector(".bubble");
  const original = body.innerHTML;
  const holder = document.createElement("div");
  holder.className = "edit-wrap";
  holder.innerHTML = '<textarea rows="1" spellcheck="false"></textarea>'
    + '<div class="edit-row"><button type="button" data-cancel>Cancel</button>'
    + '<button type="button" class="save" data-save>Send</button></div>';
  body.replaceWith(holder);
  wrap.classList.add("editing");
  const ta = holder.querySelector("textarea");
  ta.value = msg.content;
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.style.height = Math.min(ta.scrollHeight, 300) + "px";
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 300) + "px"; });
  const cancel = () => { holder.replaceWith(body); body.innerHTML = original; wrap.classList.remove("editing"); };
  holder.querySelector("[data-cancel]").addEventListener("click", cancel);
  holder.querySelector("[data-save]").addEventListener("click", () => {
    const text = ta.value.trim();
    if(!text) return cancel();
    wrap.classList.remove("editing");
    const idx = chat.messages.findIndex(m => m.id === msg.id);
    abortStream();
    chat.messages = chat.messages.slice(0, idx);
    chat.messages.push({ id: uid(), role: "user", content: text, ts: Date.now() });
    if(idx === 0) chat.title = titleFor(text);
    const assistantMsg = { id: uid(), role: "assistant", content: "", streaming: true, ts: Date.now() };
    chat.messages.push(assistantMsg);
    save(); renderMain(); placeComposer(); renderSidebar(); scrollToBottom(true);
    runStream(chat, assistantMsg);
  });
  ta.addEventListener("keydown", (e) => {
    if(e.key === "Enter" && !e.shiftKey){ e.preventDefault(); holder.querySelector("[data-save]").click(); }
    if(e.key === "Escape") cancel();
  });
}

/* ================================ boot ================================ */
function buildComposer(){
  const tpl = $("composerTemplate");
  const node = tpl.firstElementChild.cloneNode(true);
  node.removeAttribute("id");
  node.id = "composerInline";
  $("composerHost").appendChild(node);
  tpl.remove();               // no duplicate ids left in the document
  composerNode = node;
  return node;
}

function wire(){
  const input = $("input");
  input.addEventListener("input", () => { autoGrow(); updateSendState(); });
  input.addEventListener("keydown", (e) => {
    if(e.key === "Enter" && !e.shiftKey && !e.isComposing){
      e.preventDefault();
      if(!streaming) send();
    }
  });
  $("composerForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if(streaming) return abortStream();
    const el = $("input");
    if(!el.value.trim() && !attachments.length) return;
    send();
  });

  // message actions (delegated)
  view().addEventListener("click", async (e) => {
    const fix = e.target.closest("[data-fix]");
    if(fix){
      const what = fix.dataset.fix;
      if(what === "settings") openSettings();
      if(what === "retry"){
        const chat = activeChat();
        chat.messages = chat.messages.filter(m => !m.error);
        const assistantMsg = { id: uid(), role: "assistant", content: "", streaming: true, ts: Date.now() };
        chat.messages.push(assistantMsg);
        save(); renderMain(); placeComposer(); scrollToBottom(true);
        runStream(chat, assistantMsg);
      }
      return;
    }
    const copyBtn = e.target.closest("[data-copy]");
    if(copyBtn){
      const code = copyBtn.closest(".code-wrap").querySelector("pre code");
      copyText(code.textContent, copyBtn);
      return;
    }
    const act = e.target.closest("[data-a]");
    if(!act) return;
    const wrap = act.closest(".msg");
    const chat = activeChat();
    const msg = chat.messages.find(m => m.id === wrap.dataset.id);
    if(!msg) return;
    if(act.dataset.a === "copy"){ copyText(msg.content, null); toast("Copied message"); }
    if(act.dataset.a === "regen") regenerate(msg.id);
    if(act.dataset.a === "edit") startEdit(wrap, msg, chat);
  });

  // sidebar + top bar
  $("newChatBtn").addEventListener("click", () => {
    abortStream();
    const chat = newChat();
    state.chats.unshift(chat); state.activeId = chat.id;
    attachments = []; renderAttachments();
    save(); renderAll(); focusInput();
    if(window.innerWidth <= 820) closeSidebar();
  });
  $("collapseBtn").addEventListener("click", () => {
    if(window.matchMedia("(max-width: 820px)").matches) return closeSidebar();
    $("sidebar").classList.toggle("rail");
    setTimeout(() => { updateSendState(); scrollToBottom(true); }, 200);
  });
  $("openSidebarBtn").addEventListener("click", openSidebar);
  $("scrim").addEventListener("click", closeSidebar);
  $("clearAllBtn").addEventListener("click", () => {
    if(!confirm("Delete all chats? This cannot be undone.")) return;
    abortStream();
    state.chats = [newChat()];
    state.activeId = state.chats[0].id;
    save(); renderAll(); toast("All chats deleted");
  });
  $("modelStat").addEventListener("click", () => openSettings("model"));
  $("modelPickBtn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    if($("modelMenu").classList.contains("on")) closeModelMenu(); else openModelMenu();
  });
  $("modelMenu").addEventListener("click", (ev) => ev.stopPropagation());
  document.addEventListener("click", () => closeModelMenu());
  const addBtn = $("addModelBtn"), addInput = $("newModel");
  const submitModel = () => { addModel(addInput.value); addInput.value = ""; addInput.focus(); };
  addBtn.addEventListener("click", submitModel);
  addInput.addEventListener("keydown", (ev) => { if(ev.key === "Enter"){ ev.preventDefault(); submitModel(); } });
  $("exportBtn").addEventListener("click", exportChat);
  $("jumpBtn").addEventListener("click", () => scrollToBottom());

  // composer extras
  $("plusBtn").addEventListener("click", (e) => { e.stopPropagation(); $("plusMenu").classList.toggle("on"); });
  document.addEventListener("click", (e) => {
    if(!e.target.closest(".plus-wrap")) $("plusMenu").classList.remove("on");
  });
  $("menuAttach").addEventListener("click", () => { $("plusMenu").classList.remove("on"); $("fileInput").click(); });
  $("menuSystem").addEventListener("click", () => { $("plusMenu").classList.remove("on"); openSettings(); setTimeout(() => $("sSystem").focus(), 60); });
  $("menuSettings").addEventListener("click", () => { $("plusMenu").classList.remove("on"); openSettings(); });
  $("fileInput").addEventListener("change", async (e) => {
    for(const f of e.target.files){
      if(f.type.indexOf("image/") === 0){
        if(f.size > 12000000){ toast(f.name + " is too large (12 MB limit)"); continue; }
        try{ attachments.push(await readImage(f)); }
        catch(err){ toast("Could not read " + f.name); }
      } else {
        if(f.size > 400000){ toast(f.name + " is too large (400 KB limit)"); continue; }
        try{ attachments.push({ name: f.name, kind: "text", text: await f.text() }); }
        catch(err){ toast("Could not read " + f.name); }
      }
    }
    e.target.value = "";
    renderAttachments(); updateSendState();
  });

  // settings + model modals
  $("sSave").addEventListener("click", saveSettings);
  $("sCancel").addEventListener("click", closeSettings);
  $("testConnBtn").addEventListener("click", testConnection);
  $("eyeBtn").addEventListener("click", () => {
    const k = $("sKey"); k.type = k.type === "password" ? "text" : "password";
  });
  $("sTemp").addEventListener("input", () => { $("sTempVal").textContent = (+$("sTemp").value).toFixed(1); });

  // keys
  document.addEventListener("keydown", (e) => {
    if(e.key === "Escape"){
      if($("searchOverlay").classList.contains("on")) closeSearch();
      else if($("settingsModal").classList.contains("on")) closeSettings();
      else if($("modelMenu").classList.contains("on")) closeModelMenu();
      else if($("plusMenu").classList.contains("on")) $("plusMenu").classList.remove("on");
      else if(window.innerWidth <= 820) closeSidebar();
    }
    if(e.key === "k" && (e.metaKey || e.ctrlKey)){
      e.preventDefault();
      if(window.innerWidth <= 820) openSidebar();
      focusInput();
    }
    // the same shortcuts the real app binds
    if(e.key === "b" && (e.metaKey || e.ctrlKey) && !e.altKey){
      e.preventDefault();
      if(window.innerWidth <= 820){ $("scrim").classList.contains("on") ? closeSidebar() : openSidebar(); }
      else $("collapseBtn").click();
    }
    if(e.key.toLowerCase() === "o" && (e.metaKey || e.ctrlKey) && e.shiftKey){
      e.preventDefault();
      $("newChatBtn").click();
      focusInput();
    }
    if(e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey){
      // Ctrl/Cmd+Enter sends from anywhere in the page
      const form = document.querySelector("form.composer, #composerHost form");
      if(form && $("input").value.trim() && document.activeElement !== $("input")){
        e.preventDefault(); send();
      }
    }
  });

  // scroll affordance
  $("scroll").addEventListener("scroll", () => {
    $("jumpBtn").classList.toggle("on", !isNearBottom() && activeChat().messages.length > 0);
  });

  // Layout: a media-query listener (not resize) — it also fires on phone
  // rotation and device-emulation changes, which resize does not.
  const mq = window.matchMedia("(max-width: 820px)");
  if(mq.addEventListener) mq.addEventListener("change", applyLayout);
  else if(mq.addListener) mq.addListener(applyLayout);

  wirePage();
}

/* ==========================================================================
   Page chrome: search overlay, settings panes, profile popover, mode switch
   ========================================================================== */
// the copy the real UI shows on a fresh chat; picked once per load so it does
// not change under the user every time the view re-renders
const GREETINGS = [
  "What's on the agenda today?",
  "What's on your mind today?",
  "Where should we begin?",
  "What can I help with?"
];
const GREETING = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];

function showPane(pane, label){
  const panes = { model: "paneModel", appearance: "paneAppearance" };
  Object.keys(panes).forEach(k => { const el = $(panes[k]); if(el) el.style.display = (k === pane) ? "" : "none"; });
  $("setTitle").textContent = label || (pane === "appearance" ? "Appearance" : "Model");
  document.querySelectorAll("#setNav .row").forEach(r => r.classList.toggle("active", r.dataset.pane === pane && (!label || r.textContent.trim() === label)));
}

/* ---------------- search ---------------- */
function openSearch(){
  $("searchOverlay").classList.add("on");
  $("searchInput").value = "";
  renderSearch();
  setTimeout(() => $("searchInput").focus(), 30);
}
function closeSearch(){ $("searchOverlay").classList.remove("on"); }
function renderSearch(){
  const q = $("searchInput").value.trim();
  const ql = q.toLowerCase();
  const list = $("searchList");
  $("searchLabel").textContent = q ? "Results" : "Recent chats";
  const hits = state.chats
    .filter(c => c.messages.length)
    .map(c => {
      const text = c.messages.map(m => String(m.content || "")).join(" ");
      const at = ql ? text.toLowerCase().indexOf(ql) : -1;
      const snippet = q ? (at < 0 ? text.slice(0, 90) : "\u2026" + text.slice(Math.max(0, at - 45), at + 75).trim()) : "";
      return { chat: c, title: c.title || "New chat", snippet };
    })
    .filter(h => !q || (h.title + " " + h.snippet).toLowerCase().includes(ql))
    .slice(0, 40);
  if(!hits.length){
    list.innerHTML = '<div class="srch-empty">' + (q ? "No chats match \u201c" + esc(q) + "\u201d." : "No chats yet.") + "</div>";
    return;
  }
  list.innerHTML = hits.map(h => {
    let snip = "";
    if(h.snippet){
      const i = h.snippet.toLowerCase().indexOf(ql);
      snip = i < 0 ? esc(h.snippet)
        : esc(h.snippet.slice(0, i)) + "<mark>" + esc(h.snippet.slice(i, i + q.length)) + "</mark>" + esc(h.snippet.slice(i + q.length));
    }
    return '<button type="button" class="srch-item" data-open="' + h.chat.id + '">'
      + '<span class="si"><svg><use href="#i-chat"/></svg></span>'
      + '<span class="st"><b>' + esc(h.title) + "</b>" + (snip ? "<span>" + snip + "</span>" : "") + "</span>"
      + (q ? '<span class="sd">' + new Date(h.chat.createdAt || Date.now()).toLocaleDateString(undefined, {month:"short", day:"numeric"}) + "</span>" : "")
      + "</button>";
  }).join("");
  list.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => {
    state.activeId = b.dataset.open; save(); renderAll(); closeSearch(); focusInput();
  }));
}

/* ---------------- the rest ---------------- */
function wirePage(){
  $("searchBtn").addEventListener("click", openSearch);
  $("searchClose").addEventListener("click", closeSearch);
  $("searchClear").addEventListener("click", () => { $("searchInput").value = ""; renderSearch(); $("searchInput").focus(); });
  $("searchInput").addEventListener("input", renderSearch);
  $("searchOverlay").addEventListener("mousedown", (e) => { if(e.target === $("searchOverlay")) closeSearch(); });

  $("setNav").addEventListener("click", (e) => {
    const row = e.target.closest(".row"); if(!row) return;
    showPane(row.dataset.pane, row.textContent.trim());
  });
  $("setBack").addEventListener("click", closeSettings);
  $("setPanel").addEventListener("click", () => {
    const side = document.querySelector(".set-side");
    const hidden = side.style.display === "none";
    side.style.display = hidden ? "" : "none";
  });
  $("setSearch").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll("#setNav .row").forEach(r => { r.style.display = r.textContent.toLowerCase().includes(q) ? "" : "none"; });
  });
  $("sTheme").addEventListener("change", (e) => {
    state.settings.theme = e.target.value; save(); syncChrome();
  });


  const think = $("thinkLevel");
  think.value = state.settings.think || "off";
  think.addEventListener("change", () => { state.settings.think = think.value; save(); });

  $("openSidebarBtn").addEventListener("click", openSidebar);
  $("scrim").addEventListener("click", closeSidebar);
  $("jumpBtn").addEventListener("click", () => scrollToBottom(true));
}

load();
buildComposer();
wire();
renderAll();
applyLayout();
autoGrow(); updateSendState(); focusInput();
renderModelMenu(); renderModelSettings();
if(!state.settings.apiKey.trim() && !activeChat().messages.length) setTimeout(openSettings, 350);

window.__app = { state, send, renderMarkdown, callAPI, save, openSettings, newChat, placeComposer, buildRequest, renderAll, renderMain, addModel, removeModel, setModel, openModelMenu };  // test hook
</script>