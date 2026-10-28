import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { bandFilter, buildChain, defaultSettings, flatBands, PRESETS, type EqSettings } from "./eq";

// Flat with the limiter off does nothing at all
assert.equal(buildChain({ ...defaultSettings(), limiter: false }), "");
assert.equal(buildChain({ ...defaultSettings(), enabled: false, preamp: 6 }), "");

// Flat with the limiter on is only the limiter
assert.equal(buildChain(defaultSettings()), "lavfi=[alimiter=limit=0.97:level=0]");

// Bands, preamp and smart volume in order
const s: EqSettings = { ...defaultSettings(), preamp: -3, smartVolume: "balanced" };
s.bands[0] = { enabled: true, type: "highpass", freq: 60, gain: 0, q: 0.707 };
s.bands[6] = { enabled: true, type: "peaking", freq: 2000, gain: 4, q: 1.2 };
assert.equal(
	buildChain(s),
	"lavfi=[volume=-3dB,highpass=f=60:t=q:w=0.71,equalizer=f=2000:t=q:w=1.2:g=4,dynaudnorm=f=250:g=15:m=8,alimiter=limit=0.97:level=0]",
);

// Shelves, disabled bands and clamping
assert.equal(bandFilter({ enabled: true, type: "lowshelf", freq: 100, gain: 3, q: 0.7 }), "lowshelf=f=100:t=q:w=0.7:g=3");
assert.equal(bandFilter({ enabled: false, type: "peaking", freq: 100, gain: 3, q: 1 }), undefined);
assert.equal(bandFilter({ enabled: true, type: "peaking", freq: 99999, gain: 99, q: 0 }), "equalizer=f=20000:t=q:w=0.1:g=24");

// Hostile values can never reach the filter string as text
const evil = { enabled: true, type: "peaking", freq: NaN, gain: "1,amovie=x" as unknown as number, q: Infinity } as const;
assert.equal(bandFilter(evil), undefined); // gain falls back to 0, so the band is dropped
assert.equal(bandFilter({ ...evil, type: "nope" as never, gain: 2 }), "equalizer=f=1000:t=q:w=1:g=2");

// Presets keep 10 bands and leave headroom for their boosts
for (const [key, p] of Object.entries(PRESETS)) {
	const bands = p.bands();
	assert.equal(bands.length, 10, key);
	assert.ok(p.preamp <= -Math.max(0, ...bands.map((b) => b.gain)) + 0.5, `${key} preamp must cover its biggest boost`);
}
assert.equal(flatBands().every((b) => b.gain === 0), true);

// The chains are valid for the real mpv, when it is installed
const MPV = "C:\\Program Files\\MPV Player\\mpv.exe";
if (existsSync(MPV)) {
	for (const [key, p] of Object.entries(PRESETS)) {
		const chain = buildChain({ ...defaultSettings(), preamp: p.preamp, bands: p.bands(), smartVolume: "loud" });
		execFileSync(MPV, ["--no-config", "--ao=null", "--length=0.3", `--af=${chain}`, "av://lavfi:sine=f=1000:d=0.3"], { stdio: "ignore" });
	}
	console.log("eq: preset chains accepted by mpv");
}

console.log("eq: all tests passed");
