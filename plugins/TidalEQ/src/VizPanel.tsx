import React from "react";

import { heading, Pill, text, type Looks } from "./NowPlayingTab";
import { settings, vizSettings } from "./Settings";
import { coverPixels, defaultViz, MAX_COLOR_POINTS, sampleColors, type VizSettings } from "./viz";

// Controls for the visualizer. Changes are stored right away and the visualizer reads them on its next frame.

const useViz = () => {
	const [viz, setViz] = React.useState(vizSettings);
	const update = (next: Partial<VizSettings>) => {
		const merged = { ...vizSettings(), ...next }; // from storage, so quick successive changes all stick
		setViz(merged);
		settings.viz = merged;
	};
	return [viz, update] as const;
};

const value: React.CSSProperties = { ...text, fontSize: 12, color: "#fff", width: 64, textAlign: "right", fontVariantNumeric: "tabular-nums" };

const Slider = ({ label, min, max, step = 1, unit = "", v, set }: { label: string; min: number; max: number; step?: number; unit?: string; v: number; set: (v: number) => void }) => (
	<label style={{ display: "flex", alignItems: "center", gap: 12, flex: "1 1 260px", minWidth: 0 }}>
		<span style={{ ...text, color: "#fff", width: 92, flexShrink: 0 }}>{label}</span>
		<input type="range" min={min} max={max} step={step} value={v} onChange={(e) => set(+e.target.value)} style={{ flex: 1, minWidth: 0, accentColor: "#fff" }} />
		<span style={value}>
			{Number.isInteger(step) ? v : v.toFixed(2)}
			{unit}
		</span>
	</label>
);

const Choice = <T extends string | number | boolean>({ looks, label, options, v, set }: { looks: Looks; label: string; options: [T, string][]; v: T; set: (v: T) => void }) => (
	<div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
		<span style={{ ...text, color: "#fff", width: 92 }}>{label}</span>
		<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
			{options.map(([o, name]) => (
				<Pill key={String(o)} looks={looks} pressed={o === v} onClick={() => set(o)}>
					{name}
				</Pill>
			))}
		</div>
	</div>
);

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
	<section style={{ marginTop: 28 }}>
		<h3 style={heading}>{title}</h3>
		<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
	</section>
);
const Row = ({ children }: { children: React.ReactNode }) => <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 24px" }}>{children}</div>;

const coverSrc = () => document.querySelector<HTMLImageElement>("[data-test=new-now-playing] [class*=_artworkWrapper_] img")?.src ?? "";

