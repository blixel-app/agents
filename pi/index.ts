import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Finds the CLI inside Blixel.app, never on PATH, and ends in `exec`, so killing it
// kills the receiver.
const CLI = path.join(HERE, "..", "skills", "connect-agent", "scripts", "app-cli");
const RECEIVE = ["agent", "receive", "--deliver-with", path.join(HERE, "submit.sh")];
// The prompts that act with no model, the same as Claude's mod and Codex's hooks read them.
const PHRASE = /^(?:blixel[ :](connect|disconnect|status)|(connect|disconnect|status) blixel)$/;
// A connect the model runs, not a mention of one, as in `grep "blixel agent connect"`.
const RUNS = /(?:^|[\s;&|(/])blixel["']? agent connect\b/;
// How long a connect waits for its receiver to attach before it answers.
const RECEIVING_MS = 5_000;
// The sessions whose receiver a reload stopped, for the runtime that replaces this one.
const RELOADED = Symbol.for("blixel.pi.reloaded");
const reloaded = ((globalThis as { [RELOADED]?: Set<string> })[RELOADED] ??= new Set());

type Verb = "connect" | "disconnect" | "status";
type Failure = { code?: string; message?: string; hint?: string };
type Answer = { data?: any; error?: Failure };

function last(text: string): Answer | undefined {
	try {
		return JSON.parse(text.trim().split("\n").at(-1) ?? "");
	} catch {
		return undefined;
	}
}

function failure(error?: Failure) {
	return [error?.message ?? "Blixel did not answer.", error?.hint].filter(Boolean).join(" ");
}

function lines(stream: Readable, take: (line: string) => void) {
	let rest = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		const parts = (rest + chunk).split("\n");
		rest = parts.pop() ?? "";
		parts.forEach(take);
	});
	stream.on("end", () => rest && take(rest));
}

