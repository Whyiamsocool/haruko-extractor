// Content script: bridges the page's sessionStorage to the extension
// sessionStorage is same-origin, so content scripts can access it

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getAuth') {
    let token = null;
    try {
      const raw = sessionStorage.getItem('haruko_token');
      token = raw ? JSON.parse(raw) : null;
    } catch (e) {
      // Token may be a plain string, not JSON
      token = sessionStorage.getItem('haruko_token');
    }
    const baseUrl = window.location.origin;
    sendResponse({ token, baseUrl });
  }

  if (request.action === 'getGroups') {
    // Try to extract group info from the page URL or DOM
    const url = window.location.href;
    const groupMatch = url.match(/summary\/([^/?#]+)/);
    const group = groupMatch ? decodeURIComponent(groupMatch[1]) : null;
    sendResponse({ currentGroup: group });
  }

  return true; // keep channel open for async
});
