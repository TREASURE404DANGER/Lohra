// The built-in manual behind "Lohra guide" (plain language) and "Lohra guide dev" (technical). Not a plugin (leading underscore).
// ONE source for both audiences: every topic has a `user` text (simple, optional) and a `dev` text (how and why it works).
// Honesty check: every registered command must appear in some topic's `commands`. test/guide.test.js checks the source files,
// and "Lohra guide dev check" checks the commands that are actually loaded right now.
// "{p}" in a text is replaced by the real command prefix (e.g. "Lohra ").

export const TOPICS = [
  {
    id: 'talk', aliases: ['agent', 'ai', 'assistant', 'natural'], commands: ['command', 'cmd', 'do'],
    title: 'Tell me what to do',
    user: {
      summary: 'Say what you want in plain English',
      body: `*Tell me what to do*
Type {p}command and then what you want. Or just say it in a voice note: I work out whether it is an instruction or something to write down. End it with "this is a command" to be sure I act, or "this is not a command" to get the text.

*I can*
• Message someone (I ask you to approve first, nothing is sent behind your back)
• Send one message to several people, or everyone (one approval, then I send them one by one)
• Write a draft in your own chat
• Show someone's latest status
• Watch someone and tell you about their new statuses or messages
• Show or stop your watches

*Examples*
• {p}command tell Thomas I'll be 15 minutes late
• {p}command send happy new month to everyone
• {p}command keep an eye on Precious's status for memes
• {p}command what am I watching?
• {p}command stop watching Precious

*I can't* set reminders, alarms or timed jobs. Watching works the moment something new arrives; it doesn't run on a schedule.
If I didn't understand, I'll say what I can do instead.`,
    },
    dev: {
      summary: 'Natural-language agent (Gemini Live + tools)',
      body: `*Agent: natural-language commands*
*Entry points*: (1) a voice note: ending "this is a command" runs it, ending "this is not a command" transcribes it, neither = _intent.js detectCommand decides (voice.js) (2) {p}command <text> (agent.js). Both call Agent.runCommand, then _agentlive.js runAgentCommand: one Gemini 3.8 Live session, text in, function calls out, short reply back. Limits: 6 tool calls, 90 s.

*The model's whole world* is plugins/_agenttools.js: TOOL_DECLS (what it can do) and SYSTEM_PROMPT (how to read loose wording). A capability that isn't declared there does not exist for the agent. That is why "periodically check Precious's status" used to fall back to a one-time status fetch: there was no watch tool, and nothing told the model what to do with "periodically".

*Dispatch*: makeDispatch(agent) maps each tool to agent.handle({op}). wabctl uses the same ops over the control socket, so limits, approval and the pause switch apply identically.

*Adding a capability*
1. Add an op in agent.js handle()
2. Declare the tool + a dispatch line in _agenttools.js. Describe WHEN to use it and when NOT to
3. Put its cue words and one worked example in SYSTEM_PROMPT
4. Mirror it in cli/wabctl (TOOLS, PROMPT, GUIDE); add to STATE_TOOLS if it changes state
5. Run test/agenttools.test.js
6. Try 5-6 loosely worded phrasings against the real model (see {p}guide dev ops)

*Safety*: send_message only proposes. commandReply() rewrites any "sent" claim that has no hedge. Text from contacts is untrusted data.`,
    },
  },
  {
    id: 'watch', aliases: ['monitor', 'alert', 'notify'], commands: ['watch', 'monitor'],
    title: 'Watch someone',
    user: {
      summary: 'Get told when someone posts something you care about',
      body: `*Watch someone*
I tell you when a person posts a new status, or sends a message, that you care about. It lands in your own chat. They never know.

• {p}watch Precious next status that is a meme
• {p}watch Thomas every message about the meeting for 3 days
• {p}watch list
• {p}watch info <id>
• {p}watch cancel <id, name or all>

*Good to know*
• "periodically", "keep checking", "whenever", "every" = I keep going after a match. "next" or "once" = I stop after the first one.
• I react the moment something new arrives. I can't check on a clock like "every hour", I just watch the whole time.
• A watch lasts 7 days unless you say otherwise ("for 3 days"). Up to 25 at once.
• If a name is spelled oddly I'll ask "did you mean ...?"`,
    },
    dev: {
      summary: 'Event-driven watch engine + AI-written checks',
      body: `*Watch engine*: plugins/watch.js (command, parsing, did-you-mean), _watch.js (Watcher), _judge.js (Gemini REST). State: data/watch.

*Flow*: text, then parseRequest (Gemini REST, JSON schema) gives a spec {target, kind, condition, rubric, once, anywhere, ttlHours}. Then the contact is resolved (_contacts.js, did-you-mean on a miss). Then Watcher.add saves it.

*Why a rubric*: the model writes its own 3-6 sentence check once. Every new item is then judged against it (judgeItem): strict, unsure means no match, and confidence must reach WATCH_MIN_CONF (0.6).

*Event-driven, not polled*: Watcher.onUpsert runs on every messages.upsert (statuses arrive as status@broadcast). tick() every 30 s only expires watches and retries; the "cron loop" comment in _watch.js is just that housekeeping. There is no scheduler anywhere in this project.

*Limits*: 25 active, 150 AI checks per watch (WATCH_MAX_EVALS), ttl 1-720 h (default 168), 2 concurrent judge calls, duplicates rejected, media over 14 MB is judged on text only.

*Untrusted input*: cleanText() strips control/bidi characters and our delimiter tags; the model can only return JSON; the bot never executes what it says.

*Agent path*: ops watch.add / watch.list / watch.cancel (agent.js) build the rubric through the same parseRequest. Non-voice callers (wabctl) also get a note in the owner's chat, so a watch is never silent.

*Env*: GEMINI_API_KEY, WATCH_MODEL (gemini-3.5-flash-lite, fallback gemini-flash-lite-latest), WATCH_MIN_CONF, WATCH_MAX_EVALS.`,
    },
  },
  {
    id: 'lookback', aliases: ['archive', 'memory', 'history', 'chats'], commands: ['archive'],
    title: 'Look back at old messages',
    user: {
      summary: 'I remember recent chats so I can find a voice note or photo',
      body: `*Look back at old messages*
I keep a short memory of your chats, so you can say things like:
• "Check my chat with Precious and send me the last voice note"
• "Find the photo I sent Mary"
• "What did Thomas say about the meeting?"
Say it in a voice note (end with "this is a command" to be sure), or type {p}command <what you want>. Anything I find lands in your own chat. Nobody else is told.

*Good to know*
• I only remember messages I saw while connected, for 30 days. I can't read chats from before that.
• Photos, voice notes and files can only be fetched while WhatsApp still has them (usually a few weeks).
• {p}archive shows what I hold. {p}archive off stops saving, {p}archive clear deletes everything.`,
    },
    dev: {
      summary: 'Message archive + find_messages / deliver_to_owner tools',
      body: `*Why*: a linked device cannot ask WhatsApp for old chats, so look-back only works on messages the bot has seen.

*Code*: plugins/archive.js (plugin, command, event hooks) and _archive.js (Archive class, classify()). Files: data/archive/<chat>.jsonl (dir 0700) plus settings.json. Fed by messages.upsert and messaging-history.set.

*Record*: {id, chat, group, nums[], fromMe, name, ts, kind, text, seconds, mime, fileName, raw}. kind = text|voice|audio|image|video|document|sticker (reactions, calls, protocol ignored). Text is capped at 2000 chars. Media bytes are NOT stored: raw holds the message proto (BufferJSON, thumbnails stripped) so downloadMediaMessage can fetch it again from WhatsApp, which fails once the media expired (media_expired error).

*Identity*: 1:1 chats are matched by phone digits. LID chats are linked through remoteJidAlt or lidMapping (getPNForLID / getLIDForPN), the same way _watch.js does it.

*Retention*: ARCHIVE_DAYS (30) and ARCHIVE_MAX_PER_CHAT (2000), pruned on start and every 6 h. {p}archive off|on|clear (owner only).

*Agent path*: tools find_messages (ops msgs.find; deliver_newest=true also sends the newest match) and deliver_to_owner (msgs.send) in _agenttools.js, mirrored in cli/wabctl (messages find|send). Delivery goes only to the owner's own chat via the normal send queue; max 15 per hour; paused agent refuses; audited as msg_delivered.

*Honesty rule*: an empty result returns none_found with archive_since and a hint, so the agent says so plainly and offers watch_contact instead of guessing.`,
    },
  },
  {
    id: 'status', aliases: ['stories', 'story'], commands: ['story', 'stories', 'wastatus'],
    title: 'See a status now',
    user: {
      summary: "See someone's latest status right now",
      body: `*See a status now*
• {p}story Precious: I send you their latest status
• {p}story list: who posted recently

I can only show statuses that arrived while I was connected, and I keep them for 24 hours (up to 15 per person).
Want to hear about FUTURE statuses instead? Use a watch: {p}guide watch`,
    },
    dev: {
      summary: 'Status store: 24 h cache of statuses',
      body: `*Status store*: plugins/status.js (command "story"), _status.js (StatusStore). Data: data/statuses/index.json plus media/.

Statuses arrive live as status@broadcast events and are saved; nothing is fetched on demand, so only items seen while connected exist. Kept 24 h (STATUS_MAX_AGE_MS), 15 per contact. deliverLatest(name, contacts, selfJid) resolves the contact (did-you-mean if no match) and re-sends the newest item to the owner chat.

*Gotcha*: the built-in "{p}status <name>" forwards to "story" only in the newer src/builtin/core.js. The running image can lag the folder on disk (src/ is baked in), so "{p}story <name>" is the form that always works.

Agent tool: get_contact_status calls the same deliverLatest (op status.get). It is a ONE-TIME look; for future items the agent must use watch_contact.`,
    },
  },
  {
    id: 'contacts', aliases: ['contact', 'people', 'add'], commands: ['contact', 'contacts', 'add'],
    title: 'Contacts',
    user: {
      summary: 'Save the people I can work with',
      body: `*Contacts*
I only message, watch or fetch statuses for people you have saved.
• {p}add contact 0801234567 as Thomas alias Mr T
• {p}add contact +234... as Mum
• {p}contacts: show everyone
• {p}contact find Thomas
• {p}contact remove Thomas

Numbers starting with 0 get your country code added automatically.`,
    },
    dev: {
      summary: 'contacts.json, matching, country codes',
      body: `*Contacts*: data/contacts.json, parsed by _contacts.js (re-read on every request; edit by hand freely). Forms: "Thomas": "+234..." or {number, aliases[], note}; groups {jid: "...@g.us"}; keys starting "_" are ignored.

*Matching* (resolveRecipient): exact, alias, partial, then fuzzy. A raw number is accepted unless allowRawNumbers is false in data/agent/config.json. Fuzzy matches are shown with "matched from ..." so a wrong guess is visible.

*Sound-alikes* (_names.js) are only ever suggestions: they go through the did-you-mean step and nothing runs until you confirm. No AI is involved in name matching.

*Numbers*: DEFAULT_CC (234) is added to numbers that start with 0. The agent masks numbers in tool output (••••1234).

Commands: contact (aliases contacts, add) in agent.js: saveContact/deleteContact normalise numbers and write contacts.json.`,
    },
  },
  {
    id: 'pick', aliases: ['yes', 'no', 'didyoumean', 'dym'], commands: ['pick', 'yes', 'y', 'no', 'n', '1', '2', '3', '4', '5'],
    title: 'Answering "did you mean ...?"',
    user: {
      summary: 'Answer when I ask "did you mean ...?"',
      body: `*Did you mean ...?*
If a name doesn't match exactly, I ask instead of guessing:
• {p}yes: that's the one
• {p}no: cancel
• {p}1 / {p}2 / {p}3: pick from my list
• {p}pick <name>: narrow the list

Questions expire after 3 minutes and nothing happens until you answer.`,
    },
    dev: {
      summary: 'Shared did-you-mean step (didyoumean.js)',
      body: `*Did-you-mean*: plugins/didyoumean.js plus _names.js. Any plugin that looks up a person calls api.dym.offer(ctx, {query, ranked, list, onPick}); the answer commands (pick, yes, y, no, n, 1-5) resolve it. One pending question per chat, TTL 3 min, at most 5 options (3 shown).

*Ranking*: phonetic key plus spelling distance, never AI. A sound-alike is never auto-accepted, and an exact name that simply has no data (e.g. no status) is not treated as a mishearing.

*Why the bare words "yes" / "no" / digits are commands*: so you can answer with just "Lohra yes". They only act when a question is pending, otherwise they reply that nothing is waiting.

Used by: watch.js (target), status.js (story), agent contact lookups.`,
    },
  },
  {
    id: 'voice', aliases: ['transcribe', 'voicenote', 'audio'], commands: ['voice', 'transcribe', 'tr'],
    title: 'Voice notes',
    user: {
      summary: 'Send me a voice note, get the text back',
      body: `*Voice notes*
Send yourself a voice note and I reply with the text. Long ones are fine.
• I decide whether a note is an instruction or something to write down. If unsure, I write it down.
• End a note with "this is a command" and I always act on it. End with "this is not a command" and I always write it out (see {p}guide talk).
• {p}voice auto off: I only act when you say "this is a command".
• Reply to any voice note with {p}transcribe to read it.
• {p}voice status: see the settings
• {p}voice on or off
• {p}voice commands on or off`,
    },
    dev: {
      summary: 'Transcription pipeline + voice commands',
      body: `*Voice*: plugins/voice.js, _gemini.js (Live sessions), _audio.js (ffmpeg). No local fallback. State: data/voice.json.

*Pipeline*: your own voice note in your own chat, then download, ffmpeg to PCM, cut at quiet moments into pieces of at most about 5-7 min (a Gemini Live connection lives about 10 min), transcribe with gemini-3.5-transcribe-live at 2x pacing, optional polish with gemini-3.8-live (guarded by looksLikeCleanup/outputIsSafe), reply.

*Voice commands* (only your own, non-forwarded notes in your own chat): ends with exactly "this is a command" (parseVoiceCommand) = handed to the agent, no check. Ends with "this is not a command" (parseNotCommand) = transcript with the phrase dropped, no check. Neither = _intent.js detectCommand asks a small Gemini model (JSON, temperature 0, transcript passed as delimited data, needs isCommand and confidence >= 0.8); it is skipped (transcript) when the agent is paused or unavailable, the transcript is partial, over 120 words, looks like an injection, or "{p}voice auto off". Any error or doubt = transcript. An implicit command that fails before any step ran falls back to the transcript (see {p}guide dev talk). "{p}transcribe" never runs commands.

*Limits*: ignores notes older than 5 min (replay after downtime), 3 h max, 100 MB download guard, long transcripts go out in up to 3 messages or a .txt.

*Settings*: voice on|off, voice polish on|off, voice commands on|off. If Gemini fails, a circuit breaker pauses it for a while; the raw transcript is still sent when only the cleanup fails.`,
    },
  },
  {
    id: 'yoink', aliases: ['download', 'video', 'link'], commands: ['yoink', 'yoinks'],
    title: 'Save a video or song',
    user: {
      summary: 'Save a video or song from a link',
      body: `*Save a video or song*
• {p}yoink <link>: I send the video back
• {p}yoink mp3 <link>: audio only
• Or reply to a message that contains a link with {p}yoink

Works with most sites (YouTube, Instagram, TikTok, X and more). One at a time; very big files are refused.`,
    },
    dev: {
      summary: 'yt-dlp downloader with safety checks',
      body: `*Yoink*: plugins/yoink.js, yt-dlp binary in data/bin (copied from /usr/local/bin, self-updates daily; a corrupt update is rolled back).

*Safety*: assertPublicUrl blocks private/loopback addresses (SSRF), no shell (spawn with args), one queue with a cooldown per sender, process-group kill on dispose, temp files cleaned on start.

*Limits (env)*: YOINK_MAX_MB 95, YOINK_MAX_QUEUE 6, YOINK_CONCURRENCY 1, YOINK_TIMEOUT_S 420. Retry ladder on failure.

*Subcommands*: yoink status (yt-dlp version, queue), yoink update, "yoink mp3 <link>" for audio.`,
    },
  },
  {
    id: 'approve', aliases: ['approval', 'confirm', 'pause'], commands: ['agent'],
    title: 'Approving requests',
    user: {
      summary: 'Say yes or no when I ask to send something',
      body: `*Approving requests*
When I want to message someone for you, I put the request in your own chat. React to it:
• 👍 send it
• 🙏 save it as a draft in your chat (you edit and send)
• 😢 decline
Or reply yes, draft or no.

Nothing is sent until you answer. Requests expire after 10 minutes.
• {p}agent: see what's waiting
• {p}agent stop: end a message to many people that is currently being sent
• {p}agent pause: stop all requests (and cancel waiting ones)
• {p}agent resume`,
    },
    dev: {
      summary: 'Approval model, limits, audit log',
      body: `*Approval model*: agent.js. send proposes; a request is posted in the owner's chat; only a reaction or reply from the owner account decides (classifyEmoji/classifyWord in _contacts.js: 👍/yes/send/ok = send, 🙏/draft/edit = draft, 😢/no/cancel = decline). There is no approve command in wabctl by design. A decision applies once; late approval after expiry does nothing.

*Limits* (data/agent/config.json): ttlSec 600 (30-3600), maxPending 5, maxPerHour 20, maxText 4000, allowRawNumbers true, verifyNumbers true (checks the number is on WhatsApp first).

*State*: data/agent/state.json (pending survives restarts; interrupted sends are marked failed), audit.jsonl (full lifecycle), control.sock (0600).

*Kill switch*: "{p}agent pause" cancels everything waiting and refuses new requests, including new watches from the agent.

*Drafts* never leave the account: the text goes into the owner's own chat with a wa.me link.`,
    },
  },
  {
    id: 'broadcast', aliases: ['bulk', 'everyone', 'many', 'group-send', 'newmonth'], commands: [],
    title: 'Messaging many people',
    user: {
      summary: 'One message to several people or everyone',
      body: `*Messaging many people*
Say it like this, by voice or with {p}command:
• {p}command send happy new month to everyone
• {p}command message Ana, Ben and Chidi: the meeting is at 5
• {p}command tell everyone except Mum that I've changed my number

I put one request in your chat showing *every name*, the message and the pace. Nothing goes out until you react 👍. 🙏 gives you the text as a draft instead, 😢 cancels.

*After you approve*
• Messages go out one at a time, 2 seconds apart (say "5 seconds apart" to change it)
• I tell you when it starts and when it's done, and who didn't get it
• {p}agent stop ends it right away; people after that point don't get it
• Put {name} in the message to use each person's first name ("Hi {name}, happy new month!")

*Safety*
• Only people in your contact book, never groups unless you name one
• Up to 50 people per message and 150 a day
• The same text never goes to the same person twice in a day
• Numbers not on WhatsApp are skipped and listed
• Sending lots of messages quickly can get a WhatsApp number restricted. For bigger lists, ask for a longer pause.`,
    },
    dev: {
      summary: 'Broadcast engine: send_bulk, pacing, limits, restart safety',
      body: `*Broadcast*: agent.js #proposeBulk / #runBulk, pure helpers in _bulk.js. Tool: send_bulk (op send.bulk); wabctl has the same tool.

*Flow*: propose resolves names with the same matcher as send (any unclear name = ask, never guess), drops yourself, same-text-within-24h people and numbers WhatsApp says don't exist (one batched onWhatsApp), then posts ONE approval listing everyone. 👍/yes starts it. The loop sends one message at a time via api.send, saves state after each person, waits delaySec + up to 25% jitter (never shorter), and stops on {p}agent stop, {p}agent pause, a plugin reload, or 3 failures in a row.

*Limits* (data/agent/config.json): maxBulk 50, maxBulkPerDay 150, bulkDelaySec 2, bulkJitter 0.25, bulkFailStreak 3. One broadcast pending or running at a time. Pause range 1-60 s.

*Restart safety*: state.json keeps a status per person (queued/sent/failed/skipped). After a restart a running broadcast is marked failed with who got it; it is NEVER resumed automatically (that could double-send). The owner is told once. Audit: proposed, bulk_approved, bulk_done.

*Not included*: scheduling ("send at midnight"), pulling the phone's address book (a linked device only knows contacts.json), media broadcasts.`,
    },
  },
  {
    id: 'admin', aliases: ['health', 'help', 'reload', 'ping'], commands: ['ping', 'help', 'menu', 'status', 'plugins', 'reload', 'guide', 'howto', 'manual'],
    title: 'Checks and upkeep',
    user: {
      summary: 'Is it alive? Reload, quick list',
      body: `*Checks and upkeep*
• {p}ping: am I alive?
• {p}status: how I'm doing (connection, uptime)
• {p}help: quick list of every command
• {p}guide: this manual
• {p}plugins: what's installed
• {p}reload: apply plugin changes`,
    },
    dev: {
      summary: 'Built-in commands (core.js)',
      body: `*Built-ins*: src/builtin/core.js, baked into the image (not in the mounted plugins/ folder).
• ping: round trip from the message timestamp
• help (alias menu): one-line list of every command, grouped by plugin
• status: connection state, uptime, reconnects, plugin counts, memory (newer core.js also forwards "status <name>" to story)
• plugins: loaded plugins and any that failed to load
• reload: re-import plugins (also automatic on file change)
• guide (aliases howto, manual): this manual, from plugins/guide.js

*Why "help" and "guide" are separate*: the loader rejects duplicate command names, and "help" belongs to core. Folding them together means editing src/builtin/core.js and rebuilding the image.

*Health*: data/health.json plus the Docker healthcheck (docker ps shows "healthy").`,
    },
  },

  // ---------------------------------------------------------------- dev only
  {
    id: 'agents', aliases: ['wabctl', 'cli'], commands: [],
    title: 'Agents and wabctl',
    dev: {
      summary: 'How outside agents drive the bot',
      body: `*wabctl* (cli/wabctl, Python stdlib) talks to the bot over data/agent/control.sock (0600) into Agent.handle({op}). It is the same code path as voice and "{p}command".

*Start here*: wabctl guide (which tool for which request) · wabctl tools (function declarations) · wabctl prompt (system-prompt rules) · wabctl <command> --help.
Roles: WABCTL_ROLE=agent hides contact editing, log and doctor.

*Ops*: send, draft, get, list, cancel, notify, status, status.get, contacts.*, watch.add / watch.list / watch.cancel.

*Two prompts on purpose*: _agenttools.js SYSTEM_PROMPT (in-bot: no wait_for_action, the owner answers on the phone) and wabctl PROMPT (outside agents: with wait_for_action). Shared tool names must match; test/agenttools.test.js enforces it.

*Why agents misroute loose wording*: tools plus prompt are the agent's whole world. A tool nobody declared does not exist, and a word like "periodically" means nothing unless the prompt maps it to a tool. So write tool descriptions as "use when / do NOT use when", list cue words, give one worked example, and test phrasings against the real model.

*Exit codes*: 0 ok, 2 usage, 3 bot unreachable, 4 rejected, 10 declined, 11 expired, 12 failed, 13 cancelled, 124 still waiting.`,
    },
  },
  {
    id: 'arch', aliases: ['architecture', 'how', 'files'], commands: [],
    title: 'Architecture',
    dev: {
      summary: 'Containers, message path, data files',
      body: `*Container* lohra (node:lts-alpine, 512 MB, 0.5 CPU, restart unless-stopped). Mounts: ./data to /app/data (state), ./plugins to /app/plugins (live). *src/ and test/ are baked into the image*: editing plugins/ is live, editing src/ needs a rebuild.

*Message path*: Baileys socket (src/connection.js: backoff reconnect, atomic auth in data/auth) then Bot (src/bot.js) parses "{p}<command> <args>" (case-insensitive prefix, owner check) then PluginManager (src/plugins.js) then command.run(ctx). Plugins can also subscribe to raw events: on: {'messages.upsert': fn}.

*Loading*: builtin first, then plugins/*.js. Files starting "_" are helpers. Duplicate command names are an error. Reloads on file change; "{p}reload" forces it.

*Shared services on api*: send, conn, store, config, plugins, agent (Agent), watch (Watcher), status (StatusStore), dym (did-you-mean).

*Data (data/)*: auth/ (session), contacts.json, agent/ (state.json, audit.jsonl, control.sock, config.json), watch/, statuses/ (24 h), voice.json, health.json, bin/ (yt-dlp), cache/tmp.

*Sidecars*: none. The local speech-to-text and cleanup LLM were removed; Gemini is the only voice engine.`,
    },
  },
  {
    id: 'build', aliases: ['plugin', 'develop', 'extend'], commands: [],
    title: 'Writing a plugin',
    dev: {
      summary: 'Add your own command',
      body: `*Writing a plugin*: drop plugins/<name>.js with a default export (see plugins/_example.js). Files starting "_" are helpers, not plugins.

  export default {
    name, version, description,
    init: async (api) => {}, dispose: async () => {},
    on: { 'messages.upsert': (data) => {} },
    commands: { mycmd: { aliases: [], description: '...', ownerOnly: true,
                run: async (ctx) => { await ctx.reply('hi'); } } },
  }

*ctx*: reply, react, args, argText, command, prefix, jid, sender, isOwner, msg, api.

*Rules*: command names and aliases must be unique across ALL plugins (a duplicate fails that plugin's load). Use ownerOnly: true unless public is intended. Never run code taken from message text. Keep state under api.config.dataDir with atomic writes.

*Keep the manual honest*: add the command to a topic in plugins/_guide.js; "{p}guide dev check" lists anything undocumented.

*Want the agent to use it?* Add an op in agent.js, a tool in _agenttools.js and cli/wabctl, and cue words in the prompts (see {p}guide dev agents).`,
    },
  },
  {
    id: 'config', aliases: ['env', 'settings', 'limits'], commands: [],
    title: 'Configuration',
    dev: {
      summary: '.env variables and limits',
      body: `*.env*: PHONE_NUMBER (pairing), PREFIX (Lohra), ALLOWED (extra owner numbers), PUBLIC, DEFAULT_CC (234), LOG_LEVEL, DATA_DIR, PLUGINS_DIR.
*Gemini*: GEMINI_API_KEY (voice, {p}command and watch need it), GEMINI_STT_SPEEDUP, GEMINI_STT_LANG, POLISH, WATCH_MODEL, WATCH_MIN_CONF (0.6), WATCH_MAX_EVALS (150).
*Yoink*: YOINK_MAX_MB (95), YOINK_MAX_QUEUE (6), YOINK_CONCURRENCY (1), YOINK_TIMEOUT_S (420).
*Other*: FFMPEG_PATH.
*Agent limits*: data/agent/config.json (ttlSec, maxPending, maxPerHour, allowRawNumbers, defaultCountryCode, verifyNumbers). *Contacts*: data/contacts.json.
Changing .env needs a container restart; plugin files do not.`,
    },
  },
  {
    id: 'ops', aliases: ['debug', 'test', 'tests', 'deploy', 'logs'], commands: [],
    title: 'Run, test, debug',
    dev: {
      summary: 'Logs, restarts, tests, prompt testing',
      body: `*Logs*: docker logs -f lohra. *Health*: docker ps (healthy), data/health.json.
*Restart*: docker compose restart lohra (in ~/projects/lohra). After editing src/: docker compose up -d --build lohra.

*Tests*: run them against the files on disk, not the baked-in copies:
  docker run --rm --entrypoint node -v $PWD/plugins:/app/plugins:ro -v $PWD/test:/app/test:ro -v $PWD/src:/app/src:ro -e DATA_DIR=/tmp/d lohra:latest --test "test/*.test.js" plugins/_didyoumean.test.js plugins/_watch.test.js

*Drift*: the image's src/ and test/ can lag the folder. Running tests inside the live container mixes old tests with new plugins and fails for no real reason. Compare md5sums before trusting a failure.

*Testing prompts*: call runAgentCommand (plugins/_agentlive.js) with TOOL_DECLS, SYSTEM_PROMPT and a fake dispatch that records calls, using the real GEMINI_API_KEY. It shows exactly which tool a phrasing triggers.

*Agent CLI*: wabctl bot | pending | log --tail 20 | doctor.
*Backups*: data/ is all the state; copy data/auth before risky changes.`,
    },
  },
];

