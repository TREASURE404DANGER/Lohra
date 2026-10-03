import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../plugins/_baileys_ops.js';

function mockSock(overrides = {}) {
  const sent = [];
  const modified = [];
  return {
    sent,
    modified,
    user: { id: '15550001111:1@s.whatsapp.net' },
    groupMetadata: async (jid) => overrides.groupMetadata ? overrides.groupMetadata(jid) : ({
      id: jid,
      subject: 'Test Group',
      owner: '15550001111@s.whatsapp.net',
      creation: 1700000000,
      desc: 'A test group description',
      announce: false,
      restrict: false,
      ephemeralDuration: 0,
      participants: [
        { id: '15550001111@s.whatsapp.net', admin: 'superadmin', isSuperAdmin: true },
        { id: '2348012345678@s.whatsapp.net', admin: 'admin', isAdmin: true },
        { id: '2348099990001@s.whatsapp.net', admin: null },
      ],
    }),
    groupFetchAllParticipating: async () => overrides.groupFetchAllParticipating ? overrides.groupFetchAllParticipating() : ({
      '120363001@g.us': { id: '120363001@g.us', subject: 'Group 1', participants: [{ id: '1@s.whatsapp.net' }] },
      '120363002@g.us': { id: '120363002@g.us', subject: 'Group 2', participants: [{ id: '1@s.whatsapp.net' }, { id: '2@s.whatsapp.net' }] },
    }),
    groupParticipantsUpdate: async (jid, parts, action) => overrides.groupParticipantsUpdate ? overrides.groupParticipantsUpdate(jid, parts, action) : parts.map((p) => ({ status: '200', jid: p })),
    groupSettingUpdate: async (jid, setting) => overrides.groupSettingUpdate ? overrides.groupSettingUpdate(jid, setting) : true,
    groupUpdateSubject: async (jid, sub) => overrides.groupUpdateSubject ? overrides.groupUpdateSubject(jid, sub) : true,
    groupUpdateDescription: async (jid, desc) => overrides.groupUpdateDescription ? overrides.groupUpdateDescription(jid, desc) : true,
    groupInviteCode: async (jid) => overrides.groupInviteCode ? overrides.groupInviteCode(jid) : 'ABC123xyz',
    groupRevokeInvite: async (jid) => overrides.groupRevokeInvite ? overrides.groupRevokeInvite(jid) : 'NEWCODE456',
    groupRequestParticipantsList: async (jid) => overrides.groupRequestParticipantsList ? overrides.groupRequestParticipantsList(jid) : [{ jid: '2348033334444@s.whatsapp.net', request_time: 1700000000 }],
    groupRequestParticipantsUpdate: async (jid, parts, action) => overrides.groupRequestParticipantsUpdate ? overrides.groupRequestParticipantsUpdate(jid, parts, action) : parts.map((p) => ({ status: '200', jid: p })),
    sendMessage: async (jid, content) => {
      if (overrides.sendMessage) return overrides.sendMessage(jid, content);
      sent.push({ jid, content });
      return { key: { id: `MSG_${sent.length}`, remoteJid: jid } };
    },
    chatModify: async (mod, jid) => {
      if (overrides.chatModify) return overrides.chatModify(mod, jid);
      modified.push({ jid, mod });
      return true;
    },
    updateBlockStatus: async (jid, action) => overrides.updateBlockStatus ? overrides.updateBlockStatus(jid, action) : true,
    fetchBlocklist: async () => overrides.fetchBlocklist ? overrides.fetchBlocklist() : ['2348000000000@s.whatsapp.net'],
    onWhatsApp: async (jid) => overrides.onWhatsApp ? overrides.onWhatsApp(jid) : [{ exists: !jid.includes('9999999'), jid }],
    updateProfileStatus: async (status) => overrides.updateProfileStatus ? overrides.updateProfileStatus(status) : true,
    updateProfileName: async (name) => overrides.updateProfileName ? overrides.updateProfileName(name) : true,
  };
}

// ----------------- JID NORMALIZATION -----------------

