import type { LunaUnload } from "@luna/core";
import { observe } from "@luna/lib";
import React from "react";
import { createRoot, type Root } from "react-dom/client";

import { PRESETS, type Band, type EqSettings, type Macros } from "./eq";
import { EqGraph } from "./EqGraph";
import { BandEditor, MacroSlider, useEq } from "./Settings";

// TIDAL's class names are hashed per build, so only data-test attributes and class names copied at runtime are used.
// The Equalizer tab borrows the Credits panel: TIDAL opens it (and shifts the artwork aside), we cover its content with ours.

const text: React.CSSProperties = { fontSize: 14, fontWeight: 400, color: "rgba(255,255,255,0.55)", margin: 0 };
const heading: React.CSSProperties = { fontSize: 14, fontWeight: 500, color: "#fff", margin: "0 0 12px" };

// The preset whose bands and preamp match the current ones, if any
const currentPreset = (eq: EqSettings) =>
	Object.keys(PRESETS).find((k) => {
		const p = PRESETS[k];
		const bands = p.bands();
		return p.preamp === eq.preamp && eq.bands.every((b, i) => b.type === bands[i].type && b.freq === bands[i].freq && b.gain === bands[i].gain && b.q === bands[i].q && b.enabled);
	});

/** Same look as TIDAL's own tabs: their class names are passed in from the live buttons. */
const Pill = ({ looks, pressed, onClick, children }: { looks: Looks; pressed: boolean; onClick: () => void; children: React.ReactNode }) => (
	<button type="button" aria-pressed={pressed} onClick={onClick} className={pressed ? `${looks.button} ${looks.pressed}` : looks.button}>
		<span className={looks.label}>{children}</span>
	</button>
);

type Looks = { button: string; pressed: string; label: string };

const Panel = ({ looks }: { looks: Looks }) => {
	const [eq, update] = useEq();
	const [selected, setSelected] = React.useState<number | null>(null);
	const preset = currentPreset(eq);
	const setBand = (i: number, b: Band) => update({ bands: eq.bands.map((x, j) => (j === i ? b : x)) });
	const setMacro = (key: keyof Macros, v: number) => update({ macros: { ...eq.macros, [key]: v } });

	return (
		// Column flex + auto margins centers the content on the artwork, and still scrolls when it doesn't fit
		<div style={{ height: "100%", overflowY: "auto", padding: "0 24px", boxSizing: "border-box", color: "#fff", fontFamily: "inherit", display: "flex", flexDirection: "column" }}>
			<div style={{ margin: "auto 0" }}>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 24 }}>
				<p style={text}>{eq.enabled ? "Playing through mpv with your equalizer." : "Off: TIDAL plays normally."}</p>
				<div style={{ display: "flex", gap: 8 }}>
					<Pill looks={looks} pressed={eq.enabled} onClick={() => update({ enabled: !eq.enabled })}>
						{eq.enabled ? "On" : "Off"}
					</Pill>
					<Pill looks={looks} pressed={false} onClick={() => update({ bands: PRESETS.flat.bands(), preamp: 0, macros: { bass: 0, voice: 0, treble: 0 } })}>
						Reset
					</Pill>
				</div>
			</div>

			<div style={{ opacity: eq.enabled ? 1 : 0.4, transition: "opacity .2s" }}>
				<EqGraph bands={eq.bands} macros={eq.macros} selected={selected} onSelect={setSelected} onBand={setBand} />
				{selected !== null && eq.bands[selected] ? (
					<BandEditor band={eq.bands[selected]} index={selected} onChange={(b) => setBand(selected, b)} />
				) : (
					<p style={{ ...text, fontSize: 12, marginTop: 10 }}>Drag a dot to shape the sound. Scroll on it to change its width, double-click to reset.</p>
				)}

				<div style={{ display: "flex", flexWrap: "wrap", gap: 16, margin: "24px 0 32px" }}>
					<MacroSlider label="Bass" value={eq.macros.bass} onChange={(v) => setMacro("bass", v)} />
					<MacroSlider label="Voice" value={eq.macros.voice} onChange={(v) => setMacro("voice", v)} />
					<MacroSlider label="Treble" value={eq.macros.treble} onChange={(v) => setMacro("treble", v)} />
				</div>

				<h3 style={heading}>Presets</h3>
				<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
					{Object.entries(PRESETS).map(([key, p]) => (
						<Pill key={key} looks={looks} pressed={key === preset} onClick={() => update({ bands: p.bands(), preamp: p.preamp })}>
							{p.label.replace(/^Music: /, "")}
						</Pill>
					))}
				</div>
			</div>
			<p style={{ ...text, fontSize: 12, marginTop: 32 }}>Preamp, smart volume and limiter are in the plugin settings.</p>
			</div>
		</div>
	);
};

