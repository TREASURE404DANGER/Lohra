// Tool surface + rules for the in-bot agent (Gemini 3.8 Live), used by voice notes ending in "this is a command" AND by "Lohra command <text>".
// The model can only do what is listed here: if a capability is missing from TOOL_DECLS/SYSTEM_PROMPT it effectively does not exist for the agent.
// Keep in sync with TOOLS in cli/wabctl (test/agenttools.test.js checks the tool names match).
// No wait_for_action here: the owner answers on their phone, and the agent itself posts the outcome in the chat.
import { words } from './_gemini.js';

export const COMMAND_PHRASE = 'this is a command';
// the note must END with the phrase (trailing punctuation allowed); "this is a command" anywhere else does nothing
const PHRASE_END = /(?:^|[\s,.;:!?\-–—"'“”‘’(\[])this\s+is\s+a\s+command[\s.!?,;:…"'“”‘’)\]]*$/i;

/** -> null (not a command) | { command } where command is what was said before the phrase (may be empty). */
export function parseVoiceCommand(text) {
  const t = String(text ?? '').trim();
  const m = PHRASE_END.exec(t);
  if (!m) return null;
  const tail = words(t).slice(-4).join(' ');
  if (tail !== COMMAND_PHRASE) return null;
  return { command: t.slice(0, m.index).replace(/[\s,;:\-–—]+$/, '').trim() };
}

// "this is not a command" (or "this isn't a command") at the END forces a plain transcript and skips the command check
const NOT_END = /(?:^|[\s,.;:!?\-–—"'“”‘’(\[])this\s+(?:is\s+not|isn['’]?t|is\s+no)\s+(?:a\s+)?command[\s.!?,;:…"'“”‘’)\]]*$/i;

/** -> null (phrase not at the end) | { text } where text is what was said before the phrase (may be empty). */
export function parseNotCommand(text) {
  const t = String(text ?? '').trim();
  const m = NOT_END.exec(t);
  return m ? { text: t.slice(0, m.index).replace(/[\s,;:\-–—]+$/, '').trim() } : null;
}

const str = (description) => ({ type: 'string', description });

export const TOOL_DECLS = [
  {
    name: 'send_message',
    description: "Ask the owner to send a WhatsApp text message to a saved contact or phone number. Nothing is sent yet: the owner gets a request in their own chat and answers with a reaction (👍 send now, 🙏 save as a draft, 😢 decline). Returns an action id with status 'pending'. Do not wait for the answer.",
    parameters: { type: 'object', properties: { to: str("Contact name as the owner said it (e.g. 'Thomas'), or a full phone number with country code."), text: str("The exact message to send, in the owner's voice.") }, required: ['to', 'text'] },
  },
  {
    name: 'draft_message',
    description: "Put a drafted message into the owner's own chat so they can edit and send it themselves. Nothing goes to the recipient. Use when the owner says draft, write or prepare.",
    parameters: { type: 'object', properties: { to: str('Contact name or full phone number.'), text: str('The draft text.') }, required: ['to', 'text'] },
  },
  {
    name: 'send_bulk',
    description: "Ask the owner to send ONE message to SEVERAL people: a list of contacts, or all contacts. Use for 'send X to everyone / all my contacts', 'message A, B and C', 'wish everyone happy new month'. Never for a single person (use send_message). Nothing is sent yet: the owner sees the full list and the text in their own chat and answers with a reaction (👍 send to all, 🙏 draft only, 😢 decline). After approval the messages go out one by one with a short pause, and the owner can stop it with 'Lohra agent stop'. Returns an action id with status 'pending'. Do not wait for the answer.",
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: "Contact names exactly as the owner said them. Leave out when the owner means everyone." },
        all_contacts: { type: 'boolean', description: "true when the owner means everyone / all my contacts / all of them." },
        except: { type: 'array', items: { type: 'string' }, description: "Names to leave out ('everyone except Mum')." },
        text: str("The exact message, in the owner's voice. Use {name} only if the owner asked for each person's name to be included."),
        delay_seconds: { type: 'integer', description: "Pause between messages in seconds, only if the owner named one. Default 2, range 1 to 60." },
      },
      required: ['text'],
    },
  },
  { name: 'check_action', description: 'Status of an earlier action: pending, sent, drafted, declined, expired, cancelled, executed or failed.', parameters: { type: 'object', properties: { id: str('Action id.') }, required: ['id'] } },
  { name: 'cancel_action', description: 'Cancel a request that is still pending, or stop a broadcast that is currently sending (people after the point of stopping do not get it).', parameters: { type: 'object', properties: { id: str('Action id.') }, required: ['id'] } },
  { name: 'list_pending', description: 'List requests waiting for the owner and the most recent finished ones.' },
  { name: 'find_contact', description: "Check who a spoken name refers to in the owner's contacts (handles nicknames and mishearings). Returns the match or candidates. Numbers are masked.", parameters: { type: 'object', properties: { query: str('The name as heard.') }, required: ['query'] } },
  { name: 'list_contacts', description: "List the names in the owner's contact book." },
  { name: 'notify_owner', description: "Post a short note in the owner's own chat.", parameters: { type: 'object', properties: { text: str('The note, max 1000 characters.') }, required: ['text'] } },
  { name: 'bot_status', description: 'Whether the bot is connected and whether agent actions are paused.' },
  {
    name: 'get_contact_status',
    description: "ONE-TIME look: fetch the status/story a contact has ALREADY posted (their latest) and send it to the owner now. Use for 'check X's status', 'get / download X's last status or meme', 'what did X post', 'show me X's story'. Do NOT use when the owner wants to hear about FUTURE or REPEATED updates (periodically, keep checking, whenever, as soon as): that is watch_contact.",
    parameters: {
      type: 'object',
      properties: {
        contact: str("The name of the contact as spoken (e.g. 'Precious', 'Thomas'), or their phone number."),
      },
      required: ['contact'],
    },
  },
  {
    name: 'watch_contact',
    description: "ONGOING monitoring: keep an eye on a contact and send the owner every NEW status or message that matches, with its media, in the owner's own chat. Nothing is ever sent to the contact. Use for ANY request about the future or repeating: periodically, regularly, from time to time, keep checking, keep an eye on, monitor, track, watch, whenever, every time, as soon as, when they post, let me know / tell me / alert me when or if. It reacts the moment something new arrives (it is not a clock or timer). Do NOT use for a one-time look at what was already posted: that is get_contact_status.",
    parameters: {
      type: 'object',
      properties: {
        contact: str("Contact name as the owner said it, or a full phone number."),
        kind: { type: 'string', enum: ['status', 'message'], description: "'status' for a status, story or update; 'message' for chat messages, texts or voice notes." },
        condition: str("Optional filter in a few words, such as 'is a meme' or 'mentions food'. Leave empty when any new item counts."),
        keep_watching: { type: 'boolean', description: 'true when the wording repeats or is open-ended (periodically, keep, every, whenever, any, all); false only for a single next item (the next one, once, as soon as).' },
        hours: { type: 'integer', description: "How long to keep watching, in hours. 'for 3 days' = 72, 'today' = 24, 'this week' = 168. Default 168 when not stated." },
      },
      required: ['contact', 'kind', 'keep_watching'],
    },
  },
  {
    name: 'find_messages',
    description: "LOOK BACK in the owner's saved WhatsApp chats. Use for 'the last voice note Precious sent', 'what did Thomas say about the meeting', 'find the photo I sent Mary', 'get / send me the last video from X', 'check my chat with X'. Read-only: nothing is sent to the contact. Newest first, each with an id. Set deliver_newest=true when the owner wants the item itself ('send it here', 'forward it', 'let me hear it'): the newest match is then sent to the owner's own chat in the same step. Only messages the bot saw while connected are saved (about 30 days): if nothing is found, say so plainly and offer watch_contact for future ones. Do NOT use for statuses/stories (that is get_contact_status) or for things that have not happened yet (watch_contact).",
    parameters: {
      type: 'object',
      properties: {
        contact: str("The person (or group) whose chat to search, as the owner said it (e.g. 'Precious'), or a full phone number."),
        kind: { type: 'string', enum: ['any', 'text', 'voice', 'image', 'video', 'document', 'sticker'], description: "'voice' = voice notes and audio, 'image' = photos/memes, 'video', 'document' = files, 'text' = written messages. Default any." },
        from: { type: 'string', enum: ['any', 'them', 'me'], description: "'them' = sent by the contact, 'me' = sent by the owner. Default any." },
        query: str('Optional words the message must contain (text or caption), e.g. a topic. Leave empty to just take the latest.'),
        limit: { type: 'integer', description: 'How many to list, 1-10 (default 5).' },
        hours: { type: 'integer', description: "Only messages from the last N hours ('today' = 24, 'this week' = 168). Leave out for all saved." },
        deliver_newest: { type: 'boolean', description: "true = also send the newest match to the owner's own chat (voice notes arrive as voice notes, photos as photos)." },
      },
      required: ['contact'],
    },
  },
  {
    name: 'deliver_to_owner',
    description: "Send ONE saved message found with find_messages (voice note, photo, video, file or text) to the owner's own chat. Use when the owner picks a different one than the newest. It never goes to the contact.",
    parameters: { type: 'object', properties: { id: str('The message id from find_messages.') }, required: ['id'] },
  },
  { name: 'list_watches', description: "List the owner's active watches (who, what, how long left) and the last few finished ones." },
  { name: 'cancel_watch', description: "Stop a watch so it no longer reports new items. Use for 'stop watching X', 'cancel that', 'forget it'; pass the id, the contact name, or 'all'.", parameters: { type: 'object', properties: { id: str("The watch id from watch_contact or list_watches, a contact name, or 'all'.") }, required: ['id'] } },
  {
    name: 'group_info',
    description: "Fetch metadata for a WhatsApp group: subject, description, admin list, and member count. Use to check group details or admin status before proposing actions.",
    parameters: {
      type: 'object',
      properties: {
        group: str("Group name or group JID (e.g. '120363...@g.us')."),
      },
      required: ['group'],
    },
  },
  {
    name: 'list_groups',
    description: "List all WhatsApp groups the bot is currently participating in, with their names and member counts.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_chats',
    description: "List recent active WhatsApp chats and unread message counts from the bot's session.",
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Maximum number of chats to list (1-50, default 10).' },
      },
    },
  },
  {
    name: 'check_on_whatsapp',
    description: "Check if a phone number is registered on WhatsApp before proposing to message or add them.",
    parameters: {
      type: 'object',
      properties: {
        number: str('The phone number with country code to check.'),
      },
      required: ['number'],
    },
  },
  {
    name: 'inspect_manual',
    description: "Query documentation on Lohra CLI capabilities, commands, and options when brainstorming how to fulfill a complex request.",
    parameters: {
      type: 'object',
      properties: {
        topic: str("Topic to inspect: 'groups', 'messages', 'chats', 'contacts', 'status', 'profile', 'watches', or 'all'."),
      },
    },
  },
  {
    name: 'propose_group_action',
    description: "Propose an action on a WhatsApp group: kick, add, promote, demote, subject, description, setting, revoke_invite, or tagall. Nothing happens immediately: the owner receives an Approval Card in their chat and must react 👍 to execute, 🙏 for details, or 😢 to decline. Never claim the action was done.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['kick', 'add', 'promote', 'demote', 'subject', 'description', 'setting', 'revoke_invite', 'tagall'], description: 'The group action to perform.' },
        group: str('Group name or JID.'),
        member: str('Contact name or phone number of the target member (for kick, add, promote, demote).'),
        text: str('New text for subject, description, or tagall message.'),
        setting: { type: 'string', enum: ['announcement', 'not_announcement', 'locked', 'unlocked'], description: 'Setting to update.' },
      },
      required: ['action', 'group'],
    },
  },
  {
    name: 'propose_message_action',
    description: "Propose an action on a message: edit a sent message, delete for everyone, pin, react with emoji, create a group poll, or star/unstar. Nothing happens immediately: the owner receives an Approval Card in their chat and must react 👍 to execute, 🙏 for details, or 😢 to decline. Never claim the action was done.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['edit', 'delete', 'pin', 'react', 'poll', 'star'], description: 'The message action to perform.' },
        chat: str('Contact name, phone number, or group JID where the message is.'),
        message_id: str('The message ID from find_messages or recent chat.'),
        text: str('New text (for edit), emoji (for react), or poll question (for poll).'),
        options: { type: 'array', items: { type: 'string' }, description: 'Options for poll (at least 2).' },
        duration_hours: { type: 'integer', description: 'Duration in hours for pin (e.g. 24, 168). 0 to unpin.' },
      },
      required: ['action', 'chat'],
    },
  },
  {
    name: 'propose_chat_action',
    description: "Propose an action on a chat: mute notifications, unmute, archive, unarchive, or clear messages. Nothing happens immediately: the owner receives an Approval Card in their chat and must react 👍 to execute, 🙏 for details, or 😢 to decline. Never claim the action was done.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['mute', 'unmute', 'archive', 'unarchive', 'clear'], description: 'The chat action to perform.' },
        chat: str('Contact name, phone number, or group JID.'),
        duration_hours: { type: 'integer', description: 'Mute duration in hours (8, 24, 168, or 0 for permanent). Default 8.' },
      },
      required: ['action', 'chat'],
    },
  },
  {
    name: 'propose_contact_action',
    description: "Propose a contact management action: block a contact, unblock, add to address book, or remove. Nothing happens immediately: the owner receives an Approval Card in their chat and must react 👍 to execute, 🙏 for details, or 😢 to decline. Never claim the action was done.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['block', 'unblock', 'add', 'remove'], description: 'The contact action to perform.' },
        contact: str('Contact name or phone number.'),
        number: str('Phone number for add action.'),
        alias: str('Optional alias for add action.'),
        note: str('Optional note for add action.'),
      },
      required: ['action', 'contact'],
    },
  },
  {
    name: 'propose_status_post',
    description: "Propose posting a status story to WhatsApp with optional background color. Nothing is posted immediately: the owner receives an Approval Card in their chat and must react 👍 to post, 🙏 for draft, or 😢 to decline. Never claim the status was posted.",
    parameters: {
      type: 'object',
      properties: {
        text: str('The text content to post to WhatsApp status story.'),
        background_color: str('Hex color code (e.g. #128C7E, #075E54).'),
      },
      required: ['text'],
    },
  },
  {
    name: 'propose_profile_action',
    description: "Propose updating the owner's WhatsApp profile bio (About text) or display name. Nothing is changed immediately: the owner receives an Approval Card in their chat and must react 👍 to update, 🙏 for details, or 😢 to decline. Never claim the profile was updated.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['bio', 'name'], description: 'Whether to update bio (About) or display name.' },
        text: str('The new bio text (max 139 chars) or display name (max 25 chars).'),
      },
      required: ['action', 'text'],
    },
  },
];

