import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { Sender } from '../src/send.js';
import { Agent } from '../plugins/agent.js';
import { makeDispatch, commandReply } from '../plugins/_agenttools.js';
import { silent } from './helpers.js';

const CONTACTS = {
  Thomas: '+234 801 234 5678',
  Mum: { number: '2348011112222', aliases: ['mom'] },
  'Family Group': { jid: '120363000000000001@g.us' },
};

function fakeBaileysSocket(overrides = {}) {
  const sent = [];
  const modified = [];
  return {
    sent,
    modified,
    user: { id: '15550001111:1@s.whatsapp.net' },
    groupMetadata: async (jid) => ({
      id: jid,
      subject: 'Tech Group',
      participants: [{ id: '15550001111@s.whatsapp.net', admin: 'superadmin' }, { id: '2348012345678@s.whatsapp.net', admin: null }],
    }),
    groupFetchAllParticipating: async () => ({
      '120363000000000001@g.us': { id: '120363000000000001@g.us', subject: 'Family Group', participants: [{ id: '1@s.whatsapp.net' }] },
    }),
    groupParticipantsUpdate: async (jid, parts, action) => {
      if (overrides.groupParticipantsUpdate) return overrides.groupParticipantsUpdate(jid, parts, action);
      return parts.map((p) => ({ status: '200', jid: p }));
    },
    groupSettingUpdate: async (jid, setting) => {
      if (overrides.groupSettingUpdate) return overrides.groupSettingUpdate(jid, setting);
      return true;
    },
    groupUpdateSubject: async (jid, sub) => true,
    groupUpdateDescription: async (jid, desc) => true,
    groupInviteCode: async (jid) => 'CODE123',
    groupRevokeInvite: async (jid) => 'REVOKED123',
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `OUT_${sent.length}`, remoteJid: jid } };
    },
    chatModify: async (mod, jid) => {
      modified.push({ jid, mod });
      return true;
    },
    updateBlockStatus: async (jid, action) => true,
    fetchBlocklist: async () => ['2348000000000@s.whatsapp.net'],
    onWhatsApp: async (jid) => [{ exists: true, jid }],
    updateProfileStatus: async (status) => true,
    updateProfileName: async (name) => true,
  };
}

async function setupTestAgent(cfg = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-verify-'));
  await fs.writeFile(path.join(dir, 'contacts.json'), JSON.stringify(CONTACTS));
  const sock = fakeBaileysSocket(cfg.overrides || {});
  const conn = {
    sock,
    state: 'open',
    waitOpen: async () => sock,
  };
  const store = createStore();
  const sender = new Sender({ conn, store, config: { sendGapMs: 0 }, log: silent });
  const clock = { t: 1_700_000_000_000 };
  const api = {
    config: { dataDir: dir, allowed: [] },
    conn,
    store,
    log: silent,
    startedAt: clock.t,
    send: (j, c, o) => sender.send(j, c, o),
  };
  const agent = new Agent(api, { now: () => clock.t });
  await agent.start();
  const dispatch = makeDispatch(agent);
  return {
    dir,
    agent,
    sock,
    dispatch,
    clock,
    self: '15550001111@s.whatsapp.net',
    sent: sock.sent,
  };
}

const react = (targetId, text, fromMe = true, participant = '15550001111@s.whatsapp.net') => ({
  messages: [{
    key: { id: `R${Math.random()}`, fromMe, remoteJid: '15550001111@s.whatsapp.net', participant },
    message: { reactionMessage: { key: { id: targetId }, text } },
  }],
});

const reply = (stanzaId, text, fromMe = true, participant = '15550001111@s.whatsapp.net') => ({
  messages: [{
    key: { id: `T${Math.random()}`, fromMe, remoteJid: '15550001111@s.whatsapp.net', participant },
    message: { extendedTextMessage: { text, contextInfo: { stanzaId } } },
  }],
});

// ----------------- 1. PROPOSAL CREATION FOR ALL ACTIONS -----------------

test('1. propose_group_action (kick): creates pending approval card without executing', async () => {
  const { agent, dispatch, sent, self } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.equal(r.title, 'Group KICK');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, self);
  assert.match(sent[0].content.text, /\*Action Proposal/);
  assert.match(sent[0].content.text, /kick 2348012345678/);
  assert.match(sent[0].content.text, /👍 Approve & execute/);
  await agent.stop();
});

test('2. propose_group_action (add): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'add', group: 'Family Group', member: 'Mum' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /add Mum/);
  await agent.stop();
});

