(function () {
  "use strict";

  var tooltip = createTooltip();
  var lastExtractedKey = "";

  function processExtractedData(data) {
    // Hook your backend/API call here.
    console.log("[Hover URL Extractor]", data);
  }

  function createTooltip() {
    var el = document.createElement("div");
    el.id = "hover-url-extractor-tooltip";
    el.style.position = "fixed";
    el.style.bottom = "16px";
    el.style.right = "16px";
    el.style.maxWidth = "min(90vw, 560px)";
    el.style.padding = "8px 10px";
    el.style.borderRadius = "8px";
    el.style.background = "rgba(0, 0, 0, 0.85)";
    el.style.color = "#ffffff";
    el.style.font = "12px/1.4 Arial, sans-serif";
    el.style.zIndex = "2147483647";
    el.style.pointerEvents = "none";
    el.style.wordBreak = "break-word";
    el.style.display = "none";
    document.documentElement.appendChild(el);
    return el;
  }

  function showTooltip(data) {
    tooltip.textContent = data.platform + ": " + data.url;
    tooltip.style.display = "block";
  }

  function hideTooltip() {
    tooltip.style.display = "none";
  }

  function extractYouTubeData(target) {
    if (!target || !target.closest) {
      return null;
    }

    var anchor = target.closest('a[href*="/watch?v="]');
    if (!anchor) {
      return null;
    }

    var href = anchor.getAttribute("href") || "";
    if (!href) {
      return null;
    }

    var parsed = new URL(href, window.location.origin);
    var videoId = parsed.searchParams.get("v");

    if (!videoId) {
      return null;
    }

    return {
      url: "https://www.youtube.com/watch?v=" + videoId,
      platform: "youtube"
    };
  }

  function extractTwitterData(target) {
    if (!target || !target.closest) {
      return null;
    }

    var article = target.closest("article");
    if (!article) {
      return null;
    }

    var anchors = article.querySelectorAll('a[href*="/status/"]');
    if (!anchors || anchors.length === 0) {
      return null;
    }

    for (var i = 0; i < anchors.length; i += 1) {
      var rawHref = anchors[i].getAttribute("href") || "";
      if (!rawHref) {
        continue;
      }

      var parsed = new URL(rawHref, window.location.origin);
      // Extract only /username/status/tweet_id and drop /photo/1, query params, etc.
      var match = parsed.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);

      if (!match) {
        continue;
      }

      var cleanPath = "/" + match[1] + "/status/" + match[2];
      return {
        url: window.location.origin + cleanPath,
        platform: "twitter"
      };
    }

    return null;
  }

  function detectPlatform() {
    var host = window.location.hostname;

    if (host.indexOf("youtube.com") !== -1) {
      return "youtube";
    }

    if (host.indexOf("twitter.com") !== -1 || host.indexOf("x.com") !== -1) {
      return "twitter";
    }

    return null;
  }

  function handleMouseOver(event) {
    try {
      var platform = detectPlatform();
      if (!platform) {
        return;
      }

      var data =
        platform === "youtube"
          ? extractYouTubeData(event.target)
          : extractTwitterData(event.target);

      if (!data || !data.url) {
        return;
      }

      var key = data.platform + "|" + data.url;
      if (key === lastExtractedKey) {
        showTooltip(data);
        return;
      }

      lastExtractedKey = key;
      showTooltip(data);
      processExtractedData(data);
    } catch (err) {
      // Silently ignore extraction errors to avoid breaking site interactions.
      console.debug("[Hover URL Extractor] extraction error", err);
    }
  }

  function handleMouseOut() {
    hideTooltip();
  }

  document.addEventListener("mouseover", handleMouseOver, true);
  document.addEventListener("mouseout", handleMouseOut, true);
})();
