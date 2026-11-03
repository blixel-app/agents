# Hermes

`blixel` here always means
`/Applications/Blixel.app/Contents/Resources/bin/blixel`, by that full path, or that path
under `~/Applications` if Blixel is there. Hermes sets `HERMES_SESSION_ID` for the
commands it runs, which names this session.

## Receiving

After `blixel agent connect` answers `"receiving": false`, run
`terminal(command="<full path>/blixel agent receive --print-handoffs --once", background=true)`.

When Hermes reports it finished with a handoff on its output, start it again first,
then act on the handoff as the user's own prompt. When it finished with nothing on
stdout, the connection ended: stop.

Use Hermes's TUI or desktop app: the classic CLI doesn't show those messages.
