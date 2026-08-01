/**
 * Logique commune au popup et au service worker.
 *
 * L'extension ne peut pas s'appuyer sur le cookie de session : ses requêtes
 * sont cross-site et le cookie est en SameSite=Lax. Elle échange donc une
 * fois la clé d'activation contre un jeton (/auth/token), qu'elle range dans
 * chrome.storage.local et présente ensuite dans l'en-tête X-Session.
 */

const DEFAULT_APP_URL = "https://music.example.com";

export async function getConfig() {
  const c = await chrome.storage.local.get(["appUrl", "token"]);
  return { appUrl: c.appUrl || DEFAULT_APP_URL, token: c.token || "" };
}

export const setConfig = (patch) => chrome.storage.local.set(patch);

/**
 * Accepte le lien d'activation complet ou la clé seule.
 * Coller le lien entier configure aussi l'adresse du serveur — une saisie
 * de moins, et aucune faute de frappe possible sur le domaine.
 */
export function parseSetup(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const k = u.searchParams.get("k");
    if (k) return { appUrl: u.origin, key: k };
  } catch {
    /* pas une URL : on traite l'entrée comme la clé seule */
  }
  return { appUrl: null, key: raw };
}

/** Échange la clé d'activation contre un jeton de session. */
export async function activate(appUrl, key) {
  let res;
  try {
    res = await fetch(`${appUrl}/auth/token?k=${encodeURIComponent(key)}`);
  } catch {
    throw new Error("Cannot reach the server. Check the address.");
  }
  if (res.status === 401) throw new Error("Wrong activation key.");
  if (!res.ok) throw new Error(`Server error ${res.status}.`);
  const { token } = await res.json().catch(() => ({}));
  if (!token) throw new Error("No token returned.");
  return token;
}

const VIDEO =
  /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;

export function videoIdFrom(url) {
  const m = String(url || "").match(VIDEO);
  return m ? m[1] : null;
}

/** Dépose un titre dans la file. Renvoie { id } ou { id, duplicate: true }. */
export async function addTrack(url) {
  const { appUrl, token } = await getConfig();
  if (!token) throw new Error("NOT_CONFIGURED");

  const res = await fetch(`${appUrl}/api/tracks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session": token },
    body: JSON.stringify({ url }),
  });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) throw new Error("Session expired. Set up the extension again.");
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
