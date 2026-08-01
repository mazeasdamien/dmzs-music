/**
 * Tests des parties critiques : signature de session et analyse des Range.
 * Lancer : node test.mjs
 */
import {
  issueSession,
  readSession,
  safeEqual,
  sessionCookie,
  getCookie,
  requestSession,
} from "./src/auth.js";
import { videoIdFrom, parseRange } from "./src/util.js";

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${label}`); }
};
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label} — reçu ${JSON.stringify(a)}, attendu ${JSON.stringify(b)}`);

console.log("\n── videoIdFrom ─────────────────────────────");
eq(videoIdFrom("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ", "watch classique");
eq(videoIdFrom("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ", "lien court");
eq(videoIdFrom("https://youtu.be/dQw4w9WgXcQ?si=abc123"), "dQw4w9WgXcQ", "lien court + tracking");
eq(videoIdFrom("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42s"), "dQw4w9WgXcQ", "mobile + timestamp");
eq(videoIdFrom("https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ"), "dQw4w9WgXcQ", "v après un autre paramètre");
eq(videoIdFrom("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ", "shorts");
eq(videoIdFrom("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ", "embed");
eq(videoIdFrom("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ", "youtube music");
eq(videoIdFrom("  dQw4w9WgXcQ  "), "dQw4w9WgXcQ", "id brut avec espaces");
eq(videoIdFrom("https://example.com/watch?v=dQw4w9WgXcQ"), null, "domaine non YouTube rejeté");
eq(videoIdFrom("n'importe quoi"), null, "texte quelconque rejeté");
eq(videoIdFrom(""), null, "chaîne vide rejetée");
eq(videoIdFrom(null), null, "null rejeté");
console.log(`  ${pass} assertions passées`);

console.log("\n── parseRange (taille 1000) ────────────────");
const S = 1000;
eq(parseRange("bytes=0-1", S), { start: 0, end: 1 }, "sonde Safari bytes=0-1");
eq(parseRange("bytes=0-", S), { start: 0, end: 999 }, "ouvert à droite");
eq(parseRange("bytes=500-", S), { start: 500, end: 999 }, "depuis 500");
eq(parseRange("bytes=200-499", S), { start: 200, end: 499 }, "intervalle fermé");
eq(parseRange("bytes=-300", S), { start: 700, end: 999 }, "suffixe : 300 derniers octets");
eq(parseRange("bytes=-5000", S), { start: 0, end: 999 }, "suffixe plus grand que le fichier");
eq(parseRange("bytes=0-99999", S), { start: 0, end: 999 }, "fin tronquée à la taille");
eq(parseRange(" bytes=0-1 ", S), { start: 0, end: 1 }, "espaces tolérés");
eq(parseRange("bytes=1000-1200", S), null, "début hors fichier → 416");
eq(parseRange("bytes=800-200", S), null, "intervalle inversé → 416");
eq(parseRange("bytes=-0", S), null, "suffixe nul → 416");
eq(parseRange("bytes=-", S), null, "vide des deux côtés → 416");
eq(parseRange("octets=0-1", S), null, "unité inconnue → 416");
eq(parseRange("bytes=0-1, 5-6", S), null, "multi-intervalles non supporté → 416");
eq(parseRange("", S), null, "en-tête vide");
eq(parseRange(null, S), null, "en-tête absent");

// Cohérence Content-Length : la longueur annoncée doit correspondre aux octets servis.
for (const h of ["bytes=0-1", "bytes=0-", "bytes=-300", "bytes=200-499"]) {
  const r = parseRange(h, S);
  ok(r && r.end - r.start + 1 > 0 && r.end < S, `longueur cohérente pour ${h}`);
}
console.log(`  ${pass} assertions cumulées`);

console.log("\n── sessions signées ────────────────────────");
const SECRET = "un-secret-de-test-suffisamment-long-123456";

const token = await issueSession(SECRET);
ok((await readSession(token, SECRET)) !== null, "un jeton fraîchement émis est valide");
ok((await readSession(token, "mauvais-secret")) === null, "un autre secret le rejette");

const [body, sig] = token.split(".");
ok((await readSession(`${body}x.${sig}`, SECRET)) === null, "payload modifié → rejet");
ok((await readSession(`${body}.${sig.slice(0, -2)}AA`, SECRET)) === null, "signature modifiée → rejet");
ok((await readSession(body, SECRET)) === null, "signature absente → rejet");
ok((await readSession("", SECRET)) === null, "jeton vide → rejet");
ok((await readSession(null, SECRET)) === null, "jeton null → rejet");
ok((await readSession("....", SECRET)) === null, "jeton absurde → rejet");

// Un attaquant ne doit pas pouvoir forger une expiration lointaine :
// changer le payload invalide la signature.
const forged = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString("base64url");
ok((await readSession(`${forged}.${sig}`, SECRET)) === null, "expiration forgée → rejet");

const expired = await issueSession(SECRET, -10);
ok((await readSession(expired, SECRET)) === null, "jeton expiré → rejet");

const long = await issueSession(SECRET);
const payload = await readSession(long, SECRET);
const days = (payload.exp - Math.floor(Date.now() / 1000)) / 86400;
ok(days > 1824 && days < 1826, `durée de vie ≈ 5 ans (${Math.round(days)} j)`);

console.log("\n── comparaison à temps constant ────────────");
ok(safeEqual("abc", "abc"), "chaînes identiques");
ok(!safeEqual("abc", "abd"), "un caractère de différence");
ok(!safeEqual("abc", "abcd"), "longueurs différentes");
ok(!safeEqual("", "x"), "vide vs non vide");
ok(safeEqual("", ""), "deux vides");

console.log("\n── cookie ──────────────────────────────────");
const c = sessionCookie("VALEUR");
ok(c.includes("HttpOnly"), "HttpOnly présent");
ok(c.includes("Secure"), "Secure présent");
ok(c.includes("SameSite=Lax"), "SameSite=Lax présent");
ok(c.includes("Max-Age=157680000"), "Max-Age = 5 ans");

const fakeReq = (cookie) => ({ headers: { get: (h) => (h === "Cookie" ? cookie : null) } });
eq(getCookie(fakeReq("dmzs_session=abc")), "abc", "lecture simple");
eq(getCookie(fakeReq("autre=1; dmzs_session=abc; x=2")), "abc", "lecture parmi d'autres");
eq(getCookie(fakeReq("  dmzs_session=abc  ")), "abc", "espaces tolérés");
eq(getCookie(fakeReq("dmzs_session_autre=abc")), null, "pas de correspondance partielle");
eq(getCookie(fakeReq(null)), null, "aucun cookie");

console.log("\n── session par en-tête (extension Chrome) ───");
// L'extension ne peut pas envoyer le cookie (cross-site, SameSite=Lax) :
// elle présente le même jeton signé dans X-Session. Le chemin doit être
// exactement aussi strict que celui du cookie.
const req2 = (cookie, header) => ({
  headers: {
    get: (h) => (h === "Cookie" ? cookie : h === "X-Session" ? header : null),
  },
});
const ENV = { AUTH_SECRET: SECRET };

ok((await requestSession(req2(null, token), ENV)) !== null, "X-Session valide → accepté");
ok((await requestSession(req2(null, "bidon"), ENV)) === null, "X-Session bricolé → rejet");
ok((await requestSession(req2(null, expired), ENV)) === null, "X-Session expiré → rejet");
ok((await requestSession(req2(null, null), ENV)) === null, "ni cookie ni en-tête → rejet");
ok((await requestSession(req2(`dmzs_session=${token}`, null), ENV)) !== null, "cookie seul → toujours accepté");
ok((await requestSession(req2(null, token), { AUTH_SECRET: "" })) === null, "sans AUTH_SECRET → rejet");

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} assertions passées, ${fail} échec(s)\n`);
process.exit(fail ? 1 : 0);