export default function (pi: ExtensionAPI) {
	let receiver: ChildProcess | undefined;
	let server: net.Server | undefined;
	let folder: string | undefined;
	let retry: NodeJS.Timeout | undefined;
	// This runtime receives for its session, and starts `receive` again when it stops.
	let receives = false;
	let attached = false;
	let elsewhere = false;
	let waiting: (() => void)[] = [];
	// A stopped receiver until it exits: the app refuses a second one while it lives.
	let leaving: Promise<void> = Promise.resolve();
	let notify: ExtensionContext["ui"]["notify"] | undefined;

	// The variable pi's bash tool sets, so the model's commands and these name one session.
	const environment = (ctx: ExtensionContext) => ({ ...process.env, PI_SESSION_ID: ctx.sessionManager.getSessionId() });

	const call = (ctx: ExtensionContext, ...args: string[]) =>
		new Promise<{ answer: Answer; stdout: string }>((resolve) =>
			execFile(CLI, ["agent", ...args], { env: environment(ctx) }, (_error, stdout, stderr) => {
				const line = stderr.trim().split("\n").at(-1);
				resolve({ answer: last(stdout) ?? last(stderr) ?? { error: { message: line || undefined } }, stdout });
			}),
		);

	const settled = () => {
		for (const resolve of waiting.splice(0)) resolve();
	};

	// Answers once the receiver has exited, or 3 s on.
	const stop = () => {
		receives = attached = false;
		clearTimeout(retry);
		const child = receiver;
		receiver = undefined;
		const exited = new Promise<void>((resolve) => {
			if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
			child.once("close", () => resolve());
			setTimeout(resolve, 3_000).unref();
			child.kill();
		});
		server?.close();
		if (folder) fs.rmSync(folder, { recursive: true, force: true });
		server = folder = undefined;
		settled();
		leaving = exited;
		return exited;
	};

	// The deliver program is another process, so each text comes back over this socket.
	// A NUL ends it, as no argument can hold one.
	const take = (socket: net.Socket) => {
		const chunks: Buffer[] = [];
		socket.on("data", (chunk) => {
			chunks.push(chunk);
			if (chunk.at(-1) !== 0) return;
			try {
				pi.sendUserMessage(Buffer.concat(chunks).subarray(0, -1).toString(), { deliverAs: "followUp" });
				socket.end("ok");
			} catch {
				socket.end("no");
			}
		});
		// A program `receive` stopped closes on us, and an unheard error would end pi.
		socket.on("error", () => {});
	};

	const receive = (ctx: ExtensionContext, attempt: number) => {
		if (!receives || receiver) return;
		// Under /tmp, as a socket's path has a limit a long TMPDIR passes.
		folder ??= fs.mkdtempSync("/tmp/blixel-pi-");
		const socket = path.join(folder, "submit");
		server ??= net.createServer(take).listen(socket);
		const child = spawn(CLI, RECEIVE, {
			env: { ...environment(ctx), BLIXEL_PI_SOCKET: socket },
			stdio: ["ignore", "pipe", "pipe"],
		});
		receiver = child;
		let ended: string | undefined;
		let failed: Failure | undefined;
		lines(child.stdout!, (line) => {
			const event = last(line) as { event?: string; data?: any } | undefined;
			if (event?.event === "receiving") {
				attempt = 0;
				attached = true;
				elsewhere = false;
				settled();
			} else if (event?.event === "ended") ended = String(event.data?.reason ?? "");
		});
		lines(child.stderr!, (line) => {
			failed = last(line)?.error ?? failed;
		});
		child.on("error", (error) => {
			failed ??= { message: error.message };
		});
		child.on("close", () => {
			// Stopped here, and perhaps already started again.
			if (receiver !== child) return;
			receiver = undefined;
			attached = false;
			if (ended === "received_elsewhere") {
				elsewhere = true;
				stop();
			} else if (ended !== undefined || failed?.code === "not_connected") {
				stop();
			} else if (failed && failed.code !== "cancelled") {
				// It would fail the same way each time.
				stop();
				notify?.(`Blixel stopped receiving handoffs: ${failure(failed)}`, "error");
			} else {
				settled();
				retry = setTimeout(() => receive(ctx, attempt + 1), Math.min(60_000, 1_000 * 2 ** attempt));
				retry.unref();
			}
		});
	};

	// Receives, if this runtime does not already, and answers once it does or has
	// stopped trying.
	const receiving = async (ctx: ExtensionContext) => {
		notify = ctx.ui.notify.bind(ctx.ui);
		receives = true;
		elsewhere = false;
		if (!receiver) {
			clearTimeout(retry);
			await leaving;
			receive(ctx, 0);
		}
		if (attached || !receiver) return;
		await Promise.race([
			new Promise<void>((resolve) => waiting.push(resolve)),
			new Promise<void>((resolve) => setTimeout(resolve, RECEIVING_MS).unref()),
		]);
	};

	const answers: Record<Verb, (ctx: ExtensionContext) => Promise<string>> = {
		connect: async (ctx) => {
			const { answer } = await call(ctx, "connect");
			if (answer.data?.outcome !== "connected") return `Blixel did not connect: ${failure(answer.error)}`;
			await receiving(ctx);
			const replaced = answer.data.replaced ? " Another session was connected and no longer receives them." : "";
			if (attached) return `Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation.${replaced}`;
			if (elsewhere) return `Connected to the Blixel meeting. Another receiver in this session takes its handoffs.${replaced}`;
			return `Connected to the Blixel meeting, but not receiving its handoffs yet. Type /blixel:status to check.${replaced}`;
		},
		disconnect: async (ctx) => {
			const { answer } = await call(ctx, "disconnect");
			const outcome = answer.data?.outcome;
			if (outcome !== "disconnected" && outcome !== "not_connected") return failure(answer.error);
			stop();
			return outcome === "disconnected"
				? "Disconnected from the Blixel meeting. Handoffs stop arriving."
				: "This session was not connected to the Blixel meeting.";
		},
		status: async (ctx) => {
			const { answer } = await call(ctx, "status");
			if (answer.error) return failure(answer.error);
			if (answer.data?.session?.connection_id) {
				return answer.data.session.receiving
					? "Connected to the Blixel meeting. Handoffs from people in it arrive in this conversation."
					: "Connected to the Blixel meeting, but not receiving its handoffs. Type /blixel:connect to receive them.";
			}
			if (answer.data?.connection?.connection_id) {
				return "Another session is connected to the Blixel meeting. Type /blixel:connect here to move its handoffs to this one.";
			}
			if (answer.data?.meeting_id) {
				return "This session is not connected to the Blixel meeting. Type /blixel:connect to connect it.";
			}
			return "Blixel is not in a meeting.";
		},
	};

	const descriptions: Record<Verb, string> = {
		connect: "Connect this session to the Blixel meeting, so people in it can hand it requests",
		disconnect: "Stop receiving Blixel handoffs in this session",
		status: "Show whether this session receives Blixel handoffs",
	};

	for (const verb of ["connect", "disconnect", "status"] as const) {
		pi.registerCommand(`blixel:${verb}`, {
			description: descriptions[verb],
			handler: async (args, ctx) => {
				if (verb === "connect" && args.trim()) {
					ctx.ui.notify("Usage: /blixel:connect", "error");
					return;
				}
				ctx.ui.notify(await answers[verb](ctx), "info");
			},
		});
	}

	pi.on("input", async (event, ctx) => {
		// What pi.sendUserMessage delivered is a handoff: someone in the call saying a
		// phrase must not run it.
		if (event.source === "extension") return { action: "continue" };
		const said = PHRASE.exec(event.text.trim().toLowerCase());
		const verb = (said?.[1] ?? said?.[2]) as Verb | undefined;
		if (!verb) return { action: "continue" };
		ctx.ui.notify(await answers[verb](ctx), "info");
		return { action: "handled" };
	});

	// Only a call that ran gets here: one a `tool_call` handler blocked, as a permission
	// gate does, never connected and is left alone. A connect of this session is taken
	// over, and the model reads that the session receives. A connect of another session,
	// as with `--session-env` or over ssh, is left alone: the connect below would make
	// one the call never asked for.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash" || event.isError || !RUNS.test(String(event.input.command ?? ""))) return;
		const ran = last(event.content.map((part) => (part.type === "text" ? part.text : "")).join(""))?.data;
		const id = ran?.connection?.connection_id;
		if (ran?.outcome !== "connected" || typeof id !== "string") return;
		const mine = (await call(ctx, "status")).answer;
		if (mine.data?.session?.connection_id !== id) return;
		await receiving(ctx);
		const { answer, stdout } = await call(ctx, "connect");
		if (answer.data?.outcome !== "connected") return;
		return { content: [{ type: "text", text: stdout.trim() }] };
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "reload" && reloaded.delete(ctx.sessionManager.getSessionId())) void receiving(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (!receives) return;
		// The next runtime's receiver would find this one still alive.
		await stop();
		// A reload keeps the session and its connection: the next runtime receives again.
		if (event.reason === "reload") reloaded.add(ctx.sessionManager.getSessionId());
		else await call(ctx, "disconnect");
	});
}