test('3. propose_group_action (promote): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'promote', group: 'Family Group', member: 'Thomas' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /promote Thomas/);
  await agent.stop();
});

test('4. propose_group_action (demote): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'demote', group: 'Family Group', member: 'Thomas' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /demote Thomas/);
  await agent.stop();
});

test('5. propose_group_action (subject): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'subject', group: 'Family Group', text: 'New Subject' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Change subject to "New Subject"/);
  await agent.stop();
});

test('6. propose_group_action (description): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'description', group: 'Family Group', text: 'New Rules' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Change description to "New Rules"/);
  await agent.stop();
});

test('7. propose_group_action (setting): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'setting', group: 'Family Group', setting: 'announcement' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Set setting: announcement/);
  await agent.stop();
});

test('8. propose_group_action (revoke_invite): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'revoke_invite', group: 'Family Group' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Revoke invite link/);
  await agent.stop();
});

test('9. propose_group_action (tagall): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'tagall', group: 'Family Group', text: 'Attention please' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Tag all members: "Attention please"/);
  await agent.stop();
});

test('10. propose_message_action (edit): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_message_action', { action: 'edit', chat: 'Thomas', message_id: 'MSG1', text: 'corrected text' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Edit message MSG1 to: "corrected text"/);
  await agent.stop();
});

test('11. propose_message_action (delete): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_message_action', { action: 'delete', chat: 'Thomas', message_id: 'MSG1' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Delete message MSG1 for everyone/);
  await agent.stop();
});

test('12. propose_message_action (pin): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_message_action', { action: 'pin', chat: 'Thomas', message_id: 'MSG1', duration_hours: 48 });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Pin message MSG1 for 48h/);
  await agent.stop();
});

test('13. propose_message_action (react): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_message_action', { action: 'react', chat: 'Thomas', message_id: 'MSG1', text: '❤️' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /React with ❤️ to message MSG1/);
  await agent.stop();
});

test('14. propose_message_action (poll): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_message_action', { action: 'poll', chat: 'Family Group', text: 'What for dinner?', options: ['Rice', 'Pasta'] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Create poll "What for dinner\?" with 2 option\(s\)/);
  await agent.stop();
});

test('15. propose_message_action (star): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_message_action', { action: 'star', chat: 'Thomas', message_id: 'MSG1' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Star message MSG1/);
  await agent.stop();
});

test('16. propose_chat_action (mute): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_chat_action', { action: 'mute', chat: 'Family Group', duration_hours: 24 });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Mute notifications for 24 hours/);
  await agent.stop();
});

test('17. propose_chat_action (unmute): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_chat_action', { action: 'unmute', chat: 'Family Group' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Unmute notifications/);
  await agent.stop();
});

test('18. propose_chat_action (archive): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_chat_action', { action: 'archive', chat: 'Thomas' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Archive chat/);
  await agent.stop();
});

test('19. propose_chat_action (clear): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_chat_action', { action: 'clear', chat: 'Thomas' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Clear chat history/);
  await agent.stop();
});

test('20. propose_contact_action (block): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_contact_action', { action: 'block', contact: '2348099990001' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /block 2348099990001/);
  await agent.stop();
});

test('21. propose_contact_action (unblock): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_contact_action', { action: 'unblock', contact: '2348099990001' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /unblock 2348099990001/);
  await agent.stop();
});

test('22. propose_contact_action (add): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_contact_action', { action: 'add', contact: 'Alex', number: '+2348011223344', alias: 'Lex' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Save contact "Alex"/);
  await agent.stop();
});

test('23. propose_contact_action (remove): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_contact_action', { action: 'remove', contact: 'Thomas' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /remove Thomas/);
  await agent.stop();
});

test('24. propose_status_post: creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_status_post', { text: 'Happy Friday!', background_color: '#25D366' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Happy Friday!/);
  await agent.stop();
});

test('25. propose_profile_action (bio): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_profile_action', { action: 'bio', text: 'Building great things.' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Set bio to "Building great things\."/);
  await agent.stop();
});

test('26. propose_profile_action (name): creates pending approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('propose_profile_action', { action: 'name', text: 'Lohra Assistant' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.match(sent[0].content.text, /Set name to "Lohra Assistant"/);
  await agent.stop();
});

// ----------------- 2. APPROVAL, DECLINE, DRAFT LIFECYCLE -----------------

