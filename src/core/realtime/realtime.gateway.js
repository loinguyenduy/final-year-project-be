let realtimeIo = null;

const USER_ROOM_PREFIX = 'user:';
const ROLE_ROOM_PREFIX = 'role:';
const getUserRoom = (userId) => `${USER_ROOM_PREFIX}${userId}`;
const getRoleRoom = (role) => `${ROLE_ROOM_PREFIX}${String(role).toUpperCase()}`;

const registerRealtimeIo = (io) => {
    realtimeIo = io;
};

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
