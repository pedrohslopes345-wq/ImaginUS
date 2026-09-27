import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signOut,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  arrayUnion,
  arrayRemove,
  deleteField,
  Bytes,
} from "firebase/firestore";
import { firebaseConfig } from "./firebase-config.js";

// Abra renderer/index.html#demo num navegador para ver a interface com dados de mentira.
const DEMO = location.hash === "#demo";

const MAX_SOUND_BYTES = 800 * 1024;
const MAX_SOUND_SECONDS = 10;
const FRESH_MS = 2 * 60 * 1000; // toques mais antigos que isso (ex.: PC estava desligado) não tocam, só aparecem no Dash
const INVITE_TTL_MS = 15 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const native = window.native ?? {
  onHotkey() {},
  onUpdateReady() {},
  getSettings: async () => ({ hotkey: "Control+Alt+Space", autostart: false, version: "dev" }),
  setHotkey: async () => ({ ok: true }),
  setAutostart: async (enabled) => enabled,
  checkForUpdate: async () => ({ status: "dev" }),
  installUpdate() {},
  setTrayStatus() {},
  showWindow() {},
};

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

const state = {
  uid: null,
  email: "",
  profile: null,
  pairId: null,
  pair: null,
  messages: [],
  events: [],
  eventsLoaded: false,
  dashFilter: "received",
  tab: "messages",
  settings: { hotkey: "Control+Alt+Space", autostart: false, version: "" },
  lastSeenDash: Number(safeStorage("get", "lastSeenDash") || 0),
  sending: new Set(),
};

let signupName = null;
let userUnsub = null;
let pairUnsubs = [];
let pairRetryTimer = null;

// ---------- utilidades ----------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function safeStorage(op, key, value) {
  try {
    return op === "get" ? localStorage.getItem(key) : localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function show(view) {
  $$("[data-view]").forEach((el) => (el.hidden = el.dataset.view !== view));
}

let toastTimer;
function toast(text, isError = false) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function friendlyError(e) {
  const messages = {
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/invalid-login-credentials": "E-mail ou senha incorretos.",
    "auth/wrong-password": "E-mail ou senha incorretos.",
    "auth/user-not-found": "E-mail ou senha incorretos.",
    "auth/email-already-in-use": "Esse e-mail já tem conta. Use Entrar.",
    "auth/weak-password": "A senha precisa de pelo menos 6 caracteres.",
    "auth/invalid-email": "E-mail inválido.",
    "auth/network-request-failed": "Sem internet.",
    "auth/too-many-requests": "Muitas tentativas. Espere um pouco.",
    "auth/api-key-not-valid.-please-pass-a-valid-api-key.": "Falta configurar o Firebase (veja o README).",
    "permission-denied": "Sem permissão para isso.",
    unavailable: "Sem conexão com o servidor.",
  };
  return messages[e?.code] ?? e?.message ?? "Algo deu errado.";
}

function myName() {
  return state.profile?.name || state.email.split("@")[0] || "Eu";
}

function partnerUid() {
  return state.pair?.members?.find((m) => m !== state.uid) ?? null;
}

function partnerName() {
  const uid = partnerUid();
  return (uid && state.pair?.names?.[uid]) || "a outra pessoa";
}

function favoriteMessage() {
  return state.messages.find((m) => m.id === state.profile?.favoriteMessageId) ?? state.messages[0] ?? null;
}

function isPaired() {
  return (state.pair?.members?.length ?? 0) === 2;
}

function millis(ts) {
  return ts?.toMillis ? ts.toMillis() : ts instanceof Date ? ts.getTime() : null;
}

function randomCode() {
  const values = crypto.getRandomValues(new Uint32Array(6));
  return Array.from(values, (v) => CODE_ALPHABET[v % CODE_ALPHABET.length]).join("");
}

// ---------- sons ----------

let audioCtx;
function beep(freqs, duration = 0.12, volume = 0.18) {
  audioCtx ??= new AudioContext();
  let t = audioCtx.currentTime;
  for (const freq of freqs) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + duration);
    t += duration * 0.9;
  }
}

