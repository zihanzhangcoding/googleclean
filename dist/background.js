const ORGANIZER_URL = chrome.runtime.getURL("organizer.html");

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: ORGANIZER_URL });
});