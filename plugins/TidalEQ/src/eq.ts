/** Equalizer model and its translation into an mpv audio filter chain (FFmpeg lavfi). */

export type BandType = "peaking" | "lowshelf" | "highshelf" | "highpass" | "lowpass";
export type SmartVolume = "off" | "quiet" | "balanced" | "loud";

export type Band = { enabled: boolean; type: BandType; freq: number; gain: number; q: number };

export type EqSettings = {
	enabled: boolean;
	preamp: number; // dB, applied before the bands so boosts have headroom
	bands: Band[];
	smartVolume: SmartVolume;
	limiter: boolean;
};

export const BAND_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const flatBands = (): Band[] => BAND_FREQS.map((freq) => ({ enabled: true, type: "peaking", freq, gain: 0, q: 1 }));

export const defaultSettings = (): EqSettings => ({ enabled: true, preamp: 0, bands: flatBands(), smartVolume: "off", limiter: true });

const withGains = (gains: number[]): Band[] => flatBands().map((b, i) => ({ ...b, gain: gains[i] ?? 0 }));

export const PRESETS: Record<string, { label: string; bands: () => Band[]; preamp: number }> = {
	flat: { label: "Flat", bands: flatBands, preamp: 0 },
	bass: { label: "Bass Boost", bands: () => withGains([6, 5, 3.5, 1.5, 0, 0, 0, 0, 0, 0]), preamp: -6 },
	vshape: { label: "V-Shape", bands: () => withGains([4, 3, 1.5, 0, -1.5, -1.5, 0, 2, 3.5, 4]), preamp: -4 },
	vocal: { label: "Vocal", bands: () => withGains([-2, -1.5, -1, 0.5, 2, 3, 2.5, 1, 0, -1]), preamp: -3 },
	treble: { label: "Treble Boost", bands: () => withGains([0, 0, 0, 0, 0, 0.5, 1.5, 3, 4.5, 5]), preamp: -5 },
	warm: { label: "Warm", bands: () => withGains([2, 2.5, 2, 1, 0, -0.5, -1, -1.5, -2, -2.5]), preamp: -3 },
};

const clamp = (v: number, lo: number, hi: number, fallback: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
// Rounded fixed-point numbers only, so a setting can never inject text into the filter string
const num = (v: number, digits = 2) => String(Number(v.toFixed(digits)));

const LAVFI_NAME: Record<BandType, string> = {
	peaking: "equalizer",
	lowshelf: "lowshelf",
	highshelf: "highshelf",
	highpass: "highpass",
	lowpass: "lowpass",
};

const SMART_VOLUME: Record<Exclude<SmartVolume, "off">, string> = {
	// dynaudnorm: f = frame ms, g = smoothing window, m = max gain; larger m lifts quiet passages more
	quiet: "dynaudnorm=f=500:g=31:m=4",
	balanced: "dynaudnorm=f=250:g=15:m=8",
	loud: "dynaudnorm=f=150:g=9:m=16",
};

export const bandFilter = (band: Band): string | undefined => {
	if (!band.enabled) return;
	const type = LAVFI_NAME[band.type] ? band.type : "peaking";
	const freq = clamp(band.freq, 20, 20000, 1000);
	const q = clamp(band.q, 0.1, 10, 1);
	if (type === "highpass" || type === "lowpass") return `${LAVFI_NAME[type]}=f=${num(freq, 0)}:t=q:w=${num(q)}`;
	const gain = clamp(band.gain, -24, 24, 0);
	if (gain === 0) return; // a 0 dB band changes nothing
	return `${LAVFI_NAME[type]}=f=${num(freq, 0)}:t=q:w=${num(q)}:g=${num(gain, 1)}`;
};

/** The value for mpv's `af` property, or "" for no processing at all. */
export const buildChain = (s: EqSettings): string => {
	if (!s.enabled) return "";
	const filters: string[] = [];
	const preamp = clamp(s.preamp, -24, 24, 0);
	if (preamp !== 0) filters.push(`volume=${num(preamp, 1)}dB`);
	for (const band of s.bands) {
		const f = bandFilter(band);
		if (f) filters.push(f);
	}
	if (s.smartVolume !== "off" && SMART_VOLUME[s.smartVolume]) filters.push(SMART_VOLUME[s.smartVolume]);
	if (s.limiter) filters.push("alimiter=limit=0.97:level=0");
	return filters.length ? `lavfi=[${filters.join(",")}]` : "";
};