const sfx = {
  defaultToque: () => beep([880, 1320]),
  sent: () => beep([660], 0.06, 0.08),
  error: () => beep([220, 170], 0.16, 0.15),
};

const soundCache = new Map();

function soundUrl(message) {
  if (DEMO || !message?.soundVersion || !state.pairId) return Promise.resolve(null);
  const key = `${message.id}:${message.soundVersion}`;
  if (!soundCache.has(key)) {
    const pending = getDoc(doc(db, "pairs", state.pairId, "sounds", message.id))
      .then((snap) => {
        if (!snap.exists()) return null;
        const blob = new Blob([snap.get("data").toUint8Array()], { type: snap.get("mime") || "audio/mpeg" });
        return URL.createObjectURL(blob);
      })
      .catch(() => {
        soundCache.delete(key);
        return null;
      });
    soundCache.set(key, pending);
  }
  return soundCache.get(key);
}

async function playMessage(messageId) {
  const message = state.messages.find((m) => m.id === messageId);
  const url = await soundUrl(message);
  if (!url) return sfx.defaultToque();
  new Audio(url).play().catch(() => sfx.defaultToque());
}

function audioDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (value) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(null);
    audio.src = url;
  });
}

// ---------- sessão ----------

function stopPair() {
  pairUnsubs.forEach((unsub) => unsub());
  pairUnsubs = [];
  clearTimeout(pairRetryTimer);
  state.pairId = null;
  state.pair = null;
  state.messages = [];
  state.events = [];
  state.eventsLoaded = false;
}

function stopUser() {
  stopPair();
  userUnsub?.();
  userUnsub = null;
  state.profile = null;
}

onAuthStateChanged(auth, async (user) => {
  if (DEMO) return;
  stopUser();
  state.uid = user?.uid ?? null;
  state.email = user?.email ?? "";
  if (!user) {
    native.setTrayStatus("desconectado");
    show("login");
    return;
  }
  show("loading");
  try {
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        name: signupName || user.displayName || user.email.split("@")[0],
        createdAt: serverTimestamp(),
      });
    }
    userUnsub = onSnapshot(ref, (s) => onProfile(s.data() ?? {}), (e) => toast(friendlyError(e), true));
  } catch (e) {
    toast(friendlyError(e), true);
    show("login");
  }
});

function onProfile(profile) {
  state.profile = profile;
  const pairId = profile.pairId ?? null;
  if (pairId !== state.pairId) {
    stopPair();
    if (pairId) startPair(pairId);
  }
  route();
}

function startPair(pairId) {
  state.pairId = pairId;
  const ref = doc(db, "pairs", pairId);
  const unsub = onSnapshot(
    ref,
    (snap) => onPair(snap),
    () => {
      // Logo depois de criar ou entrar num par o servidor pode ainda não ter a escrita:
      // tenta de novo antes de concluir que o vínculo acabou.
      pairUnsubs = pairUnsubs.filter((u) => u !== unsub);
      pairRetryTimer = setTimeout(async () => {
        if (state.pairId !== pairId) return;
        try {
          await getDoc(ref);
          stopPair();
          startPair(pairId);
        } catch {
          clearMyPair();
        }
      }, 3000);
    }
  );
  pairUnsubs.push(unsub);
}

function onPair(snap) {
  if (!snap.exists()) return clearMyPair();
  const pair = snap.data();
  const wasPaired = isPaired();
  state.pair = pair;

  const members = pair.members ?? [];
  if (!members.includes(state.uid)) return clearMyPair();

  if (members.length === 1) {
    const partnerLeft = Object.keys(pair.names ?? {}).length > 1;
    const created = millis(pair.createdAt);
    const expired = created && Date.now() - created > INVITE_TTL_MS;
    if (partnerLeft || expired) {
      toast(partnerLeft ? `${partnerName()} desfez o vínculo.` : "O código expirou.");
      return deletePairAndClear();
    }
  }

  if (isPaired() && !wasPaired) startPairData();
  route();
}

