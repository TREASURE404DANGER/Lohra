// Baileys Operations Layer: wraps Baileys socket calls with validation, standard timeouts, error mapping, and safety checks.
import { spawn } from 'node:child_process';
import { digitsOf } from '../src/bot.js';

const err = (error, message, extra = {}) => ({ ok: false, error, message, ...extra });

export const ffmpegBin = () => process.env.FFMPEG_PATH || 'ffmpeg';

export function execFfmpeg(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegBin();
    let p;
    try {
      p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new Error(`Failed to spawn ffmpeg: ${e.message}`));
    }
    let stderr = '';
    p.stderr?.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    p.on('error', (e) => {
      clearTimeout(timer);
      p.kill?.();
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`));
    });
  });
}

function checkSock(sock) {
  if (!sock || typeof sock !== 'object') {
    return err('bot_offline', 'The WhatsApp bot is not connected right now.', { retryable: true });
  }
  return null;
}

export function normalizeJid(target, defaultDomain = 's.whatsapp.net') {
  if (!target) return '';
  const s = String(target).trim();
  if (s.includes('@')) return s;
  const d = digitsOf(s);
  return d ? `${d}@${defaultDomain}` : '';
}

export function normalizeGroupJid(target) {
  if (!target) return '';
  const s = String(target).trim();
  if (s.endsWith('@g.us')) return s;
  const d = digitsOf(s);
  return d ? `${d}@g.us` : '';
}

// ----------------- GROUPS -----------------

export async function groupInfo(sock, groupJid) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeGroupJid(groupJid);
  if (!jid) return err('invalid_group', 'Invalid group identifier (expected @g.us or digits).');
  try {
    const meta = await sock.groupMetadata(jid);
    if (!meta) return err('not_found', 'Group not found or bot is not a participant.');
    const participants = meta.participants || [];
    const admins = participants.filter((p) => p.admin || p.isAdmin || p.isSuperAdmin).map((p) => p.id);
    return {
      ok: true,
      id: meta.id,
      subject: meta.subject || '',
      owner: meta.owner || meta.subjectOwner || '',
      creation: meta.creation || null,
      desc: meta.desc || '',
      participantsCount: participants.length,
      participants: participants.map((p) => ({
        id: p.id,
        admin: p.admin || (p.isSuperAdmin ? 'superadmin' : p.isAdmin ? 'admin' : null),
      })),
      admins,
      announce: !!meta.announce,
      restrict: !!meta.restrict,
      ephemeralDuration: meta.ephemeralDuration || 0,
    };
  } catch (e) {
    return err('group_info_failed', `Could not fetch group info: ${e.message}`, { code: e.output?.statusCode });
  }
}

export async function groupList(sock) {
  const offline = checkSock(sock);
  if (offline) return offline;
  try {
    const list = await sock.groupFetchAllParticipating();
    const groups = Object.values(list || {}).map((g) => ({
      id: g.id,
      subject: g.subject || '',
      participantsCount: (g.participants || []).length,
      announce: !!g.announce,
      restrict: !!g.restrict,
    }));
    return { ok: true, count: groups.length, groups };
  } catch (e) {
    return err('group_list_failed', `Could not list groups: ${e.message}`);
  }
}

export async function groupParticipantsUpdate(sock, groupJid, participants, action) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeGroupJid(groupJid);
  if (!jid) return err('invalid_group', 'Invalid group identifier.');
  if (!['add', 'remove', 'promote', 'demote'].includes(action)) {
    return err('invalid_action', `Invalid participant action "${action}". Expected add, remove, promote, or demote.`);
  }
  const parts = (Array.isArray(participants) ? participants : [participants])
    .map((p) => normalizeJid(p, 's.whatsapp.net'))
    .filter(Boolean);
  if (!parts.length) return err('invalid_participants', 'No valid participant JIDs or phone numbers provided.');

  try {
    const res = await sock.groupParticipantsUpdate(jid, parts, action);
    return { ok: true, action, group: jid, participants: parts, result: res };
  } catch (e) {
    const statusCode = e.output?.statusCode;
    const msg = statusCode === 403 ? 'Bot lacks admin permission in this group.' : e.message;
    return err('group_action_failed', msg, { statusCode });
  }
}

export async function groupSettingUpdate(sock, groupJid, setting) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeGroupJid(groupJid);
  if (!jid) return err('invalid_group', 'Invalid group identifier.');
  const valid = ['announcement', 'not_announcement', 'locked', 'unlocked'];
  if (!valid.includes(setting)) {
    return err('invalid_setting', `Setting must be one of: ${valid.join(', ')}.`);
  }
  try {
    await sock.groupSettingUpdate(jid, setting);
    return { ok: true, group: jid, setting };
  } catch (e) {
    const statusCode = e.output?.statusCode;
    const msg = statusCode === 403 ? 'Bot lacks admin permission to change group settings.' : e.message;
    return err('group_setting_failed', msg, { statusCode });
  }
}

export async function groupUpdateSubject(sock, groupJid, subject) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeGroupJid(groupJid);
  if (!jid) return err('invalid_group', 'Invalid group identifier.');
  const sub = String(subject || '').trim();
  if (!sub) return err('invalid_subject', 'Group subject cannot be empty.');
  if (sub.length > 100) return err('invalid_subject', 'Group subject too long (max 100 chars).');
  try {
    await sock.groupUpdateSubject(jid, sub);
    return { ok: true, group: jid, subject: sub };
  } catch (e) {
    const statusCode = e.output?.statusCode;
    const msg = statusCode === 403 ? 'Bot lacks admin permission to update group subject.' : e.message;
    return err('group_subject_failed', msg, { statusCode });
  }
}

export async function groupUpdateDescription(sock, groupJid, description) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeGroupJid(groupJid);
  if (!jid) return err('invalid_group', 'Invalid group identifier.');
  const desc = String(description ?? '').trim();
  try {
    await sock.groupUpdateDescription(jid, desc);
    return { ok: true, group: jid, description: desc };
  } catch (e) {
    const statusCode = e.output?.statusCode;
    const msg = statusCode === 403 ? 'Bot lacks admin permission to update group description.' : e.message;
    return err('group_desc_failed', msg, { statusCode });
  }
}

export async function groupInvite(sock, groupJid, action = 'code') {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeGroupJid(groupJid);
  if (!jid) return err('invalid_group', 'Invalid group identifier.');
  try {
    if (action === 'revoke') {
      const code = await sock.groupRevokeInvite(jid);
      return { ok: true, group: jid, revoked: true, newCode: code };
    }
    const code = await sock.groupInviteCode(jid);
    const link = code ? `https://chat.whatsapp.com/${code}` : null;
    return { ok: true, group: jid, code, link };
  } catch (e) {
    return err('group_invite_failed', `Could not manage group invite: ${e.message}`);
  }
}

