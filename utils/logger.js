const fs = require('fs');
const path = require('path');

class Logger {
  constructor(options = {}) {
    this.level = options.level || process.env.LOG_LEVEL || 'info';
    this.logFilePath = options.logFilePath || process.env.LOG_FILE_PATH || './logs/calendar-sync.log';
    this.enableConsole = options.enableConsole !== false;
    this.enableFile = options.enableFile !== false;
    
    // Níveis de log em ordem de prioridade
    this.levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3
    };
    
    // Criar diretório de logs se não existir
    this.ensureLogDirectory();
  }

  ensureLogDirectory() {
    const logDir = path.dirname(this.logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  shouldLog(level) {
    return this.levels[level] <= this.levels[this.level];
  }

  formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ` | ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  }

  log(level, message, meta = {}) {
    if (!this.shouldLog(level)) return;

    const formattedMessage = this.formatMessage(level, message, meta);

    // Log no console
    if (this.enableConsole) {
      const consoleMethod = level === 'error' ? 'error' : 
                           level === 'warn' ? 'warn' : 'log';
      console[consoleMethod](formattedMessage);
    }

    // Log no arquivo
    if (this.enableFile) {
      try {
        fs.appendFileSync(this.logFilePath, formattedMessage + '\n');
      } catch (error) {
        console.error('Failed to write to log file:', error.message);
      }
    }
  }

  error(message, meta = {}) {
    this.log('error', message, meta);
  }

  warn(message, meta = {}) {
    this.log('warn', message, meta);
  }

  info(message, meta = {}) {
    this.log('info', message, meta);
  }

  debug(message, meta = {}) {
    this.log('debug', message, meta);
  }

  // Método especial para logging de sincronização
  syncStart(companyId, integrationId) {
    this.info('🔄 Starting calendar sync', { 
      companyId, 
      integrationId,
      action: 'sync_start'
    });
  }

  syncSuccess(companyId, integrationId, eventsProcessed = 0, duration = 0) {
    this.info('✅ Calendar sync completed successfully', {
      companyId,
      integrationId,
      eventsProcessed,
      duration,
      action: 'sync_success'
    });
  }

  syncError(companyId, integrationId, error) {
    this.error('❌ Calendar sync failed', {
      companyId,
      integrationId,
      error: error.message,
      stack: error.stack,
      action: 'sync_error'
    });
  }

  batchStart(totalIntegrations) {
    this.info('🚀 Starting sync batch', {
      totalIntegrations,
      action: 'batch_start'
    });
  }

  batchComplete(processedCount, successCount, errorCount, duration) {
    this.info('🏁 Sync batch completed', {
      processedCount,
      successCount,
      errorCount,
      duration,
      action: 'batch_complete'
    });
  }

  healthCheck(status, details = {}) {
    this.info('🏥 Health check', {
      status,
      ...details,
      action: 'health_check'
    });
  }
}

// Instância singleton do logger
const logger = new Logger();

module.exports = logger; 
