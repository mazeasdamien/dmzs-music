/**
 * The "Add to Music" button injected into the YouTube page.
 *
 * This script never calls the Worker itself: it goes through the service
 * worker (chrome.runtime.sendMessage). That is what avoids requesting a host
 * permission on youtube.com. A script injected into the page cannot make a
 * cross-origin request without one; the service worker can.
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
    // Happens after the extension is reloaded: the channel is dead.
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
 * Where to put the button, from most desirable to last resort.
 *
 * `#owner` holds the avatar, the channel name and the Subscribe button, so
 * appending ours lands it just to the right of Subscribe. The action rows are
 * the fallback if YouTube changes that structure, which it does. That is why
 * there are four levels rather than one.
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
    // The floating button is a fallback: as soon as the action row exists,
    // move it there. YouTube often builds that row after the first render.
    if (host && btn.classList.contains("float")) {
      btn.classList.replace("float", "inline");
      host.appendChild(btn);
    }
    // New video: the button has to go back to its initial state.
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
  // Single trace: if the button cannot be found, the console says right away
  // whether the script was injected and where it managed to attach.
  console.log("[dmzs-music] button placed:", host ? host.id || host.tagName : "floating");
}

/* YouTube is a SPA: no page load, no stable DOM. We combine its navigation
   event with a deliberately lazy observer, because watching every mutation on
   youtube.com would cost far too much. */
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
