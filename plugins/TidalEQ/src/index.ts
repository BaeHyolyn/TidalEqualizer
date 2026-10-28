import { Tracer, type LunaUnload } from "@luna/core";
import { ipcRenderer, MediaItem, PlayState, redux, safeInterval } from "@luna/lib";

import { buildChain } from "./eq";
import { addPanelTab, EqPanel } from "./NowPlayingTab";
import { getTime, loadTrack, seek, setChain, setPaused, setVolume, startAnalysis, startPlayer, stopAnalysis, stopPlayer, stopTrack } from "./player.native";
import { setEqChangeHandler, settings, vizSettings } from "./Settings";
import { resetPcm, startVisualizer } from "./Visualizer";
import { VizPanel } from "./VizPanel";
import { PCM_RATE } from "./viz";

export const unloads = new Set<LunaUnload>();
export const { trace } = Tracer("[TidalEQ]");
export { Settings } from "./Settings";

const SYNC_MS = 250;
const MAX_DRIFT_S = 0.3; // resync mpv to TIDAL beyond this
const BACK_CONFIRM_MS = 700; // on a track change TIDAL drops to 0 ~300 ms before switching tracks; don't replay the old one
const MAX_HOLD_S = 2; // mpv ahead by less than this: wait for TIDAL instead of seeking back (which replays audio)
const SETTLE_S = 1.5; // after loading a track, give mpv time to buffer before judging drift

let running = false;
let loadedId: MediaItem["id"] | null = null;
let loadedAt = 0;
let lastPaused: boolean | null = null;
let lastVolume = -1;
let busy = false;
let holdUntil = 0;
let backSeekSince = 0;
let analyzedId: MediaItem["id"] | null = null; // track the visualizer has samples for

const tidalVolume = () => redux.store.getState().playbackControls.volume ?? 100;
// TIDAL reports its position only every ~300 ms; fill the gaps with elapsed time so mpv isn't judged against a stale value
let lastReported = { value: -1, at: 0 };
const tidalPosition = () => {
	// Live player position; playTime only updates on play/pause/seek
	const reported = PlayState.currentTime || PlayState.playTime;
	const now = performance.now();
	if (reported !== lastReported.value) lastReported = { value: reported, at: now };
	if (!PlayState.playing) return reported;
	return reported + Math.min(0.5, (now - lastReported.at) / 1000);
};

// TIDAL's own player keeps playing (so progress, queue and next track work as always), just silent
const setOriginalVolume = (volume: number) =>
	ipcRenderer.send("player.message", JSON.stringify({ command: "media.volume", volume }));

const sync = async () => {
	if (!running || busy || performance.now() < holdUntil) return;
	busy = true;
	try {
		const media = await MediaItem.fromPlaybackContext();
		if (!media || media.contentType !== "track") {
			// mpv only does audio: let TIDAL play videos itself
			if (loadedId !== null) await stopTrack();
			loadedId = analyzedId = null;
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
			backSeekSince = 0;
			lastPaused = !PlayState.playing;
			return;
		}

		// The visualizer decodes the track separately; (re)start it when turned on or after a track change
		const wantAnalysis = vizSettings().enabled;
		if (wantAnalysis && analyzedId !== loadedId) {
			await startAnalysis(PCM_RATE);
			resetPcm(true);
			analyzedId = loadedId;
		} else if (!wantAnalysis && analyzedId !== null) {
			await stopAnalysis();
			resetPcm(false);
			analyzedId = null;
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
			const ahead = mpvTime === null ? 0 : mpvTime - tidalTime;
			if (ahead > MAX_DRIFT_S && ahead < MAX_HOLD_S) {
				// Pause mpv for exactly the gap; the sync after the hold resumes it (lastPaused is reset)
				await setPaused(true);
				lastPaused = null;
				holdUntil = performance.now() + ahead * 1000;
			} else if (ahead >= MAX_HOLD_S) {
				// Big jump back: only once it has lasted, so a track change in progress doesn't restart the old track
				if (!backSeekSince) backSeekSince = performance.now();
				else if (performance.now() - backSeekSince > BACK_CONFIRM_MS) {
					backSeekSince = 0;
					await seek(tidalTime);
				}
				return;
			} else if (ahead < -MAX_DRIFT_S) await seek(tidalTime);
			backSeekSince = 0;
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
	loadedId = analyzedId = null;
	lastPaused = null;
	lastVolume = -1;
	await sync();
};

const stop = async () => {
	running = false;
	loadedId = analyzedId = null;
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
addPanelTab(unloads, "tidaleq", "Equalizer", EqPanel);
addPanelTab(unloads, "tidaleq-visualizer", "Visualizer", VizPanel);
startVisualizer(unloads);
start();
