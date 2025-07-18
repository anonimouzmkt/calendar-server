const logger = require('../utils/logger');
const rateLimiter = require('../utils/rateLimiter');
const performanceMonitor = require('../utils/performanceMonitor');
const {
  getActiveGoogleCalendarIntegrations,
  updateIntegrationSyncData,
  updateIntegrationTokens,
  markIntegrationAsError,
  getCompanyAdminUser,
  createAppointment,
  upsertAppointment,
  updateAppointment,
  getAppointmentByGoogleEventId,
  cancelAppointment
} = require('./supabaseService');

// Configurações da API do Google Calendar
const GOOGLE_API_BASE_URL = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

class GoogleCalendarSyncService {
  constructor() {
    this.retryAttempts = parseInt(process.env.RETRY_ATTEMPTS || '3');
    this.retryDelay = parseInt(process.env.RETRY_DELAY_MS || '1000');
    this.syncTimeout = parseInt(process.env.SYNC_TIMEOUT_SECONDS || '30') * 1000;
    this.maxCompaniesPerBatch = parseInt(process.env.MAX_COMPANIES_PER_BATCH || '50');
  }

  /**
   * Executa sincronização em batch para todas as integrações ativas
   */
  async syncAllIntegrations() {
    const syncCycleData = performanceMonitor.startSyncCycle();
    let processedCount = 0;
    let successCount = 0;
    let errorCount = 0;

    try {
      // Buscar todas as integrações ativas
      const integrations = await getActiveGoogleCalendarIntegrations();
      
      if (integrations.length === 0) {
        logger.info('📭 No active Google Calendar integrations found');
        performanceMonitor.endSyncCycle(syncCycleData, true);
        return;
      }

      // Limitar o número de integrações processadas por batch
      const batchIntegrations = integrations.slice(0, this.maxCompaniesPerBatch);
      
      logger.batchStart(batchIntegrations.length);

      // Processar cada integração
      for (const integration of batchIntegrations) {
        processedCount++;
        syncCycleData.integrationsProcessed++;
        
        const integrationStartTime = Date.now();
        let eventsProcessed = 0;
        
        try {
          eventsProcessed = await this.syncSingleIntegration(integration);
          successCount++;
          
          const integrationDuration = Date.now() - integrationStartTime;
          performanceMonitor.recordIntegrationSync(integrationDuration, true, eventsProcessed);
          syncCycleData.eventsProcessed += eventsProcessed;
          
        } catch (error) {
          errorCount++;
          const integrationDuration = Date.now() - integrationStartTime;
          
          logger.syncError(integration.company_id, integration.id, error);
          performanceMonitor.recordIntegrationSync(integrationDuration, false, 0);
          
          // Registrar tipo de erro
          this.categorizeAndRecordError(error);
          
          // Marcar integração como erro se for um erro persistente
          if (this.isPersistentError(error)) {
            await markIntegrationAsError(integration.id, error.message);
          }
        }
      }

      const duration = Date.now() - syncCycleData.startTime;
      logger.batchComplete(processedCount, successCount, errorCount, duration);
      performanceMonitor.endSyncCycle(syncCycleData, true);

    } catch (error) {
      logger.error('❌ Fatal error in batch sync', { error: error.message });
      performanceMonitor.endSyncCycle(syncCycleData, false, error);
      this.categorizeAndRecordError(error);
    }
  }

  /**
   * Sincroniza uma integração específica
   */
  async syncSingleIntegration(integration) {
    const startTime = Date.now();
    let eventsProcessed = 0;

    logger.syncStart(integration.company_id, integration.id);

    try {
      // Verificar e renovar token se necessário
      const accessToken = await this.ensureValidToken(integration);

      // Configurar parâmetros de sincronização
      const syncParams = this.buildSyncParams(integration);

      // Fazer chamada para Google Calendar API com rate limiting
      const eventsData = await this.fetchGoogleCalendarEvents(accessToken, integration.calendar_id, syncParams);

      // Processar eventos retornados
      for (const event of eventsData.items || []) {
        await this.processGoogleEvent(integration.company_id, event);
        eventsProcessed++;
      }

      // Atualizar sync token se fornecido
      if (eventsData.nextSyncToken) {
        await updateIntegrationSyncData(integration.id, {
          sync_token: eventsData.nextSyncToken
        });
      }

      const duration = Date.now() - startTime;
      logger.syncSuccess(integration.company_id, integration.id, eventsProcessed, duration);
      
      return eventsProcessed;

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.syncError(integration.company_id, integration.id, error);
      throw error;
    }
  }