function startPairData() {
  const base = ["pairs", state.pairId];
  pairUnsubs.push(
    onSnapshot(query(collection(db, ...base, "messages"), orderBy("createdAt")), (snap) => {
      state.messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.messages.forEach(soundUrl);
      render();
    })
  );
  pairUnsubs.push(
    onSnapshot(query(collection(db, ...base, "events"), orderBy("createdAt", "desc"), limit(300)), (snap) => {
      const firstLoad = !state.eventsLoaded;
      state.events = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
      state.eventsLoaded = true;
      if (!firstLoad) {
        for (const change of snap.docChanges()) {
          const ev = change.doc.data();
          const at = millis(ev.createdAt);
          if (change.type === "added" && ev.to === state.uid && at && Date.now() - at < FRESH_MS) {
            playMessage(ev.messageId);
          }
        }
      }
      render();
    })
  );
}

async function clearMyPair() {
  stopPair();
  if (!state.uid) return;
  await updateDoc(doc(db, "users", state.uid), { pairId: deleteField(), favoriteMessageId: deleteField() }).catch(() => {});
}

async function deletePairAndClear() {
  const pairId = state.pairId;
  stopPair();
  const batch = writeBatch(db);
  batch.delete(doc(db, "pairs", pairId));
  batch.update(doc(db, "users", state.uid), { pairId: deleteField(), favoriteMessageId: deleteField() });
  await batch.commit().catch(() => clearMyPair());
}

// ---------- ações ----------

async function createInvite() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomCode();
    const batch = writeBatch(db);
    batch.set(doc(db, "pairs", code), {
      members: [state.uid],
      names: { [state.uid]: myName() },
      createdAt: serverTimestamp(),
    });
    batch.update(doc(db, "users", state.uid), { pairId: code });
    try {
      await batch.commit();
      await addDoc(collection(db, "pairs", code, "messages"), {
        label: "Oi",
        soundVersion: 0,
        createdBy: state.uid,
        createdAt: serverTimestamp(),
      });
      return;
    } catch (e) {
      if (e.code !== "permission-denied") throw e; // código já existia: tenta outro
    }
  }
  throw new Error("Não consegui gerar um código. Tente de novo.");
}

async function acceptInvite(rawCode) {
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) throw new Error("O código tem 6 caracteres.");
  if (code === state.pairId) throw new Error("Esse código é seu. Digite-o no PC da outra pessoa.");
  const batch = writeBatch(db);
  if (state.pairId) batch.delete(doc(db, "pairs", state.pairId)); // descarta o meu código pendente
  batch.update(doc(db, "pairs", code), {
    members: arrayUnion(state.uid),
    [`names.${state.uid}`]: myName(),
  });
  batch.update(doc(db, "users", state.uid), { pairId: code });
  try {
    await batch.commit();
  } catch (e) {
    if (e.code === "not-found" || e.code === "permission-denied") throw new Error("Código inválido ou expirado.");
    throw e;
  }
}

async function leavePair() {
  const batch = writeBatch(db);
  batch.update(doc(db, "pairs", state.pairId), { members: arrayRemove(state.uid) });
  batch.update(doc(db, "users", state.uid), { pairId: deleteField(), favoriteMessageId: deleteField() });
  await batch.commit();
}

async function sendMessage(message) {
  if (!message) return;
  if (!isPaired()) {
    sfx.error();
    native.showWindow();
    return toast("Vincule com a outra pessoa primeiro.", true);
  }
  state.sending.add(message.id);
  render();
  try {
    if (DEMO) {
      await new Promise((r) => setTimeout(r, 400));
      state.events.unshift({ id: String(Date.now()), from: state.uid, to: partnerUid(), messageId: message.id, label: message.label, createdAt: new Date() });
    } else {
      await addDoc(collection(db, "pairs", state.pairId, "events"), {
        from: state.uid,
        to: partnerUid(),
        messageId: message.id,
        label: message.label,
        createdAt: serverTimestamp(),
      });
    }
    sfx.sent();
    toast(`Enviado: ${message.label}`);
  } catch (e) {
    sfx.error();
    toast(friendlyError(e), true);
  } finally {
    state.sending.delete(message.id);
    render();
  }
}

