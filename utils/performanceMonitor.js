const logger = require('./logger');

class PerformanceMonitor {
  constructor() {
    this.metrics = {
      syncCycles: {
        total: 0,
        successful: 0,
        failed: 0,
        averageDuration: 0,
        lastDuration: 0,
        minDuration: Infinity,
        maxDuration: 0
      },
      integrations: {
        totalProcessed: 0,
        successful: 0,
        failed: 0,
        averageDuration: 0
      },
      events: {
        totalProcessed: 0,
        created: 0,
        updated: 0,
        cancelled: 0
      },
      api: {
        totalRequests: 0,
        successful: 0,
        failed: 0,
        averageResponseTime: 0,
        rateLimitHits: 0
      },
      errors: {
        tokenRefreshErrors: 0,
        apiErrors: 0,
        databaseErrors: 0,
        networkErrors: 0
      }
    };
    
    this.recentSyncs = [];
    this.maxRecentSyncs = 100;
    this.startTime = Date.now();
  }

  /**
   * Registrar início de ciclo de sincronização
   */
  startSyncCycle() {
    return {
      startTime: Date.now(),
      integrationsProcessed: 0,
      eventsProcessed: 0
    };
  }

  /**
   * Registrar fim de ciclo de sincronização
   */
  endSyncCycle(syncData, success = true, error = null) {
    const duration = Date.now() - syncData.startTime;
    
    this.metrics.syncCycles.total++;
    this.metrics.syncCycles.lastDuration = duration;
    
    if (success) {
      this.metrics.syncCycles.successful++;
    } else {
      this.metrics.syncCycles.failed++;
    }
    
    // Atualizar estatísticas de duração
    this.metrics.syncCycles.minDuration = Math.min(this.metrics.syncCycles.minDuration, duration);
    this.metrics.syncCycles.maxDuration = Math.max(this.metrics.syncCycles.maxDuration, duration);
    this.metrics.syncCycles.averageDuration = this.calculateRunningAverage(
      this.metrics.syncCycles.averageDuration,
      duration,
      this.metrics.syncCycles.total
    );
    
    // Manter histórico de syncs recentes
    this.recentSyncs.push({
      timestamp: new Date(),
      duration,
      success,
      integrationsProcessed: syncData.integrationsProcessed,
      eventsProcessed: syncData.eventsProcessed,
      error: error?.message
    });
    
    if (this.recentSyncs.length > this.maxRecentSyncs) {
      this.recentSyncs.shift();
    }
    
    logger.debug('📊 Sync cycle metrics updated', {
      duration,
      success,
      totalCycles: this.metrics.syncCycles.total,
      successRate: this.getSuccessRate('syncCycles')
    });
  }

  /**
   * Registrar processamento de integração
   */
  recordIntegrationSync(duration, success = true, eventsProcessed = 0) {
    this.metrics.integrations.totalProcessed++;
    
    if (success) {
      this.metrics.integrations.successful++;
    } else {
      this.metrics.integrations.failed++;
    }
    
    this.metrics.integrations.averageDuration = this.calculateRunningAverage(
      this.metrics.integrations.averageDuration,
      duration,
      this.metrics.integrations.totalProcessed
    );
    
    this.metrics.events.totalProcessed += eventsProcessed;
  }

  /**
   * Registrar processamento de evento
   */
  recordEventProcessing(eventType) {
    switch (eventType) {
      case 'created':
        this.metrics.events.created++;
        break;
      case 'updated':
        this.metrics.events.updated++;
        break;
      case 'cancelled':
        this.metrics.events.cancelled++;
        break;
    }
  }

  /**
   * Registrar chamada de API
   */
  recordApiCall(duration, success = true) {
    this.metrics.api.totalRequests++;
    
    if (success) {
      this.metrics.api.successful++;
    } else {
      this.metrics.api.failed++;
    }
    
    this.metrics.api.averageResponseTime = this.calculateRunningAverage(
      this.metrics.api.averageResponseTime,
      duration,
      this.metrics.api.totalRequests
    );
  }

  /**
   * Registrar hit de rate limit
   */
  recordRateLimitHit() {
    this.metrics.api.rateLimitHits++;
    logger.warn('🚫 Rate limit hit recorded');
  }

