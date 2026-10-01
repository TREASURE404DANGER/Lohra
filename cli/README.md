# wabctl: agent control CLI

`wabctl` (symlinked in ~/.local/bin) talks to the bot over a private unix socket (`data/agent/control.sock`, 0600). Python stdlib only, no Docker needed.

Agents only PROPOSE. Sending needs the owner's reaction on WhatsApp: 👍 send now, ✍️ drop as draft in your own chat (with a wa.me link), 👎 decline. You can also reply yes / draft / no to the request. There is no approve command in the CLI by design.

## Agent tools (Gemini Live)
    wabctl tools            # function declarations, paste into the Live session setup
    wabctl prompt           # recommended system-prompt rules
    wabctl call <tool> '{json}'   # run a tool call, always prints JSON
Tools: send_message, draft_message, check_action, wait_for_action, cancel_action, list_pending, find_contact, list_contacts, notify_owner, bot_status.
Run the agent with `WABCTL_ROLE=agent` to lock out contact editing, logs and doctor.

## Direct use
    wabctl send --to Thomas --text "running late" [--wait 120] [--ttl 600]
    wabctl draft --to Thomas --text -        # text from stdin
    wabctl check|wait|cancel <id>;  wabctl pending;  wabctl bot
    wabctl contacts list|find NAME|add NAME NUMBER [--alias x] [--cc 234]|remove NAME|check
    wabctl log --tail 20;  wabctl doctor

Exit codes: 0 ok/approved, 2 usage, 3 bot unreachable, 4 rejected, 10 declined, 11 expired, 12 failed, 13 cancelled, 124 still waiting.

## Files (data/)
- contacts.json: edit freely, re-read on every request. `"Thomas": "+234..."` or `{ "number", "aliases": [], "note" }`, groups `{ "jid": "...@g.us" }`. Keys starting with _ are ignored.
- agent/config.json (optional): ttlSec, maxPending, maxPerHour, allowRawNumbers (false = contacts only), defaultCountryCode, verifyNumbers.
- agent/state.json, agent/audit.jsonl: pending requests (survive restarts) and the full history.

## WhatsApp side (owner only)
`Lohra agent` (status), `agent yes|draft|no [id]`, `agent pause|resume` (kill switch: cancels everything waiting and refuses new requests).