test('1. normalizeJid: handles raw numbers, jids, and edge cases', () => {
  assert.equal(ops.normalizeJid('2348012345678'), '2348012345678@s.whatsapp.net');
  assert.equal(ops.normalizeJid('+234 801 234 5678'), '2348012345678@s.whatsapp.net');
  assert.equal(ops.normalizeJid('2348012345678@s.whatsapp.net'), '2348012345678@s.whatsapp.net');
  assert.equal(ops.normalizeJid('120363001@g.us'), '120363001@g.us');
  assert.equal(ops.normalizeJid(''), '');
  assert.equal(ops.normalizeJid(null), '');
  assert.equal(ops.normalizeJid(undefined), '');
});

test('2. normalizeGroupJid: handles group IDs and raw digits', () => {
  assert.equal(ops.normalizeGroupJid('120363001@g.us'), '120363001@g.us');
  assert.equal(ops.normalizeGroupJid('120363001'), '120363001@g.us');
  assert.equal(ops.normalizeGroupJid(''), '');
  assert.equal(ops.normalizeGroupJid(null), '');
});

// ----------------- GROUPS -----------------

test('3. groupInfo: returns bot_offline if socket is null', async () => {
  const r = await ops.groupInfo(null, '120363001@g.us');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bot_offline');
});

test('4. groupInfo: returns invalid_group if group identifier is invalid', async () => {
  const sock = mockSock();
  const r = await ops.groupInfo(sock, '');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_group');
});

test('5. groupInfo: returns parsed group metadata with admin classification', async () => {
  const sock = mockSock();
  const r = await ops.groupInfo(sock, '120363001@g.us');
  assert.equal(r.ok, true);
  assert.equal(r.subject, 'Test Group');
  assert.equal(r.participantsCount, 3);
  assert.deepEqual(r.admins, ['15550001111@s.whatsapp.net', '2348012345678@s.whatsapp.net']);
  assert.equal(r.announce, false);
});

test('6. groupInfo: handles Baileys 404 / group not found', async () => {
  const sock = mockSock({ groupMetadata: async () => null });
  const r = await ops.groupInfo(sock, '120363001@g.us');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_found');
});

test('7. groupInfo: handles Baileys socket error throw', async () => {
  const sock = mockSock({ groupMetadata: async () => { const e = new Error('Forbidden'); e.output = { statusCode: 403 }; throw e; } });
  const r = await ops.groupInfo(sock, '120363001@g.us');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'group_info_failed');
  assert.equal(r.code, 403);
});

test('8. groupList: returns bot_offline when socket is null', async () => {
  const r = await ops.groupList(null);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bot_offline');
});

test('9. groupList: returns list of participating groups', async () => {
  const sock = mockSock();
  const r = await ops.groupList(sock);
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.groups[0].subject, 'Group 1');
  assert.equal(r.groups[1].participantsCount, 2);
});

test('10. groupList: handles empty participating groups map', async () => {
  const sock = mockSock({ groupFetchAllParticipating: async () => ({}) });
  const r = await ops.groupList(sock);
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.deepEqual(r.groups, []);
});

test('11. groupList: handles socket error throw gracefully', async () => {
  const sock = mockSock({ groupFetchAllParticipating: async () => { throw new Error('Connection lost'); } });
  const r = await ops.groupList(sock);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'group_list_failed');
});

test('12. groupParticipantsUpdate: returns bot_offline when socket is null', async () => {
  const r = await ops.groupParticipantsUpdate(null, '120363001@g.us', '2348012345678', 'remove');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bot_offline');
});

test('13. groupParticipantsUpdate: rejects invalid actions', async () => {
  const sock = mockSock();
  const r = await ops.groupParticipantsUpdate(sock, '120363001@g.us', '2348012345678', 'ban_forever');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_action');
});

test('14. groupParticipantsUpdate: rejects empty participants', async () => {
  const sock = mockSock();
  const r = await ops.groupParticipantsUpdate(sock, '120363001@g.us', [], 'remove');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_participants');
});

test('15. groupParticipantsUpdate: normalizes single string participant and succeeds', async () => {
  const sock = mockSock();
  const r = await ops.groupParticipantsUpdate(sock, '120363001@g.us', '08012345678', 'remove');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'remove');
  assert.deepEqual(r.participants, ['08012345678@s.whatsapp.net']);
});

test('16. groupParticipantsUpdate: maps 403 statusCode to admin permission failure', async () => {
  const sock = mockSock({ groupParticipantsUpdate: async () => { const e = new Error('Not admin'); e.output = { statusCode: 403 }; throw e; } });
  const r = await ops.groupParticipantsUpdate(sock, '120363001@g.us', '2348012345678', 'promote');
  assert.equal(r.ok, false);
  assert.match(r.message, /Bot lacks admin permission/);
});