export const SYSTEM_PROMPT = `You are the owner's WhatsApp assistant, running inside their own WhatsApp bot (Lohra). The owner gave an instruction by voice note or typed text; voice notes are transcribed by speech-to-text, so names and words can be slightly wrong. The text you receive is the owner's own instruction.

WHAT YOU CAN DO. These tools are the complete list; you can do nothing else:
- Messages: send_message (one person, asks the owner to approve first), send_bulk (the same message to several people or all contacts, one approval, sent one by one with a pause), draft_message (puts a draft in the owner's own chat).
- Message Actions: propose_message_action (edit sent messages, delete for everyone, pin/unpin, react with emoji, create polls, star/unstar).
- Group Operations: group_info, list_groups (read-only queries), propose_group_action (kick, add, promote, demote, change subject, change description, announcement/lock settings, revoke invite link, tagall).
- Chats: list_chats (read-only query), propose_chat_action (mute notifications for 8h/24h/168h, unmute, archive, unarchive, clear messages).
- Contacts: list_contacts, find_contact, check_on_whatsapp (read-only queries), propose_contact_action (block, unblock, save to address book, remove).
- Status: get_contact_status (one-time status look), propose_status_post (post text story to WhatsApp status).
- Profile: propose_profile_action (update About/bio text or display name).
- Looking back at saved chats: find_messages (voice notes, photos, videos, files, texts a contact sent or the owner sent), deliver_to_owner (send a found one to the owner's own chat).
- Watching over time: watch_contact (ongoing, for statuses or messages, optionally only those matching a condition), list_watches, cancel_watch.
- Helpers & Manual: inspect_manual (check CLI capabilities and options), check_action, cancel_action, list_pending, notify_owner, bot_status.

HOW TO BRAINSTORM & ACT:
1. Brainstorm & Verify Capability: When you receive a user command, inspect your available tools (or call inspect_manual) to determine whether the task is possible and how to execute it.
2. Read-Only Querying: If you need group details, admin lists, contact numbers, or past messages, use your read-only query tools (find_contact, group_info, list_groups, list_chats, find_messages, check_on_whatsapp) to gather context first.
3. Propose Mutating Actions: Any operation that changes state (sending messages, modifying groups, editing/deleting messages, muting/archiving chats, blocking contacts, posting status stories, modifying profile) MUST be proposed via proposal tools (send_message, send_bulk, propose_group_action, propose_message_action, propose_chat_action, propose_contact_action, propose_status_post, propose_profile_action).
4. Universal Verification: Every proposed action sends an Approval Card to the owner's WhatsApp. The action is NEVER executed immediately. The owner must react 👍 to approve and execute, 🙏 for draft/details, or 😢 to decline.
5. Invariable Guardrail: NEVER claim an action has already been performed before owner reaction verification. Always tell the owner what was proposed and remind them to react 👍 on WhatsApp to confirm.

HOW TO READ LOOSE WORDING:
- "check X's status", "get / download X's last status or meme", "what did X post", "show me X's story" = one look at what is ALREADY there: get_contact_status.
- Anything about the FUTURE or REPEATING is watch_contact, never get_contact_status. Cue words: periodically, regularly, from time to time, keep checking, keep an eye on, monitor, track, watch, whenever, every time, any time, as soon as, when X posts, let me know / tell me / alert me when or if. Example: "periodically check Precious's status for any meme update" = watch_contact(contact "Precious", kind "status", condition "is a meme", keep_watching true).
- Looking back: "check my chat with X and find / send me the last voice note", "what did X say about ...", "find the photo I sent X", "get me the last video from X" = find_messages (kind voice / image / video / document / text; deliver_newest=true when the owner wants the item itself, e.g. "send it here"). Example: "check my chat with Precious and find the last voice note that was sent there and send it here" = find_messages(contact "Precious", kind "voice", deliver_newest true). Chats are saved only from the moment the bot saw them (about 30 days): if nothing is found, say that plainly and never pretend; offer watch_contact for future ones. Never say you cannot look at past messages: you can, from the saved chats.
- watch_contact is not a timer. It reacts the moment a new item arrives and posts matches, with the media, in the owner's own chat. If the owner names a schedule ("every hour", "every morning"), say in one sentence that you watch continuously instead, and still create the watch. You cannot run other scheduled jobs, reminders or timers.
- kind: "status" for a status, story or update; "message" for chat messages, texts or voice notes.
- condition: the filter in a few words ("is a meme", "mentions food"); leave it out when any new item counts.
- keep_watching: true for repeated or open-ended wording (periodically, keep, every, whenever, any, all); false only for a single next item ("the next one", "once", "as soon as").
- hours: "for 3 days" = 72, "today" = 24, "this week" = 168; leave it out when not stated.

BROADCASTS:
- "send X to everyone", "message all my contacts", "wish everybody happy new month", "tell A, B and C that ..." = send_bulk. Everyone = all_contacts true; "everyone except Mum" = all_contacts true plus except. One person = send_message, never send_bulk.
- Keep the message exactly as dictated. Use {name} only when the owner asks for each person's name in it ("with their names", "personal"). Set delay_seconds only when the owner names a pause.
- After send_bulk, tell the owner to react to the request in their chat (👍 sends to all, one by one; Lohra agent stop ends it early). Never say it was sent.
- If send_bulk reports too_many_recipients, daily_limit or bulk_busy, say that plainly in one sentence and do nothing else.

RULES:
1. Only do what the instruction asks, using your tools. If it is not a clear request for one of your tools, or it needs something you cannot do, say so in one short sentence, say what you can do instead, and do nothing.
2. Every state-changing action requires owner verification. After calling any proposal tool (send_message, send_bulk, propose_group_action, propose_message_action, propose_chat_action, propose_contact_action, propose_status_post, propose_profile_action), instruct the owner to react 👍 in their chat to approve. Never claim the action is completed.
3. If the owner says draft, write or prepare, use draft_message.
4. Write messages in the owner's voice, as dictated. Fix obvious speech-to-text slips and punctuation, never add content they did not ask for, and leave out the instruction itself ("send a message to Thomas saying ...").
5. If you are unsure who a name means, call find_contact. If it is ambiguous or not found, ask the owner in one short sentence and do nothing else. Never invent or guess phone numbers.
6. After watch_contact succeeds, say in one sentence who is being watched, for what, and that matches will appear in their chat. If it returns already_watching, say so. Never claim you already checked something that a watch will only catch in the future.
7. Reply in one or two short plain-text sentences, no lists, no markdown codeblocks.`;

