import { Tracer, type LunaUnload } from "@luna/core";
import { ipcRenderer, MediaItem, PlayState, redux, safeInterval } from "@luna/lib";

import { buildChain } from "./eq";
import { addNowPlayingTab } from "./NowPlayingTab";
import { getTime, loadTrack, seek, setChain, setPaused, setVolume, startPlayer, stopPlayer, stopTrack } from "./player.native";
import { setEqChangeHandler, settings } from "./Settings";

export const unloads = new Set<LunaUnload>();
export const { trace } = Tracer("[TidalEQ]");
export { Settings } from "./Settings";

const SYNC_MS = 250;
const MAX_DRIFT_S = 0.3; // resync mpv to TIDAL beyond this
const SETTLE_S = 1.5; // after loading a track, give mpv time to buffer before judging drift

let running = false;
let loadedId: MediaItem["id"] | null = null;
let loadedAt = 0;
let lastPaused: boolean | null = null;
let lastVolume = -1;
let busy = false;

const tidalVolume = () => redux.store.getState().playbackControls.volume ?? 100;
// Live player position; playTime only updates on play/pause/seek
const tidalPosition = () => PlayState.currentTime || PlayState.playTime;

// TIDAL's own player keeps playing (so progress, queue and next track work as always), just silent
const setOriginalVolume = (volume: number) =>
	ipcRenderer.send("player.message", JSON.stringify({ command: "media.volume", volume }));

const sync = async () => {
	if (!running || busy) return;
	busy = true;
	try {
		const media = await MediaItem.fromPlaybackContext();
		if (!media || media.contentType !== "track") {
			// mpv only does audio: let TIDAL play videos itself
			if (loadedId !== null) await stopTrack();
			loadedId = null;
			setOriginalVolume(tidalVolume());
			return;
		}
		setOriginalVolume(0);

		if (media.id !== loadedId) {
			const quality = PlayState.playbackContext?.actualAudioQuality;
			const info = await media.playbackInfo(quality);
			if (!info) return;
			await loadTrack(info, tidalPosition(), !PlayState.playing);
			loadedId = media.id;
			loadedAt = performance.now();
			lastPaused = !PlayState.playing;
			return;
		}

		const paused = !PlayState.playing;
		if (paused !== lastPaused) {
			await setPaused(paused);
			lastPaused = paused;
		}

		const volume = tidalVolume();
		if (volume !== lastVolume) {
			await setVolume(volume);
			lastVolume = volume;
		}

		if (!paused && performance.now() - loadedAt > SETTLE_S * 1000) {
			const mpvTime = await getTime();
			const tidalTime = tidalPosition();
			if (mpvTime !== null && Math.abs(mpvTime - tidalTime) > MAX_DRIFT_S) await seek(tidalTime);
		}
	} catch (err) {
		trace.warn("sync failed", err);
	} finally {
		busy = false;
	}
};

const start = async () => {
	if (!settings.enabled) return;
	const error = await startPlayer(settings.mpvPath, buildChain(settings), tidalVolume());
	if (error) {
		trace.msg.err(`Could not start mpv, TIDAL keeps playing normally. Check the mpv path in TidalEQ settings. (${error})`);
		return;
	}
	running = true;
	loadedId = null;
	lastPaused = null;
	lastVolume = -1;
	await sync();
};

const stop = async () => {
	running = false;
	loadedId = null;
	await stopPlayer().catch(() => {});
	setOriginalVolume(tidalVolume());
};

// Dragging a band fires many changes per second; mpv rebuilds its filters on each one, so apply the last one only
const APPLY_DELAY_MS = 120;
let applyTimer: ReturnType<typeof setTimeout> | undefined;
setEqChangeHandler(() => {
	if (settings.enabled && !running) return void start();
	if (!settings.enabled && running) return void stop();
	clearTimeout(applyTimer);
	applyTimer = setTimeout(() => {
		if (running) setChain(buildChain(settings)).catch((err) => trace.warn("could not apply equalizer", err));
	}, APPLY_DELAY_MS);
});
unloads.add(() => clearTimeout(applyTimer));

// TIDAL re-sends its volume to its own player when the slider moves; mute it again right away
redux.intercept("playbackControls/SET_VOLUME", unloads, () => {
	if (running) setTimeout(() => setOriginalVolume(0), 50);
});

safeInterval(unloads, sync, SYNC_MS);
unloads.add(stop);
addNowPlayingTab(unloads);
start();
