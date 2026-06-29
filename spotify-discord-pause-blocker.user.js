// ==UserScript==
// @name         Spotify Discord Pause Auto-Resume
// @namespace    https://github.com/WinterMelon14/spotify-discord-pause-auto-resume
// @version      1.1.0
// @description  Auto-resumes Spotify Web Player when Discord/voice activity causes unwanted pauses.
// @match        https://open.spotify.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(() => {
  "use strict";

  const LOG_PREFIX = "[Spotify Pause Auto-Resume]";

  const CONFIG = {
    enabled: true,

    // Try multiple times because Spotify’s UI/state can lag behind the media pause.
    resumeDelaysMs: [25, 100, 250],

    // Lets you manually pause without the script immediately fighting you.
    allowRecentManualPauseIntent: true,

    // Increase this if manual pausing still gets auto-resumed.
    manualPauseGraceMs: 1500,

    // Prevents rapid repeated auto-resume loops.
    autoResumeCooldownMs: 500,

    // Set true while debugging.
    debug: false
  };

  let lastManualPauseIntentAt = 0;
  let lastAutoResumeAt = 0;

  function log(...args) {
    if (CONFIG.debug) {
      console.log(LOG_PREFIX, ...args);
    }
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function markManualIntent(reason, details = {}) {
    lastManualPauseIntentAt = Date.now();
    log("Manual playback intent detected:", reason, details);
  }

  function recentlyManualPauseIntent() {
    return Date.now() - lastManualPauseIntentAt < CONFIG.manualPauseGraceMs;
  }

  function isSpotifyPlayPauseButton(el) {
    if (!el) return false;

    const button = el.closest?.("button");
    if (!button) return false;

    const text = [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.dataset?.testid
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (
      text.includes("play") ||
      text.includes("pause") ||
      text.includes("playpause") ||
      text.includes("control-button-playpause")
    );
  }

  /**
   * Detect normal mouse/touch clicks on Spotify's own play/pause button.
   */
  document.addEventListener(
    "pointerdown",
    event => {
      if (isSpotifyPlayPauseButton(event.target)) {
        markManualIntent("spotify play/pause button", {
          target: event.target
        });
      }
    },
    true
  );

  /**
   * Detect keyboard playback-ish input when the browser exposes it to the page.
   * Some hardware media keys will NOT appear here, hence the Media Session patch below.
   */
  document.addEventListener(
    "keydown",
    event => {
      const manualKeys = new Set([
        "Space",
        "MediaPlayPause",
        "MediaPause",
        "MediaPlay"
      ]);

      if (
        manualKeys.has(event.code) ||
        manualKeys.has(event.key) ||
        event.key === " "
      ) {
        markManualIntent("keyboard/media key", {
          key: event.key,
          code: event.code
        });
      }
    },
    true
  );

  /**
   * Detect hardware media keys routed through the Media Session API.
   *
   * Many keyboards' play/pause buttons do not fire regular keydown events
   * inside the Spotify tab. Instead, the browser calls Spotify's registered
   * media session action handlers. We wrap those handlers and mark that as
   * manual intent before Spotify pauses.
   */
  if (navigator.mediaSession?.setActionHandler) {
    const originalSetActionHandler =
      navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);

    navigator.mediaSession.setActionHandler = function patchedSetActionHandler(
      action,
      handler
    ) {
      const wrappedHandler = handler
        ? function wrappedMediaSessionHandler(details) {
            if (
              action === "pause" ||
              action === "play" ||
              action === "playpause" ||
              action === "stop"
            ) {
              markManualIntent("media session action", {
                action,
                details
              });
            }

            return handler.apply(this, arguments);
          }
        : handler;

      return originalSetActionHandler(action, wrappedHandler);
    };

    log("Media Session action handler patched");
  }

  function findMediaElements() {
    return [...document.querySelectorAll("audio, video")];
  }

  function findPlayButton() {
    return (
      document.querySelector('button[data-testid="control-button-playpause"]') ||
      document.querySelector('button[aria-label="Play"]') ||
      document.querySelector('[aria-label="Play"]')
    );
  }

  function attemptResume(reason, delay) {
    const mediaElements = findMediaElements();

    for (const el of mediaElements) {
      if (el.paused) {
        log(`Trying media.play() after ${delay}ms`, {
          reason,
          currentTime: el.currentTime,
          readyState: el.readyState
        });

        el.play().catch(err => {
          log("media.play() failed:", err);
        });
      }
    }

    const playButton = findPlayButton();

    if (playButton) {
      const label = playButton.getAttribute("aria-label") || "";

      // Only click if Spotify currently exposes this as a Play button.
      // This avoids accidentally clicking Pause after playback already resumed.
      if (label.toLowerCase().includes("play")) {
        log(`Clicking Spotify play button after ${delay}ms`, {
          reason
        });

        playButton.click();
      }
    }
  }

  function scheduleAutoResume(reason) {
    if (!CONFIG.enabled) return;

    if (
      CONFIG.allowRecentManualPauseIntent &&
      recentlyManualPauseIntent()
    ) {
      log("Skipping auto-resume because pause looks manual", {
        reason
      });
      return;
    }

    const now = Date.now();

    if (now - lastAutoResumeAt < CONFIG.autoResumeCooldownMs) {
      log("Skipping auto-resume because one just happened", {
        reason
      });
      return;
    }

    lastAutoResumeAt = now;

    warn("Auto-resuming after unwanted pause:", reason);

    for (const delay of CONFIG.resumeDelaysMs) {
      setTimeout(() => {
        if (
          CONFIG.allowRecentManualPauseIntent &&
          recentlyManualPauseIntent()
        ) {
          log("Skipping delayed resume because manual intent appeared", {
            reason,
            delay
          });
          return;
        }

        attemptResume(reason, delay);
      }, delay);
    }
  }

  /**
   * Patch local media pause.
   *
   * This is the part that actually handles the Discord-triggered pause.
   * Spotify has already paused locally by the time its network state request
   * fires, so intercepting fetch alone is too late.
   */
  const originalPause = HTMLMediaElement.prototype.pause;
  const originalPlay = HTMLMediaElement.prototype.play;

  HTMLMediaElement.prototype.pause = function patchedPause() {
    const result = originalPause.apply(this, arguments);

    scheduleAutoResume("HTMLMediaElement.pause()");

    return result;
  };

  HTMLMediaElement.prototype.play = function patchedPlay() {
    log("HTMLMediaElement.play() called");
    return originalPlay.apply(this, arguments);
  };

  console.log(`${LOG_PREFIX} Installed`);
})();