const norm = (s) => String(s ?? '').toLowerCase().trim();
const fill = (t, p) => String(t).replaceAll('{p}', p);

export const audienceOf = (word) => (/^(dev|developer|tech|technical)$/i.test(word || '') ? 'dev' : 'user');
const visible = (audience) => TOPICS.filter((t) => t[audience]);

/** topic by id, alias or command name; falls back to a prefix/substring match. Dev-only topics are invisible to the user audience. */
export function find(query, audience = 'user') {
  const q = norm(query);
  if (!q) return null;
  const list = visible(audience);
  return list.find((t) => t.id === q)
    || list.find((t) => t.aliases.includes(q))
    || list.find((t) => t.commands.includes(q))
    || list.find((t) => t.id.startsWith(q) || t.title.toLowerCase().includes(q) || t[audience].summary.toLowerCase().includes(q))
    || null;
}

export function menu(audience, p) {
  const list = visible(audience);
  const lines = list.map((t) => `• *${t.id}*: ${t[audience].summary}`);
  if (audience === 'dev') {
    return fill(`*Lohra technical manual*
How each part works and why. Open a topic with {p}guide dev <topic>.

${lines.join('\n')}

{p}guide dev check: list loaded commands the manual doesn't cover
{p}guide: the simple version`, p);
  }
  return fill(`*What I can do*
Say it your way: I understand plain English. Open a topic with {p}guide <topic>.

${lines.join('\n')}

Quick command list: {p}help
Technical version: {p}guide dev`, p);
}

export const topicText = (topic, audience, p) => fill(topic[audience].body, p);

/** split on blank lines so each WhatsApp message stays comfortable to read */
export function chunk(text, max = 3000) {
  const out = [];
  let cur = '';
  for (const para of String(text).split('\n\n')) {
    if (cur && cur.length + para.length + 2 > max) { out.push(cur); cur = para; } else cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) out.push(cur);
  return out;
}

/** which of the given command names (and aliases) no topic mentions */
export function missingFrom(names) {
  const known = new Set(TOPICS.flatMap((t) => t.commands));
  return [...new Set(names.map(norm))].filter((n) => n && !known.has(n)).sort();
}
