'use strict';

const readline = require('node:readline');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');

const ICLOUD = Object.freeze({
  imapHost: 'imap.mail.me.com',
  imapPort: 993,
  smtpHost: 'smtp.mail.me.com',
  smtpPort: 587,
});

const MAX_BODY_CHARS = 20000;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SECRET_KEYS = Object.freeze({
  a: 'icloud_mail_app_password',
  b: 'icloud_mail_app_password_b',
});

function normalizeCredentials(value) {
  const input = value && typeof value === 'object' ? value : {};
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const appSpecificPassword = typeof input.appSpecificPassword === 'string'
    ? input.appSpecificPassword.replace(/\s+/g, '').trim()
    : '';
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error('INVALID_EMAIL');
  if (
    appSpecificPassword.length < 8
    || appSpecificPassword.length > 128
    || /[\r\n\0]/.test(appSpecificPassword)
  ) {
    throw new Error('INVALID_APP_SPECIFIC_PASSWORD');
  }
  return { email, appSpecificPassword };
}

/**
 * Reads the credentials the host injected temporarily for this JSON-RPC request. This
 * field never comes from the plugin main.js and only methods bound in ghost.json receive
 * it; the reference on the request object is cleared right after it is read.
 */
function consumeRequestCredentials(request) {
  const params = request.params && typeof request.params === 'object' ? request.params : {};
  const cindy = request.cindy && typeof request.cindy === 'object' ? request.cindy : {};
  const secrets = cindy.secrets && typeof cindy.secrets === 'object' ? cindy.secrets : {};
  const credentialSlot = params.credentialSlot === undefined ? 'a' : params.credentialSlot;
  const rawCode = credentialSlot === 'a' || credentialSlot === 'b'
    ? secrets[SECRET_KEYS[credentialSlot]]
    : undefined;
  Object.values(SECRET_KEYS).forEach((key) => {
    secrets[key] = '';
  });
  if (credentialSlot !== 'a' && credentialSlot !== 'b') {
    throw new Error('INVALID_CREDENTIAL_SLOT');
  }
  return normalizeCredentials({
    email: params.email,
    appSpecificPassword: rawCode,
  });
}

function normalizeRecipients(value, required) {
  let items = [];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') items = value.split(',');
  const normalized = items.map((entry) => String(entry).trim()).filter(Boolean);
  if (required && normalized.length === 0) throw new Error('RECIPIENT_REQUIRED');
  if (normalized.length > 50 || normalized.some((entry) => !EMAIL_RE.test(entry))) {
    throw new Error('INVALID_RECIPIENT');
  }
  return normalized;
}

function parseSearchDate(value, field) {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`INVALID_${field.toUpperCase()}`);
  return date;
}

function buildSearchCriteria(action) {
  const criteria = {};
  if (typeof action.from === 'string' && action.from.trim()) criteria.from = action.from.trim();
  if (typeof action.to === 'string' && action.to.trim()) criteria.to = action.to.trim();
  if (typeof action.subject === 'string' && action.subject.trim()) criteria.subject = action.subject.trim();
  if (typeof action.unread === 'boolean') criteria.seen = !action.unread;
  const since = parseSearchDate(action.since, 'since');
  const before = parseSearchDate(action.before, 'before');
  if (since) criteria.since = since;
  if (before) criteria.before = before;
  if (typeof action.text === 'string' && action.text.trim()) {
    const text = action.text.trim();
    criteria.or = [
      { subject: text },
      { from: text },
      { to: text },
      { body: text },
    ];
  }
  if (Object.keys(criteria).length === 0) criteria.all = true;
  return criteria;
}

function addressText(value) {
  if (!Array.isArray(value)) return '';
  return value.map((entry) => {
    const address = entry && entry.address ? String(entry.address) : '';
    const name = entry && entry.name ? String(entry.name) : '';
    return name && address ? `${name} <${address}>` : address || name;
  }).filter(Boolean).join(', ');
}

function flagsArray(flags) {
  return flags && typeof flags[Symbol.iterator] === 'function' ? Array.from(flags) : [];
}