test('17. groupSettingUpdate: validates valid settings', async () => {
  const sock = mockSock();
  for (const s of ['announcement', 'not_announcement', 'locked', 'unlocked']) {
    const r = await ops.groupSettingUpdate(sock, '120363001@g.us', s);
    assert.equal(r.ok, true);
    assert.equal(r.setting, s);
  }
});

test('18. groupSettingUpdate: rejects unknown settings', async () => {
  const sock = mockSock();
  const r = await ops.groupSettingUpdate(sock, '120363001@g.us', 'read_only');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_setting');
});

test('19. groupSettingUpdate: maps 403 permission error', async () => {
  const sock = mockSock({ groupSettingUpdate: async () => { const e = new Error('Forbidden'); e.output = { statusCode: 403 }; throw e; } });
  const r = await ops.groupSettingUpdate(sock, '120363001@g.us', 'announcement');
  assert.equal(r.ok, false);
  assert.match(r.message, /Bot lacks admin permission/);
});

test('20. groupUpdateSubject: rejects empty subject', async () => {
  const sock = mockSock();
  const r = await ops.groupUpdateSubject(sock, '120363001@g.us', '   ');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_subject');
});

test('21. groupUpdateSubject: rejects subjects longer than 100 chars', async () => {
  const sock = mockSock();
  const r = await ops.groupUpdateSubject(sock, '120363001@g.us', 'A'.repeat(101));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_subject');
});

test('22. groupUpdateSubject: successfully updates subject', async () => {
  const sock = mockSock();
  const r = await ops.groupUpdateSubject(sock, '120363001@g.us', 'New Group Name');
  assert.equal(r.ok, true);
  assert.equal(r.subject, 'New Group Name');
});

test('23. groupUpdateDescription: handles empty and multiline descriptions', async () => {
  const sock = mockSock();
  const r1 = await ops.groupUpdateDescription(sock, '120363001@g.us', '');
  assert.equal(r1.ok, true);
  assert.equal(r1.description, '');

  const r2 = await ops.groupUpdateDescription(sock, '120363001@g.us', 'Line 1\nLine 2\nLine 3');
  assert.equal(r2.ok, true);
  assert.equal(r2.description, 'Line 1\nLine 2\nLine 3');
});

test('24. groupInvite: gets invite code and builds invite URL', async () => {
  const sock = mockSock();
  const r = await ops.groupInvite(sock, '120363001@g.us', 'code');
  assert.equal(r.ok, true);
  assert.equal(r.code, 'ABC123xyz');
  assert.equal(r.link, 'https://chat.whatsapp.com/ABC123xyz');
});

test('25. groupInvite: revokes invite and returns new code', async () => {
  const sock = mockSock();
  const r = await ops.groupInvite(sock, '120363001@g.us', 'revoke');
  assert.equal(r.ok, true);
  assert.equal(r.revoked, true);
  assert.equal(r.newCode, 'NEWCODE456');
});

test('26. groupRequests: lists join requests', async () => {
  const sock = mockSock();
  const r = await ops.groupRequests(sock, '120363001@g.us', 'list');
  assert.equal(r.ok, true);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].jid, '2348033334444@s.whatsapp.net');
});

test('27. groupRequests: rejects invalid action', async () => {
  const sock = mockSock();
  const r = await ops.groupRequests(sock, '120363001@g.us', 'delete_all');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_action');
});

test('28. groupRequests: approves participant requests', async () => {
  const sock = mockSock();
  const r = await ops.groupRequests(sock, '120363001@g.us', 'approve', ['2348033334444']);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'approve');
});

test('29. groupTagAll: tags all participants with mentions payload', async () => {
  const sock = mockSock();
  const r = await ops.groupTagAll(sock, '120363001@g.us', 'Important announcement:');
  assert.equal(r.ok, true);
  assert.equal(r.mentionedCount, 3);
  assert.equal(sock.sent.length, 1);
  assert.match(sock.sent[0].content.text, /Important announcement:/);
  assert.match(sock.sent[0].content.text, /@15550001111/);
  assert.deepEqual(sock.sent[0].content.mentions.length, 3);
});

// ----------------- MESSAGES -----------------

