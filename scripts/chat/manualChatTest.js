import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import db from '../../src/core/database/connection.js';
import User from '../../src/modules/identity/models/User.model.js';

dotenv.config();

const config = {
  serverUrl: process.env.CHAT_TEST_SERVER_URL || 'http://localhost:5000',
  customerToken: process.env.CHAT_TEST_CUSTOMER_TOKEN,
  handymanToken: process.env.CHAT_TEST_HANDYMAN_TOKEN,
  outsiderToken: process.env.CHAT_TEST_OUTSIDER_TOKEN,
  jobId: process.env.CHAT_TEST_JOB_ID,
  lifecycleJobId: process.env.CHAT_TEST_LIFECYCLE_JOB_ID,
  inactiveUserId: process.env.CHAT_TEST_INACTIVE_USER_ID,
  allowDbMutation: String(process.env.CHAT_TEST_ALLOW_DB_MUTATION || '').toLowerCase() === 'true',
  allowLifecycleMutation:
    String(process.env.CHAT_TEST_CONFIRM_LIFECYCLE_MUTATION || '').toLowerCase() === 'true'
};

const sockets = [];
let failures = 0;
let dbUsed = false;

const print = (kind, name, detail = '') => {
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`${kind} ${name}${suffix}`);
};

const assert = (condition, name, detail = '') => {
  if (condition) {
    print('PASS', name, detail);
    return;
  }
  failures += 1;
  print('FAIL', name, detail);
  throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
};

const expectCode = (response, code, name) => {
  const actual = response?.code || '<missing>';
  print('EXPECTED ERROR', name, code);
  print('ACTUAL RESPONSE', name, JSON.stringify(response));
  assert(actual === code, name, `expected=${code} actual=${actual}`);
};

const requireConfig = () => {
  const required = [
    ['CHAT_TEST_CUSTOMER_TOKEN', config.customerToken],
    ['CHAT_TEST_HANDYMAN_TOKEN', config.handymanToken],
    ['CHAT_TEST_OUTSIDER_TOKEN', config.outsiderToken],
    ['CHAT_TEST_JOB_ID', config.jobId]
  ];
  const missing = required.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('Manual chat verification is disabled in production.');
  }
};

const api = async (method, path, token, body = undefined) => {
  const response = await fetch(`${config.serverUrl}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json();
  return { status: response.status, payload };
};

const connectSocket = (token, label) => new Promise((resolve, reject) => {
  const socket = io(config.serverUrl, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000
  });
  sockets.push(socket);

  const timer = setTimeout(() => {
    socket.disconnect();
    reject(new Error(`${label} connection timed out.`));
  }, 7000);
  socket.once('connect', () => {
    clearTimeout(timer);
    print('PASS', `${label} connected`, socket.id);
    resolve(socket);
  });
  socket.once('connect_error', (error) => {
    clearTimeout(timer);
    reject(new Error(`${label} connect_error: ${JSON.stringify(error.data || error.message)}`));
  });
});

const expectInvalidConnection = () => new Promise((resolve, reject) => {
  const socket = io(config.serverUrl, {
    auth: { token: 'invalid-token' },
    transports: ['websocket'],
    reconnection: false,
    timeout: 3000
  });
  const timer = setTimeout(() => {
    socket.disconnect();
    reject(new Error('Invalid token connection was not rejected.'));
  }, 5000);
  socket.once('connect', () => {
    clearTimeout(timer);
    socket.disconnect();
    reject(new Error('Invalid token unexpectedly connected.'));
  });
  socket.once('connect_error', (error) => {
    clearTimeout(timer);
    print('EXPECTED ERROR', 'invalid token rejected', error.data?.code || error.message);
    socket.disconnect();
    resolve();
  });
});

const expectConnectionRejected = (token, expectedCode, label) => new Promise((resolve, reject) => {
  const socket = io(config.serverUrl, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    timeout: 3000
  });
  const timer = setTimeout(() => {
    socket.disconnect();
    reject(new Error(`${label} was not rejected.`));
  }, 5000);
  socket.once('connect', () => {
    clearTimeout(timer);
    socket.disconnect();
    reject(new Error(`${label} unexpectedly connected.`));
  });
  socket.once('connect_error', (error) => {
    clearTimeout(timer);
    const actualCode = error.data?.code;
    print('EXPECTED ERROR', label, expectedCode);
    print('ACTUAL RESPONSE', label, JSON.stringify(error.data || error.message));
    socket.disconnect();
    if (actualCode !== expectedCode) {
      reject(new Error(`${label}: expected=${expectedCode} actual=${actualCode}`));
      return;
    }
    resolve();
  });
});

const emitAck = (socket, event, payload, timeoutMs = 7000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${event} acknowledgement timed out.`)), timeoutMs);
  socket.emit(event, payload, (response) => {
    clearTimeout(timer);
    resolve(response);
  });
});

