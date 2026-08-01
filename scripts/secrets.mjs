/**
 * Generates the three secrets and prints the commands to run.
 *   node scripts/secrets.mjs
 *
 * Keep the output: the activation link contains BOOTSTRAP_KEY, and that link
 * is what grants access to the app. Anyone can guess the site URL, nobody
 * will guess this key.
 */
import { randomBytes } from "node:crypto";

const key = () => randomBytes(32).toString("base64url");

const AUTH_SECRET = key();
const BOOTSTRAP_KEY = key();
const WORKER_TOKEN = key();

const DOMAIN = process.argv[2] || "music.example.com";

console.log(`
┌─ Secrets générés ────────────────────────────────────────────
│
│  AUTH_SECRET    ${AUTH_SECRET}
│  BOOTSTRAP_KEY  ${BOOTSTRAP_KEY}
│  WORKER_TOKEN   ${WORKER_TOKEN}
│
└──────────────────────────────────────────────────────────────

1. Enregistre-les auprès de Cloudflare (une commande, une valeur
   collée quand elle est demandée) :

   npx wrangler secret put AUTH_SECRET
   npx wrangler secret put BOOTSTRAP_KEY
   npx wrangler secret put WORKER_TOKEN

2. Lien d'activation — à ouvrir UNE FOIS par appareil :

   https://${DOMAIN}/auth?k=${BOOTSTRAP_KEY}

   Le cookie posé est valable un an. Note ce lien quelque part :
   il te resservira sur chaque nouvel appareil.

⚠️  Ne remets jamais ces valeurs dans un fichier suivi par git.
`);
