async function pauseYouTubeTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" });
  await Promise.all(tabs.flatMap((tab) => tab.id === undefined
    ? []
    : [chrome.tabs.sendMessage(tab.id, { action: "pause-window" }).catch(() => undefined)]));
}

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) void pauseYouTubeTabs();
});
