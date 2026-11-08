# Blixel for coding agents — agent rules

## Tests

- Tests never drive a real agent harness: Claude Code, Codex, OpenCode, pi or
  Hermes. They run plugin code in-process against fakes of the agent's plugin API
  and a stand-in `blixel`, so results depend only on this repository.
- Behaviour only a real agent shows is a manual check before a release, listed in
  README under "Releasing".