/** The current cover with draggable dots: each dot is where one colour is taken from. Click adds, double-click removes. */
const ColorPoints = ({ points, set }: { points: [number, number][]; set: (p: [number, number][]) => void }) => {
	const [src, setSrc] = React.useState(coverSrc);
	const [pixels, setPixels] = React.useState<Uint8ClampedArray | null>(null);
	const box = React.useRef<HTMLDivElement>(null);
	const drag = React.useRef<number | null>(null);
	// Follow track changes
	React.useEffect(() => {
		const t = setInterval(() => setSrc(coverSrc()), 1000);
		return () => clearInterval(t);
	}, []);
	React.useEffect(() => {
		let live = true;
		if (src) coverPixels(src).then((p) => live && setPixels(p));
		return () => void (live = false);
	}, [src]);
	const colors = pixels ? sampleColors(pixels, points) : points.map(() => "#fff");

	const at = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
		const r = box.current!.getBoundingClientRect();
		const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
		return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
	};

	return (
		<div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
			<div
				ref={box}
				style={{ position: "relative", width: 180, height: 180, borderRadius: 4, overflow: "hidden", cursor: "crosshair", touchAction: "none", flexShrink: 0, background: "rgba(255,255,255,0.06)" }}
				onPointerMove={(e) => drag.current !== null && set(points.map((p, i) => (i === drag.current ? at(e) : p)))}
				onPointerUp={() => (drag.current = null)}
				onClick={(e) => e.target === e.currentTarget.firstChild && points.length < MAX_COLOR_POINTS && set([...points, at(e)])}
			>
				{src && <img src={src} alt="" draggable={false} style={{ width: "100%", height: "100%", display: "block", userSelect: "none" }} />}
				{points.map(([x, y], i) => (
					<span
						key={i}
						title="Drag to move, double-click to remove"
						onPointerDown={(e) => {
							e.stopPropagation();
							(e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
							drag.current = i;
						}}
						onDoubleClick={(e) => {
							e.stopPropagation();
							if (points.length > 1) set(points.filter((_, j) => j !== i));
						}}
						style={{
							position: "absolute", left: `${x * 100}%`, top: `${y * 100}%`, width: 16, height: 16, margin: -8, borderRadius: 8,
							background: colors[i], border: "2px solid #fff", boxShadow: "0 0 0 1px rgba(0,0,0,0.5)", cursor: "grab",
						}}
					/>
				))}
			</div>
			<div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0, flex: "1 1 200px" }}>
				<p style={{ ...text, fontSize: 12 }}>
					Each dot picks a colour from the cover; the ring blends them in order. Drag a dot to move it, click the cover to add one (up to {MAX_COLOR_POINTS}), double-click a dot to remove it.
				</p>
				<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
					{colors.map((c, i) => (
						<span key={i} style={{ width: 28, height: 28, borderRadius: 6, background: c, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.25)" }} />
					))}
				</div>
			</div>
		</div>
	);
};