test('27. Precondition: Zero side-effects happen until owner reacts', async () => {
  let kickExecuted = false;
  const { agent, dispatch, sent } = await setupTestAgent({
    overrides: { groupParticipantsUpdate: async () => { kickExecuted = true; return [{ status: '200' }]; } },
  });
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.equal(kickExecuted, false); // invariant: NOT executed
  await agent.stop();
});

test('28. Owner reacts 👍 -> action executes successfully, status becomes executed, note posted', async () => {
  let kickExecuted = false;
  const { agent, dispatch, sent, self } = await setupTestAgent({
    overrides: { groupParticipantsUpdate: async () => { kickExecuted = true; return [{ status: '200' }]; } },
  });
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  const msgId = sent[0].content.text.match(/#([a-z0-9]+)/)?.[1];
  assert.equal(r.id, msgId);

  await agent.onUpsert(react('OUT_1', '👍'));
  assert.equal(kickExecuted, true);

  const check = await agent.handle({ op: 'get', id: r.id });
  assert.equal(check.status, 'executed');
  assert.ok(sent.some((x) => x.jid === self && /Approved & executed/.test(x.content.text)));
  await agent.stop();
});

test('29. Owner replies "yes" -> action executes successfully', async () => {
  let kickExecuted = false;
  const { agent, dispatch, sent } = await setupTestAgent({
    overrides: { groupParticipantsUpdate: async () => { kickExecuted = true; return [{ status: '200' }]; } },
  });
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  await agent.onUpsert(reply('OUT_1', 'yes'));
  assert.equal(kickExecuted, true);
  const check = await agent.handle({ op: 'get', id: r.id });
  assert.equal(check.status, 'executed');
  await agent.stop();
});

test('30. Owner reacts 😢 -> action is declined, ZERO execution calls made', async () => {
  let kickExecuted = false;
  const { agent, dispatch, sent, self } = await setupTestAgent({
    overrides: { groupParticipantsUpdate: async () => { kickExecuted = true; return [{ status: '200' }]; } },
  });
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  await agent.onUpsert(react('OUT_1', '😢'));
  assert.equal(kickExecuted, false); // ZERO execution

  const check = await agent.handle({ op: 'get', id: r.id });
  assert.equal(check.status, 'declined');
  assert.ok(sent.some((x) => x.jid === self && /Declined/.test(x.content.text)));
  await agent.stop();
});

test('31. Owner replies "no" -> action is declined', async () => {
  let kickExecuted = false;
  const { agent, dispatch } = await setupTestAgent({
    overrides: { groupParticipantsUpdate: async () => { kickExecuted = true; return [{ status: '200' }]; } },
  });
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  await agent.onUpsert(reply('OUT_1', 'no'));
  assert.equal(kickExecuted, false);
  const check = await agent.handle({ op: 'get', id: r.id });
  assert.equal(check.status, 'declined');
  await agent.stop();
});

test('32. Owner reacts 🙏 -> action is drafted/details sent to owner chat, ZERO execution', async () => {
  let kickExecuted = false;
  const { agent, dispatch, sent, self } = await setupTestAgent({
    overrides: { groupParticipantsUpdate: async () => { kickExecuted = true; return [{ status: '200' }]; } },
  });
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  await agent.onUpsert(react('OUT_1', '🙏'));
  assert.equal(kickExecuted, false);

  const check = await agent.handle({ op: 'get', id: r.id });
  assert.equal(check.status, 'drafted');
  assert.ok(sent.some((x) => x.jid === self && /Proposal Details/.test(x.content.text)));
  await agent.stop();
});

test('33. Non-owner reaction is strictly ignored', async () => {
  let kickExecuted = false;
  const { agent, dispatch } = await setupTestAgent({
    overrides: { groupParticipantsUpdate: async () => { kickExecuted = true; return [{ status: '200' }]; } },
  });
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  await agent.onUpsert(react('OUT_1', '👍', false, '2348099990001@s.whatsapp.net')); // non-owner
  assert.equal(kickExecuted, false);
  const check = await agent.handle({ op: 'get', id: r.id });
  assert.equal(check.status, 'pending');
  await agent.stop();
});

test('34. Irrelevant emoji reaction (e.g. 😂) is ignored', async () => {
  const { agent, dispatch } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  await agent.onUpsert(react('OUT_1', '😂'));
  const check = await agent.handle({ op: 'get', id: r.id });
  assert.equal(check.status, 'pending');
  await agent.stop();
});

test('35. Decided proposal cannot be approved again', async () => {
  const { agent, dispatch } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  await agent.decide(r.id, 'approve', 'command');
  const doubleApprove = await agent.decide(r.id, 'approve', 'command');
  assert.equal(doubleApprove.ok, false);
  assert.equal(doubleApprove.error, 'not_pending');
  await agent.stop();
});

test('36. Expired proposal cannot be approved', async () => {
  const { agent, dispatch, clock } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  clock.t += 601_000; // advance clock past 600s TTL
  const res = await agent.decide(r.id, 'approve', 'command');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'expired');
  await agent.stop();
});

