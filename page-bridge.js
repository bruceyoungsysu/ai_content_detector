// Runs in the page's MAIN JavaScript context.
// Responsibilities:
//   1. Return window.ytInitialData on request.
//   2. Intercept YouTube's continuation fetch calls (infinite scroll, search,
//      next-up recommendations) and forward the JSON response so the content
//      script can index those videos too.

(function () {
  // ── 1. On-demand ytInitialData ──────────────────────────────────────────
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    if (event.data?.type !== "AICD_REQUEST_YT_DATA") return;
    // eslint-disable-next-line no-undef
    const data = typeof ytInitialData !== "undefined" ? ytInitialData : null;
    window.postMessage({ type: "AICD_YT_DATA_RESPONSE", payload: data }, "*");
  });

  // ── 2. Intercept continuation fetch calls ───────────────────────────────
  const WATCHED_PATHS = [
    "/youtubei/v1/browse",   // homepage, channel, subscriptions
    "/youtubei/v1/search",   // search results
    "/youtubei/v1/next",     // up-next / watch page recommendations
  ];

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await _fetch.apply(this, args);

    const url = typeof args[0] === "string"
      ? args[0]
      : (args[0]?.url ?? "");

    if (WATCHED_PATHS.some((p) => url.includes(p))) {
      response.clone().json()
        .then((data) => {
          window.postMessage({ type: "AICD_YT_CONTINUATION", payload: data }, "*");
        })
        .catch(() => {});
    }

    return response;
  };
})();
