/**
 * Service worker : le clic droit « Add to Music ».
 * Le popup gère le cas du clic sur l'icône ; ici on couvre l'ajout en un
 * geste, sans ouvrir de fenêtre.
 */
import { addTrack, videoIdFrom } from "./shared.js";

const YT = ["*://*.youtube.com/*", "*://youtu.be/*"];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    // Deux entrées plutôt qu'une : sur une page YouTube on vise la page
    // courante, ailleurs on vise le lien survolé. Une seule entrée cumulant
    // les deux filtres exigerait que les deux correspondent en même temps.
    chrome.contextMenus.create({
      id: "add-page",
      title: "Add to Music",
      contexts: ["page", "video", "selection"],
      documentUrlPatterns: YT,
    });
    chrome.contextMenus.create({
      id: "add-link",
      title: "Add to Music",
      contexts: ["link"],
      targetUrlPatterns: YT,
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  send(info.linkUrl || info.pageUrl || tab?.url);
});

/* Le bouton injecté dans la page YouTube passe par ici : un script de contenu
   n'a pas la permission d'hôte nécessaire pour appeler le Worker lui-même. */
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type !== "add") return false;
  addTrack(msg.url)
    .then((data) => respond({ ok: true, duplicate: Boolean(data.duplicate) }))
    .catch((e) => respond({ ok: false, error: e.message }));
  // true : la réponse arrive plus tard, Chrome doit garder le canal ouvert.
  return true;
});

async function send(url) {
  if (!videoIdFrom(url)) return flash("?", "#56565e");
  try {
    const data = await addTrack(url);
    flash(data.duplicate ? "=" : "✓", "#f0a04b");
  } catch {
    // Le détail de l'erreur est affiché par le popup ; ici, une pastille
    // rouge suffit à dire « ça n'est pas parti ».
    flash("!", "#f2615c");
  }
}

function flash(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  // Un service worker MV3 peut être arrêté avant l'échéance : la pastille
  // resterait alors affichée. Sans conséquence, elle est écrasée au clic suivant.
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
}