export const VizPanel = ({ looks }: { looks: Looks }) => {
	const [viz, update] = useViz();
	const set = <K extends keyof VizSettings>(key: K) => (v: VizSettings[K]) => update({ [key]: v } as Partial<VizSettings>);
	const onOff: [boolean, string][] = [[true, "On"], [false, "Off"]];

	return (
		<div style={{ minHeight: "100%", color: "#fff", fontFamily: "inherit", display: "flex", flexDirection: "column" }}>
			<div style={{ margin: "auto 0", paddingBottom: 48 }}>
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
					<p style={text}>
						{!settings.enabled ? "Turn the equalizer on: the visualizer reads the audio mpv plays." : "Spectrum around the cover, after your equalizer."}
					</p>
					<div style={{ display: "flex", gap: 8 }}>
						<Pill looks={looks} pressed={viz.enabled} onClick={() => update({ enabled: !viz.enabled })}>
							{viz.enabled ? "On" : "Off"}
						</Pill>
						<Pill looks={looks} pressed={false} onClick={() => update({ ...defaultViz(), enabled: viz.enabled })}>
							Reset
						</Pill>
					</div>
				</div>

				<div style={{ opacity: viz.enabled ? 1 : 0.4, transition: "opacity .2s" }}>
					<Section title="Look">
						<Choice looks={looks} label="Style" options={[["bars", "Bars"], ["wave", "Wave"], ["dots", "Dots"]]} v={viz.style} set={set("style")} />
						<Choice looks={looks} label="Shape" options={[["square", "Follow cover"], ["circle", "Circle"]]} v={viz.shape} set={set("shape")} />
						<Choice looks={looks} label="Placement" options={[["outside", "Outside"], ["inside", "Inside"], ["both", "Both ways"]]} v={viz.placement} set={set("placement")} />
						<Choice looks={looks} label="Mirror" options={onOff} v={viz.mirror} set={set("mirror")} />
						<Choice looks={looks} label="Round ends" options={onOff} v={viz.roundCaps} set={set("roundCaps")} />
						<Choice looks={looks} label="Peaks" options={onOff} v={viz.peaks} set={set("peaks")} />
					</Section>

					<Section title="Size">
						<Row>
							<Slider label="Bars" min={16} max={256} step={2} v={viz.bars} set={set("bars")} />
							<Slider label="Thickness" min={0.1} max={1} step={0.05} v={viz.width} set={set("width")} />
						</Row>
						<Row>
							<Slider label="Height" min={8} max={200} unit=" px" v={viz.length} set={set("length")} />
							<Slider label="Distance" min={-40} max={80} unit=" px" v={viz.gap} set={set("gap")} />
						</Row>
					</Section>

					<Section title="Color">
						<Choice looks={looks} label="Colors" options={[["artwork", "From cover"], ["solid", "Solid"], ["gradient", "Gradient"], ["spectrum", "Rainbow"]]} v={viz.colorMode} set={set("colorMode")} />
						{viz.colorMode === "artwork" && (
							<>
								<ColorPoints points={viz.colorPoints} set={set("colorPoints")} />
								<div>
									<Pill looks={looks} pressed={false} onClick={() => update({ colorPoints: defaultViz().colorPoints })}>
										Reset points
									</Pill>
								</div>
							</>
						)}
						{(viz.colorMode === "solid" || viz.colorMode === "gradient") && (
						<div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
							{(["color1", "color2"] as const).slice(0, viz.colorMode === "solid" ? 1 : 2).map((k, i) => (
								<label key={k} style={{ display: "flex", gap: 12, alignItems: "center" }}>
									<span style={{ ...text, color: "#fff", width: 92 }}>{i ? "Color 2" : "Color 1"}</span>
									<input type="color" value={viz[k]} onChange={(e) => update({ [k]: e.target.value })}
										style={{ width: 40, height: 28, border: "none", background: "transparent", padding: 0, cursor: "pointer" }} />
								</label>
							))}
						</div>
						)}
						<Row>
							<Slider label="Opacity" min={0.1} max={1} step={0.05} v={viz.opacity} set={set("opacity")} />
							<Slider label="Glow" min={0} max={40} unit=" px" v={viz.glow} set={set("glow")} />
						</Row>
					</Section>

					<Section title="Motion">
						<Row>
							<Slider label="Rotation" min={0} max={359} unit="°" v={viz.rotation} set={set("rotation")} />
							<Slider label="Spin" min={-30} max={30} unit=" rpm" v={viz.spin} set={set("spin")} />
						</Row>
						<Row>
							<Slider label="Cover beat" min={0} max={1} step={0.05} v={viz.pulse} set={set("pulse")} />
							<Slider label="Smoothing" min={0} max={1} step={0.05} v={viz.smoothing} set={set("smoothing")} />
						</Row>
						<Row>
							<Slider label="Rise" min={5} max={300} unit=" ms" v={viz.attack} set={set("attack")} />
							<Slider label="Fall" min={20} max={1500} step={10} unit=" ms" v={viz.decay} set={set("decay")} />
						</Row>
					</Section>

					<Section title="Response">
						<Row>
							<Slider label="Sensitivity" min={-12} max={40} unit=" dB" v={viz.sensitivity} set={set("sensitivity")} />
							<Slider label="Range" min={20} max={90} unit=" dB" v={viz.range} set={set("range")} />
						</Row>
						<Row>
							<Slider label="Lowest" min={20} max={500} step={5} unit=" Hz" v={viz.minFreq} set={set("minFreq")} />
							<Slider label="Highest" min={1000} max={11000} step={100} unit=" Hz" v={viz.maxFreq} set={set("maxFreq")} />
						</Row>
						<Row>
							<Slider label="Treble lift" min={0} max={6} step={0.5} unit=" dB/oct" v={viz.tilt} set={set("tilt")} />
							<Slider label="Sync" min={-300} max={300} step={10} unit=" ms" v={viz.syncOffset} set={set("syncOffset")} />
						</Row>
					</Section>

					<Section title="Performance">
						<Choice looks={looks} label="Frame rate" options={[[30, "30"], [60, "60"], [120, "120"], [0, "Max"]]} v={viz.fps} set={set("fps")} />
					</Section>
				</div>
			</div>
		</div>
	);
};
