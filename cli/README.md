# wabctl: Lohra Control CLI

`wabctl` (symlinked in `~/.local/bin`) talks to Lohra over a private Unix socket (`data/agent/control.sock`, 0600). Built with Python standard library only, zero external dependencies.

## Universal Action Verification

**No mutating action ever executes autonomously.**

Whenever an action is triggered (via CLI, Gemini Live voice agent, or automated workflows), Lohra generates an **Action Proposal Card** delivered directly to the owner's WhatsApp chat:

- **👍 Approve & Execute**: Executes the proposed action immediately.
- **🙏 Details / Draft**: Drops full configuration parameters into the owner's chat without executing.
- **😢 Decline & Cancel**: Cancels the proposed action permanently.

Plain text replies (`yes`, `no`, `draft`) quoting or specifying the action ID are also supported. The CLI does not have an approve command by design; approval authority rests exclusively with the WhatsApp device owner.

---

## Capabilities & Subcommands

### 1. Groups (`wabctl groups ...`)
- `wabctl groups list`: List all groups participating in.
- `wabctl groups info <jid>`: View group metadata, admin roster, and settings.
- `wabctl groups kick <group> <member>`: Propose kicking a participant.
- `wabctl groups add <group> <member>`: Propose adding a participant.
- `wabctl groups promote <group> <member>`: Propose promoting to admin.
- `wabctl groups demote <group> <member>`: Propose demoting from admin.
- `wabctl groups subject <group> "Title"`: Propose updating group subject.
- `wabctl groups desc <group> "Description"`: Propose updating group description.
- `wabctl groups setting <group> <announcement|not_announcement|locked|unlocked>`: Propose group setting change.
- `wabctl groups invite <group>`: Get active invite link.
- `wabctl groups revoke <group>`: Propose revoking invite code.
- `wabctl groups tagall <group> [message]`: Propose tagging all group members.

### 2. Messages (`wabctl ...`)
- `wabctl send --to <contact> --text <message>`: Propose sending a message.
- `wabctl send --bulk --to <contact1,contact2> --text <message>`: Propose rate-limited broadcast.
- `wabctl draft --to <contact> --text <message>`: Save draft message to owner chat.
- `wabctl call propose_message_action '{"action":"edit","chat":"...","message_id":"...","text":"..."}'`
- `wabctl call propose_message_action '{"action":"delete","chat":"...","message_id":"..."}'`
- `wabctl call propose_message_action '{"action":"pin","chat":"...","message_id":"...","duration_hours":24}'`
- `wabctl call propose_message_action '{"action":"react","chat":"...","message_id":"...","text":"👍"}'`
- `wabctl call propose_message_action '{"action":"poll","chat":"...","text":"Question","options":["A","B"]}'`

### 3. Chats (`wabctl chats ...`)
- `wabctl chats list [--limit 20]`: List recent conversations.
- `wabctl chats mute <chat> [--hours 8]`: Propose muting chat (8h, 24h, 168h).
- `wabctl chats unmute <chat>`: Propose unmuting chat.
- `wabctl chats archive <chat>`: Propose archiving chat.
- `wabctl chats unarchive <chat>`: Propose unarchiving chat.
- `wabctl chats clear <chat>`: Propose clearing chat message history.

### 4. Contacts & Privacy (`wabctl contacts ...`)
- `wabctl contacts list`: List all configured contacts.
- `wabctl contacts find <query>`: Fuzzy/exact search contacts.
- `wabctl contacts add <name> <number> [--alias a] [--note n]`: Propose adding contact.
- `wabctl contacts remove <name>`: Propose removing contact.
- `wabctl contacts block <contact>`: Propose blocking number.
- `wabctl contacts unblock <contact>`: Propose unblocking number.
- `wabctl contacts check <number>`: Check if phone number is registered on WhatsApp.
- `wabctl contacts blocklist`: List all currently blocked contacts.

### 5. Status Stories & Profile (`wabctl status ...`, `wabctl profile ...`)
- `wabctl status post --text "Update" [--color "#128C7E"]`: Propose posting WhatsApp status story.
- `wabctl profile bio "Available for consultations"`: Propose updating WhatsApp About/Bio.
- `wabctl profile name "Lohra"`: Propose updating WhatsApp display name.

### 6. Archival Search & Event-Driven Watches
- `wabctl messages find --contact <name> [--kind voice|text|image] [--query q]`: Search saved chats.
- `wabctl messages send <id>`: Deliver saved message to owner chat.
- `wabctl watch add <contact> --kind message|status [--condition c]`: Real-time event monitoring.
- `wabctl watch list`: List active watches.
- `wabctl watch cancel <id>`: Cancel active watch.

---

## Agent Tools (Gemini Live Integration)

Run `wabctl tools` to dump all 27 function declarations in JSON format.
Run `wabctl prompt` to inspect the assistant system guidelines.
Run `wabctl call <tool_name> '<json_arguments>'` to execute tool dispatches directly.

Exit Codes:
- `0`: Success / Approved & Executed
- `2`: Invalid CLI arguments or usage
- `3`: WhatsApp bot offline or socket unreachable
- `4`: Action rejected or validation failure
- `10`: Proposal declined by owner (`😢`)
- `11`: Proposal expired
- `12`: Action execution failed
- `13`: Proposal cancelled by owner
- `124`: Awaiting owner reaction (timeout exceeded)

---

## WhatsApp Owner Commands

From the owner chat:
- `Lohra agent`: View channel status and pending proposals.
- `Lohra agent yes [id]`: Approve and execute pending proposal.
- `Lohra agent draft [id]`: Deliver details / draft to owner chat.
- `Lohra agent no [id]`: Decline and cancel pending proposal.
- `Lohra agent pause`: Emergency kill-switch (cancels pending, blocks new proposals).
- `Lohra agent resume`: Re-enables proposal processing.
- `Lohra guide [topic]`: Interactive manual with detailed feature documentation.
