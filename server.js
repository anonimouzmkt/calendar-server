#!/usr/bin/env node

require('dotenv').config();
const cron = require('node-cron');
const http = require('http');
const logger = require('./utils/logger');
const performanceMonitor = require('./utils/performanceMonitor');
const rateLimiter = require('./utils/rateLimiter');
const { testConnection } = require('./services/supabaseService');
const GoogleCalendarSyncService = require('./services/googleCalendarSyncService');

// =====================================
// 🔧 CONFIGURAÇÃO
// =====================================

// ✅ NOVO: Suporte a segundos para polling mais frequente
const POLLING_INTERVAL_SECONDS = parseInt(process.env.POLLING_INTERVAL_SECONDS || '60');
const PORT = parseInt(process.env.PORT || '3002');
const HEALTH_CHECK_PORT = parseInt(process.env.HEALTH_CHECK_PORT || '3003');
const ENABLE_HEALTH_CHECK = process.env.ENABLE_HEALTH_CHECK === 'true';

// Validar configuração
if (POLLING_INTERVAL_SECONDS < 5 || POLLING_INTERVAL_SECONDS > 3600) {
  logger.error('❌ POLLING_INTERVAL_SECONDS deve estar entre 5 segundos e 3600 segundos (1 hora)');
  process.exit(1);
}

// =====================================
// 🔧 INICIALIZAÇÃO
// =====================================

let syncService;
let isRunning = false;
let lastSyncTime = null;
let syncStats = {
  totalRuns: 0,
  successfulRuns: 0,
  failedRuns: 0,
  lastError: null
};

// =====================================
// 🚀 FUNÇÃO PRINCIPAL DE SYNC
// =====================================

async function performSync() {
  if (isRunning) {
    logger.warn('⚠️ Sync already running, skipping this cycle');
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    logger.info('⏰ Starting scheduled sync cycle');
    
    await syncService.syncAllIntegrations();
    
    syncStats.successfulRuns++;
    syncStats.lastError = null;
    lastSyncTime = new Date();
    
    const duration = Date.now() - startTime;
    logger.info(`✅ Sync cycle completed successfully in ${duration}ms`);
    
  } catch (error) {
    syncStats.failedRuns++;
    syncStats.lastError = {
      message: error.message,
      time: new Date(),
      stack: error.stack
    };
    
    logger.error('❌ Sync cycle failed', { 
      error: error.message,
      stack: error.stack
    });
  } finally {
    syncStats.totalRuns++;
    isRunning = false;
  }
}

// =====================================
// 🏥 HEALTH CHECK SERVER
// =====================================

function createHealthCheckServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        polling: {
          interval: `${POLLING_INTERVAL_SECONDS} second(s)`,
          isRunning,
          lastSyncTime,
          stats: syncStats
        },
        performance: performanceMonitor.getPerformanceReport(),
        rateLimiter: rateLimiter.getStats(),
        memory: process.memoryUsage(),
        pid: process.pid
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));
      
      logger.healthCheck('ok', { endpoint: '/health' });
    } else if (req.url === '/metrics' && req.method === 'GET') {
      const metrics = performanceMonitor.getSummary();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics, null, 2));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(HEALTH_CHECK_PORT, () => {
    logger.info(`🏥 Health check server running on port ${HEALTH_CHECK_PORT}`);
    logger.info(`   → http://localhost:${HEALTH_CHECK_PORT}/health`);
  });

  return server;
}

// =====================================
// 🔄 CONFIGURAÇÃO DO CRON
// =====================================

function setupCronJob() {
  let cronExpression;
  let intervalDescription;

  if (POLLING_INTERVAL_SECONDS >= 60) {
    // Intervalo em minutos (para intervalos >= 60 segundos)
    const intervalMinutes = Math.floor(POLLING_INTERVAL_SECONDS / 60);
    cronExpression = `*/${intervalMinutes} * * * *`;
    intervalDescription = `${intervalMinutes} minute(s)`;
  } else {
    // Intervalo em segundos (para intervalos < 60 segundos)
    cronExpression = `*/${POLLING_INTERVAL_SECONDS} * * * * *`;
    intervalDescription = `${POLLING_INTERVAL_SECONDS} second(s)`;
  }
  
  logger.info(`⏰ Setting up cron job with interval: ${intervalDescription}`);
  logger.info(`   → Cron expression: ${cronExpression}`);
  
  const task = cron.schedule(cronExpression, performSync, {
    scheduled: false, // Não iniciar automaticamente
    timezone: 'UTC'   // Usar UTC para consistência
  });

  return task;
}

