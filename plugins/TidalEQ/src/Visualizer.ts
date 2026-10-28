import type { LunaUnload } from "@luna/core";
import { MediaItem, PlayState } from "@luna/lib";

import { responseDb } from "./eq";
import { getTime, readPcm } from "./player.native";
import { settings, vizSettings } from "./Settings";
import { analyze, autoPoints, bandEdges, bandLevels, coverPixels, PCM_RATE, sampleColors, smoothBars, type VizSettings } from "./viz";

// Draws the spectrum around TIDAL's now-playing cover on one canvas, in its own animation loop (never through React).
// Samples come from the silent decoder mpv (readPcm); the position from the playing mpv, extrapolated between polls.

const VIEW = "[data-test=new-now-playing]";
// The cover is an <img>, or a <video> for albums with an animated cover
export const COVER = `${VIEW} [class*=_artworkWrapper_] :is(img, video)`;
/** The cover's still image: an animated cover's poster frame is the same artwork. */
export const coverImageSrc = (el: Element | null) => (el instanceof HTMLVideoElement ? el.poster : el instanceof HTMLImageElement ? el.src : "");

// Decoded samples of the current track
let pcm = new Float32Array(PCM_RATE * 60 * 5);
let pcmLength = 0;
let pcmBytes = 0;
let pcmDone = true;
let pcmLeftover = new Uint8Array(0);

/** Called on every track load: forget the old samples and read the new ones as they're decoded. */
// While the Visualizer tab is open and the music is paused, animate a made-up spectrum so changes can still be seen
let preview = false;
export const setPreview = (on: boolean) => (preview = on);

export const resetPcm = (decoding: boolean) => {
	pcmLength = 0;
	pcmBytes = 0;
	pcmLeftover = new Uint8Array(0);
	pcmDone = !decoding;
};

const pullPcm = async () => {
	if (pcmDone) return;
	const { data, done } = await readPcm(pcmBytes);
	if (data?.length) {
		pcmBytes += data.length;
		// Samples are 4 bytes; a read can end mid-sample, so carry the remainder to the next read
		const bytes = new Uint8Array(pcmLeftover.length + data.length);
		bytes.set(pcmLeftover);
		bytes.set(data, pcmLeftover.length);
		const whole = bytes.length - (bytes.length % 4);
		pcmLeftover = bytes.slice(whole);
		const samples = new Float32Array(bytes.buffer, 0, whole / 4);
		if (pcmLength + samples.length > pcm.length) {
			const bigger = new Float32Array(Math.max(pcm.length * 2, pcmLength + samples.length));
			bigger.set(pcm.subarray(0, pcmLength));
			pcm = bigger;
		}
		pcm.set(samples, pcmLength);
		pcmLength += samples.length;
	}
	if (done && !data?.length) pcmDone = true;
};

// Playing position: polled from mpv a few times a second, extrapolated in between
let polled = { time: 0, at: 0 };
const pollTime = async () => {
	const time = await getTime();
	if (time !== null) polled = { time, at: performance.now() };
};
const position = (offsetMs: number) => {
	const t = PlayState.playing ? polled.time + (performance.now() - polled.at) / 1000 : polled.time;
	return t - offsetMs / 1000;
};

/**
 * TIDAL's own accent colour for the album, lightened: TIDAL tints the now-playing background with the same colour,
 * so the raw one would vanish into it.
 */
const albumColor = async (): Promise<string | null> => {
	const album = await (await MediaItem.fromPlaybackContext())?.album();
	const hex = album?.tidalAlbum?.vibrantColor;
	if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
	const mix = (i: number) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.55 + 255 * 0.45);
	return `rgb(${mix(1)},${mix(3)},${mix(5)})`;
};

/** Rough brightness of an rgb()/#hex colour, 0..255. */
const lum = (c: string) => {
	const n = c.startsWith("#") ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : (c.match(/\d+/g) ?? []).map(Number);
	return (n[0] ?? 0) * 0.3 + (n[1] ?? 0) * 0.59 + (n[2] ?? 0) * 0.11;
};

