import { Plugin } from "@opencode/plugin/tui";

// The prompts that act with no model, the same as Claude's mod and Codex's hooks read them.
const PHRASE = /^(?:blixel[ :](connect|disconnect|status)|(connect|disconnect|status) blixel)(?: (ask|direct))?$/;

export default Plugin.define({
	id: "blixel",
	setup(ctx) {
		// Nothing else says whether the prompt is in shell mode, where a phrase is a command.
		let prompt: { mode: string } | undefined;
		ctx.ui.slot({
			append: "prompt.footer.status",
			render: (input) => {
				prompt = input;
				return null;
			},
		});

		ctx.keymap.layer(() => ({
			commands: [
				{
					id: "blixel.phrase",
					bind: "return",
					// Only the server's commands answer with no model, and the server cannot stop a
					// prompt it was sent, so a phrase becomes its command before Enter submits it. A
					// handoff reaches the server with no key pressed and never comes through here.
					run: () => {
						const input = ctx.renderer.currentFocusedRenderable as any;
						const said = PHRASE.exec(String(input?.plainText ?? "").trim().toLowerCase());
						const verb = said?.[1] ?? said?.[2];
						if (verb && prompt?.mode !== "shell" && (!said?.[3] || verb === "connect")) {
							input.setText(`/blixel:${verb}${said?.[3] ? ` ${said[3]}` : ""}`);
						}
						return false;
					},
				},
			],
		}));
	},
});
