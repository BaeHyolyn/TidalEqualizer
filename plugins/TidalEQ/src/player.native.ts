import type { PlaybackInfo } from "@luna/lib";
import { fetchMediaItemStream } from "@luna/lib.native";
import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { createServer, type Server } from "http";
import { connect, type Socket } from "net";
import type { Readable } from "stream";

let mpv: ChildProcess | null = null;
let ipc: Socket | null = null;
let server: Server | null = null;
let port = 0;
let nextRequest = 1;
const pending = new Map<number, (reply: { error: string; data?: unknown }) => void>();
// One stream per load; the random token keeps other local programs from reading it
const streams = new Map<string, PlaybackInfo>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const startServer = () =>
	new Promise<void>((resolve, reject) => {
		server = createServer(async (req, res) => {
			const info = streams.get((req.url ?? "").replace(/^\/track\//, ""));
			if (!info) return void res.writeHead(404).end();
			let stream: Readable | undefined;
			try {
				stream = await fetchMediaItemStream(info);
				res.writeHead(200, { "Content-Type": "application/octet-stream" });
				stream.pipe(res);
				res.on("close", () => stream?.destroy());
			} catch (err) {
				res.writeHead(502).end(String(err));
			}
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

export const loadTrack = async (info: PlaybackInfo, startAt: number, paused: boolean) => {
	const token = randomBytes(16).toString("hex");
	streams.clear();
	streams.set(token, info);
	await command("set_property", "pause", paused);
	await command("loadfile", `http://127.0.0.1:${port}/track/${token}`, "replace", -1, `start=${Math.max(0, startAt).toFixed(2)}`);
};

export const stopTrack = async () => {
	streams.clear();
	await command("stop");
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
		streams.clear();
		pending.clear();
	}
};
