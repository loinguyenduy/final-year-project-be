import { Server } from 'socket.io';
import User from '../../identity/models/User.model.js';
import {
  CHAT_EVENTS,
  getConversationRoom
} from '../constants/chat.constants.js';
import { getConversationForJoinService } from '../services/Conversation.service.js';
import { sendMessageService } from '../services/Message.service.js';
import { markConversationReadService } from '../services/ReadState.service.js';
import { ChatError, chatError, toErrorEnvelope } from '../utils/chatError.util.js';
import { consumeMessageToken } from '../utils/chatRateLimiter.util.js';
import { isPlainObject, isValidUuid } from '../utils/chatValidation.util.js';
import { registerChatIo } from './chat.gateway.js';
import { authenticateSocket } from './socketAuth.middleware.js';
import {
  getRoleRoom,
  getUserRoom,
  registerRealtimeIo
} from '../../../core/realtime/realtime.gateway.js';
import {
  getFrontendOrigin,
  parseOrigin,
} from '../../../core/config/publicUrls.config.js';


const emitProtocolError = (socket, envelope) => socket.emit(CHAT_EVENTS.ERROR, envelope);

// Hàm check xem callback có được cung cấp hay không
const requireAcknowledgement = (socket, ack) => {
  if (typeof ack === 'function') return true;
  emitProtocolError(socket, {
    EM: 'This event requires an acknowledgement callback.',
    EC: 400,
    code: 'SOCKET_ACK_REQUIRED',
    DT: ''
  });
  return false;
};

// Hàm refresh thông tin người dùng từ cơ sở dữ liệu và kiểm tra trạng thái của người dùng
const refreshSocketUser = async (socket) => {
  const user = await User.findByPk(socket.data.user.id);
  if (!user || !user.is_active) {
    throw chatError(
      'User account is inactive.',
      409,
      'PARTICIPANT_INACTIVE',
      { caller_inactive: true }
    );
  }
  if (Number(socket.data.user.auth_version || 0) !== Number(user.auth_version || 0)) {
    throw chatError('This session has been revoked.', 401, 'SESSION_REVOKED', { caller_inactive: true });
  }
  if (!['CUSTOMER', 'HANDYMAN'].includes(user.role)) {
    throw chatError('User is not allowed to use chat.', 403, 'SOCKET_UNAUTHORIZED');
  }
  socket.data.user = { id: user.id, role: user.role, full_name: user.full_name, auth_version: Number(user.auth_version || 0) };
  return user;
};

// Xử lý lỗi cho các sự kiện socket, bao gồm việc log lỗi, gửi phản hồi lỗi và ngắt kết nối nếu cần thiết
const handleEventError = (socket, ack, error, operation) => {
  if (!(error instanceof ChatError)) {
    console.error(`[chat] Socket ${operation} failed.`, {
      socket_id: socket.id,
      user_id: socket.data.user?.id,
      error
    });
  }
  const envelope = toErrorEnvelope(error);
  if (typeof ack === 'function') ack(envelope);
  else emitProtocolError(socket, envelope);

  if (error instanceof ChatError && error.dt?.caller_inactive) {
    setImmediate(() => socket.disconnect(true));
  }
};