function summaryFromMessage(message, folder) {
  const envelope = message.envelope || {};
  const flags = flagsArray(message.flags);
  return {
    uid: message.uid,
    folder,
    from: addressText(envelope.from),
    to: addressText(envelope.to),
    subject: envelope.subject || '',
    date: (envelope.date || message.internalDate || null)
      ? new Date(envelope.date || message.internalDate).toISOString()
      : null,
    unread: !flags.includes('\\Seen'),
    flagged: flags.includes('\\Flagged'),
    size: Number.isFinite(message.size) ? message.size : null,
  };
}

function imapOptions(credentials) {
  return {
    host: ICLOUD.imapHost,
    port: ICLOUD.imapPort,
    secure: true,
    auth: {
      user: credentials.email,
      pass: credentials.appSpecificPassword,
    },
    disableAutoIdle: true,
    emitLogs: false,
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  };
}

function smtpOptions(credentials) {
  return {
    host: ICLOUD.smtpHost,
    port: ICLOUD.smtpPort,
    secure: false,
    requireTLS: true,
    pool: false,
    auth: {
      user: credentials.email,
      pass: credentials.appSpecificPassword,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

function createRuntimeDeps() {
  return {
    createImap(credentials) {
      return new ImapFlow(imapOptions(credentials));
    },
    createSmtp(credentials) {
      return nodemailer.createTransport(smtpOptions(credentials));
    },
    createComposer() {
      return nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: 'windows',
      });
    },
    parseMessage(source) {
      return simpleParser(source, {
        keepCidLinks: true,
        skipHtmlToText: false,
        skipTextToHtml: true,
        maxHtmlLengthToParse: 2 * 1024 * 1024,
      });
    },
  };
}

async function withImap(credentials, deps, operation) {
  const client = deps.createImap(credentials);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await operation(client);
  } finally {
    if (connected) {
      try {
        await client.logout();
      } catch (_error) {
        try {
          client.close();
        } catch (_closeError) {
          // The connection is already closing; ignore.
        }
      }
    } else {
      try {
        client.close();
      } catch (_error) {
        // Never connected; nothing else to do.
      }
    }
  }
}

async function withMailbox(client, folder, operation) {
  let lock;
  try {
    lock = await client.getMailboxLock(folder);
    return await operation();
  } finally {
    if (lock) lock.release();
  }
}

async function listFolders(credentials, deps) {
  return withImap(credentials, deps, async (client) => {
    const folders = await client.list();
    return {
      folders: folders.map((folder) => ({
        path: folder.path,
        name: folder.name || folder.path,
        delimiter: folder.delimiter || null,
        special_use: folder.specialUse || null,
        selectable: !(folder.flags && folder.flags.has && folder.flags.has('\\Noselect')),
      })),
    };
  });
}

async function search(credentials, action, deps) {
  const folder = action.folder || 'INBOX';
  const maxResults = Number.isInteger(action.max_results)
    ? Math.min(20, Math.max(1, action.max_results))
    : 10;
  return withImap(credentials, deps, (client) => withMailbox(client, folder, async () => {
    const uids = await client.search(buildSearchCriteria(action), { uid: true });
    const selected = uids.slice(-maxResults).reverse();
    if (selected.length === 0) return { folder, total: 0, messages: [] };
    const messages = await client.fetchAll(
      selected,
      { uid: true, envelope: true, flags: true, internalDate: true, size: true },
      { uid: true },
    );
    const byUid = new Map(messages.map((message) => [message.uid, message]));
    return {
      folder,
      total: uids.length,
      messages: selected.map((uid) => byUid.get(uid)).filter(Boolean)
        .map((message) => summaryFromMessage(message, folder)),
    };
  }));
}

