import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import { initDatabase, db } from './core/database/setup.js';
import { initCronJobs, stopCronJobs } from './core/cron/index.js';
import v1Routes from './core/routes/v1.routes.js';
import passport from './core/middlewares/passport.middleware.js';
import { initializeSystemWallets } from './modules/fintech/services/Wallet.service.js';
import { initializeChatSocket } from './modules/chat/sockets/chat.socket.js';
import { correlationIdMiddleware } from './core/middlewares/correlationId.middleware.js';
import { getRefreshCookieOptions } from './modules/identity/utils/authCookie.util.js';
import { getFrontendOrigin } from './core/config/publicUrls.config.js';
import { assertProductionBootstrapEnvironment } from './core/config/environmentValidation.js';

dotenv.config();
assertProductionBootstrapEnvironment();
getRefreshCookieOptions();

const app = express();
// Tạo máy chủ HTTP để sử dụng với Socket.IO.
const httpServer = createServer(app); 
let io = null;
let ready = false;
let shuttingDown = false;

//Proxy là một máy chủ trung gian giữa client và server, giúp bảo vệ server gốc, 
// cải thiện hiệu suất và cung cấp các tính năng bổ sung như cân bằng tải, bộ nhớ đệm và bảo mật.
const trustProxy = String(process.env.TRUST_PROXY || '').trim();
if (trustProxy && !['false', '0'].includes(trustProxy.toLowerCase())) {
  const parsedTrustProxy = trustProxy.toLowerCase() === 'true'
    ? true
    : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy;
  app.set('trust proxy', parsedTrustProxy);
}

app.use(express.json());
app.use(
  cors({
    origin: getFrontendOrigin({ required: false }) || false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID'],
    exposedHeaders: ['X-Correlation-ID'],
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(passport.initialize());
app.use(correlationIdMiddleware);
app.use('/api/v1', v1Routes);

app.get('/health', (_req, res) => {
  if (!ready) return res.status(503).json({ status: 'starting' });
  return res.status(200).json({ status: 'ok' });
});
app.get('/', (_req, res) => {
  res.send('Trusted Handyman API is running');
});

const PORT = process.env.PORT || 5000;

// Đóng máy chủ HTTP
const closeHttpServer = () => new Promise((resolve) => {
  if (!httpServer.listening) return resolve();
  return httpServer.close(() => resolve());
});

// Đóng máy chủ Socket.IO
const closeSocketServer = () => new Promise((resolve) => {
  if (!io) return resolve();
  return io.close(() => resolve());
});

// Xử lý tín hiệu tắt máy chủ (SIGTERM, SIGINT) để thực hiện các bước dọn dẹp trước khi thoát.
const shutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  console.log(`Received ${signal}; shutting down.`);

  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Shutdown timed out.')), 10_000);
    timer.unref();
  });
  const cleanup = (async () => {
    await stopCronJobs();
    await Promise.all([closeHttpServer(), closeSocketServer()]);
    await db.close();
  })();

  try {
    await Promise.race([cleanup, timeout]);
    console.log('Shutdown completed.');
    process.exit(exitCode);
  } catch (error) {
    console.error('Shutdown failed:', error?.message || 'unknown error');
    process.exit(1);
  }
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

// Khởi động máy chủ HTTP, kết nối cơ sở dữ liệu, khởi tạo ví hệ thống và các công việc định kỳ.
const start = async () => {
  await initDatabase();
  const walletSummary = await initializeSystemWallets();
  console.log('System Wallet initialization completed.', walletSummary);
  initCronJobs();
  io = initializeChatSocket(httpServer);
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PORT, () => {
      httpServer.off('error', reject);
      ready = true;
      console.log(`Server ready on port ${PORT}.`);
      resolve();
    });
  });
};

start().catch(async (error) => {
  console.error('Backend startup failed:', error?.message || 'unknown error');
  await shutdown('startup failure', 1);
});
