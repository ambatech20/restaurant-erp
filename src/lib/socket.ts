'use client';

import { io, Socket } from 'socket.io-client';

let socketInstance: Socket | null = null;

/** Socket.io needs the custom server; Vercel only runs the Next.js handler. */
const REALTIME_DISABLED = Boolean(process.env.NEXT_PUBLIC_VERCEL_ENV);

export function getSocket(): Socket | null {
  if (REALTIME_DISABLED) return null;
  if (!socketInstance) {
    socketInstance = io({
      path: '/api/socketio',
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
  }
  return socketInstance;
}

export function disconnectSocket(): void {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
  }
}
