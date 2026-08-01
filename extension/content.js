/**
 * Bouton « Add to Music » injecté dans la page YouTube.
 *
 * Le script n'appelle jamais le Worker lui-même : il passe par le service
 * worker (chrome.runtime.sendMessage). C'est ce qui évite de réclamer une
 * permission d'hôte sur youtube.com — un script injecté dans la page ne peut
 * pas faire de requête cross-origin sans elle, le service worker si.
 */

const BTN_ID = "dmzs-add-btn";

const VIDEO =
  /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;

const videoId = (url = location.href) => (String(url).match(VIDEO) || [])[1] || null;

const ICON = `<svg viewBox="0 0 24 24"><path d="M12 3a1 1 0 0 1 1 1v8.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.4L11 12.6V4a1 1 0 0 1 1-1zM4 16a1 1 0 0 1 1 1v2h14v-2a1 1 0 1 1 2 0v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a1 1 0 0 1 1-1z"/></svg>`;

function setState(btn, state, text) {
  btn.className = `${btn.classList.contains("float") ? "float" : "inline"} ${state}`.trim();
  btn.disabled = state === "busy" || state === "ok" || state === "dup";
  btn.innerHTML =
    (state === "busy" ? `<span class="spin"></span>` : ICON) + `<span>${text}</span>`;
}

async function send(btn) {
  const url = location.href;
  if (!videoId(url)) return setState(btn, "err", "Not a video");

  setState(btn, "busy", "Adding…");
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "add", url });
  } catch {
    // Arrive après un rechargement de l'extension : le canal est mort.
    return setState(btn, "err", "Reload the page");
  }

  if (res?.ok) setState(btn, res.duplicate ? "dup" : "ok", res.duplicate ? "In library" : "Added");
  else if (res?.error === "NOT_CONFIGURED") setState(btn, "err", "Set up the extension");
  else setState(btn, "err", res?.error || "Failed");
}

function makeButton() {
  const b = document.createElement("button");
  b.id = BTN_ID;
  b.type = "button";
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    send(b);
  });
  return b;
}

/**
 * Où poser le bouton, du plus souhaitable au dernier recours.
 *
 * `#owner` contient l'avatar, le nom de la chaîne et le bouton S'abonner :
 * y ajouter le nôtre le place juste à droite de S'abonner. Les rangées
 * d'actions servent de repli si YouTube change cette structure — ce qui
 * arrive, et c'est pour ça qu'il y a quatre niveaux plutôt qu'un.
 */
const HOSTS = [
  "ytd-watch-metadata #owner",
  "ytd-watch-metadata #top-row #owner",
  "ytd-watch-metadata #actions #top-level-buttons-computed",
  "ytd-watch-metadata #actions",
];

function findHost() {
  for (const sel of HOSTS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

let lastId = null;

function ensureButton() {
  const id = videoId();
  if (!id) {
    document.getElementById(BTN_ID)?.remove();
    lastId = null;
    return;
  }

  let btn = document.getElementById(BTN_ID);
  const host = findHost();

  if (btn?.isConnected) {
    // Le bouton flottant est un repli : dès que la barre d'actions existe,
    // on l'y range. YouTube la construit souvent après le premier rendu.
    if (host && btn.classList.contains("float")) {
      btn.classList.replace("float", "inline");
      host.appendChild(btn);
    }
    // Nouvelle vidéo : le bouton doit repartir de zéro.
    if (id !== lastId) {
      lastId = id;
      setState(btn, "", "Add to Music");
    }
    return;
  }

  btn = makeButton();
  btn.classList.add(host ? "inline" : "float");
  setState(btn, "", "Add to Music");
  (host || document.body).appendChild(btn);
  lastId = id;
  // Trace unique : si le bouton reste introuvable, la console dit tout de
  // suite si le script s'est injecté et où il a réussi à se poser.
  console.log("[dmzs-music] bouton posé —", host ? host.id || host.tagName : "flottant");
}

/* YouTube est une SPA : ni chargement de page, ni DOM stable. On combine
   son évènement de navigation et un observateur volontairement paresseux —
   observer chaque mutation de youtube.com coûterait bien trop cher. */
let pending = null;
const schedule = () => {
  clearTimeout(pending);
  pending = setTimeout(ensureButton, 250);
};

new MutationObserver(schedule).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
addEventListener("yt-navigate-finish", schedule);
schedule();
