import type { PlaybackInfo } from "@luna/lib";
import { fetchMediaItemStream } from "@luna/lib.native";
import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { closeSync, openSync, readSync, rmSync } from "fs";
import { createServer, type Server } from "http";
import { connect, type Socket } from "net";
import { tmpdir } from "os";
import { join } from "path";
import type { Readable } from "stream";

let mpv: ChildProcess | null = null;
let ipc: Socket | null = null;
let server: Server | null = null;
let port = 0;
let nextRequest = 1;
const pending = new Map<number, (reply: { error: string; data?: unknown }) => void>();
// One track per load; the random token keeps other local programs from reading it.
// The player and the visualizer's decoder share one download: every request replays what arrived so far, then follows.
type Track = { info: PlaybackInfo; source?: Readable; chunks: Buffer[]; done: boolean; started: boolean; wake: Set<() => void> };
const streams = new Map<string, Track>();
const clearStreams = () => {
	for (const t of streams.values()) t.source?.destroy();
	streams.clear();
};
let mpvBinary = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const startServer = () =>
	new Promise<void>((resolve, reject) => {
		server = createServer(async (req, res) => {
			const track = streams.get((req.url ?? "").replace(/^\/track\//, ""));
			if (!track) return void res.writeHead(404).end();
			const notify = () => track.wake.forEach((fn) => fn());
			if (!track.started) {
				track.started = true;
				// shortcut: keeps the whole track in memory (up to ~150 MB for hi-res) until the next track; fine for one track at a time
				fetchMediaItemStream(track.info)
					.then((source) => {
						track.source = source;
						source.on("data", (c: Buffer) => (track.chunks.push(c), notify()));
						source.on("end", () => ((track.done = true), notify()));
						source.on("error", () => ((track.done = true), notify()));
					})
					.catch(() => ((track.done = true), notify()));
			}
			res.writeHead(200, { "Content-Type": "application/octet-stream" });
			let sent = 0;
			const pump = () => {
				while (sent < track.chunks.length) res.write(track.chunks[sent++]);
				if (track.done) {
					track.wake.delete(pump);
					res.end();
				}
			};
			track.wake.add(pump);
			res.on("close", () => track.wake.delete(pump));
			pump();
		});
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			port = (server!.address() as { port: number }).port;
			resolve();
		});
	});

const command = (...args: unknown[]) =>
	new Promise<unknown>((resolve, reject) => {
		if (!ipc) return reject(new Error("mpv is not running"));
		const id = nextRequest++;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`mpv did not answer: ${args[0]}`));
		}, 3000);
		pending.set(id, (reply) => {
			clearTimeout(timer);
			if (reply.error === "success") resolve(reply.data);
			else reject(new Error(`${args[0]}: ${reply.error}`));
		});
		ipc.write(JSON.stringify({ command: args, request_id: id }) + "\n");
	});

const connectIpc = async (pipe: string) => {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			ipc = await new Promise<Socket>((resolve, reject) => {
				const s = connect(pipe, () => resolve(s));
				s.once("error", reject);
			});
			break;
		} catch {
			await sleep(100);
		}
	}
	if (!ipc) throw new Error("Could not connect to mpv");
	let buffer = "";
	ipc.on("data", (chunk) => {
		buffer += chunk.toString();
		let nl;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			try {
				const msg = JSON.parse(line);
				if (typeof msg.request_id === "number") pending.get(msg.request_id)?.(msg);
				pending.delete(msg.request_id);
			} catch {
				// mpv only sends JSON lines; ignore anything partial
			}
		}
	});
	ipc.on("close", () => (ipc = null));
};

/** Starts mpv (idle, no window) with the equalizer chain. Returns an error message, or "" when ready. */
export const startPlayer = async (mpvPath: string, chain: string, volume: number): Promise<string> => {
	await stopPlayer();
	mpvBinary = mpvPath;
	try {
		await startServer();
		const pipe = `\\\\.\\pipe\\tidaleq-${process.pid}-${randomBytes(4).toString("hex")}`;
		mpv = spawn(
			mpvPath,
			[
				"--idle=yes",
				"--no-video",
				"--no-terminal",
				"--no-config",
				"--audio-display=no",
				"--cache=yes",
				"--demuxer-max-bytes=300MiB",
				"--demuxer-max-back-bytes=300MiB",
				`--volume=${Math.round(volume)}`,
				`--input-ipc-server=${pipe}`,
				...(chain ? [`--af=${chain}`] : []),
			],
			{ windowsHide: true, stdio: "ignore" },
		);
		const spawnError = new Promise<string>((resolve) => mpv!.once("error", (e) => resolve(String(e))));
		const ready = connectIpc(pipe).then(() => "");
		const result = await Promise.race([spawnError, ready]);
		if (result) await stopPlayer();
		return result;
	} catch (err) {
		await stopPlayer();
		return String(err);
	}
};

