<h1 align="center">TidalEQ</h1>

<p align="center">A real equalizer inside TIDAL.</p>

TidalEQ is an equalizer plugin for [TidaLuna](https://github.com/Inrixia/TidaLuna). It adds an **Equalizer** tab next to Similar tracks, Credits and Lyrics in TIDAL's now-playing view, so you can shape the sound without leaving the player.

## Install

1. Install [TidaLuna](https://github.com/Inrixia/TidaLuna).
2. Install [mpv](https://mpv.io/installation/). TidalEQ looks for it in `C:\Program Files\MPV Player\mpv.exe`; you can change the path in the plugin settings.
3. In TIDAL, open **Settings → Luna → Plugin Store**.
4. Paste this into **Install from URL**:

   ```
   https://github.com/BaeHyolyn/TidalEqualizer/releases/latest/download/store.json
   ```

5. Install **TidalEQ** from the store that appears.

Turn off TIDAL's exclusive mode: TidalEQ plays the audio itself, and exclusive mode would lock the output device.

## Features

- **Equalizer tab** in the now-playing view, with the same look as TIDAL's own tabs.
- **10 parametric bands** on a live frequency response graph. Drag a dot to change its frequency and gain, scroll to change its width, double-click to reset it. Each band can be a peak, low/high shelf or low/high-pass filter.
- **Bass, Voice and Treble** sliders for quick broad changes.
- **19 presets**: Deep Bass, Punchy, Bright, Clear Vocals, Hip-Hop, Trap, EDM, Rock, Metal, Pop, K-Pop, Jazz, Classical, Lo-fi, Acoustic, Podcast, Movie Dialog, Movie Immersion and Flat.
- **Preamp**, **smart volume** (evens out loud and quiet parts) and a **limiter** so boosts never clip.

## How it works

TIDAL's desktop app plays audio in a separate native player that plugins can't reach, so TidalEQ plays each track through [mpv](https://mpv.io) with your equalizer instead. TIDAL's own player keeps running silently, so the progress bar, queue, play/pause, seeking and volume all work as usual and mpv follows them. Videos are left to TIDAL.

If mpv can't start, TidalEQ tells you and TIDAL keeps playing normally.

## Build

```
pnpm install
pnpm run build
pnpm test
```

`pnpm run watch` serves the build on `http://127.0.0.1:3000` for Luna's dev store.

## License

[AGPL-3.0](LICENSE)