// =====================================
// 🛡️ TRATAMENTO DE SINAIS
// =====================================

function setupGracefulShutdown(cronTask, healthServer) {
  const shutdown = (signal) => {
    logger.info(`📟 Received ${signal}, initiating graceful shutdown...`);
    
    // Parar cron job
    if (cronTask) {
      cronTask.stop();
      logger.info('⏹️ Cron job stopped');
    }
    
    // Parar health check server
    if (healthServer) {
      healthServer.close(() => {
        logger.info('🏥 Health check server stopped');
      });
    }
    
    // Aguardar sync atual terminar
    if (isRunning) {
      logger.info('⏳ Waiting for current sync to complete...');
      const checkInterval = setInterval(() => {
        if (!isRunning) {
          clearInterval(checkInterval);
          logger.info('✅ Graceful shutdown completed');
          process.exit(0);
        }
      }, 1000);
      
      // Timeout de 30 segundos para shutdown forçado
      setTimeout(() => {
        logger.warn('⚠️ Forcing shutdown after timeout');
        process.exit(1);
      }, 30000);
    } else {
      logger.info('✅ Graceful shutdown completed');
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGUSR2', () => shutdown('SIGUSR2')); // nodemon restart
}

// =====================================
// 🚀 INICIALIZAÇÃO DO SERVIDOR
// =====================================

async function startServer() {
  try {
    logger.info('🚀 Starting Calendar Sync Server...');
    logger.info(`📅 Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`⏰ Polling interval: ${POLLING_INTERVAL_SECONDS} second(s)`);
    
    // Testar conexão com Supabase
    logger.info('🔍 Testing Supabase connection...');
    const connectionOk = await testConnection();
    if (!connectionOk) {
      logger.error('❌ Failed to connect to Supabase');
      process.exit(1);
    }
    
    // Inicializar serviço de sincronização
    syncService = new GoogleCalendarSyncService();
    logger.info('✅ Google Calendar sync service initialized');
    
    // Configurar cron job
    const cronTask = setupCronJob();
    
    // Configurar health check server (se habilitado)
    let healthServer = null;
    if (ENABLE_HEALTH_CHECK) {
      healthServer = createHealthCheckServer();
    }
    
    // Configurar graceful shutdown
    setupGracefulShutdown(cronTask, healthServer);
    
    // Executar uma sincronização inicial (opcional)
    if (process.env.RUN_INITIAL_SYNC !== 'false') {
      logger.info('🔄 Running initial sync...');
      setTimeout(performSync, 5000); // Aguardar 5 segundos para inicialização completa
    }
    
    // Iniciar cron job
    cronTask.start();
    logger.info('✅ Cron job started');
    
    // Configurar logging periódico de métricas (a cada 15 minutos)
    const metricsLoggingInterval = setInterval(() => {
      performanceMonitor.logPeriodicSummary();
    }, 15 * 60 * 1000);
    
    // Cleanup do interval no shutdown
    process.on('exit', () => {
      clearInterval(metricsLoggingInterval);
    });
    
    logger.info('🎉 Calendar Sync Server is running!');
    logger.info('───────────────────────────────────────');
    logger.info(`⏰ Next sync in: ${POLLING_INTERVAL_SECONDS} second(s)`);
    
    if (ENABLE_HEALTH_CHECK) {
      logger.info(`🏥 Health check: http://localhost:${HEALTH_CHECK_PORT}/health`);
      logger.info(`📊 Metrics: http://localhost:${HEALTH_CHECK_PORT}/metrics`);
    }
    
    logger.info('📋 Logs location: ./logs/calendar-sync.log');
    logger.info('🛑 Press Ctrl+C to stop');
    logger.info('───────────────────────────────────────');
    
  } catch (error) {
    logger.error('💥 Failed to start server:', error);
    process.exit(1);
  }
}

// =====================================
// 🎬 PONTO DE ENTRADA
// =====================================

// Verificar se estamos rodando como script principal
if (require.main === module) {
  startServer().catch(error => {
    logger.error('💥 Unhandled error during startup:', error);
    process.exit(1);
  });
}

module.exports = {
  startServer,
  performSync,
  syncStats
}; 