const waitForEvent = (socket, event, predicate = () => true, timeoutMs = 7000) => new Promise((resolve, reject) => {
  const handler = (payload) => {
    if (!predicate(payload)) return;
    clearTimeout(timer);
    socket.off(event, handler);
    resolve(payload);
  };
  const timer = setTimeout(() => {
    socket.off(event, handler);
    reject(new Error(`${event} timed out.`));
  }, timeoutMs);
  socket.on(event, handler);
});

const expectNoEvent = (socket, event, predicate = () => true, timeoutMs = 800) => new Promise((resolve, reject) => {
  const handler = (payload) => {
    if (!predicate(payload)) return;
    clearTimeout(timer);
    socket.off(event, handler);
    reject(new Error(`Unexpected ${event}: ${JSON.stringify(payload)}`));
  };
  const timer = setTimeout(() => {
    socket.off(event, handler);
    resolve();
  }, timeoutMs);
  socket.on(event, handler);
});

const joinConversation = async (socket, conversationId, label) => {
  const response = await emitAck(socket, 'conversation:join', { conversation_id: conversationId });
  assert(response.EC === 0, `${label} joined conversation`, JSON.stringify(response));
};

const runInactiveVerification = async ({ conversationId, customerSocket, handymanSocket }) => {
  if (!config.allowDbMutation || !config.inactiveUserId) {
    print(
      'EXPECTED ERROR',
      'inactive participant verification skipped',
      'requires CHAT_TEST_ALLOW_DB_MUTATION=true and CHAT_TEST_INACTIVE_USER_ID'
    );
    return;
  }

  await db.authenticate();
  dbUsed = true;
  const user = await User.findByPk(config.inactiveUserId);
  if (!user) throw new Error(`Inactive test user ${config.inactiveUserId} was not found.`);
  const decodedCustomer = jwt.decode(config.customerToken);
  const decodedHandyman = jwt.decode(config.handymanToken);
  if (![decodedCustomer?.id, decodedHandyman?.id].includes(user.id)) {
    throw new Error('CHAT_TEST_INACTIVE_USER_ID must be the configured customer or handyman.');
  }

  const originalActive = user.is_active;
  try {
    await user.update({ is_active: false });
    const inactiveIsCustomer = decodedCustomer.id === user.id;
    const activeSocket = inactiveIsCustomer ? handymanSocket : customerSocket;
    const inactiveSocket = inactiveIsCustomer ? customerSocket : handymanSocket;
    const inactiveToken = inactiveIsCustomer ? config.customerToken : config.handymanToken;

    const postConversation = await api(
      'POST',
      `/chat/jobs/${config.jobId}/conversation`,
      inactiveToken,
      {}
    );
    expectCode(postConversation.payload, 'PARTICIPANT_INACTIVE', 'inactive blocks POST conversation');

    const getConversation = await api(
      'GET',
      `/chat/jobs/${config.jobId}/conversation`,
      inactiveToken
    );
    expectCode(getConversation.payload, 'PARTICIPANT_INACTIVE', 'inactive blocks GET conversation');

    const getHistory = await api(
      'GET',
      `/chat/conversations/${conversationId}/messages?limit=1`,
      inactiveToken
    );
    expectCode(getHistory.payload, 'PARTICIPANT_INACTIVE', 'inactive blocks history');

    await expectConnectionRejected(inactiveToken, 'PARTICIPANT_INACTIVE', 'inactive reconnect');

    const response = await emitAck(activeSocket, 'message:send', {
      conversation_id: conversationId,
      client_message_id: randomUUID(),
      content: 'This message must be rejected while the partner is inactive.'
    });
    expectCode(response, 'PARTICIPANT_INACTIVE', 'partner inactive blocks send');

    const readResponse = await emitAck(inactiveSocket, 'conversation:read', {
      conversation_id: conversationId,
      last_message_id: randomUUID()
    });
    expectCode(readResponse, 'PARTICIPANT_INACTIVE', 'inactive caller blocks read');
  } finally {
    try {
      await user.update({ is_active: originalActive });
      print('PASS', 'inactive test user restored', user.id);
    } catch (restoreError) {
      failures += 1;
      console.error('FAIL CRITICAL: unable to restore is_active.', {
        user_id: user.id,
        error: restoreError.message
      });
    }
  }
};

