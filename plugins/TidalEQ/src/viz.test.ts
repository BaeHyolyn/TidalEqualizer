import assert from "assert";

import { analyze, bandEdges, bandLevels, FFT_SIZE, PCM_RATE, sampleColors, smoothBars } from "./viz";

// A full-scale 1 kHz sine peaks at ~0 dB in the 1 kHz bin and is far lower elsewhere
const n = PCM_RATE;
const sine = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / PCM_RATE));
const spec = analyze(sine, n, n / 2);
const bin = Math.round(1000 / (PCM_RATE / FFT_SIZE));
assert(Math.abs(spec[bin]) < 1.5, `1 kHz bin should be ~0 dB, got ${spec[bin]}`);
assert(spec[Math.round(5000 / (PCM_RATE / FFT_SIZE))] < -60, "5 kHz should be quiet");

// Outside the decoded range is silence (analyze reuses one buffer, so read results before the next call)
assert(analyze(sine, n, -FFT_SIZE * 2)[bin] < -150, "before the start is silent");

// Bands: log spaced, and only the band holding 1 kHz is loud
const edges = bandEdges(32, 40, 10000);
assert(Math.abs(edges[0] - 40) < 1e-3 && Math.abs(edges[32] - 10000) < 1e-2, "edges span the range");
const levels = bandLevels(analyze(sine, n, n / 2), edges, new Float32Array(32));
const loud = levels.indexOf(Math.max(...levels));
assert(edges[loud] <= 1000 * 1.1 && edges[loud + 1] >= 1000 * 0.9, "the loudest band contains 1 kHz");

// Smoothing: rises faster than it falls, and the spread doesn't accumulate in the state
const state = new Float32Array(8);
const out = new Float32Array(8);
const opts = { attack: 40, decay: 200, smoothing: 0.5 };
smoothBars(state, Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0]), out, 16, opts);
const risen = state[3];
assert(risen > 0.2 && state[2] === 0, "only the hit bar rises in the state");
assert(out[2] > 0 && out[2] < out[3], "neighbours are lifted in the output");
smoothBars(state, new Float32Array(8), out, 16, opts);
assert(risen - state[3] < risen * 0.2, "falls slower than it rose");
for (let i = 0; i < 200; i++) smoothBars(state, new Float32Array(8), out, 16, opts);
assert(Math.max(...out) < 0.01, "everything settles back to zero");

// Colour points: left half red, right half blue; each point reads its side (nudged 20% toward white)
const px = new Uint8ClampedArray(64 * 64 * 4);
for (let i = 0; i < 64 * 64; i++) px.set(i % 64 < 32 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
assert.deepStrictEqual(sampleColors(px, [[0.1, 0.5], [0.9, 0.5], [2, -1]]), ["rgb(255,51,51)", "rgb(51,51,255)", "rgb(51,51,255)"]);

console.log("viz: all tests passed");
