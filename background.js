const ORGANIZER_URL = chrome.runtime.getURL("organizer.html");

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: ORGANIZER_URL });
});

// ---------------------------------------------------------------------------
// Tab screenshot cache
// ---------------------------------------------------------------------------
// A live web page (especially an internal SPA) often has no og:image and no
// large <img>, so there is nothing meaningful to show as a "preview". The only
// faithful way to show "该网页当前打开的画面" is a real screenshot of the tab.
//
// Chrome can only capture the *visible* (active) tab of a window, so we build a
// cache opportunistically: whenever a tab becomes visible we snapshot it and
// keep the latest image keyed by tabId. The organizer page then requests the
// cached screenshot on hover.
// ---------------------------------------------------------------------------

const MAX_CACHE = 40;
const CAPTURE_OPTS = { format: "jpeg", quality: 55 };
// tabId(string) -> { dataUrl, ts, url }
const screenshotCache = new Map();

function isCapturableUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function rememberShot(tabId, dataUrl, url) {
  if (tabId == null || !dataUrl) return;
  const key = String(tabId);
  screenshotCache.delete(key);
  screenshotCache.set(key, { dataUrl, ts: Date.now(), url: url || "" });
  while (screenshotCache.size > MAX_CACHE) {
    const oldest = screenshotCache.keys().next().value;
    screenshotCache.delete(oldest);
  }
  // Best-effort persistence across service-worker restarts.
  try {
    const obj = {};
    obj[`shot:${key}`] = { dataUrl, ts: Date.now(), url: url || "" };
    chrome.storage.session.set(obj);
  } catch (_) {}
}

async function captureWindowActiveTab(windowId) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab || !isCapturableUrl(tab.url)) return;
    if (tab.url && tab.url.startsWith(ORGANIZER_URL)) return; // skip our own page
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, CAPTURE_OPTS);
    if (dataUrl) rememberShot(tab.id, dataUrl, tab.url);
  } catch (_) {
    // captureVisibleTab throws for chrome:// pages, throttling, etc. — ignore.
  }
}

// Capture whenever the visible tab changes.
chrome.tabs.onActivated.addListener(({ windowId }) => {
  // small delay so the tab has painted
  setTimeout(() => captureWindowActiveTab(windowId), 250);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab && tab.active) {
    setTimeout(() => captureWindowActiveTab(tab.windowId), 300);
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId != null && windowId !== chrome.windows.WINDOW_ID_NONE) {
    setTimeout(() => captureWindowActiveTab(windowId), 200);
  }
});

// Snapshot the active tab of every window right now (used when the organizer
// page opens, so at least the current foreground tabs have fresh screenshots).
async function primeAllWindows() {
  try {
    const wins = await chrome.windows.getAll({ populate: false });
    for (const w of wins) {
      await captureWindowActiveTab(w.id);
    }
  } catch (_) {}
}

async function getCachedShot(tabId) {
  if (tabId == null) return null;
  const key = String(tabId);
  if (screenshotCache.has(key)) return screenshotCache.get(key);
  try {
    const stored = await chrome.storage.session.get(`shot:${key}`);
    const entry = stored && stored[`shot:${key}`];
    if (entry && entry.dataUrl) {
      screenshotCache.set(key, entry);
      return entry;
    }
  } catch (_) {}
  return null;
}

// Capture the real rendered pixels of ANY tab (even a background one) via the
// Chrome Debugger protocol. captureVisibleTab only works on the visible tab,
// so this is the only way to preview a tab that is open but not in front.
const debuggerBusy = new Set();

async function captureViaDebugger(tabId) {
  if (tabId == null || !chrome.debugger) return "";
  const key = String(tabId);
  if (debuggerBusy.has(key)) return "";
  debuggerBusy.add(key);
  const target = { tabId };
  let attached = false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !isCapturableUrl(tab.url)) return "";
    if (tab.url && tab.url.startsWith(ORGANIZER_URL)) return "";

    await chrome.debugger.attach(target, "1.3");
    attached = true;
    // Enabling Page makes captureScreenshot reliable for background tabs.
    try { await chrome.debugger.sendCommand(target, "Page.enable", {}); } catch (_) {}
    const result = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 60,
      captureBeyondViewport: false
    });
    const dataUrl = result && result.data ? `data:image/jpeg;base64,${result.data}` : "";
    if (dataUrl) rememberShot(tabId, dataUrl, tab.url);
    return dataUrl;
  } catch (_error) {
    return "";
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
    debuggerBusy.delete(key);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "getScreenshot") {
    (async () => {
      // 1) If the requested tab is currently the active/visible tab, capture it
      //    live with the cheap API for the freshest possible image.
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        if (tab && tab.active && isCapturableUrl(tab.url)) {
          try {
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, CAPTURE_OPTS);
            if (dataUrl) {
              rememberShot(tab.id, dataUrl, tab.url);
              sendResponse({ dataUrl, live: true });
              return;
            }
          } catch (_) {}
        }
      } catch (_) {}

      // 2) Background tab (the common case): capture the real pixels through the
      //    debugger protocol — this works even though the tab is not visible.
      const shot = await captureViaDebugger(msg.tabId);
      if (shot) {
        sendResponse({ dataUrl: shot, live: true });
        return;
      }

      // 3) Last resort: whatever we cached earlier.
      const entry = await getCachedShot(msg.tabId);
      sendResponse({ dataUrl: entry ? entry.dataUrl : "" });
    })();
    return true; // async response
  }

  if (msg.type === "primeScreenshots") {
    (async () => {
      await primeAllWindows();
      sendResponse({ ok: true });
    })();
    return true;
  }
});
