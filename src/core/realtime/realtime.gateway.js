let realtimeIo = null;

const USER_ROOM_PREFIX = 'user:';
const ROLE_ROOM_PREFIX = 'role:';
const getUserRoom = (userId) => `${USER_ROOM_PREFIX}${userId}`;
const getRoleRoom = (role) => `${ROLE_ROOM_PREFIX}${String(role).toUpperCase()}`;

const registerRealtimeIo = (io) => {
    realtimeIo = io;
};

// Emit 1 sự kiện đến tất cả các socket của một danh sách người dùng cụ thể. 
// Nếu realtimeIo chưa được khởi tạo, nó sẽ ghi cảnh báo và trả về false.
const emitToUsers = (userIds, eventName, payload) => {
    if (!realtimeIo) {
        console.warn('[realtime] Socket.IO is not initialized; lifecycle event was not emitted.', {
            event: eventName,
            recipient_count: new Set(userIds.filter(Boolean)).size
        });
        return false;
    }

    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
    uniqueUserIds.forEach(userId => {
        realtimeIo.to(getUserRoom(userId)).emit(eventName, payload);
    });
    return true;
};

// Emit 1 sự kiện đến tất cả các socket của một vai trò cụ thể.
const emitToRole = (role, eventName, payload) => {
    if (!realtimeIo) {
        console.warn('[realtime] Socket.IO is not initialized; role event was not emitted.', {
            event: eventName,
            role
        });
        return false;
    }
    realtimeIo.to(getRoleRoom(role)).emit(eventName, payload);
    return true;
};

// Ngắt kết nối tất cả các socket của một người dùng cụ thể.
const disconnectUserSockets = (userId) => {
    if (!realtimeIo) return false;
    realtimeIo.in(getUserRoom(userId)).disconnectSockets(true);
    return true;
};

export {
    emitToRole,
    emitToUsers,
    disconnectUserSockets,
    getRoleRoom,
    getUserRoom,
    registerRealtimeIo
};