async function setFavorite(messageId) {
  if (DEMO) {
    state.profile.favoriteMessageId = messageId;
    return render();
  }
  await updateDoc(doc(db, "users", state.uid), { favoriteMessageId: messageId });
}

async function saveMessage(existing, label, file) {
  if (file) {
    if (file.size > MAX_SOUND_BYTES) throw new Error("O som passa de 800 KB. Use um áudio mais curto.");
    const seconds = await audioDuration(file);
    if (seconds === null) throw new Error("Não consegui ler esse arquivo de áudio.");
    if (seconds > MAX_SOUND_SECONDS) throw new Error(`O som tem ${Math.round(seconds)} s. O máximo é ${MAX_SOUND_SECONDS} s.`);
  }
  if (DEMO) {
    if (existing) existing.label = label;
    else state.messages.push({ id: String(Date.now()), label, soundVersion: 0 });
    return render();
  }
  const messagesCol = collection(db, "pairs", state.pairId, "messages");
  const ref = existing ? doc(messagesCol, existing.id) : doc(messagesCol);
  const data = { label };
  const batch = writeBatch(db);
  if (file) {
    batch.set(doc(db, "pairs", state.pairId, "sounds", ref.id), {
      data: Bytes.fromUint8Array(new Uint8Array(await file.arrayBuffer())),
      mime: file.type || "audio/mpeg",
      updatedAt: serverTimestamp(),
    });
    data.soundVersion = Date.now();
  }
  if (existing) batch.update(ref, data);
  else batch.set(ref, { soundVersion: 0, ...data, createdBy: state.uid, createdAt: serverTimestamp() });
  await batch.commit();
}

async function deleteMessage(message) {
  if (DEMO) {
    state.messages = state.messages.filter((m) => m !== message);
    return render();
  }
  const batch = writeBatch(db);
  batch.delete(doc(db, "pairs", state.pairId, "messages", message.id));
  batch.delete(doc(db, "pairs", state.pairId, "sounds", message.id));
  await batch.commit();
}

// ---------- telas ----------

function route() {
  if (!state.profile) return show("loading");
  if (!isPaired()) {
    const waiting = state.pair?.members?.length === 1;
    $("#invite-start").hidden = waiting;
    $("#invite-waiting").hidden = !waiting;
    if (waiting) $("#invite-code").textContent = state.pairId;
    native.setTrayStatus("não vinculado");
    return show("pair");
  }
  show("main");
  render();
}

function render() {
  if (!isPaired()) return;
  const received = state.events.filter((e) => e.to === state.uid);
  const unread = received.filter((e) => (millis(e.createdAt) ?? 0) > state.lastSeenDash).length;

  $("#partner-line").textContent = `com ${partnerName()}`;
  $("#hotkey-hint").textContent = prettyHotkey(state.settings.hotkey);
  $("#dash-dot").hidden = unread === 0 || state.tab === "dash";
  native.setTrayStatus(unread ? `${unread} toque(s) novo(s) de ${partnerName()}` : `com ${partnerName()}`);

  renderGrid();
  renderDash(received);
  renderSettings();
}

function renderGrid() {
  const fav = favoriteMessage();
  const cards = state.messages.map((m) => {
    const classes = ["msg"];
    if (m === fav) classes.push("fav");
    if (state.sending.has(m.id)) classes.push("sent");
    return `<button class="${classes.join(" ")}" data-id="${esc(m.id)}">
      ${m === fav ? '<span class="badge" title="Mensagem do atalho">★</span>' : ""}
      ${esc(m.label)}
      <span class="more" data-more title="Opções">⋯</span>
      ${state.sending.has(m.id) ? '<span class="status">enviando…</span>' : ""}
    </button>`;
  });
  cards.push('<button class="msg add" id="add-message">+ Nova</button>');
  $("#message-grid").innerHTML = cards.join("");
}

