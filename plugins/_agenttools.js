// Tool surface + rules for the in-bot voice agent (Gemini 3.8 Live). Keep in sync with TOOLS in cli/wabctl.
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
  { name: 'check_action', description: 'Status of an earlier action: pending, sent, drafted, declined, expired, cancelled or failed.', parameters: { type: 'object', properties: { id: str('Action id.') }, required: ['id'] } },
  { name: 'cancel_action', description: 'Cancel a request that is still pending.', parameters: { type: 'object', properties: { id: str('Action id.') }, required: ['id'] } },
  { name: 'list_pending', description: 'List requests waiting for the owner and the most recent finished ones.' },
  { name: 'find_contact', description: "Check who a spoken name refers to in the owner's contacts (handles nicknames and mishearings). Returns the match or candidates. Numbers are masked.", parameters: { type: 'object', properties: { query: str('The name as heard.') }, required: ['query'] } },
  { name: 'list_contacts', description: "List the names in the owner's contact book." },
  { name: 'notify_owner', description: "Post a short note in the owner's own chat.", parameters: { type: 'object', properties: { text: str('The note, max 1000 characters.') }, required: ['text'] } },
  { name: 'bot_status', description: 'Whether the bot is connected and whether agent actions are paused.' },
  {
    name: 'get_contact_status',
    description: "Check a contact's latest WhatsApp status/story update and download/send it to the owner. Use when the owner asks to check someone's status, download their last status, get the meme they posted, see their story, etc.",
    parameters: {
      type: 'object',
      properties: {
        contact: str("The name of the contact as spoken (e.g. 'Precious', 'Thomas'), or their phone number."),
      },
      required: ['contact'],
    },
  },
];

export const SYSTEM_PROMPT = `You are the owner's WhatsApp assistant, running inside their own WhatsApp bot. The owner recorded a voice note that was transcribed by speech-to-text, so names and words can be slightly wrong. The text you receive is the owner's own spoken instruction.
Rules:
1. Only do what the note asks, using your tools. If it is not a clear request for one of your tools, say so in one short sentence and do nothing.
2. send_message never sends by itself: it asks the owner to approve on their phone (👍 send now, 🙏 draft, 😢 decline). Do not wait. After calling it, tell the owner to react to the request in their chat. Never say a message was sent.
3. If the owner says draft, write or prepare, use draft_message.
4. Write the message in the owner's voice, as dictated. Fix obvious speech-to-text slips and punctuation, never add content they did not ask for, and leave out the instruction itself ("send a message to Thomas saying ...").
5. If you are unsure who a name means, call find_contact. If it is ambiguous or not found, ask the owner in one short sentence and do nothing else. Never invent or guess phone numbers.
6. Reply in one or two short plain-text sentences, no lists, no markdown.
7. If the owner asks to check someone's status, download their last status/meme, or see their story, call get_contact_status with their name.`;

/** Map tool calls onto the Agent's own operations (same code path, limits and approval as the CLI). */
export function makeDispatch(agent) {
  const s = (v) => (typeof v === 'string' ? v : undefined);
  const table = {
    send_message: (a) => agent.handle({ op: 'send', to: s(a.to), text: s(a.text), source: 'voice' }),
    draft_message: (a) => agent.handle({ op: 'draft', to: s(a.to), text: s(a.text), source: 'voice' }),
    check_action: (a) => agent.handle({ op: 'get', id: s(a.id) }),
    cancel_action: (a) => agent.handle({ op: 'cancel', id: s(a.id) }),
    list_pending: () => agent.handle({ op: 'list' }),
    find_contact: (a) => agent.handle({ op: 'contacts.find', query: s(a.query) }),
    list_contacts: () => agent.handle({ op: 'contacts.list' }),
    notify_owner: (a) => agent.handle({ op: 'notify', text: s(a.text) }),
    bot_status: () => agent.handle({ op: 'status' }),
    get_contact_status: (a) => agent.handle({ op: 'status.get', contact: s(a.contact) }),
  };
  return async (name, args) => {
    const fn = table[name];
    if (!fn) return { ok: false, error: 'unknown_tool', message: `No tool called "${name}".` };
    try { return await fn(args && typeof args === 'object' ? args : {}); } catch (e) { return { ok: false, error: 'internal', message: e.message }; }
  };
}

/** Tools that change something (a request, a draft, a cancellation, a note). If a command fails after one of these ran, say so. */
export const STATE_TOOLS = new Set(['send_message', 'draft_message', 'cancel_action', 'notify_owner', 'get_contact_status']);

const CLAIMS_DONE = /\b(sent|delivered|messaged|texted)\b/i;
const HEDGES = /\b(approv|confirm|pending|waiting|react|draft|declin|not (?:been )?sent|nothing (?:was |has been )?sent|hasn'?t|haven'?t|yet|asked)\b/i;

/**
 * The text posted back to the owner. The model's own words are used unless it claims a message went out:
 * a send request only ever ASKS for approval, so any "sent" claim without a hedge is replaced by a plain statement.
 */
export function commandReply(modelText, trace = []) {
  const t = String(modelText ?? '').trim();
  const asked = trace.some((x) => x.tool === 'send_message' && x.ok);
  if (asked && (!t || (CLAIMS_DONE.test(t) && !HEDGES.test(t)))) return 'I asked for your OK on the request above: react 👍 to send, 🙏 to get it as a draft, or 😢 to decline.';
  if (t) return t;
  return trace.length ? 'Done.' : "I didn't hear a request I can act on.";
}
