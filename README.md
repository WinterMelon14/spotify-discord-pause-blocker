# Spotify Discord Pause Blocker

A Tampermonkey userscript that helps stop Spotify Web Player from staying paused when Discord voice/activity detection causes an unwanted pause.

Instead of trying to fully prevent Spotify’s internal pause event, the script detects the local media pause, quickly resumes playback, and blocks Spotify’s outgoing pause-state sync request.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open the raw userscript URL:

   ```text
   https://raw.githubusercontent.com/WinterMelon14/spotify-discord-pause-blocker/main/spotify-discord-pause-blocker.user.js
   ```

3. Make sure allow user scripts is turned on for Tampermonkey
4. That's it! Nothing needs to be changed in discord!

## License
MIT