function dayLabel(date) {
  const today = new Date();
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(date)) / 86400000);
  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Ontem";
  return date.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
}

function renderDash(received) {
  const list = state.dashFilter === "received" ? received : state.events.filter((e) => e.from === state.uid);
  if (list.length === 0) {
    $("#dash-list").innerHTML = `<li class="empty">${state.dashFilter === "received" ? "Nenhum toque recebido ainda." : "Você ainda não enviou nenhum toque."}</li>`;
    return;
  }
  let lastDay = null;
  const rows = [];
  for (const ev of list) {
    const at = millis(ev.createdAt);
    const date = at ? new Date(at) : new Date();
    const day = dayLabel(date);
    if (day !== lastDay) {
      rows.push(`<li class="day">${esc(day)}</li>`);
      lastDay = day;
    }
    const unread = state.dashFilter === "received" && at > state.lastSeenDash;
    const time = at ? date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "…";
    rows.push(`<li class="item${unread ? " unread" : ""}" data-message="${esc(ev.messageId)}" title="Clique para ouvir">
      <span class="time">${time}</span><span class="label">${esc(ev.label)}</span>
    </li>`);
  }
  $("#dash-list").innerHTML = rows.join("");
}

function renderSettings() {
  const fav = favoriteMessage();
  $("#favorite-select").innerHTML = state.messages
    .map((m) => `<option value="${esc(m.id)}"${m === fav ? " selected" : ""}>${esc(m.label)}</option>`)
    .join("");
  if (!$("#hotkey-input").classList.contains("recording")) {
    $("#hotkey-input").value = prettyHotkey(state.settings.hotkey);
  }
  $("#autostart").checked = !!state.settings.autostart;
  $("#account-line").textContent = `${myName()} · ${state.email} · vinculado com ${partnerName()}`;
  $("#version-line").textContent = `ImaginUS ${state.settings.version}`;
}

function goTab(tab) {
  state.tab = tab;
  $$("[data-tab]").forEach((el) => (el.hidden = el.dataset.tab !== tab));
  $$("[data-go]").forEach((el) => el.classList.toggle("active", el.dataset.go === tab));
  render();
  if (tab === "dash" && state.dashFilter === "received") markDashSeen();
}

function markDashSeen() {
  // Mantém o destaque dos novos enquanto a pessoa olha; some na próxima vez.
  state.lastSeenDash = Date.now();
  safeStorage("set", "lastSeenDash", String(state.lastSeenDash));
}

// ---------- atalho do teclado ----------

const KEY_NAMES = {
  Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`",
};

function acceleratorFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  const code = e.code;
  let key = KEY_NAMES[code] ?? null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (/^Numpad\d$/.test(code)) key = `num${code.slice(6)}`;
  if (!key || mods.length === 0) return null;
  return [...mods, key].join("+");
}

function prettyHotkey(accelerator) {
  return (accelerator || "")
    .replace("Control", "Ctrl")
    .replace("Super", "Win")
    .replace("Space", "Espaço")
    .split("+")
    .join(" + ");
}

let recordingHotkey = false;

function startRecordingHotkey() {
  recordingHotkey = true;
  const input = $("#hotkey-input");
  input.classList.add("recording");
  input.value = "Pressione o atalho… (Esc cancela)";
}

function stopRecordingHotkey() {
  recordingHotkey = false;
  $("#hotkey-input").classList.remove("recording");
  renderSettings();
}

window.addEventListener(
  "keydown",
  async (e) => {
    if (!recordingHotkey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return stopRecordingHotkey();
    const accelerator = acceleratorFromEvent(e);
    if (!accelerator) return; // só modificadores até agora
    const { ok } = await native.setHotkey(accelerator);
    if (ok) {
      state.settings.hotkey = accelerator;
      toast(`Atalho: ${prettyHotkey(accelerator)}`);
    } else {
      toast("Esse atalho já é usado por outro programa.", true);
    }
    stopRecordingHotkey();
    render();
  },
  true
);

// ---------- editor e menu ----------

let editing = null;

function openEditor(message = null) {
  editing = message;
  const form = $("#editor-form");
  form.reset();
  form.label.value = message?.label ?? "";
  $("#editor-title").textContent = message ? "Editar mensagem" : "Nova mensagem";
  $("#editor-sound-note").textContent = message
    ? message.soundVersion ? "Deixe em branco para manter o som atual." : "Sem som próprio: toca o bipe padrão."
    : "Sem som, toca um bipe padrão.";
  $("#editor-error").textContent = "";
  $("#editor").showModal();
  form.label.focus();
}

$("#editor-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return;
  e.preventDefault();
  const form = e.target;
  const label = form.label.value.trim();
  if (!label) return;
  const save = $("#editor-save");
  save.disabled = true;
  $("#editor-error").textContent = "";
  try {
    await saveMessage(editing, label, form.sound.files[0] ?? null);
    $("#editor").close();
    toast("Mensagem salva");
  } catch (err) {
    $("#editor-error").textContent = friendlyError(err);
  } finally {
    save.disabled = false;
  }
});

let menuMessage = null;

function openMenu(message, x, y) {
  menuMessage = message;
  const menu = $("#card-menu");
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - height - 8)}px`;
}