/**
 * The 3D transforms between the cover and its wrapper (e.g. a tilt-on-hover plugin), as one CSS transform,
 * so the visualizer tilts with the cover instead of staying flat behind it.
 */
const tiltOf = (img: HTMLElement, wrapper: HTMLElement) => {
	const parts: string[] = [];
	for (let el = img.parentElement; el && el !== wrapper; el = el.parentElement) {
		const t = getComputedStyle(el).transform;
		if (!t || t === "none") continue;
		// Keep only rotation/tilt: any shift is already in the cover's on-screen position
		const m = new DOMMatrix(t);
		m.m41 = m.m42 = m.m43 = 0;
		if (!m.isIdentity) parts.unshift(m.toString());
		const p = el.parentElement && getComputedStyle(el.parentElement).perspective;
		if (p && p !== "none") parts.unshift(`perspective(${p})`);
	}
	return parts.join(" ");
};

export const startVisualizer = (unloads: Set<LunaUnload>) => {
	const canvas = document.createElement("canvas");
	// Sits right after the cover inside the now-playing view, stacked above it so "Inside" bars show over the cover
	// (a body-level canvas ends up behind TIDAL's layers). It never covers the side panel: drawing is clipped at its edge.
	canvas.style.cssText = "position:absolute;pointer-events:none;left:0;top:0;z-index:1;";
	const ctx = canvas.getContext("2d")!;
	unloads.add(() => canvas.remove());

	// What beats with the bass: the cover's own box (image, TIDAL's 1px border and glare together), not just the image
	let cover: HTMLElement | null = null;
	let coverSrc = "";
	let artColor: string | null = null;
	let pixels: Uint8ClampedArray | null = null; // the current cover, for the colour points
	let pointColors: string[] = [];
	let pointsKey = "";
	const restoreCover = () => {
		if (cover) cover.style.scale = "";
		canvas.style.scale = "";
	};
	unloads.add(restoreCover);

	// Per-bar buffers, rebuilt when the bar count or frequency range changes
	let key = "";
	let edges = new Float32Array(0);
	let eqDb = new Float32Array(0);
	let levels = new Float32Array(0);
	let target = new Float32Array(0);
	let state = new Float32Array(0);
	let shown = new Float32Array(0);
	let peaks = new Float32Array(0);
	let eqKey = "";

	const rebuild = (v: VizSettings, bands: number) => {
		const k = `${bands}|${v.minFreq}|${v.maxFreq}`;
		if (k === key) return;
		key = k;
		edges = bandEdges(bands, v.minFreq, v.maxFreq);
		[eqDb, levels, target, state, shown, peaks] = [0, 0, 0, 0, 0, 0].map(() => new Float32Array(bands));
		eqKey = "";
	};

	// What the equalizer adds at each band's centre, so the bars show what you hear (recomputed only when it changes)
	const refreshEq = () => {
		const k = settings.enabled ? JSON.stringify([settings.bands, settings.macros, settings.preamp, key]) : key;
		if (k === eqKey) return;
		eqKey = k;
		for (let b = 0; b < eqDb.length; b++) {
			const fc = Math.sqrt(edges[b] * edges[b + 1]);
			eqDb[b] = settings.enabled ? responseDb(settings, fc) + settings.preamp : 0;
		}
	};

	let last = performance.now();
	let lastPoll = 0;
	let lastPull = 0;
	let frame = 0;
	let running = true;
	unloads.add(() => (running = false));

	const loop = (now: number) => {
		if (!running) return;
		frame = requestAnimationFrame(loop);
		const v = vizSettings();
		if (v.fps > 0 && now - last < 1000 / v.fps - 2) return;
		const dt = Math.min(100, now - last);
		last = now;

		const img = document.querySelector<HTMLElement>(COVER);
		// The cover's flat box: layout size around its on-screen centre, so a 3D tilt or our beat scale doesn't inflate it
		const box = img?.getBoundingClientRect();
		const rect = box && new DOMRect(box.left + box.width / 2 - img!.offsetWidth / 2, box.top + box.height / 2 - img!.offsetHeight / 2, img!.offsetWidth, img!.offsetHeight);
		const visible = !!rect && rect.width > 40 && img!.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) !== false;
		if (!v.enabled || !settings.enabled || !visible) {
			if (canvas.width) canvas.width = 0;
			restoreCover();
			return;
		}
		const beatTarget = img!.parentElement !== null && img!.parentElement.closest("[class*=_artworkWrapper_]") ? img!.parentElement : img!;
		if (beatTarget !== cover) restoreCover(), (cover = beatTarget);
		const wrapper = img!.closest<HTMLElement>("[class*=_artworkWrapper_]")!;
		const view = wrapper.parentElement!;
		if (canvas.previousElementSibling !== wrapper) {
			if (getComputedStyle(view).position === "static") view.style.position = "relative";
			wrapper.after(canvas);
		}
		if (coverImageSrc(img) !== coverSrc) {
			coverSrc = coverImageSrc(img);
			albumColor().then((c) => (artColor = c)).catch(() => (artColor = null));
			pixels = null;
			pointsKey = "";
			const src = coverSrc;
			coverPixels(src).then((p) => src === coverSrc && (pixels = p));
		}

		if (now - lastPoll > 100) (lastPoll = now), void pollTime();
		if (now - lastPull > 200) (lastPull = now), void pullPcm();

		const bands = Math.max(4, Math.round(v.mirror ? v.bars / 2 : v.bars));
		rebuild(v, bands);
		refreshEq();

		// Spectrum at the playing position → 0..1 per band
		const spec = analyze(pcm, pcmLength, position(v.syncOffset) * PCM_RATE);
		bandLevels(spec, edges, levels);
		for (let b = 0; b < bands; b++) {
			const fc = Math.sqrt(edges[b] * edges[b + 1]);
			const db = levels[b] + eqDb[b] + v.tilt * Math.log2(fc / 1000);
			target[b] = PlayState.playing
				? Math.min(1, Math.max(0, (db + v.sensitivity + v.range) / v.range))
				: preview
					? 0.25 + 0.35 * (1 - b / bands) * (0.6 + 0.4 * Math.sin(now / 180)) + 0.2 * Math.max(0, Math.sin(now / 260 + b * 0.55))
					: 0;
		}
		smoothBars(state, target, shown, dt, v);
		for (let b = 0; b < bands; b++) peaks[b] = Math.max(shown[b], peaks[b] - dt / 1500);

		draw(v, rect!, view.getBoundingClientRect(), bands, now, tiltOf(img!, wrapper));

		// The cover beats with the bass (first ~15% of the bands)
		if (v.pulse > 0) {
			let bass = 0;
			const n = Math.max(1, Math.round(bands * 0.15));
			for (let b = 0; b < n; b++) bass += shown[b];
			// The bars grow with it so the cover never covers them
			cover!.style.scale = canvas.style.scale = String(1 + (bass / n) * v.pulse * 0.06);
		} else restoreCover();
	};

	const draw = (v: VizSettings, rect: DOMRect, origin: DOMRect, bands: number, now: number, tilt: string) => {
		// Room around the cover for the longest bar and its glow; a circle also reaches past the cover's corners
		const corner = v.shape === "circle" ? (Math.hypot(rect.width, rect.height) - Math.max(rect.width, rect.height)) / 2 : 0;
		const margin = Math.max(0, v.gap) + v.length + v.glow * 2 + 8 + corner;
		const dpr = window.devicePixelRatio || 1;
		const W = Math.ceil(rect.width + margin * 2);
		const H = Math.ceil(rect.height + margin * 2);
		if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
			canvas.width = Math.round(W * dpr);
			canvas.height = Math.round(H * dpr);
			canvas.style.width = `${W}px`;
			canvas.style.height = `${H}px`;
		} else ctx.clearRect(0, 0, canvas.width, canvas.height);
		canvas.style.transform = `translate(${Math.round(rect.left - origin.left - margin)}px,${Math.round(rect.top - origin.top - margin)}px) ${tilt}`;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		// Stay clear of TIDAL's own UI: an open side panel (Lyrics, Credits, our tabs), the tab bar above and the player below
		const left = rect.left - margin;
		const top = rect.top - margin;
		const panel = document.querySelector("[class*=_panelWrapperActive_]")?.getBoundingClientRect();
		const tabs = document.querySelector("[data-test=new-now-playing] [class*=_contentButtons_]")?.getBoundingClientRect();
		const player = document.querySelector("[data-test=footer-player]")?.getBoundingClientRect();
		const x1 = panel && panel.left > rect.right - 1 ? panel.left - 12 - left : W;
		const y0 = tabs?.height ? tabs.bottom + 4 - top : 0;
		const y1 = player?.height ? player.top - 4 - top : H;
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, y0, x1, y1 - y0);
		ctx.clip();

		// The cover in canvas coordinates, grown by the gap
		const cx = W / 2;
		const cy = H / 2;
		const hw = rect.width / 2 + v.gap;
		const hh = rect.height / 2 + v.gap;
		const radius = Math.hypot(rect.width, rect.height) / 2 + v.gap;
		const n = v.mirror ? bands * 2 : bands;
		const perimeter = v.shape === "circle" ? 2 * Math.PI * radius : 4 * (hw + hh);
		const slot = perimeter / n;
		// Bar thickness follows the slot, capped so a low bar count doesn't turn into blobs
		const thick = Math.min(40, Math.max(1, slot * v.width));
		const turn = v.rotation / 360 + (v.spin * now) / 60000;

		// Point on the outline and its outward direction, for a fraction 0..1 starting at the bottom centre, clockwise on screen
		const at = (f: number): [number, number, number, number] => {
			f = ((f % 1) + 1) % 1;
			if (v.shape === "circle") {
				const a = Math.PI / 2 + f * 2 * Math.PI;
				return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, Math.cos(a), Math.sin(a)];
			}
			let s = f * perimeter;
			const legs: [number, number, number, number, number, number, number][] = [
				// length, start x, start y, step x, step y, normal x, normal y
				[hw, cx, cy + hh, -1, 0, 0, 1],
				[2 * hh, cx - hw, cy + hh, 0, -1, -1, 0],
				[2 * hw, cx - hw, cy - hh, 1, 0, 0, -1],
				[2 * hh, cx + hw, cy - hh, 0, 1, 1, 0],
				[hw, cx + hw, cy + hh, -1, 0, 0, 1],
			];
			for (const [len, x, y, dx, dy, nx, ny] of legs) {
				if (s <= len) return [x + dx * s, y + dy * s, nx, ny];
				s -= len;
			}
			return [cx, cy + hh, 0, 1];
		};
		const valueAt = (i: number) => {
			const b = v.mirror ? (i < bands ? i : n - 1 - i) : i;
			return [shown[b], peaks[b]];
		};
		// Where a bar of `len` px starts and ends, depending on placement
		const span = (len: number): [number, number] =>
			v.placement === "outside" ? [0, len] : v.placement === "inside" ? [0, -len] : [-len / 2, len / 2];

		// Colours: one paint for the whole frame keeps it to a single draw call
		const art = artColor ?? v.color1;
		// Colours from points on the cover: picked automatically from each new cover, or the user's own points.
		// Worked out only when the cover, the mode or the points change, not every frame.
		const key = pixels ? `${coverSrc}|${v.autoColors ? `auto${v.colorCount}` : JSON.stringify(v.colorPoints)}` : "";
		if (key !== pointsKey) {
			pointsKey = key;
			const points = !pixels ? [] : v.autoColors ? autoPoints(pixels, v.colorCount) : v.colorPoints ?? [];
			pointColors = pixels && points.length ? sampleColors(pixels, points) : [];
		}
		let paint: string | CanvasGradient = v.colorMode === "artwork" ? art : v.color1;
		if (v.colorMode === "gradient" || v.colorMode === "spectrum" || v.colorMode === "artwork") {
			const g = ctx.createConicGradient(Math.PI / 2 + turn * 2 * Math.PI, cx, cy);
			const stops =
				v.colorMode === "spectrum"
					? [0, 60, 120, 180, 240, 300, 360].map((h) => `hsl(${h},90%,60%)`)
					: v.colorMode === "artwork"
						? pointColors.length
							? // around the ring and back to the first; mirrored so both sides match
								v.mirror ? [...pointColors, ...pointColors.slice(0, -1).reverse()] : [...pointColors, pointColors[0]]
							: [art, v.color1, art]
						: [v.color1, v.color2, v.color1];
			if (stops.length < 2) stops.push(stops[0]); // a single colour point
			stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
			paint = g;
		}
		ctx.globalAlpha = v.opacity;
		ctx.shadowBlur = v.glow;
		// Glow in the lightest colour in use: a dark glow just looks like a smudge
		const lightest = (cs: string[]) => cs.reduce((a, c) => (lum(c) > lum(a) ? c : a), cs[0]);
		ctx.shadowColor =
			v.colorMode === "solid" ? v.color1
			: v.colorMode === "gradient" ? lightest([v.color1, v.color2])
			: v.colorMode === "artwork" && pointColors.length ? lightest(pointColors)
			: v.colorMode === "spectrum" ? "rgba(255,255,255,0.6)"
			: art;
		ctx.strokeStyle = ctx.fillStyle = paint;
		ctx.lineCap = v.roundCaps ? "round" : "butt";
		ctx.lineJoin = "round";

		ctx.beginPath();
		if (v.style === "wave") {
			const pts: [number, number][] = [];
			for (let i = 0; i < n; i++) {
				const [x, y, nx, ny] = at(i / n + turn);
				const [, end] = span(2 + valueAt(i)[0] * v.length);
				pts.push([x + nx * end, y + ny * end]);
			}
			// Smooth closed curve through the tips, via midpoints
			const mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
			const start = mid(pts[n - 1], pts[0]);
			const wave = new Path2D();
			wave.moveTo(start[0], start[1]);
			for (let i = 0; i < n; i++) {
				const m = mid(pts[i], pts[(i + 1) % n]);
				wave.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]);
			}
			wave.closePath();
			// Fill only the band between the outline and the wave, never over the cover itself
			const band = new Path2D(wave);
			if (v.shape === "circle") band.moveTo(cx + radius, cy), band.arc(cx, cy, radius, 0, 2 * Math.PI);
			else band.rect(cx - hw, cy - hh, hw * 2, hh * 2);
			ctx.lineWidth = Math.max(1, thick * 0.5);
			ctx.globalAlpha = v.opacity * 0.35;
			ctx.fill(band, "evenodd");
			ctx.globalAlpha = v.opacity;
			ctx.stroke(wave);
		} else if (v.style === "dots") {
			for (let i = 0; i < n; i++) {
				const [x, y, nx, ny] = at((i + 0.5) / n + turn);
				const [, end] = span(2 + valueAt(i)[0] * v.length);
				const r = thick / 2;
				ctx.moveTo(x + nx * end + r, y + ny * end);
				ctx.arc(x + nx * end, y + ny * end, r, 0, 2 * Math.PI);
			}
			ctx.fill();
		} else {
			for (let i = 0; i < n; i++) {
				const [x, y, nx, ny] = at((i + 0.5) / n + turn);
				if (valueAt(i)[0] < 0.02) continue; // silent bars would only draw a dotted outline
				const [a, b] = span(1 + valueAt(i)[0] * v.length);
				ctx.moveTo(x + nx * a, y + ny * a);
				ctx.lineTo(x + nx * b, y + ny * b);
			}
			ctx.lineWidth = thick;
			ctx.stroke();
		}

		if (v.peaks && v.style !== "wave") {
			ctx.beginPath();
			ctx.shadowBlur = 0;
			for (let i = 0; i < n; i++) {
				const [x, y, nx, ny] = at((i + 0.5) / n + turn);
				const [, end] = span(3 + valueAt(i)[1] * v.length);
				ctx.moveTo(x + nx * end, y + ny * end);
				ctx.lineTo(x + nx * (end + 2 * Math.sign(end || 1)), y + ny * (end + 2 * Math.sign(end || 1)));
			}
			ctx.lineWidth = thick;
			ctx.stroke();
		}
		ctx.restore();
	};

	frame = requestAnimationFrame(loop);
	unloads.add(() => cancelAnimationFrame(frame));
};
