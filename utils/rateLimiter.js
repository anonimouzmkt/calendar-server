const logger = require('./logger');

class RateLimiter {
  constructor(options = {}) {
    this.maxRequestsPerMinute = parseInt(process.env.GOOGLE_API_RATE_LIMIT_PER_MINUTE || '300');
    this.windowSizeMs = 60 * 1000; // 1 minuto
    this.requests = [];
    this.enabled = options.enabled !== false;
  }

  /**
   * Verificar se podemos fazer uma requisição
   */
  canMakeRequest() {
    if (!this.enabled) return true;

    const now = Date.now();
    const windowStart = now - this.windowSizeMs;

    // Remover requisições antigas da janela
    this.requests = this.requests.filter(requestTime => requestTime > windowStart);

    // Verificar se ainda podemos fazer requisições
    if (this.requests.length >= this.maxRequestsPerMinute) {
      const oldestRequest = Math.min(...this.requests);
      const timeToWait = oldestRequest + this.windowSizeMs - now;
      
      logger.warn('🚫 Rate limit reached', {
        currentRequests: this.requests.length,
        maxRequestsPerMinute: this.maxRequestsPerMinute,
        timeToWaitMs: timeToWait
      });
      
      return false;
    }

    return true;
  }

  /**
   * Registrar uma requisição
   */
  recordRequest() {
    if (!this.enabled) return;

    const now = Date.now();
    this.requests.push(now);
    
    logger.debug('📡 API request recorded', {
      currentRequests: this.requests.length,
      maxRequestsPerMinute: this.maxRequestsPerMinute
    });
  }

  /**
   * Aguardar até poder fazer uma requisição
   */
  async waitForAvailability() {
    while (!this.canMakeRequest()) {
      const now = Date.now();
      const windowStart = now - this.windowSizeMs;
      const oldestRequest = Math.min(...this.requests.filter(req => req > windowStart));
      const timeToWait = Math.max(1000, oldestRequest + this.windowSizeMs - now);
      
      logger.info(`⏳ Rate limited, waiting ${timeToWait}ms`);
      await new Promise(resolve => setTimeout(resolve, timeToWait));
    }
  }

  /**
   * Obter estatísticas do rate limiter
   */
  getStats() {
    const now = Date.now();
    const windowStart = now - this.windowSizeMs;
    const currentRequests = this.requests.filter(req => req > windowStart).length;

    return {
      enabled: this.enabled,
      maxRequestsPerMinute: this.maxRequestsPerMinute,
      currentRequests,
      remainingRequests: Math.max(0, this.maxRequestsPerMinute - currentRequests),
      windowSizeMs: this.windowSizeMs
    };
  }

  /**
   * Fazer requisição respeitando rate limit
   */
  async makeRequest(requestFn) {
    await this.waitForAvailability();
    this.recordRequest();
    
    const startTime = Date.now();
    try {
      const result = await requestFn();
      const duration = Date.now() - startTime;
      
      logger.debug('✅ API request completed', { duration });
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.debug('❌ API request failed', { duration, error: error.message });
      throw error;
    }
  }
}

// Instância singleton do rate limiter
const rateLimiter = new RateLimiter();

module.exports = rateLimiter; 
