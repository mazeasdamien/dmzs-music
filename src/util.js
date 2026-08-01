/** Fonctions pures — sans dépendance au runtime Workers, donc testables. */

/** Extrait l'identifiant d'une vidéo depuis à peu près n'importe quelle forme d'URL. */
export function videoIdFrom(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/
  );
  return m ? m[1] : null;
}

/**
 * Analyse un en-tête Range. Renvoie {start, end} ou null si non satisfiable.
 *
 * Extrait pour être testable isolément : c'est le bout de code qui casse
 * silencieusement la lecture audio sur iPhone quand il est faux. Safari sonde
 * chaque <audio> avec « Range: bytes=0-1 » avant de lire quoi que ce soit.
 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;

  let start;
  let end;
  if (m[1] === "") {
    // Forme suffixe : « bytes=-500 » = les 500 derniers octets.
    const n = parseInt(m[2], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return null;
  }
  return { start, end };
}
