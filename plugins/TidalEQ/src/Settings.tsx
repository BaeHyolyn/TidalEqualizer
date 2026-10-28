import { ReactiveStore } from "@luna/core";
import { LunaSelectItem, LunaSelectSetting, LunaSettings, LunaSwitchSetting, LunaTextSetting } from "@luna/ui";
import React from "react";

import { defaultSettings, PRESETS, type Band, type BandType, type EqSettings, type SmartVolume } from "./eq";

export const DEFAULT_MPV = "C:\\Program Files\\MPV Player\\mpv.exe";

export const settings = await ReactiveStore.getPluginStorage("TidalEQ", { ...defaultSettings(), mpvPath: DEFAULT_MPV });

// Called by index.ts whenever the equalizer changes, so mpv picks it up immediately
let onEqChange: () => void = () => {};
export const setEqChangeHandler = (fn: () => void) => (onEqChange = fn);

const fmtFreq = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(1)}k` : `${Math.round(f)}`);
const fmtGain = (g: number) => `${g > 0 ? "+" : ""}${g.toFixed(1)}`;

const BAND_TYPES: [BandType, string][] = [
	["peaking", "Peak"],
	["lowshelf", "Low shelf"],
	["highshelf", "High shelf"],
	["highpass", "High-pass"],
	["lowpass", "Low-pass"],
];

const cell: React.CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 0 };
const small: React.CSSProperties = { fontSize: 11, opacity: 0.7, fontVariantNumeric: "tabular-nums" };
const field: React.CSSProperties = {
	width: "100%",
	background: "transparent",
	color: "inherit",
	border: "1px solid rgba(255,255,255,0.2)",
	borderRadius: 4,
	padding: "2px 4px",
	fontSize: 11,
	textAlign: "center",
};

const BandControl = ({ band, advanced, onChange }: { band: Band; advanced: boolean; onChange: (b: Band) => void }) => {
	const noGain = band.type === "highpass" || band.type === "lowpass";
	return (
		<div style={{ ...cell, opacity: band.enabled ? 1 : 0.4 }}>
			<span style={small}>{noGain ? "—" : fmtGain(band.gain)}</span>
			<input
				type="range"
				min={-12}
				max={12}
				step={0.5}
				value={noGain ? 0 : band.gain}
				disabled={noGain || !band.enabled}
				aria-label={`${fmtFreq(band.freq)} Hz`}
				onChange={(e) => onChange({ ...band, gain: +e.target.value })}
				onDoubleClick={() => onChange({ ...band, gain: 0 })}
				style={{ writingMode: "vertical-lr", direction: "rtl", height: 140, width: 24, accentColor: "#3fd0b4" }}
			/>
			<span style={{ ...small, opacity: 1, fontWeight: 600 }}>{fmtFreq(band.freq)}</span>
			{advanced && (
				<>
					<select value={band.type} onChange={(e) => onChange({ ...band, type: e.target.value as BandType })} style={field}>
						{BAND_TYPES.map(([v, label]) => (
							<option key={v} value={v} style={{ color: "black" }}>
								{label}
							</option>
						))}
					</select>
					<input type="number" min={20} max={20000} value={band.freq} title="Hz" style={field}
						onChange={(e) => onChange({ ...band, freq: +e.target.value })} />
					<input type="number" min={0.1} max={10} step={0.1} value={band.q} title="Q" style={field}
						onChange={(e) => onChange({ ...band, q: +e.target.value })} />
					<label style={{ ...small, display: "flex", gap: 3, alignItems: "center" }}>
						<input type="checkbox" checked={band.enabled} onChange={(e) => onChange({ ...band, enabled: e.target.checked })} />
						on
					</label>
				</>
			)}
		</div>
	);
};

export const Settings = () => {
	const [eq, setEq] = React.useState<EqSettings>({
		enabled: settings.enabled,
		preamp: settings.preamp,
		bands: settings.bands.map((b) => ({ ...b })),
		smartVolume: settings.smartVolume,
		limiter: settings.limiter,
	});
	const [mpvPath, setMpvPath] = React.useState(settings.mpvPath);
	const [advanced, setAdvanced] = React.useState(false);

	const update = (next: Partial<EqSettings>) => {
		const merged = { ...eq, ...next };
		setEq(merged);
		Object.assign(settings, merged);
		onEqChange();
	};

	return (
		<LunaSettings>
			<LunaSwitchSetting
				title="Equalizer"
				desc="Plays TIDAL through mpv with your equalizer. Turn off to go back to TIDAL's own player."
				checked={eq.enabled}
				onChange={(_, checked) => update({ enabled: checked })}
			/>
			<LunaSelectSetting
				title="Preset"
				desc="Starting point for the bands below. You can still edit every band after."
				value=""
				displayEmpty
				onChange={(e) => {
					const p = PRESETS[e.target.value as string];
					if (p) update({ bands: p.bands(), preamp: p.preamp });
				}}
			>
				<LunaSelectItem value="" disabled>
					Choose a preset…
				</LunaSelectItem>
				{Object.entries(PRESETS).map(([key, p]) => (
					<LunaSelectItem key={key} value={key}>
						{p.label}
					</LunaSelectItem>
				))}
			</LunaSelectSetting>

			<div style={{ padding: "8px 0" }}>
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
					<span style={{ fontWeight: 600 }}>Bands (dB)</span>
					<span style={{ display: "flex", gap: 12 }}>
						<button type="button" onClick={() => update({ bands: PRESETS.flat.bands() })} style={{ ...field, width: "auto", padding: "4px 10px" }}>
							Reset
						</button>
						<button type="button" onClick={() => setAdvanced(!advanced)} style={{ ...field, width: "auto", padding: "4px 10px" }}>
							{advanced ? "Simple" : "Advanced"}
						</button>
					</span>
				</div>
				<div style={{ display: "grid", gridTemplateColumns: "repeat(10, minmax(0, 1fr))", gap: 6 }}>
					{eq.bands.map((band, i) => (
						<BandControl key={i} band={band} advanced={advanced}
							onChange={(b) => update({ bands: eq.bands.map((x, j) => (j === i ? b : x)) })} />
					))}
				</div>
				<p style={{ ...small, marginTop: 8 }}>Double-click a slider to reset it to 0.</p>
			</div>

			<LunaSelectSetting
				title="Preamp"
				desc="Lowers the level before the bands, so boosts don't clip. Presets set it for you."
				value={String(eq.preamp)}
				onChange={(e) => update({ preamp: +(e.target.value as string) })}
			>
				{[0, -1, -2, -3, -4, -5, -6, -8, -10, -12].map((v) => (
					<LunaSelectItem key={v} value={String(v)}>
						{v} dB
					</LunaSelectItem>
				))}
			</LunaSelectSetting>
			<LunaSelectSetting
				title="Smart volume"
				desc="Evens out loud and quiet parts, like SteelSeries Smart Volume."
				value={eq.smartVolume}
				onChange={(e) => update({ smartVolume: e.target.value as SmartVolume })}
			>
				<LunaSelectItem value="off">Off</LunaSelectItem>
				<LunaSelectItem value="quiet">Quiet</LunaSelectItem>
				<LunaSelectItem value="balanced">Balanced</LunaSelectItem>
				<LunaSelectItem value="loud">Loud</LunaSelectItem>
			</LunaSelectSetting>
			<LunaSwitchSetting
				title="Limiter"
				desc="Stops the output from ever clipping. Keep it on."
				checked={eq.limiter}
				onChange={(_, checked) => update({ limiter: checked })}
			/>
			<LunaTextSetting
				title="mpv path"
				desc="Where mpv.exe is installed. Reload the plugin after changing it."
				value={mpvPath}
				onChange={(e) => setMpvPath((settings.mpvPath = e.target.value))}
			/>
		</LunaSettings>
	);
};