// Đăng ký các trình xử lý sự kiện chat cho socket, bao gồm join, leave, send message và read
const registerChatHandlers = (socket) => {
  socket.on(CHAT_EVENTS.JOIN, async (payload, ack) => {
    if (!requireAcknowledgement(socket, ack)) return;
    try {
      await refreshSocketUser(socket);
      if (!isPlainObject(payload) || !isValidUuid(payload.conversation_id)) {
        throw chatError('Invalid conversation_id.', 400, 'VALIDATION_ERROR');
      }
      const conversation = await getConversationForJoinService(
        payload.conversation_id,
        socket.data.user.id
      );
      const room = getConversationRoom(conversation.id);
      await socket.join(room);
      ack({
        EM: 'Conversation joined successfully.',
        EC: 0,
        code: 'CONVERSATION_JOINED',
        DT: { conversation }
      });
    } catch (error) {
      handleEventError(socket, ack, error, 'join');
    }
  });

  socket.on(CHAT_EVENTS.LEAVE, async (payload, ack) => {
    if (!requireAcknowledgement(socket, ack)) return;
    try {
      if (!isPlainObject(payload) || !isValidUuid(payload.conversation_id)) {
        throw chatError('Invalid conversation_id.', 400, 'VALIDATION_ERROR');
      }
      await socket.leave(getConversationRoom(payload.conversation_id));
      ack({
        EM: 'Conversation left successfully.',
        EC: 0,
        code: 'CONVERSATION_LEFT',
        DT: { conversation_id: payload.conversation_id }
      });
    } catch (error) {
      handleEventError(socket, ack, error, 'leave');
    }
  });

  // Xử lý sự kiện gửi tin nhắn, bao gồm xác thực người dùng, kiểm tra payload, 
  // kiểm tra giới hạn tốc độ và gửi tin nhắn
  socket.on(CHAT_EVENTS.SEND_MESSAGE, async (payload, ack) => {
    if (!requireAcknowledgement(socket, ack)) return;
    try {
      await refreshSocketUser(socket);
      if (!isPlainObject(payload) || !isValidUuid(payload.conversation_id)) {
        throw chatError('Invalid message payload.', 400, 'VALIDATION_ERROR');
      }
      const room = getConversationRoom(payload.conversation_id);
      if (!socket.rooms.has(room)) {
        throw chatError('Socket must join the conversation first.', 409, 'SOCKET_NOT_JOINED');
      }

      const rate = consumeMessageToken(socket.data.user.id);
      if (!rate.allowed) {
        throw chatError('Message rate limit exceeded.', 429, 'RATE_LIMITED', {
          retry_after_ms: rate.retryAfterMs
        });
      }

      const result = await sendMessageService({
        conversationId: payload.conversation_id,
        senderId: socket.data.user.id,
        clientMessageId: payload.client_message_id,
        content: payload.content
      });
      ack({
        EM: result.duplicate ? 'Message already saved.' : 'Message sent successfully.',
        EC: 0,
        code: result.duplicate ? 'MESSAGE_DUPLICATE' : 'MESSAGE_SENT',
        DT: result
      });

      if (!result.duplicate) {
        socket.to(room).emit(CHAT_EVENTS.NEW_MESSAGE, result.message);
      }
    } catch (error) {
      handleEventError(socket, ack, error, 'send');
    }
  });

  // Xử lý sự kiện đánh dấu tin nhắn đã đọc, 
  // bao gồm xác thực người dùng và cập nhật trạng thái đọc
  socket.on(CHAT_EVENTS.READ, async (payload, ack) => {
    if (!requireAcknowledgement(socket, ack)) return;
    try {
      await refreshSocketUser(socket);
      if (!isPlainObject(payload) || !isValidUuid(payload.conversation_id)) {
        throw chatError('Invalid read payload.', 400, 'VALIDATION_ERROR');
      }
      const room = getConversationRoom(payload.conversation_id);
      if (!socket.rooms.has(room)) {
        throw chatError('Socket must join the conversation first.', 409, 'SOCKET_NOT_JOINED');
      }

      const result = await markConversationReadService({
        conversationId: payload.conversation_id,
        userId: socket.data.user.id,
        lastMessageId: payload.last_message_id
      });
      ack({
        EM: 'Conversation read state updated.',
        EC: 0,
        code: 'READ_STATE_UPDATED',
        DT: result
      });

      if (result.advanced) {
        const { advanced: _advanced, ...eventPayload } = result;
        socket.to(room).emit(CHAT_EVENTS.READ_UPDATED, eventPayload);
      }
    } catch (error) {
      handleEventError(socket, ack, error, 'read');
    }
  });
};

// Hàm phân tích và xác thực các nguồn gốc CORS cho Socket.IO, đảm bảo rằng chúng hợp lệ và không chứa ký tự đại diện khi xác thực được bật
const parseCorsOrigins = () => {
  const raw = process.env.SOCKET_CORS_ORIGIN
    || process.env.FRONTEND_URL
    || getFrontendOrigin({ required: false });
  if (!raw) return false;
  const origins = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (origins.includes('*')) {
    throw new Error('SOCKET_CORS_ORIGIN cannot be * when credentials are enabled.');
  }
  origins.forEach((origin) => parseOrigin(origin, 'SOCKET_CORS_ORIGIN'));
  return origins.length === 1 ? origins[0] : origins;
};

// Khởi tạo server socket
const initializeChatSocket = (httpServer) => {
  // Tạo một instance của Socket.IO server với cấu hình CORS
  const io = new Server(httpServer, {
    cors: {
      origin: parseCorsOrigins(),
      credentials: true,
      methods: ['GET', 'POST']
    }
  });

  io.use(authenticateSocket); // Middleware xác thực socket trước khi xử lý các sự kiện
  io.on('connection', (socket) => {
    socket.join(getUserRoom(socket.data.user.id));
    if (socket.data.user.role === 'ADMIN') {
      socket.join(getRoleRoom('ADMIN'));
    }
    console.info('[realtime] Socket connected.', {
      socket_id: socket.id,
      user_id: socket.data.user.id,
      role: socket.data.user.role
    });
    if (['CUSTOMER', 'HANDYMAN'].includes(socket.data.user.role)) {
      registerChatHandlers(socket);
    }
    socket.on('disconnect', (reason) => {
      console.info('[realtime] Socket disconnected.', {
        socket_id: socket.id,
        user_id: socket.data.user.id,
        reason
      });
    });
  });

  registerChatIo(io);
  registerRealtimeIo(io);
  return io;
};

export { initializeChatSocket };