/** Map tool calls onto the Agent's own operations (same code path, limits and approval as the CLI). */
export function makeDispatch(agent) {
  const s = (v) => (typeof v === 'string' ? v : undefined);
  const table = {
    send_message: (a) => agent.handle({ op: 'send', to: s(a.to), text: s(a.text), source: 'voice' }),
    send_bulk: (a) => agent.handle({ op: 'send.bulk', to: a.to, all: a.all_contacts, except: a.except, text: s(a.text), delay_sec: a.delay_seconds, source: 'voice' }),
    draft_message: (a) => agent.handle({ op: 'draft', to: s(a.to), text: s(a.text), source: 'voice' }),
    check_action: (a) => agent.handle({ op: 'get', id: s(a.id) }),
    cancel_action: (a) => agent.handle({ op: 'cancel', id: s(a.id) }),
    list_pending: () => agent.handle({ op: 'list' }),
    find_contact: (a) => agent.handle({ op: 'contacts.find', query: s(a.query) }),
    list_contacts: () => agent.handle({ op: 'contacts.list' }),
    notify_owner: (a) => agent.handle({ op: 'notify', text: s(a.text) }),
    bot_status: () => agent.handle({ op: 'status' }),
    find_messages: (a) => agent.handle({ op: 'msgs.find', contact: s(a.contact), kind: s(a.kind), from: s(a.from), query: s(a.query), limit: a.limit, hours: a.hours, deliver_newest: a.deliver_newest, source: 'voice' }),
    deliver_to_owner: (a) => agent.handle({ op: 'msgs.send', id: s(a.id), source: 'voice' }),
    get_contact_status: (a) => agent.handle({ op: 'status.get', contact: s(a.contact) }),
    watch_contact: (a) => agent.handle({ op: 'watch.add', contact: s(a.contact), kind: s(a.kind), condition: s(a.condition), keep_watching: a.keep_watching, hours: a.hours, source: 'voice' }),
    list_watches: () => agent.handle({ op: 'watch.list' }),
    cancel_watch: (a) => agent.handle({ op: 'watch.cancel', id: s(a.id) }),
    group_info: (a) => agent.handle({ op: 'groups.info', group: s(a.group) }),
    list_groups: () => agent.handle({ op: 'groups.list' }),
    list_chats: (a) => agent.handle({ op: 'chats.list', limit: a.limit }),
    check_on_whatsapp: (a) => agent.handle({ op: 'contacts.check', number: s(a.number) }),
    inspect_manual: (a) => agent.handle({ op: 'manual.inspect', topic: s(a.topic) }),
    propose_group_action: (a) => agent.handle({ op: 'propose.group', action: s(a.action), group: s(a.group), member: s(a.member), text: s(a.text), setting: s(a.setting), source: 'voice' }),
    propose_message_action: (a) => agent.handle({ op: 'propose.message', action: s(a.action), chat: s(a.chat), message_id: s(a.message_id), text: s(a.text), options: a.options, duration_hours: a.duration_hours, source: 'voice' }),
    propose_chat_action: (a) => agent.handle({ op: 'propose.chat', action: s(a.action), chat: s(a.chat), duration_hours: a.duration_hours, source: 'voice' }),
    propose_contact_action: (a) => agent.handle({ op: 'propose.contact', action: s(a.action), contact: s(a.contact), number: s(a.number), alias: s(a.alias), note: s(a.note), source: 'voice' }),
    propose_status_post: (a) => agent.handle({ op: 'propose.status', text: s(a.text), background_color: s(a.background_color), source: 'voice' }),
    propose_profile_action: (a) => agent.handle({ op: 'propose.profile', action: s(a.action), text: s(a.text), source: 'voice' }),
  };
  return async (name, args) => {
    const fn = table[name];
    if (!fn) return { ok: false, error: 'unknown_tool', message: `No tool called "${name}".` };
    try { return await fn(args && typeof args === 'object' ? args : {}); } catch (e) { return { ok: false, error: 'internal', message: e.message }; }
  };
}

