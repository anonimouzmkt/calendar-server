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
  cancelAppointment,
  getUnsyncedLocalAppointments,
  updateAppointmentWithGoogleEventId,
  getSyncedAppointments
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
   * Sincroniza uma integração específica (bidirecional)
   */
  async syncSingleIntegration(integration) {
    const startTime = Date.now();
    let eventsProcessed = 0;

    logger.info('🚀 Iniciando sincronização BIDIRECIONAL', {
      operation: 'SYNC_START',
      companyId: integration.company_id,
      integrationId: integration.id,
      calendarName: integration.calendar_name || integration.calendar_id,
      status: integration.status,
      syncEnabled: integration.sync_enabled
    });

    try {
      // Verificar e renovar token se necessário
      const accessToken = await this.ensureValidToken(integration);

      // ✅ NOVO: 1. Primeiro, sincronizar appointments locais órfãos para Google Calendar
      logger.info('🔄 [1/3] Sincronizando appointments locais para Google Calendar...');
      await this.syncLocalAppointmentsToGoogle(integration, accessToken);

      // ✅ EXISTENTE: 2. Depois, sincronizar eventos do Google Calendar para banco local
      logger.info('🔄 [2/3] Sincronizando eventos do Google Calendar para banco local...');
      eventsProcessed = await this.syncGoogleEventsToLocal(integration, accessToken);

      // ✅ NOVO: 3. Por último, verificar e limpar appointments órfãos (deletados no Google)
      logger.info('🔄 [3/3] Verificando appointments órfãos (deletados no Google Calendar)...');
      await this.cleanupOrphanedAppointments(integration, accessToken);

      const duration = Date.now() - startTime;
      logger.info('🎉 Sincronização BIDIRECIONAL CONCLUÍDA com sucesso', {
        operation: 'SYNC_COMPLETE',
        companyId: integration.company_id,
        integrationId: integration.id,
        calendarName: integration.calendar_name || integration.calendar_id,
        eventsProcessed: eventsProcessed,
        duration: `${duration}ms`,
        phases: {
          'phase1': 'Appointments locais → Google Calendar',
          'phase2': 'Google Calendar → Banco local',
          'phase3': 'Cleanup de órfãos (deletados no Google)'
        }
      });
      
      return eventsProcessed;

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('💥 ERRO na sincronização bidirecional', {
        operation: 'SYNC_ERROR',
        companyId: integration.company_id,
        integrationId: integration.id,
        calendarName: integration.calendar_name || integration.calendar_id,
        duration: `${duration}ms`,
        error: error.message,
        errorType: error.name,
        phase: 'Unknown - Erro antes de completar fases'
      });
      throw error;
    }
  }

  /**
   * ✅ NOVO: Sincroniza appointments locais órfãos para Google Calendar
   */
  async syncLocalAppointmentsToGoogle(integration, accessToken) {
    try {
      // Buscar appointments que não tem google_event_id (não sincronizados)
      const unsyncedAppointments = await getUnsyncedLocalAppointments(
        integration.company_id, 
        integration.calendar_id
      );
      
      if (unsyncedAppointments.length === 0) {
        logger.info('✅ Nenhum appointment local não sincronizado encontrado (todos já tem google_event_id)', { 
          operation: 'SYNC_LOCAL_TO_GOOGLE_COMPLETE',
          companyId: integration.company_id,
          calendarId: integration.calendar_id 
        });
        return;
      }

      logger.info(`📝 Encontrados ${unsyncedAppointments.length} appointment(s) local(is) NÃO sincronizado(s)`, {
        operation: 'SYNC_LOCAL_TO_GOOGLE_START',
        unsyncedCount: unsyncedAppointments.length,
        companyId: integration.company_id,
        calendarName: integration.calendar_name || integration.calendar_id
      });

      for (const appointment of unsyncedAppointments) {
        try {
          // Criar evento no Google Calendar
          const googleEvent = await this.createGoogleEvent(appointment, integration, accessToken);
          
          // Atualizar appointment com google_event_id
          await updateAppointmentWithGoogleEventId(
            appointment.id, 
            googleEvent.id,
            googleEvent.conferenceData?.entryPoints?.[0]?.uri
          );

          performanceMonitor.recordEventProcessing('created_in_google');
          logger.info(`🔄 Appointment LOCAL enviado para Google Calendar`, { 
            operation: 'SYNC_TO_GOOGLE',
            appointmentId: appointment.id,
            googleEventId: googleEvent.id,
            title: appointment.title,
            eventDate: appointment.start_time,
            location: appointment.location || 'Sem localização',
            hasMeet: !!googleEvent.conferenceData?.entryPoints?.[0]?.uri,
            attendeesCount: appointment.attendees?.length || 0,
            companyId: integration.company_id
          });
          
        } catch (error) {
          logger.error(`❌ Erro ao sincronizar appointment`, { 
            appointmentId: appointment.id,
            error: error.message 
          });
          performanceMonitor.recordError('sync_to_google', error);
          // Continuar com os próximos appointments mesmo se um falhar
        }
      }
    } catch (error) {
      logger.error('❌ Erro na sincronização local → Google:', { error: error.message });
      performanceMonitor.recordError('sync_to_google_batch', error);
      // Não falhar a sincronização completa por causa deste erro
    }
  }

  /**
   * ✅ NOVO: Cria evento no Google Calendar baseado em appointment local
   */
  async createGoogleEvent(appointment, integration, accessToken) {
    const googleEvent = {
      summary: appointment.title,
      description: appointment.description,
      start: {
        dateTime: appointment.start_time,
        timeZone: integration.timezone
      },
      end: {
        dateTime: appointment.end_time,
        timeZone: integration.timezone
      },
      location: appointment.location,
      attendees: appointment.attendees?.map(att => ({ email: att.email })) || []
    };

    // Adicionar Google Meet se a integração permite
    if (integration.auto_create_meet) {
      googleEvent.conferenceData = {
        createRequest: {
          requestId: `meet-${Date.now()}-${appointment.id}`,
          conferenceSolutionKey: {
            type: 'hangoutsMeet'
          }
        }
      };
    }

    return rateLimiter.makeRequest(async () => {
      return this.withRetry(async () => {
        const url = `${GOOGLE_API_BASE_URL}/calendars/${integration.calendar_id}/events?conferenceDataVersion=1`;
        
        const apiStartTime = Date.now();
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(googleEvent)
        });

        const apiDuration = Date.now() - apiStartTime;
        const success = response.ok;
        
        performanceMonitor.recordApiCall(apiDuration, success);

        if (!response.ok) {
          const errorText = await response.text();
          const error = new Error(`Google Calendar API error: ${response.status} - ${errorText}`);
          
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
   * ✅ RENOMEADO: Sincroniza eventos do Google Calendar para banco local (função original)
   */
  async syncGoogleEventsToLocal(integration, accessToken) {
    // Configurar parâmetros de sincronização
    const syncParams = this.buildSyncParams(integration);

    // Fazer chamada para Google Calendar API com rate limiting
    const eventsData = await this.fetchGoogleCalendarEvents(accessToken, integration.calendar_id, syncParams);

    let eventsProcessed = 0;

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

    return eventsProcessed;
  }

  /**
   * ✅ NOVO: Limpar appointments órfãos (deletados no Google Calendar)
   * ÓRFÃOS = Appointments que TÊM google_event_id no banco mas foram DELETADOS no Google Calendar
   */
  async cleanupOrphanedAppointments(integration, accessToken) {
    try {
      // Só fazer cleanup a cada 10 syncs para não sobrecarregar a API
      const shouldRunCleanup = Math.random() < 0.1; // 10% de chance a cada sync
      
      if (!shouldRunCleanup) {
        logger.info('⏭️ Pulando cleanup de órfãos neste ciclo (otimização - executa ~10% das vezes)', {
          operation: 'ORPHAN_CLEANUP_SKIPPED',
          companyId: integration.company_id
        });
        return;
      }

      // Buscar appointments que têm google_event_id (podem estar órfãos se deletados no Google)
      const appointmentsWithGoogleId = await getSyncedAppointments(
        integration.company_id, 
        integration.calendar_id
      );
      
      if (appointmentsWithGoogleId.length === 0) {
        logger.info('✅ Nenhum appointment sincronizado encontrado para verificar órfãos', {
          operation: 'ORPHAN_CLEANUP_COMPLETE',
          companyId: integration.company_id
        });
        return;
      }

      logger.info(`🔍 Verificando órfãos: ${appointmentsWithGoogleId.length} appointment(s) sincronizado(s) vs Google Calendar`, {
        operation: 'ORPHAN_CLEANUP_START',
        appointmentsToCheck: appointmentsWithGoogleId.length,
        companyId: integration.company_id,
        calendarName: integration.calendar_name || integration.calendar_id,
        explanation: 'Órfãos = appointments com google_event_id que foram deletados no Google Calendar'
      });

      let deletedCount = 0;

      // Verificar cada appointment no Google Calendar
      for (const appointment of appointmentsWithGoogleId) {
        try {
          // Tentar buscar o evento no Google Calendar
          const eventExists = await this.checkGoogleEventExists(
            appointment.google_event_id, 
            integration.calendar_id, 
            accessToken
          );
          
          if (!eventExists) {
            // Evento não existe mais no Google Calendar - cancelar appointment
            await cancelAppointment(appointment.id);
            deletedCount++;
            
            logger.info(`🗑️ Appointment ÓRFÃO cancelado (deletado do Google Calendar)`, { 
              operation: 'ORPHAN_CLEANUP',
              appointmentId: appointment.id,
              googleEventId: appointment.google_event_id,
              title: appointment.title,
              createdAt: appointment.created_at,
              reason: 'Evento não existe mais no Google Calendar (404/410)',
              companyId: integration.company_id
            });
            
            performanceMonitor.recordEventProcessing('orphan_cleaned');
          }
          
        } catch (error) {
          logger.error(`❌ Erro ao verificar appointment órfão`, { 
            appointmentId: appointment.id,
            googleEventId: appointment.google_event_id,
            error: error.message 
          });
          // Continuar com os próximos appointments
        }
      }

      if (deletedCount > 0) {
        logger.info(`✅ Cleanup de órfãos CONCLUÍDO: ${deletedCount} appointment(s) órfão(s) cancelado(s)`, {
          operation: 'ORPHAN_CLEANUP_COMPLETE',
          orphansFound: deletedCount,
          appointmentsChecked: appointmentsWithGoogleId.length,
          companyId: integration.company_id
        });
      } else {
        logger.info(`✅ Cleanup de órfãos CONCLUÍDO: Todos os appointments estão sincronizados corretamente`, {
          operation: 'ORPHAN_CLEANUP_COMPLETE',
          orphansFound: 0,
          appointmentsChecked: appointmentsWithGoogleId.length,
          companyId: integration.company_id
        });
      }
      
    } catch (error) {
      logger.error('❌ Erro na limpeza de appointments órfãos:', { error: error.message });
      performanceMonitor.recordError('orphan_cleanup', error);
      // Não falhar a sincronização por causa deste erro
    }
  }

  /**
   * ✅ NOVO: Verificar se evento ainda existe no Google Calendar
   */
  async checkGoogleEventExists(googleEventId, calendarId, accessToken) {
    return rateLimiter.makeRequest(async () => {
      return this.withRetry(async () => {
        const url = `${GOOGLE_API_BASE_URL}/calendars/${calendarId}/events/${googleEventId}`;
        
        const apiStartTime = Date.now();
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          }
        });

        const apiDuration = Date.now() - apiStartTime;
        const success = response.ok;
        
        performanceMonitor.recordApiCall(apiDuration, success);

        if (response.status === 404) {
          // Evento não existe mais - isso é o que esperamos para órfãos
          return false;
        }
        
        if (response.status === 410) {
          // Evento foi deletado permanentemente
          return false;
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Google Calendar API error: ${response.status} - ${errorText}`);
        }

        // Se chegou aqui, evento ainda existe
        return true;
      });
    });
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
      const eventTitle = googleEvent.summary || 'Evento sem título';
      const eventDate = googleEvent.start?.dateTime || googleEvent.start?.date || 'Data não definida';
      
              if (googleEvent.status === 'cancelled') {
          // Buscar e cancelar appointment se existir
          const existingAppointment = await getAppointmentByGoogleEventId(companyId, googleEvent.id);
          if (existingAppointment) {
            await cancelAppointment(existingAppointment.id);
            performanceMonitor.recordEventProcessing('cancelled');
            logger.info('🚫 Evento CANCELADO no Google Calendar', { 
              operation: 'CANCEL_FROM_GOOGLE',
              eventId: googleEvent.id,
              appointmentId: existingAppointment.id,
              title: eventTitle,
              originalTitle: existingAppointment.title,
              eventDate: eventDate,
              companyId
            });
          } else {
            logger.debug('🚫 Evento cancelado no Google Calendar mas appointment não encontrado', {
              operation: 'CANCEL_ORPHAN',
              eventId: googleEvent.id,
              title: eventTitle,
              eventDate: eventDate,
              companyId
            });
          }
          return;
        }

      // Para eventos ativos, usar upsert (criar ou atualizar automaticamente)
      await this.upsertAppointmentFromGoogleEvent(companyId, googleEvent);
      
    } catch (error) {
      logger.error('❌ Erro ao processar evento do Google Calendar', { 
        operation: 'PROCESS_GOOGLE_EVENT_ERROR',
        eventId: googleEvent.id,
        title: googleEvent.summary || 'Evento sem título',
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

    const eventTitle = googleEvent.summary || 'Evento sem título';
    const eventDate = googleEvent.start?.dateTime || googleEvent.start?.date || 'Data não definida';

    const appointmentData = {
      company_id: companyId,
      title: eventTitle,
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
    
    if (isUpdate) {
      // Log detalhado para atualizações
      const changes = this.detectChanges(existingAppointment, appointmentData);
      logger.info(`📝 Evento ATUALIZADO do Google Calendar`, { 
        operation: 'UPDATE_FROM_GOOGLE',
        eventId: googleEvent.id,
        appointmentId: appointmentData.id,
        title: eventTitle,
        eventDate: eventDate,
        changes: changes,
        companyId
      });
    } else {
      // Log para criações
      logger.info(`📅 Novo evento CRIADO do Google Calendar`, { 
        operation: 'CREATE_FROM_GOOGLE',
        eventId: googleEvent.id,
        appointmentId: appointmentData.id,
        title: eventTitle,
        eventDate: eventDate,
        location: googleEvent.location || 'Sem localização',
        hasMeet: !!googleEvent.conferenceData?.entryPoints?.[0]?.uri,
        attendeesCount: this.parseAttendees(googleEvent.attendees).length,
        companyId
      });
    }
  }

  /**
   * ✅ NOVO: Detectar mudanças entre appointment existente e novo dados
   */
  detectChanges(existing, updated) {
    const changes = [];
    
    if (existing.title !== updated.title) {
      changes.push(`título: "${existing.title}" → "${updated.title}"`);
    }
    if (existing.start_time !== updated.start_time) {
      changes.push(`início: ${existing.start_time} → ${updated.start_time}`);
    }
    if (existing.end_time !== updated.end_time) {
      changes.push(`fim: ${existing.end_time} → ${updated.end_time}`);
    }
    if (existing.location !== updated.location) {
      changes.push(`local: "${existing.location || 'Vazio'}" → "${updated.location || 'Vazio'}"`);
    }
    if (existing.description !== updated.description) {
      changes.push(`descrição: Modificada`);
    }
    if (existing.google_meet_link !== updated.google_meet_link) {
      changes.push(`meet: ${existing.google_meet_link ? 'Tinha' : 'Não tinha'} → ${updated.google_meet_link ? 'Tem' : 'Não tem'}`);
    }
    
    return changes.length > 0 ? changes : ['Mudanças detectadas mas não identificadas'];
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