test('37. Sweep automatically marks expired proposals as expired and notes owner', async () => {
  const { agent, dispatch, clock, sent, self } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  clock.t += 601_000;
  await agent.sweep();
  const check = await agent.handle({ op: 'get', id: r.id });
  assert.equal(check.status, 'expired');
  assert.ok(sent.some((x) => x.jid === self && /Expired/.test(x.content.text)));
  await agent.stop();
});

test('38. Cancel action explicitly cancels pending proposal and notes owner', async () => {
  const { agent, dispatch, sent, self } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  const c = await agent.cancel(r.id);
  assert.equal(c.ok, true);
  assert.equal(c.status, 'cancelled');
  assert.ok(sent.some((x) => x.jid === self && /Cancelled/.test(x.content.text)));
  await agent.stop();
});

test('39. Cannot cancel an action that is not pending', async () => {
  const { agent, dispatch } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  await agent.cancel(r.id);
  const c2 = await agent.cancel(r.id);
  assert.equal(c2.ok, false);
  assert.equal(c2.error, 'not_pending');
  await agent.stop();
});

test('40. Execution failure: when Baileys throws, action is marked failed and owner is notified', async () => {
  const { agent, dispatch, sent, self } = await setupTestAgent({
    overrides: { groupParticipantsUpdate: async () => { throw new Error('Network timeout during kick'); } },
  });
  const r = await dispatch('propose_group_action', { action: 'kick', group: '120363000000000001@g.us', member: '2348012345678' });
  await agent.onUpsert(react('OUT_1', '👍'));
  const check = await agent.handle({ op: 'get', id: r.id });
  assert.equal(check.status, 'failed');
  assert.match(check.error, /Network timeout/);
  assert.ok(sent.some((x) => x.jid === self && /Execution failed/.test(x.content.text)));
  await agent.stop();
});

test('41. Paused agent rejects new proposals with "paused"', async () => {
  const { agent, dispatch } = await setupTestAgent();
  await agent.setPaused(true);
  const r = await dispatch('propose_group_action', { action: 'kick', group: 'Family Group', member: 'Thomas' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'paused');
  await agent.stop();
});

test('42. Pausing agent cancels existing pending proposals', async () => {
  const { agent, dispatch } = await setupTestAgent();
  const r = await dispatch('propose_group_action', { action: 'kick', group: 'Family Group', member: 'Thomas' });
  await agent.setPaused(true);
  const check = await agent.handle({ op: 'get', id: r.id });
  assert.equal(check.status, 'cancelled');
  await agent.stop();
});

test('43. Enforces maxPending limit on concurrent proposals', async () => {
  const { agent, dispatch } = await setupTestAgent();
  agent.cfg.maxPending = 2;
  const r1 = await dispatch('propose_status_post', { text: 'Post 1' });
  const r2 = await dispatch('propose_status_post', { text: 'Post 2' });
  const r3 = await dispatch('propose_status_post', { text: 'Post 3' });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'too_many_pending');
  await agent.stop();
});

test('44. Enforces maxPerHour rate limit on proposals', async () => {
  const { agent, dispatch } = await setupTestAgent();
  agent.cfg.maxPerHour = 2;
  const r1 = await dispatch('propose_status_post', { text: 'Post 1' });
  await agent.decide(r1.id, 'decline', 'test');
  const r2 = await dispatch('propose_status_post', { text: 'Post 2' });
  await agent.decide(r2.id, 'decline', 'test');
  const r3 = await dispatch('propose_status_post', { text: 'Post 3' });
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'rate_limited');
  await agent.stop();
});

test('45. Deciding with unknown or invalid action ID returns not_found', async () => {
  const { agent } = await setupTestAgent();
  const r = await agent.decide('xyz99', 'approve', 'test');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_found');
  await agent.stop();
});

// ----------------- 3. READ-ONLY QUERY TOOLS EXECUTE DIRECTLY -----------------