const runLifecycleVerification = async (customerSocket, handymanSocket) => {
  if (!config.allowLifecycleMutation || !config.lifecycleJobId) {
    print(
      'EXPECTED ERROR',
      'lifecycle/refund verification skipped',
      'requires CHAT_TEST_CONFIRM_LIFECYCLE_MUTATION=true and CHAT_TEST_LIFECYCLE_JOB_ID'
    );
    return;
  }

  console.warn('ACTUAL RESPONSE lifecycle mutation will change the test job and may create a refund.');
  const create = await api(
    'POST',
    `/chat/jobs/${config.lifecycleJobId}/conversation`,
    config.customerToken,
    {}
  );
  assert([200, 201].includes(create.status), 'lifecycle conversation prepared', JSON.stringify(create.payload));
  const conversationId = create.payload.DT.conversation.id;

  if (!customerSocket.connected) customerSocket = await connectSocket(config.customerToken, 'customer lifecycle');
  if (!handymanSocket.connected) handymanSocket = await connectSocket(config.handymanToken, 'handyman lifecycle');
  await joinConversation(customerSocket, conversationId, 'customer lifecycle');
  await joinConversation(handymanSocket, conversationId, 'handyman lifecycle');

  const closedEvent = waitForEvent(
    handymanSocket,
    'conversation:closed',
    (payload) => payload.conversation_id === conversationId,
    10000
  );
  const cancellation = await api(
    'POST',
    `/matchmaking/jobs/${config.lifecycleJobId}/cancel-by-customer`,
    config.customerToken,
    {
      action: 'REOPEN_BIDDING',
      reason_code: 'HANDYMAN_NOT_SUITABLE',
      reason_text: 'Automated manual chat verification'
    }
  );
  assert(cancellation.status === 200, 'lifecycle cancellation succeeded', JSON.stringify(cancellation.payload));
  const eventPayload = await closedEvent;
  assert(
    eventPayload.reason === 'CUSTOMER_REOPEN_BIDDING',
    'conversation:closed emitted',
    JSON.stringify(eventPayload)
  );

  const rejected = await emitAck(handymanSocket, 'message:send', {
    conversation_id: conversationId,
    client_message_id: randomUUID(),
    content: 'Must be rejected after lifecycle close.'
  });
  expectCode(rejected, 'SOCKET_NOT_JOINED', 'room eviction after close');
};