function closeMenu() {
  $("#card-menu").hidden = true;
  menuMessage = null;
}

$("#card-menu").addEventListener("click", async (e) => {
  const action = e.target.closest("[data-menu]")?.dataset.menu;
  const message = menuMessage;
  closeMenu();
  if (!action || !message) return;
  try {
    if (action === "play") await playMessage(message.id);
    if (action === "favorite") {
      await setFavorite(message.id);
      toast(`“${message.label}” agora vai no atalho`);
    }
    if (action === "edit") openEditor(message);
    if (action === "delete" && confirm(`Excluir “${message.label}”?`)) await deleteMessage(message);
  } catch (err) {
    toast(friendlyError(err), true);
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#card-menu") && !e.target.closest("[data-more]")) closeMenu();
});

// ---------- eventos da interface ----------

let signupMode = false;

$("#login-toggle").addEventListener("click", () => {
  signupMode = !signupMode;
  $("#name-field").hidden = !signupMode;
  $("#login-submit").textContent = signupMode ? "Criar conta" : "Entrar";
  $("#login-toggle").textContent = signupMode ? "Já tenho conta" : "Ainda não tenho conta";
  $("#login-form").password.autocomplete = signupMode ? "new-password" : "current-password";
  $("#login-error").textContent = "";
});

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const email = form.email.value.trim();
  const password = form.password.value;
  $("#login-error").textContent = "";
  $("#login-submit").disabled = true;
  try {
    if (signupMode) {
      signupName = form.elements.name.value.trim() || null; // form.name é o atributo do <form>, não o campo
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      if (signupName) await updateProfile(cred.user, { displayName: signupName });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (err) {
    $("#login-error").textContent = friendlyError(err);
  } finally {
    $("#login-submit").disabled = false;
  }
});

$$("[data-action=logout]").forEach((btn) => btn.addEventListener("click", () => signOut(auth)));

$("#invite-create").addEventListener("click", async (e) => {
  e.target.disabled = true;
  $("#pair-error").textContent = "";
  try {
    await createInvite();
  } catch (err) {
    $("#pair-error").textContent = friendlyError(err);
  } finally {
    e.target.disabled = false;
  }
});

$("#invite-cancel").addEventListener("click", () => deletePairAndClear());

$("#invite-accept").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#pair-error").textContent = "";
  try {
    await acceptInvite(e.target.code.value);
    e.target.reset();
  } catch (err) {
    $("#pair-error").textContent = friendlyError(err);
  }
});

$("#message-grid").addEventListener("click", (e) => {
  if (e.target.closest("#add-message")) return openEditor();
  const card = e.target.closest("[data-id]");
  if (!card) return;
  const message = state.messages.find((m) => m.id === card.dataset.id);
  if (e.target.closest("[data-more]")) return openMenu(message, e.clientX, e.clientY);
  if (!state.sending.has(message.id)) sendMessage(message);
});

