let realtimeIo = null;

const USER_ROOM_PREFIX = 'user:';
const getUserRoom = (userId) => `${USER_ROOM_PREFIX}${userId}`;

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

export {
    emitToUsers,
    getUserRoom,
    registerRealtimeIo
};