const run = async () => {
  requireConfig();
  console.warn('Manual verification uses real development data. Do not use important jobs or accounts.');

  const created = await api('POST', `/chat/jobs/${config.jobId}/conversation`, config.customerToken, {});
  assert([200, 201].includes(created.status), 'conversation create/get', JSON.stringify(created.payload));
  const conversationId = created.payload.DT.conversation.id;

  const fetched = await api('GET', `/chat/jobs/${config.jobId}/conversation`, config.customerToken);
  assert(fetched.status === 200, 'conversation GET does not create', JSON.stringify(fetched.payload));

  await expectInvalidConnection();
  const customerPrimary = await connectSocket(config.customerToken, 'customer primary');
  const customerSecondTab = await connectSocket(config.customerToken, 'customer second tab');
  const handyman = await connectSocket(config.handymanToken, 'handyman');
  const outsider = await connectSocket(config.outsiderToken, 'outsider');

  await joinConversation(customerPrimary, conversationId, 'customer primary');
  await joinConversation(customerSecondTab, conversationId, 'customer second tab');
  await joinConversation(handyman, conversationId, 'handyman');
  const outsiderJoin = await emitAck(outsider, 'conversation:join', { conversation_id: conversationId });
  expectCode(outsiderJoin, 'CONVERSATION_NOT_FOUND', 'outsider join hidden');

  const clientMessageId = randomUUID();
  const handymanEvent = waitForEvent(handyman, 'message:new', (message) => (
    message.client_message_id === clientMessageId
  ));
  const secondTabEvent = waitForEvent(customerSecondTab, 'message:new', (message) => (
    message.client_message_id === clientMessageId
  ));
  const send = await emitAck(customerPrimary, 'message:send', {
    conversation_id: conversationId,
    client_message_id: clientMessageId,
    content: '  Xin chào\r\nTin nhắn kiểm thử NFC: e\u0301  '
  });
  assert(send.EC === 0 && !send.DT.duplicate, 'message saved before acknowledgement', JSON.stringify(send));
  await Promise.all([handymanEvent, secondTabEvent]);
  print('PASS', 'recipient and sender second tab received message:new');

  const noDuplicateRecipient = expectNoEvent(
    handyman,
    'message:new',
    (message) => message.client_message_id === clientMessageId
  );
  const duplicate = await emitAck(customerPrimary, 'message:send', {
    conversation_id: conversationId,
    client_message_id: clientMessageId,
    content: 'Xin chào\nTin nhắn kiểm thử NFC: é'
  });
  assert(duplicate.EC === 0 && duplicate.DT.duplicate, 'normalized duplicate returns existing message');
  await noDuplicateRecipient;
  print('PASS', 'duplicate retry was not emitted');

  const conflict = await emitAck(customerPrimary, 'message:send', {
    conversation_id: conversationId,
    client_message_id: clientMessageId,
    content: 'Different content'
  });
  expectCode(conflict, 'CLIENT_MESSAGE_ID_CONFLICT', 'client message id conflict');

  const history = await api(
    'GET',
    `/chat/conversations/${conversationId}/messages?limit=30`,
    config.customerToken
  );
  assert(
    history.status === 200
      && history.payload.DT.messages.some((message) => message.id === send.DT.message.id),
    'message persisted in REST history',
    JSON.stringify(history.payload)
  );

  const readEvent = waitForEvent(
    customerPrimary,
    'conversation:read_updated',
    (payload) => payload.last_read_message_id === send.DT.message.id
  );
  const read = await emitAck(handyman, 'conversation:read', {
    conversation_id: conversationId,
    last_message_id: send.DT.message.id
  });
  assert(read.EC === 0, 'read cursor advanced', JSON.stringify(read));
  await readEvent;
  print('PASS', 'sender received conversation:read_updated');

  const burstResponses = await Promise.all(
    Array.from({ length: 15 }, (_, index) => emitAck(customerPrimary, 'message:send', {
      conversation_id: conversationId,
      client_message_id: randomUUID(),
      content: `Rate limit verification ${index}`
    }, 15000))
  );
  assert(
    burstResponses.some((response) => response.code === 'RATE_LIMITED'),
    'rate limit rejects burst',
    JSON.stringify(burstResponses.map((response) => response.code))
  );

  await new Promise((resolve) => setTimeout(resolve, 2200));
  await runInactiveVerification({
    conversationId,
    customerSocket: customerPrimary,
    handymanSocket: handyman
  });

  // Destructive lifecycle/refund verification is deliberately last.
  await runLifecycleVerification(customerPrimary, handyman);
};

run()
  .catch((error) => {
    failures += 1;
    console.error('FAIL manual chat verification:', error.message);
  })
  .finally(async () => {
    for (const socket of sockets) socket.disconnect();
    if (dbUsed) {
      try {
        await db.close();
      } catch (_error) {
        // The DB connection is optional when mutation checks are disabled.
      }
    }
    process.exitCode = failures > 0 ? 1 : 0;
  });