$("#message-grid").addEventListener("contextmenu", (e) => {
  const card = e.target.closest("[data-id]");
  if (!card) return;
  e.preventDefault();
  openMenu(state.messages.find((m) => m.id === card.dataset.id), e.clientX, e.clientY);
});

$("#dash-list").addEventListener("click", (e) => {
  const item = e.target.closest("[data-message]");
  if (item) playMessage(item.dataset.message);
});

$$("[data-filter]").forEach((btn) =>
  btn.addEventListener("click", () => {
    state.dashFilter = btn.dataset.filter;
    $$("[data-filter]").forEach((b) => b.classList.toggle("active", b === btn));
    render();
    if (state.dashFilter === "received") markDashSeen();
  })
);

$$("[data-go]").forEach((btn) => btn.addEventListener("click", () => goTab(btn.dataset.go)));

$("#favorite-select").addEventListener("change", (e) => setFavorite(e.target.value).catch((err) => toast(friendlyError(err), true)));

$("#hotkey-record").addEventListener("click", startRecordingHotkey);

$("#autostart").addEventListener("change", async (e) => {
  state.settings.autostart = await native.setAutostart(e.target.checked);
  e.target.checked = state.settings.autostart;
});

$("#unpair").addEventListener("click", async () => {
  if (!confirm(`Desvincular de ${partnerName()}? O histórico deixa de aparecer para os dois.`)) return;
  try {
    await leavePair();
  } catch (err) {
    toast(friendlyError(err), true);
  }
});

$("#update-check").addEventListener("click", async () => {
  const result = await native.checkForUpdate();
  const messages = {
    dev: "Atualizações só funcionam no app instalado.",
    latest: "Você já está na versão mais nova.",
    downloading: `Baixando a versão ${result.latest}…`,
    error: "Não consegui verificar agora.",
  };
  toast(messages[result.status] ?? "…", result.status === "error");
});

function showUpdateBanner(version) {
  $("#update-version").textContent = version;
  $("#update-banner").hidden = false;
}

$("#update-install").addEventListener("click", () => native.installUpdate());

native.onUpdateReady(showUpdateBanner);
native.onHotkey(() => sendMessage(favoriteMessage()));

native.getSettings().then((settings) => {
  state.settings = { ...state.settings, ...settings };
  if (settings.pendingUpdateVersion) showUpdateBanner(settings.pendingUpdateVersion);
  render();
});

// ---------- modo demonstração ----------

if (DEMO) {
  const now = Date.now();
  const minutes = (n) => new Date(now - n * 60000);
  state.uid = "eu";
  state.email = "voce@exemplo.com";
  state.profile = { name: "Pedro", favoriteMessageId: "m1" };
  state.pairId = "DEMO42";
  state.pair = { members: ["eu", "ela"], names: { eu: "Pedro", ela: "Ana" } };
  state.messages = [
    { id: "m1", label: "Oi", soundVersion: 0 },
    { id: "m2", label: "Saudade", soundVersion: 0 },
    { id: "m3", label: "Tô chegando", soundVersion: 0 },
    { id: "m4", label: "Boa noite", soundVersion: 0 },
    { id: "m5", label: "Pensando em você", soundVersion: 0 },
  ];
  const ev = (id, from, messageId, label, at) => ({ id, from, to: from === "eu" ? "ela" : "eu", messageId, label, createdAt: at });
  state.events = [
    ev("e1", "ela", "m1", "Oi", minutes(3)),
    ev("e2", "eu", "m2", "Saudade", minutes(20)),
    ev("e3", "ela", "m5", "Pensando em você", minutes(95)),
    ev("e4", "ela", "m4", "Boa noite", minutes(60 * 26)),
    ev("e5", "eu", "m4", "Boa noite", minutes(60 * 26 + 2)),
    ev("e6", "ela", "m3", "Tô chegando", minutes(60 * 50)),
  ];
  state.lastSeenDash = now - 30 * 60000;
  state.eventsLoaded = true;
  route();
}