let currentUrl = "";

export const loadTrack = async (info: PlaybackInfo, startAt: number, paused: boolean) => {
	const token = randomBytes(16).toString("hex");
	clearStreams();
	streams.set(token, { info, chunks: [], done: false, started: false, wake: new Set() });
	const url = `http://127.0.0.1:${port}/track/${token}`;
	currentUrl = url;
	stopDecoder();
	await command("set_property", "pause", paused);
	await command("loadfile", url, "replace", -1, `start=${Math.max(0, startAt).toFixed(2)}`);
};

/** Decodes the loaded track to mono float samples at `rate` for the visualizer (read them with readPcm). */
export const startAnalysis = (rate: number) => {
	stopDecoder();
	if (currentUrl && streams.size) startDecoder(currentUrl, rate);
};
export const stopAnalysis = () => stopDecoder();

export const stopTrack = async () => {
	clearStreams();
	currentUrl = "";
	stopDecoder();
	await command("stop");
};

// A second, silent mpv decodes the track much faster than real time into a temp file the visualizer reads as it grows
let decoder: ChildProcess | null = null;
let pcmFile: string | null = null;
let decoderDone = false;

const startDecoder = (url: string, rate: number) => {
	const file = join(tmpdir(), `tidaleq-${process.pid}-${randomBytes(4).toString("hex")}.pcm`);
	pcmFile = file;
	decoderDone = false;
	const proc = spawn(
		mpvBinary,
		["--no-config", "--no-video", "--no-terminal", "--audio-display=no", "--ao=pcm", `--ao-pcm-file=${file}`, "--ao-pcm-waveheader=no",
			"--audio-format=float", "--audio-channels=mono", `--audio-samplerate=${Math.round(rate)}`, url],
		{ windowsHide: true, stdio: "ignore" },
	);
	decoder = proc;
	proc.on("exit", () => {
		if (decoder === proc) decoderDone = true;
		else rmSync(file, { force: true });
	});
	proc.on("error", () => decoder === proc && (decoderDone = true));
};

const stopDecoder = () => {
	const file = pcmFile;
	const proc = decoder;
	decoder = null;
	pcmFile = null;
	if (proc && proc.exitCode === null) proc.kill(); // its exit handler deletes the file once it's closed
	else if (file) rmSync(file, { force: true });
};

/** Decoded samples (float32 LE) from byte `offset`; `done` once the whole track has been read. */
export const readPcm = (offset: number, maxBytes = 1 << 22): { data: Uint8Array | null; done: boolean } => {
	if (!pcmFile) return { data: null, done: true };
	const finished = decoderDone;
	let fd: number;
	try {
		fd = openSync(pcmFile, "r");
	} catch {
		return { data: null, done: finished };
	}
	try {
		const buf = Buffer.alloc(maxBytes);
		const n = readSync(fd, buf, 0, maxBytes, offset);
		return { data: n ? buf.subarray(0, n) : null, done: finished && n < maxBytes };
	} finally {
		closeSync(fd);
	}
};

export const setPaused = (paused: boolean) => command("set_property", "pause", paused);
export const seek = (seconds: number) => command("seek", Math.max(0, seconds), "absolute+exact");
export const setVolume = (volume: number) => command("set_property", "volume", Math.max(0, Math.min(100, volume)));
export const setChain = (chain: string) => command("set_property", "af", chain);

/** mpv's playback position in seconds, or null while nothing is loaded. */
export const getTime = async (): Promise<number | null> => {
	try {
		const t = await command("get_property", "time-pos");
		return typeof t === "number" ? t : null;
	} catch {
		return null;
	}
};

export const stopPlayer = async () => {
	try {
		if (ipc) await command("quit").catch(() => {});
	} finally {
		ipc?.destroy();
		ipc = null;
		mpv?.kill();
		mpv = null;
		server?.close();
		server = null;
		clearStreams();
		stopDecoder();
		pending.clear();
	}
};