test('46. group_info: executes immediately without creating approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('group_info', { group: '120363000000000001@g.us' });
  assert.equal(r.ok, true);
  assert.equal(r.subject, 'Tech Group');
  assert.equal(sent.length, 0); // No approval card sent!
  await agent.stop();
});

test('47. list_groups: executes immediately without creating approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('list_groups', {});
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(sent.length, 0);
  await agent.stop();
});

test('48. list_chats: executes immediately without creating approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('list_chats', { limit: 5 });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 0);
  await agent.stop();
});

test('49. check_on_whatsapp: executes immediately without creating approval card', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('check_on_whatsapp', { number: '+2348012345678' });
  assert.equal(r.ok, true);
  assert.equal(r.exists, true);
  assert.equal(sent.length, 0);
  await agent.stop();
});

test('50. inspect_manual: returns topic capabilities immediately', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const r = await dispatch('inspect_manual', { topic: 'groups' });
  assert.equal(r.ok, true);
  assert.match(r.doc, /groups: info, list, kick/);
  assert.equal(sent.length, 0);
  await agent.stop();
});

test('51. find_contact and list_contacts: execute immediately', async () => {
  const { agent, dispatch, sent } = await setupTestAgent();
  const f = await dispatch('find_contact', { query: 'Thomas' });
  assert.equal(f.ok, true);
  const l = await dispatch('list_contacts', {});
  assert.equal(l.ok, true);
  assert.equal(sent.length, 0);
  await agent.stop();
});

// ----------------- 4. DEFANGING & HEDGING GUARDRAILS -----------------

test('52. commandReply: unhedged claim of action completed is defanged with verification reminder', () => {
  const trace = [{ tool: 'propose_group_action', ok: true }];
  const reply1 = commandReply('I kicked Thomas from the group.', trace);
  assert.match(reply1, /react 👍 to approve and execute/);

  const reply2 = commandReply('I deleted the message.', [{ tool: 'propose_message_action', ok: true }]);
  assert.match(reply2, /react 👍 to approve and execute/);

  const reply3 = commandReply('I muted the chat.', [{ tool: 'propose_chat_action', ok: true }]);
  assert.match(reply3, /react 👍 to approve and execute/);

  const reply4 = commandReply('I blocked the contact.', [{ tool: 'propose_contact_action', ok: true }]);
  assert.match(reply4, /react 👍 to approve and execute/);

  const reply5 = commandReply('I posted the status.', [{ tool: 'propose_status_post', ok: true }]);
  assert.match(reply5, /react 👍 to approve and execute/);
});

test('53. commandReply: hedged response explaining proposal is preserved', () => {
  const trace = [{ tool: 'propose_group_action', ok: true }];
  const hedged = 'I have proposed removing Thomas. Please react 👍 on WhatsApp to confirm.';
  const r = commandReply(hedged, trace);
  assert.equal(r, hedged);
});

test('54. Validation: proposal rejects missing required fields', async () => {
  const { agent, dispatch } = await setupTestAgent();
  const g1 = await dispatch('propose_group_action', { group: 'Family Group' }); // missing action
  assert.equal(g1.ok, false);
  assert.equal(g1.error, 'invalid_action');

  const g2 = await dispatch('propose_group_action', { action: 'kick' }); // missing group
  assert.equal(g2.ok, false);
  assert.equal(g2.error, 'invalid_group');

  const m1 = await dispatch('propose_message_action', { chat: 'Thomas' }); // missing action
  assert.equal(m1.ok, false);
  assert.equal(m1.error, 'invalid_action');

  const c1 = await dispatch('propose_contact_action', { contact: 'Thomas' }); // missing action
  assert.equal(c1.ok, false);
  assert.equal(c1.error, 'invalid_action');

  const s1 = await dispatch('propose_status_post', { text: '' }); // empty text
  assert.equal(s1.ok, false);
  assert.equal(s1.error, 'invalid_text');
  await agent.stop();
});

test('55. Audit log records proposed and executed actions', async () => {
  const { agent, dispatch, dir } = await setupTestAgent();
  const r = await dispatch('propose_status_post', { text: 'Audit test' });
  await agent.decide(r.id, 'approve', 'test');
  await agent.stop();

  const auditPath = path.join(dir, 'agent', 'audit.jsonl');
  const lines = (await fs.readFile(auditPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.event === 'proposed_action' && l.id === r.id));
  assert.ok(lines.some((l) => l.event === 'executed' && l.id === r.id));
});
