import { CHAT_EVENTS, getConversationRoom } from '../constants/chat.constants.js';

let chatIo = null;

const registerChatIo = (io) => {
  chatIo = io;
};

const emitConversationClosedAndEvict = (payload) => {
  if (!chatIo) {
    console.warn('[chat] Socket.IO is not initialized; conversation:closed was not emitted.', {
      conversation_id: payload.conversation_id,
      job_id: payload.job_id
    });
    return false;
  }

  const room = getConversationRoom(payload.conversation_id);
  chatIo.to(room).emit(CHAT_EVENTS.CLOSED, payload);
  chatIo.in(room).socketsLeave(room);
  return true;
};

export { emitConversationClosedAndEvict, registerChatIo };
