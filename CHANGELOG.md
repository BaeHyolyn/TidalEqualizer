# Changelog

## Unreleased

### Fixed
- Visualizer not showing on albums with an animated cover, which TIDAL plays as a video (#11).

## 1.2.0

### Visualizer
- **Colours from the cover:** up to 24 colour points, picked automatically from every new cover (the most vivid and different colours, blended around the ring in hue order). Switch to **Manual** to place your own: drag, click to add, double-click to remove.
- Dark cover colours are brightened so they show on TIDAL's tinted background; the glow uses the lightest colour in use.
- **Resets:** ↺ next to any changed setting, double-click a slider, a reset per section, and **Reset all** with a confirmation.
- Click a value to type it exactly (out-of-range values are clamped).
- **Presets:** Default, Minimal, Neon ring, Aura, Club, Pearls, Inner glow; save your own looks and delete them.
- **Copy / Paste settings** to share a look. Pasted settings are checked: unknown keys dropped, values clamped.
- Animated preview while the music is paused and the Visualizer tab is open.
- Options that don't apply to the chosen style are hidden, and size labels follow the style.
- The ring follows TIDAL's 3D tilt of the cover, and the cover beat scales the whole cover with the bars.
- Stays clear of TIDAL's tab bar, player bar and side panel; bar thickness is capped.

### Fixed
- Visualizer shifted off the cover when TIDAL moves the artwork (#2).
- White square around the cover when hovering it (#3).
- **Inside** placement hidden under the cover; wave fill tinting the cover (#4).
- Bars running over TIDAL's tabs and player bar; few bars turning into blobs (#5).
- Equalizer curve cut off at 1 kHz (#6).
- Cover beat leaving TIDAL's border inside the cover (#7).
- Equalizer and Visualizer tabs missing on tracks without lyrics (#8).
- Presets losing colour points, Auto picking one colour, Copy/Paste blocked (#9).
- Temp files named "undefined" (#10).

## 1.1.0

- **Visualizer** tab: the real spectrum of what you hear (after the equalizer) around the now-playing cover. Bars, wave or dots; following the cover or in a circle; outside, inside or both ways; colours, glow, motion, response and frame rate are all adjustable.
- Fixed: the start of a song repeating briefly on a track change (#1).

## 1.0.0

- First release in its own repository.
- **Equalizer** tab in TIDAL's now-playing view, in TIDAL's own style, centred on the cover and usable at every window size.
- 10 parametric bands on a draggable frequency response graph, Bass/Voice/Treble controls and 19 presets.
- Preamp, smart volume and limiter. Plays through mpv; TIDAL's own player stays in sync, muted.
