import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { Plugin, Skill } from "@opencode/plugin";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.join(HERE, "..", "skills");
// Finds the CLI inside Blixel.app, never on PATH, and ends in `exec`, so killing it
// kills the receiver.
const CLI = path.join(SKILLS, "connect-agent", "scripts", "app-cli");
const RECEIVE = ["agent", "receive", "--deliver-with", path.join(HERE, "submit.sh")];
// A connect the model runs, not a mention of one, as in `grep "blixel agent connect"`.
const RUNS = /(?:^|[\s;&|(/])blixel["']? agent connect\b/;
// How long a connect waits for its receiver to attach before it answers.
const RECEIVING_MS = 5_000;
// The prompts that act at once, the same as the TUI plugin reads them.
const PHRASE = /^(?:blixel[ :](connect|disconnect|status)|(connect|disconnect|status) blixel)$/;
const RECEIVERS = Symbol.for("blixel.opencode.receivers");
const LEAVING = Symbol.for("blixel.opencode.leaving");

type Verb = "connect" | "disconnect" | "status";
type Failure = { code?: string; message?: string; hint?: string };
type Answer = { data?: any; error?: Failure };
type Prompt = { sessionID: string; prompt: { text: string }; metadata?: { displayText?: unknown } };
type Receiver = {
	child?: ChildProcess;
	server: net.Server;
	folder: string;
	attached: boolean;
	elsewhere: boolean;
	waiting: (() => void)[];
	retry?: NodeJS.Timeout;
	leave: () => Promise<void>;
};

// A server holds many sessions, so each one connected has its own receiver. They live
// here because OpenCode unloads a location an hour after its last session event, as a
// quiet meeting can be, and loads this file anew for the next prompt. No plugin call
// can stop that, and this plugin's cleanup must not stop receiving when it happens.
const shared = globalThis as { [RECEIVERS]?: Map<string, Receiver>; [LEAVING]?: Map<string, Promise<void>> };
const receivers = (shared[RECEIVERS] ??= new Map());
// A stopped receiver until it exits: the app refuses a second one while it lives.
const leaving = (shared[LEAVING] ??= new Map());

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

function skill(name: string) {
	const file = path.join(SKILLS, name, "SKILL.md");
	const text = fs.readFileSync(file, "utf8");
	const [, head = "", content = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];
	return Skill.Info.make({
		id: Skill.ID.make(name),
		name: Skill.Name.make(name),
		description: /^description: (.*)$/m.exec(head)?.[1] ?? "",
		path: Skill.Info.fields.path.make(file),
		content,
	});
}

export default Plugin.define({
	id: "blixel",
	async setup(ctx) {
		// The variable OpenCode's shell tool sets, so the model's commands and these name
		// one session, whose agent process is this server.
		const environment = (session: string) => ({ ...process.env, OPENCODE_SESSION_ID: session });

		const call = (session: string, ...args: string[]) =>
			new Promise<{ answer: Answer; stdout: string }>((resolve) =>
				execFile(CLI, ["agent", ...args], { env: environment(session) }, (_error, stdout, stderr) => {
					const line = stderr.trim().split("\n").at(-1);
					resolve({ answer: last(stdout) ?? last(stderr) ?? { error: { message: line || undefined } }, stdout });
				}),
			);

		const settled = (receiver: Receiver) => {
			for (const resolve of receiver.waiting.splice(0)) resolve();
		};

		const stop = (session: string) => {
			const receiver = receivers.get(session);
			if (!receiver) return;
			receivers.delete(session);
			process.off("exit", receiver.leave);
			clearTimeout(receiver.retry);
			receiver.server.close();
			const exited = receiver.leave();
			leaving.set(session, exited);
			void exited.then(() => leaving.get(session) === exited && leaving.delete(session));
			settled(receiver);
		};

		// The deliver program is another process, so each text comes back over this socket.
		// A NUL ends it, as no argument can hold one.
		const take = (session: string) => (socket: net.Socket) => {
			const chunks: Buffer[] = [];
			socket.on("data", (chunk) => {
				chunks.push(chunk);
				if (chunk.at(-1) !== 0) return;
				const text = Buffer.concat(chunks).subarray(0, -1).toString();
				ctx.session.prompt({ sessionID: session, text }).then(
					() => socket.end("ok"),
					() => socket.end("no"),
				);
			});
			// A program `receive` stopped closes on us, and an unheard error would end the server.
			socket.on("error", () => {});
		};

		const receive = (session: string, attempt: number) => {
			const receiver = receivers.get(session);
			if (!receiver || receiver.child) return;
			const child = spawn(CLI, RECEIVE, {
				env: { ...environment(session), BLIXEL_OPENCODE_SOCKET: path.join(receiver.folder, "submit") },
				stdio: ["ignore", "pipe", "pipe"],
			});
			receiver.child = child;
			let ended: string | undefined;
			let failed: Failure | undefined;
			lines(child.stdout!, (line) => {
				const event = last(line) as { event?: string; data?: any } | undefined;
				if (event?.event === "receiving") {
					attempt = 0;
					receiver.attached = true;
					receiver.elsewhere = false;
					settled(receiver);
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
				if (receivers.get(session) !== receiver || receiver.child !== child) return;
				receiver.child = undefined;
				receiver.attached = false;
				if (ended === "received_elsewhere") {
					receiver.elsewhere = true;
					stop(session);
				} else if (ended !== undefined || failed?.code === "not_connected") {
					stop(session);
				} else if (failed && failed.code !== "cancelled") {
					// It would fail the same way each time.
					stop(session);
					void ctx.session.synthetic({
						sessionID: session,
						text: `Blixel stopped receiving handoffs: ${failure(failed)}`,
						description: `Blixel stopped receiving handoffs: ${failure(failed)}`,
						resume: false,
					});
				} else {
					settled(receiver);
					receiver.retry = setTimeout(() => receive(session, attempt + 1), Math.min(60_000, 1_000 * 2 ** attempt));
					receiver.retry.unref();
				}
			});
		};

		const make = (session: string) => {
			// Under /tmp, as a socket's path has a limit a long TMPDIR passes.
			const folder = fs.mkdtempSync("/tmp/blixel-opencode-");
			// nc closes its side once it has sent the text, and OpenCode can take longer to answer.
			const server = net.createServer({ allowHalfOpen: true }, take(session)).listen(path.join(folder, "submit"));
			const receiver: Receiver = {
				server,
				folder,
				attached: false,
				elsewhere: false,
				waiting: [],
				// Answers once the receiver has exited, or 3 s on.
				leave: () => {
					const child = receiver.child;
					fs.rmSync(folder, { recursive: true, force: true });
					return new Promise<void>((resolve) => {
						if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
						child.once("close", () => resolve());
						setTimeout(resolve, 3_000).unref();
						child.kill();
					});
				},
			};
			// The server ending ends the connection, as the app sees its agent process exit.
			process.once("exit", receiver.leave);
			receivers.set(session, receiver);
			return receiver;
		};

		// Receives for the session, if nothing here does already, and answers once it does
		// or has stopped trying.
		const receiving = async (session: string) => {
			const receiver = receivers.get(session) ?? make(session);
			receiver.elsewhere = false;
			if (!receiver.child) {
				clearTimeout(receiver.retry);
				await leaving.get(session);
				receive(session, 0);
			}
			if (receiver.attached || !receiver.child) return receiver;
			await Promise.race([
				new Promise<void>((resolve) => receiver.waiting.push(resolve)),
				new Promise<void>((resolve) => setTimeout(resolve, RECEIVING_MS).unref()),
			]);
			return receiver;
		};

		const answers: Record<Verb, (session: string, argument: string) => Promise<string>> = {
			connect: async (session, argument) => {
				if (argument) return "Usage: /blixel:connect";
				const { answer } = await call(session, "connect");
				if (answer.data?.outcome !== "connected") return `Blixel did not connect: ${failure(answer.error)}`;
				const receiver = await receiving(session);
				const replaced = answer.data.replaced ? " Another session was connected and no longer receives them." : "";
				if (receiver.attached) return `Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation.${replaced}`;
				if (receiver.elsewhere) return `Connected to the Blixel meeting. Another receiver in this session takes its handoffs.${replaced}`;
				return `Connected to the Blixel meeting, but not receiving its handoffs yet. Type /blixel:status to check.${replaced}`;
			},
			disconnect: async (session) => {
				const { answer } = await call(session, "disconnect");
				const outcome = answer.data?.outcome;
				if (outcome !== "disconnected" && outcome !== "not_connected") return failure(answer.error);
				stop(session);
				return outcome === "disconnected"
					? "Disconnected from the Blixel meeting. Handoffs stop arriving."
					: "This session was not connected to the Blixel meeting.";
			},
			status: async (session) => {
				const { answer } = await call(session, "status");
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

		await ctx.skill.transform((editor) => {
			for (const name of ["blixel", "connect-agent"]) if (!editor.get(name)) editor.add(skill(name));
		});

		await ctx.command.transform((editor) => {
			for (const verb of ["connect", "disconnect", "status"] as const) {
				editor.add({
					name: `blixel:${verb}`,
					description: descriptions[verb],
					execute: async ({ sessionID, prompt }) => {
						const text = await answers[verb](sessionID, prompt.text.trim());
						// A description makes it a notice the user sees, and resume: false starts no turn.
						await ctx.session.synthetic({ sessionID, text, description: text, resume: false });
					},
				});
			}
		});

		// The desktop and web apps send a phrase as a prompt, which no plugin can stop, and
		// show its `displayText` in place of what the model reads: the phrase acts here, and
		// the model is told to say the answer. A handoff has no `displayText`, so one saying
		// a phrase runs nothing.
		await ctx.session.hook("prompt", async (event: Prompt) => {
			if (typeof event.metadata?.displayText !== "string") return;
			const said = PHRASE.exec(event.prompt.text.trim().toLowerCase());
			const verb = (said?.[1] ?? said?.[2]) as Verb | undefined;
			if (!verb) return;
			const text = await answers[verb](event.sessionID, "");
			event.prompt.text += `\n\nThe Blixel plugin already did what this prompt asks, and answered: ${text} Tell the user that answer in one short line, and run no tool or skill.`;
		});

		// The shell tool asks for permission inside `execute`, so only a command that was
		// allowed and ran gets past it: a declined or blocked connect throws and is left
		// alone. A connect of this session is taken over, and the model reads that the
		// session receives. A connect of another session, as with `--session-env` or over
		// ssh, is left alone: the connect below would make one the call never asked for.
		await ctx.tool.transform((editor) => {
			editor.update("shell", (tool) => {
				const execute = tool.execute;
				tool.execute = async (input, context) => {
					const ran = await execute(input, context);
					if (input.background === true || !RUNS.test(String(input.command ?? ""))) return ran;
					const answered = last(typeof ran?.output?.output === "string" ? ran.output.output : "")?.data;
					const id = answered?.connection?.connection_id;
					if (answered?.outcome !== "connected" || typeof id !== "string") return ran;
					const mine = (await call(context.sessionID, "status")).answer;
					if (mine.data?.session?.connection_id !== id) return ran;
					await receiving(context.sessionID);
					const { answer, stdout } = await call(context.sessionID, "connect");
					if (answer.data?.outcome !== "connected") return ran;
					const text = stdout.trim();
					return { ...ran, output: { ...ran.output, output: text }, content: [{ type: "text", text }] };
				};
			});
		});
	},
});