  /**
   * Registrar erro por tipo
   */
  recordError(errorType, error) {
    switch (errorType) {
      case 'token_refresh':
        this.metrics.errors.tokenRefreshErrors++;
        break;
      case 'api':
        this.metrics.errors.apiErrors++;
        break;
      case 'database':
        this.metrics.errors.databaseErrors++;
        break;
      case 'network':
        this.metrics.errors.networkErrors++;
        break;
    }
    
    logger.debug('📊 Error recorded', { errorType, message: error.message });
  }

  /**
   * Calcular média corrente
   */
  calculateRunningAverage(currentAverage, newValue, totalCount) {
    if (totalCount === 1) return newValue;
    return ((currentAverage * (totalCount - 1)) + newValue) / totalCount;
  }

  /**
   * Calcular taxa de sucesso
   */
  getSuccessRate(metric) {
    const total = this.metrics[metric].total || (this.metrics[metric].successful + this.metrics[metric].failed);
    if (total === 0) return 0;
    return ((this.metrics[metric].successful / total) * 100).toFixed(2);
  }

  /**
   * Obter relatório completo de performance
   */
  getPerformanceReport() {
    const uptime = Date.now() - this.startTime;
    const uptimeHours = (uptime / (1000 * 60 * 60)).toFixed(2);
    
    return {
      uptime: {
        milliseconds: uptime,
        hours: uptimeHours,
        startTime: new Date(this.startTime).toISOString()
      },
      syncCycles: {
        ...this.metrics.syncCycles,
        successRate: `${this.getSuccessRate('syncCycles')}%`,
        averageDuration: `${this.metrics.syncCycles.averageDuration}ms`,
        minDuration: this.metrics.syncCycles.minDuration === Infinity ? 0 : this.metrics.syncCycles.minDuration,
        cyclesPerHour: this.metrics.syncCycles.total / (uptime / (1000 * 60 * 60))
      },
      integrations: {
        ...this.metrics.integrations,
        successRate: `${this.getSuccessRate('integrations')}%`,
        averageDuration: `${this.metrics.integrations.averageDuration}ms`
      },
      events: this.metrics.events,
      api: {
        ...this.metrics.api,
        successRate: `${this.getSuccessRate('api')}%`,
        averageResponseTime: `${this.metrics.api.averageResponseTime}ms`
      },
      errors: this.metrics.errors,
      recentSyncs: this.recentSyncs.slice(-10), // Últimos 10 syncs
      memory: process.memoryUsage(),
      cpu: process.cpuUsage()
    };
  }

  /**
   * Obter resumo compacto de métricas
   */
  getSummary() {
    return {
      totalSyncs: this.metrics.syncCycles.total,
      successRate: `${this.getSuccessRate('syncCycles')}%`,
      averageDuration: `${this.metrics.syncCycles.averageDuration}ms`,
      integrationsProcessed: this.metrics.integrations.totalProcessed,
      eventsProcessed: this.metrics.events.totalProcessed,
      apiCalls: this.metrics.api.totalRequests,
      errors: Object.values(this.metrics.errors).reduce((sum, count) => sum + count, 0)
    };
  }

  /**
   * Resetar métricas
   */
  reset() {
    this.metrics = {
      syncCycles: {
        total: 0,
        successful: 0,
        failed: 0,
        averageDuration: 0,
        lastDuration: 0,
        minDuration: Infinity,
        maxDuration: 0
      },
      integrations: {
        totalProcessed: 0,
        successful: 0,
        failed: 0,
        averageDuration: 0
      },
      events: {
        totalProcessed: 0,
        created: 0,
        updated: 0,
        cancelled: 0
      },
      api: {
        totalRequests: 0,
        successful: 0,
        failed: 0,
        averageResponseTime: 0,
        rateLimitHits: 0
      },
      errors: {
        tokenRefreshErrors: 0,
        apiErrors: 0,
        databaseErrors: 0,
        networkErrors: 0
      }
    };
    
    this.recentSyncs = [];
    this.startTime = Date.now();
    
    logger.info('📊 Performance metrics reset');
  }

  /**
   * Log periódico de métricas
   */
  logPeriodicSummary() {
    const summary = this.getSummary();
    logger.info('📊 Performance Summary', summary);
  }
}

// Instância singleton do monitor de performance
const performanceMonitor = new PerformanceMonitor();

module.exports = performanceMonitor; 