export async function groupRequests(sock, groupJid, action = 'list', participants = []) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeGroupJid(groupJid);
  if (!jid) return err('invalid_group', 'Invalid group identifier.');
  try {
    if (action === 'list') {
      const list = await sock.groupRequestParticipantsList(jid);
      return { ok: true, group: jid, requests: list || [] };
    }
    if (!['approve', 'reject'].includes(action)) {
      return err('invalid_action', 'Action must be list, approve, or reject.');
    }
    const parts = (Array.isArray(participants) ? participants : [participants])
      .map((p) => normalizeJid(p, 's.whatsapp.net'))
      .filter(Boolean);
    if (!parts.length) return err('invalid_participants', 'No valid participants provided.');
    const res = await sock.groupRequestParticipantsUpdate(jid, parts, action);
    return { ok: true, group: jid, action, result: res };
  } catch (e) {
    return err('group_requests_failed', `Could not update join requests: ${e.message}`);
  }
}

export async function groupTagAll(sock, groupJid, text = '') {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeGroupJid(groupJid);
  if (!jid) return err('invalid_group', 'Invalid group identifier.');
  try {
    const meta = await sock.groupMetadata(jid);
    const participants = (meta?.participants || []).map((p) => p.id);
    if (!participants.length) return err('no_participants', 'No participants found in group.');
    const mentionsText = participants.map((p) => `@${digitsOf(p)}`).join(' ');
    const fullText = text ? `${text.trim()}\n\n${mentionsText}` : mentionsText;
    const res = await sock.sendMessage(jid, { text: fullText, mentions: participants });
    return { ok: true, group: jid, msgId: res?.key?.id, mentionedCount: participants.length };
  } catch (e) {
    return err('group_tagall_failed', `Could not tag all members: ${e.message}`);
  }
}

