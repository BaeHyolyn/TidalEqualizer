import type { LunaUnload } from "@luna/core";
import { observe } from "@luna/lib";
import React from "react";
import { createRoot, type Root } from "react-dom/client";

import { EqEditor, useEq } from "./Settings";

// TIDAL's class names are hashed per build, so only data-test attributes and class names copied at runtime are used.
// The Equalizer tab borrows the Credits panel: TIDAL opens it (and shifts the artwork aside), we cover its content with ours.

const Panel = () => {
	const [eq, update] = useEq();
	return (
		<div style={{ height: "100%", overflowY: "auto", padding: "0 24px 24px", boxSizing: "border-box" }}>
			<EqEditor eq={eq} update={update} />
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
		root.render(<Panel />);
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