async function readMessage(credentials, action, deps) {
  const folder = action.folder || 'INBOX';
  return withImap(credentials, deps, (client) => withMailbox(client, folder, async () => {
    const message = await client.fetchOne(
      action.message_uid,
      { uid: true, envelope: true, flags: true, internalDate: true, size: true },
      { uid: true },
    );
    if (!message) throw new Error('MESSAGE_NOT_FOUND');
    if (Number.isFinite(message.size) && message.size > MAX_SOURCE_BYTES) {
      throw new Error('MESSAGE_TOO_LARGE');
    }

    const downloaded = await client.download(
      action.message_uid,
      undefined,
      { uid: true, maxBytes: MAX_SOURCE_BYTES + 1 },
    );
    if (!downloaded || !downloaded.content) throw new Error('MESSAGE_NOT_FOUND');
    if (
      downloaded.meta
      && Number.isFinite(downloaded.meta.expectedSize)
      && downloaded.meta.expectedSize > MAX_SOURCE_BYTES
    ) {
      downloaded.content.destroy();
      throw new Error('MESSAGE_TOO_LARGE');
    }

    const chunks = [];
    let sourceBytes = 0;
    for await (const chunk of downloaded.content) {
      sourceBytes += chunk.length;
      if (sourceBytes > MAX_SOURCE_BYTES) {
        downloaded.content.destroy();
        throw new Error('MESSAGE_TOO_LARGE');
      }
      chunks.push(chunk);
    }
    const parsed = await deps.parseMessage(Buffer.concat(chunks, sourceBytes));
    const text = typeof parsed.text === 'string' && parsed.text.trim()
      ? parsed.text
      : typeof parsed.html === 'string'
        ? parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : '';
    return {
      ...summaryFromMessage(message, folder),
      cc: parsed.cc && parsed.cc.text ? parsed.cc.text : '',
      reply_to: parsed.replyTo && parsed.replyTo.text ? parsed.replyTo.text : '',
      message_id: parsed.messageId || '',
      body_text: text.length > MAX_BODY_CHARS
        ? `${text.slice(0, MAX_BODY_CHARS)}\n... (body too long, truncated)`
        : text,
      attachments: Array.isArray(parsed.attachments)
        ? parsed.attachments.map((attachment) => ({
            filename: attachment.filename || null,
            content_type: attachment.contentType || null,
            size: Number.isFinite(attachment.size) ? attachment.size : null,
          }))
        : [],
    };
  }));
}