/** Tools that change something (a request, a draft, a cancellation, a note, a proposal). If a command fails after one of these ran, say so. */
export const STATE_TOOLS = new Set([
  'send_message', 'send_bulk', 'draft_message', 'cancel_action', 'notify_owner',
  'get_contact_status', 'watch_contact', 'cancel_watch', 'find_messages', 'deliver_to_owner',
  'propose_group_action', 'propose_message_action', 'propose_chat_action',
  'propose_contact_action', 'propose_status_post', 'propose_profile_action',
]);

const CLAIMS_DONE = /\b(sent|delivered|messaged|texted|kicked|promoted|demoted|deleted|edited|muted|unmuted|archived|blocked|unblocked|posted|pinned)\b/i;
const HEDGES = /\b(approv|confirm|pending|waiting|react|draft|declin|not (?:been )?sent|nothing (?:was |has been )?sent|hasn'?t|haven'?t|yet|asked|propos)\b/i;

/**
 * The text posted back to the owner. The model's own words are used unless it claims a mutating action went through:
 * state-changing requests only ever ASK for approval, so any claim without a hedge is replaced by a plain verification reminder.
 */
export function commandReply(modelText, trace = []) {
  const t = String(modelText ?? '').trim();
  const asked = trace.some((x) => STATE_TOOLS.has(x.tool) && x.ok);
  if (asked && (!t || (CLAIMS_DONE.test(t) && !HEDGES.test(t)))) {
    const isSend = trace.some((x) => (x.tool === 'send_message' || x.tool === 'send_bulk') && x.ok);
    if (isSend) {
      return 'I asked for your OK on the request above: react 👍 to send, 🙏 to get it as a draft, or 😢 to decline.';
    }
    return 'I asked for your OK on the request above: react 👍 to approve and execute, 🙏 for details, or 😢 to decline.';
  }
  if (t) return t;
  return trace.length ? 'Done.' : "I didn't hear a request I can act on.";
}
