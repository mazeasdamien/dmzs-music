/**
 * Authentification sans mot de passe.
 *
 * Principe : on ouvre une fois /auth?k=<BOOTSTRAP_KEY> sur un appareil.
 * Le Worker pose alors un cookie signé en HMAC-SHA256, valable un an.
 * Plus rien à taper ensuite, sur cet appareil.
 *
 * On ne renvoie JAMAIS de redirection vers une page de connexion : un 401 sec.
 * C'est délibéré — un <audio src> qui reçoit une redirection HTML échoue en
 * silence, sans erreur exploitable. Un 401 est détectable côté client.
 */

const enc = new TextEncoder();
const YEAR = 365 * 24 * 60 * 60;
const COOKIE = "dmzs_session";

/** Durée de validité d'une activation d'appareil. */
export const SESSION_TTL = 5 * YEAR;

/**
 * Au-delà de cet âge, le cookie est réémis à la volée.
 *
 * Nécessaire parce que Chrome plafonne tout cookie à 400 jours, quoi qu'on
 * demande : sans réémission, un appareil Chrome redemanderait une activation
 * au bout de 13 mois. Safari n'applique pas ce plafond aux cookies HttpOnly
 * posés par le serveur, l'iPhone garde donc bien les 5 ans.
 *
 * Une réémission au maximum par mois et par appareil : la signature HMAC ne
 * pèse rien, mais inutile de la refaire à chaque requête.
 */
export const RENEW_AFTER = 30 * 24 * 60 * 60;

function b64urlEncode(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Comparaison à temps constant (évite de fuiter le secret octet par octet). */
export function safeEqual(a, b) {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Longueurs différentes : on compare quand même pour ne pas révéler la taille.
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Fabrique un jeton de session `<payload>.<signature>`. */
export async function issueSession(secret, ttl = SESSION_TTL) {
  const payload = { exp: Math.floor(Date.now() / 1000) + ttl };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64urlEncode(sig)}`;
}

/** Vérifie un jeton. Renvoie le payload, ou null. */
export async function readSession(token, secret) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(sig),
      enc.encode(body)
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getCookie(request, name = COOKIE) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(token, maxAge = SESSION_TTL) {
  // HttpOnly : le JS de la page ne peut pas lire le cookie, mais fetch() et
  // <audio src> l'envoient automatiquement puisqu'on est en same-origin.
  // SameSite=Lax : suffisant ici, et n'empêche pas la navigation depuis
  // le lien d'activation.
  return [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * Le payload de session porté par la requête, ou null.
 *
 * Deux sources : le cookie pour le navigateur, l'en-tête `X-Session` pour
 * l'extension Chrome. Une requête d'extension est cross-site — le cookie,
 * en SameSite=Lax, ne partirait pas.
 *
 * L'en-tête n'ouvre aucune brèche CSRF : un site tiers ne peut pas poser
 * d'en-tête personnalisé sur une requête cross-origin, et aucune règle CORS
 * permissive n'est servie. Seule une extension disposant de la permission
 * d'hôte y arrive, ce qui suppose une installation explicite.
 */
export async function requestSession(request, env) {
  if (!env.AUTH_SECRET) return null;
  const token = getCookie(request) || request.headers.get("X-Session");
  return readSession(token, env.AUTH_SECRET);
}

/** true si la requête porte une session valide. */
export async function isAuthed(request, env) {
  return (await requestSession(request, env)) !== null;
}

/**
 * Un cookie neuf si la session commence à dater, sinon null.
 * L'appareil reste activé indéfiniment tant qu'il ouvre l'app au moins une
 * fois par an — y compris sur Chrome, qui aurait sinon coupé à 400 jours.
 */
export async function renewedCookie(payload, env) {
  const age = SESSION_TTL - (payload.exp - Math.floor(Date.now() / 1000));
  if (age < RENEW_AFTER) return null;
  return sessionCookie(await issueSession(env.AUTH_SECRET));
}
