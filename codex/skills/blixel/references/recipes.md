# Recipes

`$MEETING_ID` is `meeting_id` from `blixel room current`, read fresh each time.

## Summarise a call

1. Find it. Use `room current` → `transcription.transcript_id` for the call in
   progress, or `transcript list` to match `room_name` and `started_at` for a past
   call.
2. `blixel transcript export <id> --format md`. This is the whole transcript as
   of now in one read.
3. Summarise: decisions, action items with owners, open questions. Attribute by
   `speaker_name`, and say where `gap` or `paused` stretches left holes.
4. If the person wants it in the call's chat, show the text, get a yes, then
   `chat send` with a fresh `uuidgen` request id. Check that `room current` still
   shows the same `meeting_id` first.

## Find what was said about something

`blixel transcript search "every word"` across all transcripts, newest first.
Each hit has `transcript_id` and `offset_ms`. For context around a hit,
`transcript read <transcript_id>` and page to the nearby `offset_ms`. Quote
`speaker_name` and the time (`at`).

## Watch a live call

```sh
blixel transcript follow --current > /tmp/blixel-follow.jsonl 2>/tmp/blixel-follow.err &
```

Read the file as it grows. Each line is a record with a numeric `id`, so track
the last one handled. If the watcher is restarted, use
`follow <transcript_id> --after <last id>` rather than `--current`, which would
pick whatever call is live by then. It exits by itself after `ended`. Stop it
with SIGINT when no longer needed.

## Catch up on the chat

1. `blixel room current` for `meeting_id`.
2. `blixel chat read --meeting-id "$MEETING_ID"` and summarise `messages` by
   `sender_name`. If `evicted_count` is above 0, say the oldest messages are no
   longer kept.
3. Keep the last `sequence`. Next time, `chat read --after <sequence>` returns only
   what is new; after `cursor_expired`, read again without `--after`.

To keep watching, `blixel chat follow --meeting-id "$MEETING_ID" > /tmp/blixel-chat.jsonl 2>/tmp/blixel-chat.err &`
and read the file as it grows. It stops by itself when the call ends.

## Share a window

1. `blixel window list --meeting-id "$MEETING_ID"`.
2. Match the person's description against `app` and `title`. If several match
   or none do, show the candidates and ask.
3. `blixel window share <handle> --meeting-id "$MEETING_ID"` → `started` or
   `already_sharing`.
4. Confirm with `window status`: `publication: "live"` means others are seeing it.

To stop everything shared, take `shares` from `window status` and run
`window unshare` for each handle.

## Notice when someone joins

1. Get their `participant_identity`: their `speaker_identity` in a transcript is
   the same value, as is the identity on a `participant.joined` seen for them
   before.
2. `blixel event watch --type participant.joined > /tmp/blixel-events.jsonl 2>/tmp/blixel-events.err &`
   and read lines as they arrive; the first is `watching`.
3. When `data.participant_identity` matches, tell the person. Stop the watch with
   SIGINT when done.

## Who is in a room

`blixel room list` → find the room by `name` → `blixel room presence <id>`.
Report the names and the `observed_at` time. If no one is listed, say the server
reports no one, not that the room is empty.

## Make a room and hand out its link

1. Check `blixel room list` for a room with that name already. Names aren't
   unique, so ask before making a second one.
2. `blixel room create "<name>"`, with `--policy allowlist` if only admitted
   people should get in. Keep `id` from the result.
3. `blixel room invite <id>` → give the person `url`. Post it somewhere else only
   if they ask: anyone holding it can ask to join.

The CLI can't join the room. The person opens the link, or picks the room in the
app.

## Switch servers

`blixel connection list` shows each connection's `name`, `server` and `active`.
Use `--connection <name>` for one command, or `blixel connection use <name>` to
change the default (a local change, but tell the person).

## Run something when a call's transcript ends

1. Agree on the script with the person, for example `~/bin/blixel-notes.sh`:

   ```sh
   #!/bin/zsh
   mkdir -p ~/Notes/Blixel
   blixel transcript export "$BLIXEL_TRANSCRIPT_ID" --format md > ~/Notes/Blixel/"$BLIXEL_TRANSCRIPT_ID".md
   ```

   Make it executable. For one room only, get its id from `blixel room list`.
2. With their yes:
   `blixel hook add notes --type transcript.ended [--room <room-id>] --command ~/bin/blixel-notes.sh`
3. With Blixel open, `blixel hook test notes --wait` runs it on the newest ended
   transcript. Check `result`; if it isn't `ok`, read the `log` file.

Hooks run only while Blixel is open. The person can also manage them in
Settings › Hooks.