test('30. messageEdit: returns bot_offline if socket is null', async () => {
  const r = await ops.messageEdit(null, '2348012345678', 'KEY1', 'updated text');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bot_offline');
});

test('31. messageEdit: rejects empty new text', async () => {
  const sock = mockSock();
  const r = await ops.messageEdit(sock, '2348012345678', 'KEY1', '   ');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_text');
});

test('32. messageEdit: accepts string message key and converts to targetKey', async () => {
  const sock = mockSock();
  const r = await ops.messageEdit(sock, '2348012345678', 'KEY123', 'Updated message');
  assert.equal(r.ok, true);
  assert.equal(sock.sent[0].content.text, 'Updated message');
  assert.deepEqual(sock.sent[0].content.edit, { remoteJid: '2348012345678@s.whatsapp.net', id: 'KEY123', fromMe: true });
});

test('33. messageDelete: deletes message for everyone', async () => {
  const sock = mockSock();
  const r = await ops.messageDelete(sock, '2348012345678', 'KEY123');
  assert.equal(r.ok, true);
  assert.equal(r.deletedId, 'KEY123');
  assert.deepEqual(sock.sent[0].content.delete, { remoteJid: '2348012345678@s.whatsapp.net', id: 'KEY123', fromMe: true });
});

test('34. messagePin: pins message with specified duration', async () => {
  const sock = mockSock();
  const r = await ops.messagePin(sock, '2348012345678', 'KEY123', 72);
  assert.equal(r.ok, true);
  assert.equal(r.pinned, true);
  assert.equal(r.durationHours, 72);
  assert.equal(sock.sent[0].content.type, 1);
  assert.equal(sock.sent[0].content.time, 72 * 3600);
});

test('35. messagePin: unpins message when duration is 0', async () => {
  const sock = mockSock();
  const r = await ops.messagePin(sock, '2348012345678', 'KEY123', 0);
  assert.equal(r.ok, true);
  assert.equal(r.pinned, false);
  assert.equal(sock.sent[0].content.type, 0);
  assert.equal(sock.sent[0].content.time, 0);
});

test('36. messageReact: sends emoji reaction message', async () => {
  const sock = mockSock();
  const r = await ops.messageReact(sock, '2348012345678', 'KEY123', '👍');
  assert.equal(r.ok, true);
  assert.equal(r.emoji, '👍');
  assert.deepEqual(sock.sent[0].content.react, { text: '👍', key: { remoteJid: '2348012345678@s.whatsapp.net', id: 'KEY123', fromMe: false } });
});

