import { getConfig, setConfig, parseSetup, activate, addTrack, videoIdFrom } from "./shared.js";

const $ = (s) => document.querySelector(s);

function say(el, text, kind) {
  el.textContent = text;
  el.className = `msg show ${kind}`;
}

function show(which) {
  $("#setup").classList.toggle("hide", which !== "setup");
  $("#main").classList.toggle("hide", which !== "main");
}

/* -- first run ---------------------------------------------- */
async function saveKey() {
  const parsed = parseSetup($("#key").value);
  if (!parsed) return say($("#setupMsg"), "Paste your activation link first.", "err");

  const { appUrl: current } = await getConfig();
  const appUrl = parsed.appUrl || current;

  $("#save").disabled = true;
  say($("#setupMsg"), "Connecting…", "");
  try {
    const token = await activate(appUrl, parsed.key);
    await setConfig({ appUrl, token });
    await start();
  } catch (e) {
    say($("#setupMsg"), e.message, "err");
  } finally {
    $("#save").disabled = false;
  }
}

/* -- normal use --------------------------------------------- */
let currentUrl = null;

async function add() {
  $("#add").disabled = true;
  say($("#mainMsg"), "Adding…", "");
  try {
    const data = await addTrack(currentUrl);
    say($("#mainMsg"), data.duplicate ? "Already in your library." : "Download started.", "ok");
  } catch (e) {
    if (e.message === "NOT_CONFIGURED") return show("setup");
    say($("#mainMsg"), e.message, "err");
    $("#add").disabled = false;
  }
}

async function start() {
  const { token } = await getConfig();
  if (!token) return show("setup");

  show("main");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentUrl = tab?.url || "";

  $("#tabTitle").textContent = tab?.title || "No tab";
  $("#tabUrl").textContent = currentUrl || "—";

  if (!videoIdFrom(currentUrl)) {
    $("#add").disabled = true;
    say($("#mainMsg"), "Not a YouTube video. Open one, or right-click a link → Add to Music.", "");
  }
}

$("#save").addEventListener("click", saveKey);
$("#key").addEventListener("keydown", (e) => { if (e.key === "Enter") saveKey(); });
$("#add").addEventListener("click", add);
$("#reset").addEventListener("click", async () => {
  await setConfig({ token: "" });
  show("setup");
});

start();
