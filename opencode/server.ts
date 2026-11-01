import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Plugin, Skill } from "@opencode/plugin";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.join(HERE, "..", "skills");
const SKILL = path.join(SKILLS, "connect-agent");
// Finds the CLI inside Blixel.app, never on PATH, and ends in `exec`, so killing it
// kills the relay.
const CLI = path.join(SKILL, "scripts", "app-cli");
const SUBMIT = path.join(HERE, "submit.sh");
// A command the model runs, not a mention of one, as in `grep "blixel agent connect"`.
const RUNS = /(?:^|[\s;&|(/])blixel["']? agent (connect|disconnect|status)\b/;
const RELAYS = Symbol.for("blixel.opencode.relays");

type Verb = "connect" | "disconnect" | "status";
type Answer = { data?: any; error?: { message?: string; hint?: string } };
type Relay = { child: ChildProcess; server: net.Server; leave: () => void };

// A server holds many sessions, so each one connected has its own relay. They live here
// because OpenCode unloads a location an hour after its last session event, as a quiet
// meeting can be, and loads this file anew for the next prompt. No plugin call can stop
// that, and this plugin's cleanup must not end the connection when it happens.
const shared = globalThis as { [RELAYS]?: Map<string, Relay> };
const relays = (shared[RELAYS] ??= new Map());

function rules() {
	const skill = fs.readFileSync(path.join(SKILL, "SKILL.md"), "utf8");
	const section = /^## Blixel handoffs\n([\s\S]*?)^## Connect$/m.exec(skill)?.[1].trim();
	return `This session is connected to the user's Blixel meeting, and they connected it to receive handoffs.\n\n${section}`;
}

function failure({ error }: Answer) {
	return [error?.message ?? "Blixel did not answer.", error?.hint].filter(Boolean).join(" ");
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
		const guidance = rules();
		// Shell hooks have no session ID; a unique command bridges each tool invocation.
		const commands = new Map<string, { session: string; command: string }>();

		// The server's pid, as it holds the session and a terminal only attaches to it.
		const environment = (session: string) => ({
			BLIXEL_AGENT_PID: String(process.pid),
			BLIXEL_AGENT_PROVIDER: "opencode",
			BLIXEL_AGENT_NAME: "OpenCode",
			BLIXEL_AGENT_SESSION_KEY: session,
		});

		const ask = (session: string, ...args: string[]) =>
			new Promise<Answer>((resolve) =>
				execFile(
					CLI,
					["agent", ...args],
					{ env: { ...process.env, ...environment(session) } },
					(_error, stdout, stderr) => {
						const line = (stdout.trim() || stderr.trim()).split("\n").at(-1) ?? "";
						try {
							resolve(JSON.parse(line));
						} catch {
							resolve({ error: { message: line || undefined } });
						}
					},
				),
			);

		const stop = (session: string) => {
			const relay = relays.get(session);
			if (!relay) return;
			relays.delete(session);
			process.off("exit", relay.leave);
			relay.server.close();
			relay.leave();
		};

		// The relay's submit is another process, so each text comes back over this socket.
		// A NUL ends it, as no argument can hold one.
		const receive = (session: string) => (socket: net.Socket) => {
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
			// A submit the relay stopped closes on us, and an unheard error would end the server.
			socket.on("error", () => {});
		};

		const start = (session: string) => {
			// Under /tmp, as a socket's path has a limit a long TMPDIR passes.
			const folder = fs.mkdtempSync("/tmp/blixel-opencode-");
			const socket = path.join(folder, "submit");
			// nc closes its side once it has sent the text, and OpenCode can take longer to answer.
			const server = net.createServer({ allowHalfOpen: true }, receive(session)).listen(socket);
			const child = spawn(CLI, ["agent", "relay", "--submit", SUBMIT], {
				env: { ...process.env, ...environment(session), BLIXEL_OPENCODE_SOCKET: socket },
				// A pipe nobody reads would hold up its renewals.
				stdio: "ignore",
			});
			const ended = () => {
				if (relays.get(session)?.child === child) stop(session);
			};
			child.on("error", ended).on("exit", ended);
			const leave = () => {
				child.kill();
				fs.rmSync(folder, { recursive: true, force: true });
			};
			process.once("exit", leave);
			relays.set(session, { child, server, leave });
		};

		const answers: Record<Verb, (session: string, argument: string) => Promise<string>> = {
			connect: async (session, approval) => {
				if (approval && approval !== "ask" && approval !== "direct") return "Usage: /blixel:connect [ask|direct]";
				const started = !relays.has(session);
				if (started) start(session);
				const answer = await ask(session, "connect", ...(approval ? ["--approval", approval] : []));
				if (answer.data?.outcome !== "connected") {
					if (started) stop(session);
					return `Blixel did not connect: ${failure(answer)}`;
				}
				const text = "Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation.";
				return answer.data.replaced ? `${text} Another session was connected and no longer receives them.` : text;
			},
			disconnect: async (session) => {
				const answer = await ask(session, "disconnect");
				const outcome = answer.data?.outcome;
				if (outcome !== "disconnected" && outcome !== "not_connected") return failure(answer);
				stop(session);
				return outcome === "disconnected"
					? "Disconnected from the Blixel meeting. Handoffs stop arriving."
					: "This session was not connected to the Blixel meeting.";
			},
			status: async (session) => {
				const answer = await ask(session, "status");
				if (answer.error) return failure(answer);
				if (answer.data?.session?.connection_id) {
					return "Connected to the Blixel meeting. Handoffs from people in it arrive in this conversation.";
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
			connect: "Connect this session to the Blixel meeting: [ask|direct]",
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

		await ctx.tool.transform((editor) => {
			editor.update("shell", (tool) => {
				const execute = tool.execute;
				tool.execute = async (input, context) => {
					const command = String(input.command ?? "");
					const verb = RUNS.exec(command)?.[1];
					if (!verb) return execute(input, context);
					const key = `# blixel ${randomUUID()}\n${command}`;
					commands.set(key, { session: context.sessionID, command });
					try {
						if (verb === "connect" && !relays.has(context.sessionID)) start(context.sessionID);
						return await execute({ ...input, command: key }, context);
					} finally {
						commands.delete(key);
					}
				};
			});
		});

		await ctx.shell.hook("create.before", async (event) => {
			const pending = commands.get(event.command);
			if (!pending) return;
			event.command = pending.command;
			Object.assign(event.env, environment(pending.session));
		});

		// A connect with no model never reads the skill, and this outlasts a compaction.
		const guide = async (event: { sessionID: string; system: { type: "text"; text: string }[] }) => {
			if (relays.has(event.sessionID)) event.system.push({ type: "text", text: guidance });
		};
		await ctx.session.hook("context", guide);
		await ctx.session.hook("compaction", guide);
		await ctx.session.hook("generate", guide);
	},
});
