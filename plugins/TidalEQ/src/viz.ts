/** Visualizer settings and the audio analysis behind it: FFT, log-spaced bands and bar smoothing. No DOM here. */

export const PCM_RATE = 22050; // decoded mono rate: covers up to ~11 kHz, plenty for a visualizer
export const FFT_SIZE = 2048; // ~93 ms window at 22050 Hz

export type VizShape = "square" | "circle";
export type VizStyle = "bars" | "wave" | "dots";
export type VizPlacement = "outside" | "inside" | "both";
export type VizColorMode = "artwork" | "solid" | "gradient" | "spectrum";

export type VizSettings = {
	enabled: boolean;
	style: VizStyle;
	shape: VizShape;
	placement: VizPlacement;
	mirror: boolean; // low frequencies meet at the bottom, symmetric left/right
	bars: number;
	gap: number; // px between the cover and the bars
	length: number; // px, longest bar
	width: number; // 0..1 of each bar's slot
	roundCaps: boolean;
	rotation: number; // degrees
	spin: number; // turns per minute
	colorMode: VizColorMode;
	color1: string;
	color2: string;
	opacity: number; // 0..1
	glow: number; // px
	sensitivity: number; // dB of headroom: lower = taller bars
	range: number; // dB shown from the floor to the top
	tilt: number; // dB per octave added above 1 kHz (removed below) so the highs aren't always tiny
	attack: number; // ms to rise
	decay: number; // ms to fall
	smoothing: number; // 0..1 neighbour smoothing (Monstercat style)
	peaks: boolean;
	pulse: number; // 0..1 how much the cover beats with the bass
	minFreq: number;
	maxFreq: number;
	fps: number; // 0 = monitor refresh rate
	syncOffset: number; // ms, positive shows the music later
};

export const defaultViz = (): VizSettings => ({
	enabled: true,
	style: "bars",
	shape: "square",
	placement: "outside",
	mirror: true,
	bars: 96,
	gap: 10,
	length: 48,
	width: 0.6,
	roundCaps: true,
	rotation: 0,
	spin: 0,
	colorMode: "artwork",
	color1: "#ffffff",
	color2: "#33ffee",
	opacity: 0.85,
	glow: 8,
	sensitivity: 12,
	range: 50,
	tilt: 3,
	attack: 40,
	decay: 220,
	smoothing: 0.35,
	peaks: false,
	pulse: 0.3,
	minFreq: 40,
	maxFreq: 10000,
	fps: 60,
	syncOffset: 0,
});

/** In-place radix-2 FFT. `re`/`im` length must be a power of two. */
export const fft = (re: Float32Array, im: Float32Array) => {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = (-2 * Math.PI) / len;
		const wr = Math.cos(ang);
		const wi = Math.sin(ang);
		for (let i = 0; i < n; i += len) {
			let cr = 1;
			let ci = 0;
			for (let k = 0; k < len / 2; k++) {
				const a = i + k;
				const b = a + len / 2;
				const xr = re[b] * cr - im[b] * ci;
				const xi = re[b] * ci + im[b] * cr;
				re[b] = re[a] - xr;
				im[b] = im[a] - xi;
				re[a] += xr;
				im[a] += xi;
				[cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
			}
		}
	}
};

const HANN = Float32Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
const re = new Float32Array(FFT_SIZE);
const im = new Float32Array(FFT_SIZE);
export const spectrum = new Float32Array(FFT_SIZE / 2); // dBFS per bin, refreshed by analyze()

/** Spectrum (dBFS per bin) of the window of `pcm` centred on sample `at`; silence outside the decoded range. */
export const analyze = (pcm: Float32Array, length: number, at: number) => {
	const start = Math.round(at) - FFT_SIZE / 2;
	for (let i = 0; i < FFT_SIZE; i++) {
		const k = start + i;
		re[i] = k >= 0 && k < length ? pcm[k] * HANN[i] : 0;
		im[i] = 0;
	}
	fft(re, im);
	// Hann window sums to N/2; a full-scale sine then reads ~0 dB
	const norm = 4 / FFT_SIZE;
	for (let i = 0; i < FFT_SIZE / 2; i++) spectrum[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) * norm + 1e-9);
	return spectrum;
};

/** Log-spaced band edges (Hz) for `count` bands between min and max. */
export const bandEdges = (count: number, minFreq: number, maxFreq: number) => {
	const lo = Math.max(10, Math.min(minFreq, maxFreq - 10));
	const hi = Math.min(PCM_RATE / 2, Math.max(maxFreq, lo + 10));
	return Float32Array.from({ length: count + 1 }, (_, i) => lo * (hi / lo) ** (i / count));
};

/** Loudest bin in each band, in dB. Bands narrower than one bin read the bin they fall in. */
export const bandLevels = (spec: Float32Array, edges: Float32Array, out: Float32Array) => {
	const hz = PCM_RATE / FFT_SIZE;
	for (let b = 0; b < out.length; b++) {
		const from = Math.min(spec.length - 1, Math.floor(edges[b] / hz));
		const to = Math.min(spec.length - 1, Math.max(from, Math.floor(edges[b + 1] / hz)));
		let max = -Infinity;
		for (let i = from; i <= to; i++) if (spec[i] > max) max = spec[i];
		out[b] = max;
	}
	return out;
};

/**
 * Moves `state` toward `target` (both 0..1): fast rise, slow fall, frame-rate independent.
 * `out` gets the drawn values: each bar lifted toward its neighbours so peaks spread into smooth hills
 * (kept out of `state` so the spread doesn't build up frame after frame).
 */
export const smoothBars = (
	state: Float32Array,
	target: Float32Array,
	out: Float32Array,
	dtMs: number,
	s: Pick<VizSettings, "attack" | "decay" | "smoothing">,
) => {
	const up = 1 - Math.exp(-dtMs / Math.max(1, s.attack));
	const down = 1 - Math.exp(-dtMs / Math.max(1, s.decay));
	for (let i = 0; i < state.length; i++) state[i] += (target[i] - state[i]) * (target[i] > state[i] ? up : down);
	if (s.smoothing <= 0) return out.set(state), out;
	const falloff = 1 + (1 - s.smoothing) * 2; // 1 = flat hills, 3 = barely any spread
	for (let i = 0; i < state.length; i++) {
		let v = state[i];
		for (let d = 1; d < 8; d++) {
			const n = Math.max(i - d >= 0 ? state[i - d] : 0, i + d < state.length ? state[i + d] : 0) / falloff ** d;
			if (n > v) v = n;
		}
		out[i] = v;
	}
	return out;
};