test('37. messagePoll: rejects empty question', async () => {
  const sock = mockSock();
  const r = await ops.messagePoll(sock, '120363001@g.us', '', ['Option 1', 'Option 2']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_question');
});

test('38. messagePoll: rejects fewer than 2 options', async () => {
  const sock = mockSock();
  const r = await ops.messagePoll(sock, '120363001@g.us', 'Lunch?', ['Pizza']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_options');
});

test('39. messagePoll: rejects more than 12 options', async () => {
  const sock = mockSock();
  const opts = Array.from({ length: 13 }, (_, i) => `Opt ${i + 1}`);
  const r = await ops.messagePoll(sock, '120363001@g.us', 'Pick one', opts);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_options');
});

test('40. messagePoll: creates poll and clamps selectableCount', async () => {
  const sock = mockSock();
  const r = await ops.messagePoll(sock, '120363001@g.us', 'Favorite framework?', ['Node', 'Deno', 'Bun'], 5);
  assert.equal(r.ok, true);
  assert.equal(sock.sent[0].content.poll.selectableCount, 3); // clamped to options length
});

test('41. messageStar: stars and unstars messages via chatModify', async () => {
  const sock = mockSock();
  const r1 = await ops.messageStar(sock, '2348012345678', 'KEY1', true);
  assert.equal(r1.ok, true);
  assert.equal(r1.starred, true);
  assert.equal(sock.modified[0].mod.star.star, true);

  const r2 = await ops.messageStar(sock, '2348012345678', 'KEY1', false);
  assert.equal(r2.ok, true);
  assert.equal(r2.starred, false);
  assert.equal(sock.modified[1].mod.star.star, false);
});

// ----------------- CHATS -----------------

test('42. chatMute: mutes chat for specified hours', async () => {
  const sock = mockSock();
  const r = await ops.chatMute(sock, '2348012345678', 8);
  assert.equal(r.ok, true);
  assert.equal(r.durationHours, 8);
  assert.equal(sock.modified[0].mod.mute, 8 * 3600_000);
});

test('43. chatUnmute: sets mute to null', async () => {
  const sock = mockSock();
  const r = await ops.chatUnmute(sock, '2348012345678');
  assert.equal(r.ok, true);
  assert.equal(sock.modified[0].mod.mute, null);
});

test('44. chatArchive: archives and unarchives chat', async () => {
  const sock = mockSock();
  const r1 = await ops.chatArchive(sock, '2348012345678', true);
  assert.equal(r1.ok, true);
  assert.equal(r1.archived, true);

  const r2 = await ops.chatArchive(sock, '2348012345678', false);
  assert.equal(r2.ok, true);
  assert.equal(r2.archived, false);
});

test('45. chatClear: clears chat messages', async () => {
  const sock = mockSock();
  const r = await ops.chatClear(sock, '2348012345678');
  assert.equal(r.ok, true);
  assert.equal(r.cleared, true);
  assert.equal(sock.modified[0].mod.delete, true);
});

// ----------------- CONTACTS & PRIVACY -----------------

test('46. contactBlock: blocks and unblocks contact', async () => {
  const sock = mockSock();
  const r1 = await ops.contactBlock(sock, '2348012345678', 'block');
  assert.equal(r1.ok, true);
  assert.equal(r1.action, 'block');

  const r2 = await ops.contactBlock(sock, '2348012345678', 'unblock');
  assert.equal(r2.ok, true);
  assert.equal(r2.action, 'unblock');
});

test('47. contactBlock: rejects invalid action', async () => {
  const sock = mockSock();
  const r = await ops.contactBlock(sock, '2348012345678', 'ignore');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_action');
});

test('48. fetchBlocklist: fetches blocklist array', async () => {
  const sock = mockSock();
  const r = await ops.fetchBlocklist(sock);
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.deepEqual(r.blocklist, ['2348000000000@s.whatsapp.net']);
});

test('49. checkOnWhatsApp: verifies numbers on WhatsApp', async () => {
  const sock = mockSock();
  const r1 = await ops.checkOnWhatsApp(sock, '+234 801 234 5678');
  assert.equal(r1.ok, true);
  assert.equal(r1.exists, true);

  const r2 = await ops.checkOnWhatsApp(sock, '9999999');
  assert.equal(r2.ok, true);
  assert.equal(r2.exists, false);
});

test('50. checkOnWhatsApp: rejects empty number', async () => {
  const sock = mockSock();
  const r = await ops.checkOnWhatsApp(sock, 'abc');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_number');
});

// ----------------- PROFILE -----------------

test('51. profileUpdateBio: rejects bio over 139 characters', async () => {
  const sock = mockSock();
  const r = await ops.profileUpdateBio(sock, 'X'.repeat(140));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bio_too_long');
});

test('52. profileUpdateBio: updates valid bio', async () => {
  const sock = mockSock();
  const r = await ops.profileUpdateBio(sock, 'Available on WhatsApp');
  assert.equal(r.ok, true);
  assert.equal(r.bio, 'Available on WhatsApp');
});

test('53. profileUpdateName: rejects empty name and names over 25 characters', async () => {
  const sock = mockSock();
  const r1 = await ops.profileUpdateName(sock, '   ');
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'invalid_name');

  const r2 = await ops.profileUpdateName(sock, 'A'.repeat(26));
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'name_too_long');
});

test('54. profileUpdateName: updates valid display name', async () => {
  const sock = mockSock();
  const r = await ops.profileUpdateName(sock, 'Lohra');
  assert.equal(r.ok, true);
  assert.equal(r.name, 'Lohra');
});

// ----------------- STATUS POST -----------------

test('55. statusPost: rejects empty status text', async () => {
  const sock = mockSock();
  const r = await ops.statusPost(sock, { text: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_text');
});

test('56. statusPost: posts status text with color normalization', async () => {
  const sock = mockSock();
  const r = await ops.statusPost(sock, { text: 'Hello WhatsApp Status', backgroundColor: '25D366' });
  assert.equal(r.ok, true);
  assert.equal(r.backgroundColor, '#25D366');
  assert.equal(sock.sent[0].jid, 'status@broadcast');
  assert.equal(sock.sent[0].content.text, 'Hello WhatsApp Status');
});