// ----------------- MESSAGES -----------------

export async function messageEdit(sock, chatJid, key, newText) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeJid(chatJid, 's.whatsapp.net');
  if (!jid) return err('invalid_chat', 'Invalid chat identifier.');
  const text = String(newText || '').trim();
  if (!text) return err('invalid_text', 'New message text cannot be empty.');
  const targetKey = typeof key === 'string' ? { remoteJid: jid, id: key, fromMe: true } : key;
  if (!targetKey?.id) return err('invalid_key', 'Message key or id is required.');
  try {
    const res = await sock.sendMessage(jid, { text, edit: targetKey });
    return { ok: true, chat: jid, msgId: res?.key?.id || targetKey.id, newText: text };
  } catch (e) {
    return err('message_edit_failed', `Could not edit message: ${e.message}`);
  }
}

export async function messageDelete(sock, chatJid, key) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeJid(chatJid, 's.whatsapp.net');
  if (!jid) return err('invalid_chat', 'Invalid chat identifier.');
  const targetKey = typeof key === 'string' ? { remoteJid: jid, id: key, fromMe: true } : key;
  if (!targetKey?.id) return err('invalid_key', 'Message key or id is required.');
  try {
    await sock.sendMessage(jid, { delete: targetKey });
    return { ok: true, chat: jid, deletedId: targetKey.id };
  } catch (e) {
    return err('message_delete_failed', `Could not delete message: ${e.message}`);
  }
}

export async function messagePin(sock, chatJid, key, durationHours = 24) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeJid(chatJid, 's.whatsapp.net');
  if (!jid) return err('invalid_chat', 'Invalid chat identifier.');
  const targetKey = typeof key === 'string' ? { remoteJid: jid, id: key, fromMe: true } : key;
  if (!targetKey?.id) return err('invalid_key', 'Message key or id is required.');
  const hours = durationHours !== undefined && durationHours !== null ? Number(durationHours) : 24;
  const timeSec = hours > 0 ? hours * 3600 : 0;
  const type = timeSec > 0 ? 1 : 0;
  try {
    await sock.sendMessage(jid, { pin: targetKey, type, time: timeSec });
    return { ok: true, chat: jid, msgId: targetKey.id, pinned: type === 1, durationHours: hours };
  } catch (e) {
    return err('message_pin_failed', `Could not pin/unpin message: ${e.message}`);
  }
}

export async function messageReact(sock, chatJid, key, emoji) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeJid(chatJid, 's.whatsapp.net');
  if (!jid) return err('invalid_chat', 'Invalid chat identifier.');
  const targetKey = typeof key === 'string' ? { remoteJid: jid, id: key, fromMe: false } : key;
  if (!targetKey?.id) return err('invalid_key', 'Message key or id is required.');
  const em = String(emoji ?? '').trim();
  try {
    await sock.sendMessage(jid, { react: { text: em, key: targetKey } });
    return { ok: true, chat: jid, msgId: targetKey.id, emoji: em };
  } catch (e) {
    return err('message_react_failed', `Could not react to message: ${e.message}`);
  }
}