  /**
   * Garantir que o token está válido, renovando se necessário
   */
  async ensureValidToken(integration) {
    if (!integration.access_token) {
      throw new Error('No access token available');
    }

    // Verificar se token está próximo do vencimento (5 minutos antes)
    const expiresAt = new Date(integration.token_expires_at);
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

    if (expiresAt <= fiveMinutesFromNow) {
      logger.debug('🔄 Token expiring soon, refreshing...', { integrationId: integration.id });
      
      if (!integration.refresh_token) {
        throw new Error('No refresh token available');
      }

      const newTokens = await this.refreshAccessToken(
        integration.refresh_token,
        integration.client_id,
        integration.client_secret
      );

      await updateIntegrationTokens(integration.id, {
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token || integration.refresh_token,
        expires_in: newTokens.expires_in
      });

      return newTokens.access_token;
    }

    return integration.access_token;
  }

  /**
   * Renovar token de acesso
   */
  async refreshAccessToken(refreshToken, clientId, clientSecret) {
    return this.withRetry(async () => {
      const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token'
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Token refresh failed: ${errorData.error_description || errorData.error}`);
      }

      return await response.json();
    });
  }

  /**
   * Construir parâmetros de sincronização
   */
  buildSyncParams(integration) {
    const params = new URLSearchParams({
      singleEvents: 'true',
      maxResults: '250'
    });

    // Usar sync token se disponível para sincronização incremental
    if (integration.sync_token) {
      // ✅ COM sync_token: Não usar timeMin - o token controla tudo
      params.set('syncToken', integration.sync_token);
    } else {
      // ✅ SEM sync_token: Buscar período amplo (30 dias atrás até 1 ano futuro)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const oneYearFromNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      
      params.set('orderBy', 'startTime'); // Só para primeira sync
      params.set('timeMin', thirtyDaysAgo.toISOString());
      params.set('timeMax', oneYearFromNow.toISOString());
    }

    return params;
  }

  /**
   * Buscar eventos do Google Calendar
   */
  async fetchGoogleCalendarEvents(accessToken, calendarId, syncParams) {
    return rateLimiter.makeRequest(async () => {
      return this.withRetry(async () => {
        const url = `${GOOGLE_API_BASE_URL}/calendars/${calendarId}/events?${syncParams}`;
        
        const apiStartTime = Date.now();
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          }
        });

        const apiDuration = Date.now() - apiStartTime;
        const success = response.ok;
        
        performanceMonitor.recordApiCall(apiDuration, success);

        if (!response.ok) {
          const errorText = await response.text();
          const error = new Error(`Google Calendar API error: ${response.status} - ${errorText}`);
          
          // Verificar se é rate limit do Google
          if (response.status === 429) {
            performanceMonitor.recordRateLimitHit();
          }
          
          throw error;
        }

        return await response.json();
      });
    });
  }

  /**
   * Processar evento do Google Calendar
   */
  async processGoogleEvent(companyId, googleEvent) {
    try {
      if (googleEvent.status === 'cancelled') {
        // Buscar e cancelar appointment se existir
        const existingAppointment = await getAppointmentByGoogleEventId(companyId, googleEvent.id);
        if (existingAppointment) {
          await cancelAppointment(existingAppointment.id);
          performanceMonitor.recordEventProcessing('cancelled');
          logger.debug('📅 Cancelled appointment from Google event', { 
            eventId: googleEvent.id, 
            appointmentId: existingAppointment.id 
          });
        }
        return;
      }

      // Para eventos ativos, usar upsert (criar ou atualizar automaticamente)
      await this.upsertAppointmentFromGoogleEvent(companyId, googleEvent);
      
    } catch (error) {
      logger.error('❌ Error processing Google event', { 
        eventId: googleEvent.id, 
        companyId, 
        error: error.message 
      });
    }
  }

  /**
   * Fazer upsert de appointment baseado no evento do Google Calendar
   */
  async upsertAppointmentFromGoogleEvent(companyId, googleEvent) {
    // Verificar se já existe para determinar se é criação ou atualização
    const existingAppointment = await getAppointmentByGoogleEventId(companyId, googleEvent.id);
    const isUpdate = !!existingAppointment;

    const appointmentData = {
      company_id: companyId,
      title: googleEvent.summary || 'Evento sem título',
      description: googleEvent.description,
      start_time: googleEvent.start.dateTime || googleEvent.start.date,
      end_time: googleEvent.end.dateTime || googleEvent.end.date,
      location: googleEvent.location,
      google_event_id: googleEvent.id,
      google_calendar_id: googleEvent.organizer?.email || 'primary',
      google_meet_link: googleEvent.conferenceData?.entryPoints?.[0]?.uri,
      attendees: this.parseAttendees(googleEvent.attendees),
      all_day: !googleEvent.start.dateTime,
      status: 'scheduled'
    };

    // Se é atualização, manter o ID e created_by originais
    if (isUpdate) {
      appointmentData.id = existingAppointment.id;
      appointmentData.created_by = existingAppointment.created_by;
      appointmentData.created_at = existingAppointment.created_at;
    }
    // Se é criação, o created_by será resolvido automaticamente no upsertAppointment

    await upsertAppointment(appointmentData);
    
    // Registrar métrica apropriada
    performanceMonitor.recordEventProcessing(isUpdate ? 'updated' : 'created');
    
    logger.debug(`📅 ${isUpdate ? 'Updated' : 'Created'} appointment from Google event`, { 
      eventId: googleEvent.id,
      appointmentId: appointmentData.id,
      isUpdate
    });
  }

  /**
   * Converter attendees do Google para formato do banco
   */
  parseAttendees(googleAttendees) {
    if (!googleAttendees || !Array.isArray(googleAttendees)) {
      return [];
    }

    return googleAttendees.map(attendee => ({
      email: attendee.email,
      displayName: attendee.displayName,
      responseStatus: attendee.responseStatus
    }));
  }

  /**
   * Implementar retry automático
   */
  async withRetry(fn, maxRetries = this.retryAttempts) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        // Não fazer retry para erros definitivos
        if (this.isPersistentError(error) || i === maxRetries - 1) {
          break;
        }
        
        const delay = this.retryDelay * (i + 1);
        logger.debug(`⏳ Retry attempt ${i + 1}/${maxRetries} in ${delay}ms`, { error: error.message });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError;
  }

  /**
   * Verificar se é um erro persistente que não deve ser retentado
   */
  isPersistentError(error) {
    const message = error.message?.toLowerCase() || '';
    
    return message.includes('410') || // Resource deleted
           message.includes('404') || // Not found
           message.includes('401') || // Unauthorized
           message.includes('403') || // Forbidden
           message.includes('invalid_grant') || // Invalid refresh token
           message.includes('token_revoked'); // Token revoked
  }

  /**
   * Categorizar e registrar erro para métricas
   */
  categorizeAndRecordError(error) {
    const message = error.message?.toLowerCase() || '';
    
    if (message.includes('invalid_grant') || message.includes('token_revoked') || message.includes('refresh')) {
      performanceMonitor.recordError('token_refresh', error);
    } else if (message.includes('network') || message.includes('timeout') || message.includes('enotfound')) {
      performanceMonitor.recordError('network', error);
    } else if (message.includes('supabase') || message.includes('database') || message.includes('sql')) {
      performanceMonitor.recordError('database', error);
    } else {
      performanceMonitor.recordError('api', error);
    }
  }
}

module.exports = GoogleCalendarSyncService; 