export const addNowPlayingTab = (unloads: Set<LunaUnload>) => {
	let active = false;
	let root: Root | null = null;
	let host: HTMLElement | null = null;
	let hiddenContent: HTMLElement | null = null;
	let pressedClasses: string[] = [];

	const button = document.createElement("button");
	button.type = "button";
	button.dataset.test = "toggle-tidaleq";
	button.setAttribute("aria-pressed", "false");
	button.innerHTML = `<span>Equalizer</span>`;
	unloads.add(() => button.remove());

	const credits = () => document.querySelector<HTMLButtonElement>("[data-test=toggle-credits]");

	const close = () => {
		if (!active) return;
		active = false;
		root?.unmount();
		host?.remove();
		root = host = null;
		if (hiddenContent) hiddenContent.style.visibility = "";
		hiddenContent = null;
		button.classList.remove(...pressedClasses);
		button.setAttribute("aria-pressed", "false");
	};
	unloads.add(close);

	const open = async () => {
		const creditsButton = credits();
		if (!creditsButton) return;
		if (creditsButton.getAttribute("aria-pressed") !== "true") creditsButton.click();
		// Wait for TIDAL to render the Credits panel
		let panel: HTMLElement | null = null;
		for (let i = 0; i < 40 && !panel; i++) {
			await new Promise((r) => setTimeout(r, 25));
			panel = document.querySelector<HTMLElement>("[data-test=now-playing-credits]");
		}
		const content = panel?.parentElement; // the panel's scroll container
		const wrapper = content?.parentElement;
		if (!content || !wrapper) return;

		// Move the "pressed" look from Credits to our button
		pressedClasses = [...creditsButton.classList].filter((c) => !button.classList.contains(c));
		creditsButton.classList.remove(...pressedClasses);
		creditsButton.setAttribute("aria-pressed", "false");
		button.classList.add(...pressedClasses);
		button.setAttribute("aria-pressed", "true");

		hiddenContent = content;
		content.style.visibility = "hidden";
		host = document.createElement("div");
		host.style.cssText = "position:absolute;inset:0;z-index:1;";
		if (getComputedStyle(wrapper).position === "static") wrapper.style.position = "relative";
		wrapper.appendChild(host);
		root = createRoot(host);
		root.render(<Panel looks={{ button: button.className.split(" ").filter((c) => !pressedClasses.includes(c)).join(" "), pressed: pressedClasses.join(" "), label: button.firstElementChild!.className }} />);
		active = true;
	};

	button.addEventListener("click", () => {
		if (!active) return void open();
		close();
		credits()?.click(); // closes the borrowed panel
	});

	// Another tab clicked while ours is open: Lyrics/Similar replace the panel; Credits is already there underneath
	const onTabClick = (e: MouseEvent) => {
		if (!active) return;
		const tab = (e.target as Element).closest?.("[data-test^=toggle-]");
		if (!tab || tab === button) return;
		if (tab.getAttribute("data-test") === "toggle-credits") {
			e.stopPropagation();
			e.preventDefault();
			const c = tab as HTMLElement;
			close();
			c.classList.add(...pressedClasses);
			c.setAttribute("aria-pressed", "true");
			return;
		}
		close();
	};
	document.addEventListener("click", onTabClick, true);
	unloads.add(() => document.removeEventListener("click", onTabClick, true));

	// Insert next to Lyrics whenever the now-playing view renders the tab bar
	const insert = (lyrics: Element) => {
		if (button.isConnected && button.parentElement === lyrics.parentElement) return;
		close();
		// Copy the look of a tab that isn't pressed
		const plain = [...lyrics.parentElement!.querySelectorAll("[data-test^=toggle-][aria-pressed=false]")].find((t) => t !== button) ?? lyrics;
		button.className = plain.className;
		button.firstElementChild!.className = plain.firstElementChild?.className ?? "";
		lyrics.after(button);
	};
	observe(unloads, "[data-test=toggle-lyrics]", insert);
	// observe only sees changes, so handle a now-playing view that is already open
	const existing = document.querySelector("[data-test=toggle-lyrics]");
	if (existing) insert(existing);
};
