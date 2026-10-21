const $ = (id) => document.getElementById(id);
const NOTES_KEY = "netband.notes.v1";
const KIT_KEY = "netband.emergency-kit.v1";
let deferredInstallPrompt = null;
let toastTimer = null;

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}
function readJSON(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { showToast("Could not save. Browser storage may be unavailable."); return false; }
}
function updateNetworkStatus() {
  const online = navigator.onLine;
  $("networkLabel").textContent = online ? "Internet available" : "You're offline";
  $("internetStatus").textContent = online ? "Online" : "Offline";
  $("internetHint").textContent = "Browser connectivity only";
  $("onlineDot").style.background = online ? "var(--green)" : "var(--red)";
  document.querySelector(".status-pill").classList.toggle("offline", !online);
}
window.addEventListener("online", updateNetworkStatus);
window.addEventListener("offline", updateNetworkStatus);
updateNetworkStatus();

function renderNotes() {
  const notes = readJSON(NOTES_KEY, []);
  $("noteCount").textContent = String(notes.length);
  const list = $("notesList");
  list.replaceChildren();
  if (!notes.length) {
    const empty = document.createElement("p");
    empty.className = "feedback";
    empty.textContent = "No notes saved yet.";
    list.appendChild(empty);
    return;
  }
  notes.slice().reverse().forEach(note => {
    const item = document.createElement("article");
    item.className = "note-item";
    const content = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = note.title || "Untitled note";
    const body = document.createElement("p");
    body.textContent = note.body;
    const time = document.createElement("time");
    time.textContent = new Date(note.createdAt).toLocaleString();
    content.append(title, body, time);
    const remove = document.createElement("button");
    remove.className = "delete-note";
    remove.type = "button";
    remove.setAttribute("aria-label", "Delete note");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      const next = readJSON(NOTES_KEY, []).filter(n => n.id !== note.id);
      if (writeJSON(NOTES_KEY, next)) { renderNotes(); showToast("Note deleted from this device."); }
    });
    item.append(content, remove);
    list.appendChild(item);
  });
}
$("saveNoteBtn").addEventListener("click", () => {
  const title = $("noteTitle").value.trim();
  const body = $("noteBody").value.trim();
  if (!body) { $("saveFeedback").textContent = "Write a note first."; $("noteBody").focus(); return; }
  const notes = readJSON(NOTES_KEY, []);
  notes.push({ id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()), title, body, createdAt: Date.now() });
  if (writeJSON(NOTES_KEY, notes)) {
    $("noteTitle").value = ""; $("noteBody").value = "";
    $("saveFeedback").textContent = "Saved on this device.";
    renderNotes(); showToast("Note saved for this browser.");
  }
});
function loadKit() {
  const kit = readJSON(KIT_KEY, {});
  $("emergencyName").value = kit.name || "";
  $("emergencyContact").value = kit.contact || "";
  $("emergencyInfo").value = kit.info || "";
  const ready = Boolean(kit.name || kit.contact || kit.info);
  $("kitStatus").textContent = ready ? "Prepared" : "Not checked";
}
$("saveKitBtn").addEventListener("click", () => {
  const kit = {
    name: $("emergencyName").value.trim(),
    contact: $("emergencyContact").value.trim(),
    info: $("emergencyInfo").value.trim(),
    updatedAt: Date.now()
  };
  if (!kit.name && !kit.contact && !kit.info) {
    $("kitFeedback").textContent = "Add at least one detail first.";
    return;
  }
  if (writeJSON(KIT_KEY, kit)) {
    $("kitStatus").textContent = "Prepared";
    $("kitFeedback").textContent = "Saved on this device.";
    showToast("Emergency kit saved locally.");
  }
});
renderNotes();
loadKit();

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(err => console.warn("Service worker registration failed:", err));
  });
}
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $("installBtn").hidden = false;
});
$("installBtn").addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    showToast("On iPhone: Share → Add to Home Screen (when available).");
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("installBtn").hidden = true;
});
