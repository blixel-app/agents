import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, "..", "skills", "connect-agent");
// Finds the CLI inside Blixel.app, never on PATH, and ends in `exec`, so killing it
// kills the relay.
const CLI = path.join(SKILL, "scripts", "app-cli");
const SUBMIT = path.join(HERE, "submit.sh");
// The prompts that act with no model, the same as Claude's mod and Codex's hooks read them.
const PHRASE = /^(?:blixel[ :](connect|disconnect|status)|(connect|disconnect|status) blixel)(?: (ask|direct))?$/;
// A command the model runs, not a mention of one, as in `grep "blixel agent connect"`.
const RUNS = /(?:^|[\s;&|(/])blixel["']? agent (connect|disconnect|status)\b/;

type Verb = "connect" | "disconnect" | "status";
type Answer = { data?: any; error?: { message?: string; hint?: string } };

function rules() {
	const skill = fs.readFileSync(path.join(SKILL, "SKILL.md"), "utf8");
	const section = /^## Blixel handoffs\n([\s\S]*?)^## Connect$/m.exec(skill)?.[1].trim();
	return `This session is connected to the user's Blixel meeting, and they connected it to receive handoffs.\n\n${section}`;
}

function failure({ error }: Answer) {
	return [error?.message ?? "Blixel did not answer.", error?.hint].filter(Boolean).join(" ");
}

export default function (pi: ExtensionAPI) {
	let relay: ChildProcess | undefined;
	let server: net.Server | undefined;
	let folder: string | undefined;
	let guidance: string | undefined;

	// In pi's own environment, as its bash tool copies that, so what the model runs is
	// this session too.
	const environment = (ctx: ExtensionContext) =>
		Object.assign(process.env, {
			BLIXEL_AGENT_PID: String(process.pid),
			BLIXEL_AGENT_PROVIDER: "pi",
			BLIXEL_AGENT_NAME: "pi",
			BLIXEL_AGENT_SESSION_KEY: ctx.sessionManager.getSessionId(),
		});

	const ask = (ctx: ExtensionContext, ...args: string[]) =>
		new Promise<Answer>((resolve) =>
			execFile(CLI, ["agent", ...args], { env: environment(ctx) }, (_error, stdout, stderr) => {
				const line = (stdout.trim() || stderr.trim()).split("\n").at(-1) ?? "";
				try {
					resolve(JSON.parse(line));
				} catch {
					resolve({ error: { message: line || undefined } });
				}
			}),
		);

	const stop = () => {
		relay?.kill();
		server?.close();
		if (folder) fs.rmSync(folder, { recursive: true, force: true });
		relay = server = folder = guidance = undefined;
	};

	// The relay's submit is another process, so each text comes back over this socket.
	// A NUL ends it, as no argument can hold one.
	const receive = (socket: net.Socket) => {
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
		// A submit the relay stopped closes on us, and an unheard error would end pi.
		socket.on("error", () => {});
	};

	const start = (ctx: ExtensionContext) => {
		// Under /tmp, as a socket's path has a limit a long TMPDIR passes.
		folder = fs.mkdtempSync("/tmp/blixel-pi-");
		const socket = path.join(folder, "submit");
		guidance = rules();
		server = net.createServer(receive).listen(socket);
		const child = spawn(CLI, ["agent", "relay", "--submit", SUBMIT], {
			env: { ...environment(ctx), BLIXEL_PI_SOCKET: socket },
			// A pipe nobody reads would hold up its renewals.
			stdio: "ignore",
		});
		const ended = () => {
			if (relay === child) stop();
		};
		child.on("error", ended).on("exit", ended);
		relay = child;
	};

	const answers: Record<Verb, (ctx: ExtensionContext, approval?: string) => Promise<string>> = {
		connect: async (ctx, approval) => {
			const started = !relay;
			if (started) start(ctx);
			const answer = await ask(ctx, "connect", ...(approval ? ["--approval", approval] : []));
			if (answer.data?.outcome !== "connected") {
				if (started) stop();
				return `Blixel did not connect: ${failure(answer)}`;
			}
			const text = "Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation.";
			return answer.data.replaced ? `${text} Another session was connected and no longer receives them.` : text;
		},
		disconnect: async (ctx) => {
			const answer = await ask(ctx, "disconnect");
			const outcome = answer.data?.outcome;
			if (outcome !== "disconnected" && outcome !== "not_connected") return failure(answer);
			stop();
			return outcome === "disconnected"
				? "Disconnected from the Blixel meeting. Handoffs stop arriving."
				: "This session was not connected to the Blixel meeting.";
		},
		status: async (ctx) => {
			const answer = await ask(ctx, "status");
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

	for (const verb of ["connect", "disconnect", "status"] as const) {
		pi.registerCommand(`blixel:${verb}`, {
			description: descriptions[verb],
			handler: async (args, ctx) => {
				const approval = args.trim();
				if (verb === "connect" && approval && approval !== "ask" && approval !== "direct") {
					ctx.ui.notify("Usage: /blixel:connect [ask|direct]", "error");
					return;
				}
				ctx.ui.notify(await answers[verb](ctx, approval), "info");
			},
		});
	}

	pi.on("input", async (event, ctx) => {
		// What pi.sendUserMessage delivered is a handoff: someone in the call saying a
		// phrase must not run it.
		if (event.source === "extension") return { action: "continue" };
		const said = PHRASE.exec(event.text.trim().toLowerCase());
		const verb = (said?.[1] ?? said?.[2]) as Verb | undefined;
		if (!said || !verb || (said[3] && verb !== "connect")) return { action: "continue" };
		ctx.ui.notify(await answers[verb](ctx, said[3]), "info");
		return { action: "handled" };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const verb = RUNS.exec(String(event.input.command))?.[1];
		if (!verb) return;
		environment(ctx);
		if (verb === "connect" && !relay) start(ctx);
	});

	// A connect with no model never reads the skill, and a section outlasts a compaction.
	pi.on("before_agent_start", async (event) => {
		if (guidance) event.systemPromptOptions.sections.blixel_handoffs = guidance;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!relay) return;
		stop();
		await ask(ctx, "disconnect");
	});
}