export async function messagePoll(sock, chatJid, question, options, selectableCount = 1) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeJid(chatJid, 's.whatsapp.net');
  if (!jid) return err('invalid_chat', 'Invalid chat identifier.');
  const q = String(question || '').trim();
  if (!q) return err('invalid_question', 'Poll question cannot be empty.');
  const opts = (Array.isArray(options) ? options : String(options || '').split(','))
    .map((o) => String(o).trim())
    .filter(Boolean);
  if (opts.length < 2) return err('invalid_options', 'Poll must have at least 2 options.');
  if (opts.length > 12) return err('invalid_options', 'Poll cannot have more than 12 options.');
  try {
    const res = await sock.sendMessage(jid, {
      poll: {
        name: q,
        values: opts,
        selectableCount: Math.max(1, Math.min(opts.length, Number(selectableCount) || 1)),
      },
    });
    return { ok: true, chat: jid, msgId: res?.key?.id, question: q, options: opts };
  } catch (e) {
    return err('message_poll_failed', `Could not create poll: ${e.message}`);
  }
}

export async function messageStar(sock, chatJid, key, star = true) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeJid(chatJid, 's.whatsapp.net');
  if (!jid) return err('invalid_chat', 'Invalid chat identifier.');
  const targetKey = typeof key === 'string' ? { remoteJid: jid, id: key, fromMe: true } : key;
  if (!targetKey?.id) return err('invalid_key', 'Message key or id is required.');
  try {
    await sock.chatModify(
      { star: { messages: [{ id: targetKey.id, fromMe: !!targetKey.fromMe }], star: !!star } },
      jid
    );
    return { ok: true, chat: jid, msgId: targetKey.id, starred: !!star };
  } catch (e) {
    return err('message_star_failed', `Could not star/unstar message: ${e.message}`);
  }
}

// ----------------- CHATS -----------------

export async function chatMute(sock, chatJid, durationHours = 8) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeJid(chatJid, 's.whatsapp.net');
  if (!jid) return err('invalid_chat', 'Invalid chat identifier.');
  const hours = Number(durationHours) || 8;
  const muteVal = hours > 0 ? hours * 3600_000 : 30 * 86400_000;
  try {
    await sock.chatModify({ mute: muteVal }, jid);
    return { ok: true, chat: jid, muted: true, durationHours: hours };
  } catch (e) {
    return err('chat_mute_failed', `Could not mute chat: ${e.message}`);
  }
}

export async function chatUnmute(sock, chatJid) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeJid(chatJid, 's.whatsapp.net');
  if (!jid) return err('invalid_chat', 'Invalid chat identifier.');
  try {
    await sock.chatModify({ mute: null }, jid);
    return { ok: true, chat: jid, unmuted: true };
  } catch (e) {
    return err('chat_unmute_failed', `Could not unmute chat: ${e.message}`);
  }
}

export async function chatArchive(sock, chatJid, archive = true) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeJid(chatJid, 's.whatsapp.net');
  if (!jid) return err('invalid_chat', 'Invalid chat identifier.');
  try {
    await sock.chatModify({ archive: !!archive }, jid);
    return { ok: true, chat: jid, archived: !!archive };
  } catch (e) {
    return err('chat_archive_failed', `Could not modify chat archive status: ${e.message}`);
  }
}

export async function chatClear(sock, chatJid) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeJid(chatJid, 's.whatsapp.net');
  if (!jid) return err('invalid_chat', 'Invalid chat identifier.');
  try {
    await sock.chatModify({ delete: true, lastMessages: [{ key: { remoteJid: jid } }] }, jid);
    return { ok: true, chat: jid, cleared: true };
  } catch (e) {
    return err('chat_clear_failed', `Could not clear chat: ${e.message}`);
  }
}

// ----------------- CONTACTS & PRIVACY -----------------

