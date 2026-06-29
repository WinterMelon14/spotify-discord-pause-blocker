// ==UserScript==
// @name         Spotify Discord Pause Blocker
// @namespace    https://github.com/WinterMelon14/spotify-discord-pause-blocker
// @version      1.0.0
// @description  Auto-resumes Spotify Web Player when Discord voice activity causes unwanted pauses.
// @match        https://open.spotify.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[Spotify Pause Blocker]";

  const CONFIG = {
    blockPauseStateRequests: true,

    // If blocking fails, just autoresume instantly!
    autoResumeAfterPause: true,

    // How quickly to resume after an unwanted pause.
    resumeDelaysMs: [0, 25, 75, 150, 300],

    // If true, this allows you to pause manually from the Spotify UI without fighting the script.
    allowRecentManualPauseButtonClick: true,

    // Time window for considering a click on the play/pause button "manual".
    manualClickGraceMs: 1200,

  };

  const STATE_URL_RE =
    /^https:\/\/[a-z0-9-]+spclient\.spotify\.com\/track-playback\/v1\/devices\/[^/]+\/state$/;

  let lastManualPauseIntentAt = 0;
  let lastBlockedPauseRequestAt = 0;
  let lastAutoResumeAt = 0;

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function isSpotifyPlayPauseButton(el) {
    if (!el) return false;

    const button = el.closest?.("button");
    if (!button) return false;

    const label = [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.dataset?.testid
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (
      label.includes("pause") ||
      label.includes("play") ||
      label.includes("playpause") ||
      label.includes("control-button-playpause")
    );
  }

  document.addEventListener(
    "pointerdown",
    event => {
      if (isSpotifyPlayPauseButton(event.target)) {
        lastManualPauseIntentAt = Date.now();
        log("Manual play/pause button interaction detected");
      }
    },
    true
  );

  document.addEventListener(
    "keydown",
    event => {
      // Space often toggles playback when Spotify has focus.
      if (event.code === "Space" || event.key === " ") {
        lastManualPauseIntentAt = Date.now();
        log("Possible manual keyboard playback toggle detected");
      }
    },
    true
  );

  function parseJsonBody(body) {
    if (typeof body !== "string") return null;

    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  function isPausePayload(json) {
    return (
      json?.debug_source === "pause" &&
      json?.state_ref?.paused === true &&
      json?.sub_state?.playback_speed === 0
    );
  }

  function makeFakeOkResponse() {
    return new Response(
      JSON.stringify({
        blocked: true,
        by: "Spotify Pause Blocker",
        at: new Date().toISOString()
      }),
      {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }

  function recentlyManualPauseIntent() {
    return Date.now() - lastManualPauseIntentAt < CONFIG.manualClickGraceMs;
  }

  function findSpotifyAudioElements() {
    return [...document.querySelectorAll("audio, video")];
  }

  function findPlayButton() {
    return (
      document.querySelector('button[data-testid="control-button-playpause"]') ||
      document.querySelector('button[aria-label="Play"]') ||
      document.querySelector('[aria-label="Play"]')
    );
  }

  function scheduleAutoResume(reason) {
    if (!CONFIG.autoResumeAfterPause) return;

    if (
      CONFIG.allowRecentManualPauseButtonClick &&
      recentlyManualPauseIntent()
    ) {
      log("Not auto-resuming because recent manual pause/play intent was detected");
      return;
    }

    const now = Date.now();

    // Avoid spam loops.
    if (now - lastAutoResumeAt < 500) {
      log("Skipping auto-resume because one just happened");
      return;
    }

    lastAutoResumeAt = now;

    warn("Scheduling auto-resume:", reason);

    for (const delay of CONFIG.resumeDelaysMs) {
      setTimeout(() => {
        const mediaEls = findSpotifyAudioElements();

        for (const el of mediaEls) {
          if (el.paused) {
            warn(`Attempting media.play() after ${delay}ms`, {
              reason,
              src: el.currentSrc || el.src,
              currentTime: el.currentTime,
              paused: el.paused,
              readyState: el.readyState
            });

            el.play().catch(err => {
              warn("media.play() failed:", err);
            });
          }
        }

        const playButton = findPlayButton();

        if (playButton) {
          const label = playButton.getAttribute("aria-label");
          if (label && label.toLowerCase().includes("play")) {
            warn(`Clicking Spotify play button after ${delay}ms`);
            playButton.click();
          }
        } else {
          log("No play button found during auto-resume attempt");
        }
      }, delay);
    }
  }

  /**
   * Patch network pause-state sync.
   */
  const originalFetch = window.fetch;

  window.fetch = function patchedFetch(input, init = {}) {
    let url = "";
    let method = "GET";
    let body = init?.body;

    try {
      if (typeof input === "string" || input instanceof URL) {
        url = String(input);
        method = init?.method || "GET";
      } else if (input instanceof Request) {
        url = input.url;
        method = init?.method || input.method || "GET";
        body = init?.body ?? null;
      } else {
        url = String(input);
        method = init?.method || "GET";
      }

      const json = parseJsonBody(body);

      const isTargetRequest =
        method.toUpperCase() === "PUT" &&
        STATE_URL_RE.test(url);

      const isPauseRequest = isPausePayload(json);


      if (
        CONFIG.blockPauseStateRequests &&
        isTargetRequest &&
        isPauseRequest
      ) {
        lastBlockedPauseRequestAt = Date.now();

        warn("BLOCKED Spotify pause state request", {
          url,
          json
        });

        scheduleAutoResume("blocked pause state request");

        return Promise.resolve(makeFakeOkResponse());
      }
    } catch (err) {
      console.error(LOG_PREFIX, "Fetch patch error; allowing original request:", err);
    }

    return originalFetch.apply(this, arguments);
  };

  /**
   * Patch actual local media pause.
   */
  const originalPause = HTMLMediaElement.prototype.pause;
  const originalPlay = HTMLMediaElement.prototype.play;

  HTMLMediaElement.prototype.pause = function patchedMediaPause() {
    const el = this;
    const result = originalPause.apply(this, arguments);

    if (
      CONFIG.autoResumeAfterPause &&
      !recentlyManualPauseIntent()
    ) {
      scheduleAutoResume("HTMLMediaElement.pause()");
    }

    return result;
  };

  HTMLMediaElement.prototype.play = function patchedMediaPlay() {

    return originalPlay.apply(this, arguments);
  };

  log("Installed local resume patch");
})();
