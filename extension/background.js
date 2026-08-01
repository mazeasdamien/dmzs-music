/**
 * Service worker: the "Add to Music" right-click entry.
 * The popup covers clicking the toolbar icon; this file covers adding in a
 * single gesture, without opening any window.
 */
import { addTrack, videoIdFrom } from "./shared.js";

const YT = ["*://*.youtube.com/*", "*://youtu.be/*"];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    // Two entries rather than one: on a YouTube page we target the current
    // page, elsewhere we target the hovered link. A single entry carrying
    // both filters would require both to match at the same time.
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

/* The button injected into the YouTube page goes through here: a content
   script does not hold the host permission needed to call the Worker itself. */
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type !== "add") return false;
  addTrack(msg.url)
    .then((data) => respond({ ok: true, duplicate: Boolean(data.duplicate) }))
    .catch((e) => respond({ ok: false, error: e.message }));
  // true: the answer comes later, so Chrome must keep the channel open.
  return true;
});

async function send(url) {
  if (!videoIdFrom(url)) return flash("?", "#56565e");
  try {
    const data = await addTrack(url);
    flash(data.duplicate ? "=" : "✓", "#f0a04b");
  } catch {
    // The popup shows the error detail; here a red badge is enough to say
    // "it did not go through".
    flash("!", "#f2615c");
  }
}

function flash(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  // An MV3 service worker can be stopped before this fires, leaving the
  // badge on screen. Harmless: the next click overwrites it.
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
}