function mailOptions(credentials, action) {
  const to = normalizeRecipients(action.to, true);
  const cc = normalizeRecipients(action.cc, false);
  const bcc = normalizeRecipients(action.bcc, false);
  if (typeof action.subject !== 'string' || /[\r\n\0]/.test(action.subject)) {
    throw new Error('INVALID_SUBJECT');
  }
  if (typeof action.body_text !== 'string') throw new Error('INVALID_BODY');
  if (action.subject.length > 998 || action.body_text.length > 500000) {
    throw new Error('MESSAGE_TOO_LARGE');
  }
  return {
    from: credentials.email,
    to,
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    subject: action.subject,
    text: action.body_text,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

async function sendMessage(credentials, action, deps) {
  const transporter = deps.createSmtp(credentials);
  try {
    const info = await transporter.sendMail(mailOptions(credentials, action));
    return {
      sent: true,
      message_id: info.messageId || null,
      accepted: Array.isArray(info.accepted) ? info.accepted.map(String) : [],
      rejected: Array.isArray(info.rejected) ? info.rejected.map(String) : [],
    };
  } finally {
    if (transporter && typeof transporter.close === 'function') transporter.close();
  }
}

async function findDraftFolder(client) {
  const folders = await client.list();
  const special = folders.find((folder) => folder.specialUse === '\\Drafts');
  if (special) return special.path;
  const fallback = folders.find((folder) => /(^|[/])drafts?$|草稿箱/i.test(folder.path));
  if (fallback) return fallback.path;
  throw new Error('DRAFT_FOLDER_NOT_FOUND');
}

async function saveDraft(credentials, action, deps) {
  const composer = deps.createComposer();
  try {
    const info = await composer.sendMail(mailOptions(credentials, action));
    if (!info || !Buffer.isBuffer(info.message)) throw new Error('DRAFT_BUILD_FAILED');
    return withImap(credentials, deps, async (client) => {
      const folder = await findDraftFolder(client);
      const appended = await client.append(folder, info.message, ['\\Draft'], new Date());
      if (!appended) throw new Error('DRAFT_SAVE_FAILED');
      return {
        draft: true,
        folder,
        uid: appended && appended.uid ? appended.uid : null,
        uid_validity: appended && appended.uidValidity ? String(appended.uidValidity) : null,
      };
    });
  } finally {
    if (composer && typeof composer.close === 'function') composer.close();
  }
}

async function changeFlags(credentials, action, deps, seen) {
  const folder = action.folder || 'INBOX';
  return withImap(credentials, deps, (client) => withMailbox(client, folder, async () => {
    const existing = await client.fetchOne(
      action.message_uid,
      { uid: true, flags: true },
      { uid: true },
    );
    if (!existing) throw new Error('MESSAGE_NOT_FOUND');

    const currentFlags = flagsArray(existing.flags);
    if (currentFlags.includes('\\Seen') !== seen) {
      const updated = seen
        ? await client.messageFlagsAdd(action.message_uid, ['\\Seen'], { uid: true })
        : await client.messageFlagsRemove(action.message_uid, ['\\Seen'], { uid: true });
      if (!updated) throw new Error('MESSAGE_NOT_FOUND');

      const verified = await client.fetchOne(
        action.message_uid,
        { uid: true, flags: true },
        { uid: true },
      );
      if (!verified) throw new Error('MESSAGE_NOT_FOUND');
      if (flagsArray(verified.flags).includes('\\Seen') !== seen) {
        throw new Error('MESSAGE_UPDATE_FAILED');
      }
    }
    return { updated: true, folder, uid: action.message_uid, unread: !seen };
  }));
}

async function moveMessage(credentials, action, deps) {
  const folder = action.folder || 'INBOX';
  const target = typeof action.target_folder === 'string' ? action.target_folder.trim() : '';
  if (!target) throw new Error('TARGET_FOLDER_REQUIRED');
  if (target === folder) throw new Error('TARGET_FOLDER_SAME');
  return withImap(credentials, deps, (client) => withMailbox(client, folder, async () => {
    const existing = await client.fetchOne(
      action.message_uid,
      { uid: true },
      { uid: true },
    );
    if (!existing) throw new Error('MESSAGE_NOT_FOUND');

    const moved = await client.messageMove(action.message_uid, target, { uid: true });
    if (!moved) throw new Error('MESSAGE_NOT_FOUND');
    const destinationUid = moved.uidMap && moved.uidMap.get
      ? (moved.uidMap.get(action.message_uid) || null)
      : null;
    if (!destinationUid) throw new Error('MESSAGE_MOVE_UNCONFIRMED');
    return {
      moved: true,
      from_folder: folder,
      to_folder: target,
      uid: action.message_uid,
      destination_uid: destinationUid,
    };
  }));
}

async function testAccount(credentials, deps) {
  await withImap(credentials, deps, async () => undefined);
  const transporter = deps.createSmtp(credentials);
  try {
    await transporter.verify();
  } finally {
    if (transporter && typeof transporter.close === 'function') transporter.close();
  }
  return {
    connected: true,
    email: credentials.email,
    imap: `${ICLOUD.imapHost}:${ICLOUD.imapPort}`,
    smtp: `${ICLOUD.smtpHost}:${ICLOUD.smtpPort}`,
  };
}

async function performAction(credentials, action, deps) {
  switch (action.action) {
    case 'list_folders':
      return listFolders(credentials, deps);
    case 'search':
      return search(credentials, action, deps);
    case 'read':
      return readMessage(credentials, action, deps);
    case 'send':
      return sendMessage(credentials, action, deps);
    case 'draft':
      return saveDraft(credentials, action, deps);
    case 'mark_read':
      return changeFlags(credentials, action, deps, true);
    case 'mark_unread':
      return changeFlags(credentials, action, deps, false);
    case 'move':
      return moveMessage(credentials, action, deps);
    default:
      throw new Error('UNKNOWN_ACTION');
  }
}

function humanizeError(error) {
  const code = error && error.code ? String(error.code) : '';
  const message = error && error.message ? String(error.message) : String(error || '');
  const combined = `${code} ${message}`.toLowerCase();

  if (message === 'INVALID_EMAIL') return 'Enter a valid iCloud Mail email address';
  if (message === 'INVALID_APP_SPECIFIC_PASSWORD') {
    return 'Enter the app-specific password generated on the Apple Account website, not your Apple Account password';
  }
  if (message === 'NOT_CONFIGURED') {
    return 'iCloud Mail is not configured yet. Open the "iCloud Mail (Rui)" plugin details and enter the email address and app-specific password.';
  }
  if (message === 'INVALID_CREDENTIAL_SLOT') {
    return 'Invalid iCloud Mail credential state. Reconnect in the plugin details.';
  }
  if (
    code === 'EAUTH'
    || combined.includes('authenticationfailed')
    || combined.includes('authentication failed')
    || combined.includes('invalid credentials')
    || combined.includes('login failed')
  ) {
    return 'iCloud Mail rejected the login. Make sure two-factor authentication is on for the Apple Account and use a generated app-specific password (not the Apple Account password).';
  }
  if (
    code === 'ETIMEDOUT'
    || code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'ENETUNREACH'
    || combined.includes('timed out')
  ) {
    return 'Cannot reach the iCloud Mail server. Check your network connection and try again.';
  }
  if (combined.includes('too many') || combined.includes('rate limit') || combined.includes('频繁')) {
    return 'iCloud Mail is temporarily rate limiting frequent access. Try again later.';
  }
  if (message === 'MESSAGE_NOT_FOUND') return 'This message was not found in the given folder. Search again.';
  if (message === 'MESSAGE_TOO_LARGE') return 'The message is too large for this version to handle';
  if (message === 'DRAFT_FOLDER_NOT_FOUND') {
    return 'No iCloud Mail Drafts folder found. Call list_folders first to check the server folders.';
  }
  if (message === 'DRAFT_SAVE_FAILED') {
    return 'iCloud Mail could not save the draft. Try again later.';
  }
  if (message === 'TARGET_FOLDER_REQUIRED') return 'move requires a target folder';
  if (message === 'TARGET_FOLDER_SAME') return 'The target folder cannot be the same as the current folder';
  if (message === 'MESSAGE_MOVE_UNCONFIRMED') {
    return 'Could not confirm whether the message was moved. Search the mailbox again before doing anything else.';
  }
  if (message === 'RECIPIENT_REQUIRED') return 'Provide at least one recipient';
  if (message === 'INVALID_RECIPIENT') return 'Invalid To, Cc, or Bcc address format';
  if (message === 'INVALID_SUBJECT') return 'Invalid subject format';
  if (message === 'INVALID_BODY') return 'Invalid body format';
  if (message.startsWith('INVALID_SINCE') || message.startsWith('INVALID_BEFORE')) {
    return 'Invalid search date. Use an ISO date or date-time.';
  }
  if (combined.includes('mailbox') || combined.includes('folder')) {
    return 'The iCloud Mail folder does not exist or is unavailable. Call list_folders first to get the exact name.';
  }
  return 'iCloud Mail operation failed. Try again later.';
}

async function handleRequest(request, deps = createRuntimeDeps()) {
  if (!request || typeof request !== 'object') throw new Error('INVALID_REQUEST');
  let credentials = null;
  try {
    const params = request.params && typeof request.params === 'object' ? request.params : {};
    const methodMatch = /^(account\/connect|mail\/action)-([ab])$/.exec(request.method);
    if (!methodMatch) throw new Error('METHOD_NOT_FOUND');
    const method = methodMatch[1];
    const credentialSlot = methodMatch[2];
    if (params.credentialSlot !== undefined && params.credentialSlot !== credentialSlot) {
      throw new Error('INVALID_CREDENTIAL_SLOT');
    }
    const boundRequest = {
      ...request,
      params: {
        ...params,
        credentialSlot,
      },
    };
    if (method === 'account/connect') {
      credentials = consumeRequestCredentials(boundRequest);
      const tested = await testAccount(credentials, deps);
      return { ...tested, persistence: 'cindy-safe-storage' };
    }
    if (method === 'mail/action') {
      credentials = consumeRequestCredentials(boundRequest);
      const action = params.action && typeof params.action === 'object' ? params.action : {};
      return await performAction(credentials, action, deps);
    }
    throw new Error('METHOD_NOT_FOUND');
  } catch (error) {
    throw new Error(humanizeError(error));
  } finally {
    if (credentials) credentials.appSpecificPassword = '';
  }
}

function writeReply(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function startStdio() {
  readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch (_error) {
      writeReply({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Invalid request format' },
      });
      return;
    }
    void handleRequest(request)
      .then((result) => {
        writeReply({ jsonrpc: '2.0', id: request.id, result });
      })
      .catch((error) => {
        writeReply({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32000,
            message: error && error.message ? error.message : 'iCloud Mail operation failed',
          },
        });
      });
  });
}

if (require.main === module) startStdio();

module.exports = {
  ICLOUD,
  buildSearchCriteria,
  createRuntimeDeps,
  consumeRequestCredentials,
  handleRequest,
  humanizeError,
  imapOptions,
  normalizeCredentials,
  normalizeRecipients,
  performAction,
  smtpOptions,
  startStdio,
  summaryFromMessage,
};