export async function contactBlock(sock, contactJid, action = 'block') {
  const offline = checkSock(sock);
  if (offline) return offline;
  const jid = normalizeJid(contactJid, 's.whatsapp.net');
  if (!jid) return err('invalid_contact', 'Invalid contact identifier.');
  if (!['block', 'unblock'].includes(action)) {
    return err('invalid_action', 'Action must be "block" or "unblock".');
  }
  try {
    await sock.updateBlockStatus(jid, action);
    return { ok: true, contact: jid, action };
  } catch (e) {
    return err('contact_block_failed', `Could not update block status: ${e.message}`);
  }
}

export async function fetchBlocklist(sock) {
  const offline = checkSock(sock);
  if (offline) return offline;
  try {
    const list = await sock.fetchBlocklist();
    return { ok: true, count: (list || []).length, blocklist: list || [] };
  } catch (e) {
    return err('blocklist_failed', `Could not fetch blocklist: ${e.message}`);
  }
}

export async function checkOnWhatsApp(sock, number) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const num = digitsOf(number);
  if (!num) return err('invalid_number', 'Invalid phone number.');
  try {
    const hits = await sock.onWhatsApp(`${num}@s.whatsapp.net`);
    const hit = hits?.[0];
    return {
      ok: true,
      number: num,
      exists: !!hit?.exists,
      jid: hit?.jid || `${num}@s.whatsapp.net`,
    };
  } catch (e) {
    return err('check_failed', `Could not verify number on WhatsApp: ${e.message}`);
  }
}

// ----------------- PROFILE -----------------

export async function profileUpdateBio(sock, text) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const bio = String(text ?? '').trim();
  if (bio.length > 139) return err('bio_too_long', 'About/bio cannot exceed 139 characters.');
  try {
    await sock.updateProfileStatus(bio);
    return { ok: true, bio };
  } catch (e) {
    return err('profile_bio_failed', `Could not update profile bio: ${e.message}`);
  }
}

export async function profileUpdateName(sock, name) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const n = String(name ?? '').trim();
  if (!n) return err('invalid_name', 'Profile name cannot be empty.');
  if (n.length > 25) return err('name_too_long', 'Profile name cannot exceed 25 characters.');
  try {
    await sock.updateProfileName(n);
    return { ok: true, name: n };
  } catch (e) {
    return err('profile_name_failed', `Could not update profile name: ${e.message}`);
  }
}

// ----------------- STATUS POSTING -----------------

export async function statusPost(sock, { text, backgroundColor = '#128C7E', font = 1 } = {}) {
  const offline = checkSock(sock);
  if (offline) return offline;
  const t = String(text || '').trim();
  if (!t) return err('invalid_text', 'Status text cannot be empty.');
  const color = String(backgroundColor).startsWith('#') ? backgroundColor : `#${backgroundColor}`;
  try {
    const res = await sock.sendMessage('status@broadcast', {
      text: t,
      backgroundColor: color,
      font: Number(font) || 1,
    });
    return { ok: true, statusPostId: res?.key?.id, text: t, backgroundColor: color };
  } catch (e) {
    return err('status_post_failed', `Could not post status: ${e.message}`);
  }
}

// ----------------- MEDIA CONVERSIONS -----------------

export async function convertToWebpSticker(inputPath, outputPath) {
  const args = [
    '-y',
    '-v', 'error',
    '-i', inputPath,
    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
    '-c:v', 'libwebp',
    '-lossless', '1',
    '-q:v', '70',
    '-loop', '0',
    '-an',
    outputPath,
  ];
  return execFfmpeg(args, 45_000);
}

export async function extractAudioMp3(inputPath, outputPath) {
  const args = [
    '-y',
    '-v', 'error',
    '-i', inputPath,
    '-vn',
    '-c:a', 'libmp3lame',
    '-q:a', '2',
    outputPath,
  ];
  return execFfmpeg(args, 60_000);
}

export async function convertToPtt(inputPath, outputPath) {
  const args = [
    '-y',
    '-v', 'error',
    '-i', inputPath,
    '-vn',
    '-c:a', 'libopus',
    '-b:a', '24k',
    '-ar', '16000',
    '-ac', '1',
    outputPath,
  ];
  return execFfmpeg(args, 60_000);
}
