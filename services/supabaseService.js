const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

// ===================================
// 🔧 CONFIGURAÇÃO DO CLIENTE
// ===================================

// Verificar se variáveis de ambiente estão configuradas
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  logger.error('❌ Erro: Variáveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórias');
  process.exit(1);
}

// Cliente Supabase com Service Role (mais permissões)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// ===================================
// 🗄️ FUNÇÕES DE INTEGRAÇÃO
// ===================================

/**
 * Buscar todas as integrações ativas do Google Calendar
 */
async function getActiveGoogleCalendarIntegrations() {
  try {
    const { data, error } = await supabase
      .from('google_calendar_integrations')
      .select(`
        id,
        company_id,
        user_id,
        client_id,
        client_secret,
        access_token,
        refresh_token,
        token_expires_at,
        calendar_id,
        timezone,
        auto_create_meet,
        sync_enabled,
        sync_token,
        last_sync_at,
        status
      `)
      .eq('is_active', true)
      .eq('status', 'connected')
      .eq('sync_enabled', true)
      .not('access_token', 'is', null);

    if (error) {
      throw error;
    }

    logger.debug('📋 Found active integrations', { count: data?.length || 0 });
    return data || [];
  } catch (error) {
    logger.error('❌ Erro ao buscar integrações ativas:', error);
    return [];
  }
}

/**
 * Atualizar dados de sincronização de uma integração
 */
async function updateIntegrationSyncData(integrationId, syncData) {
  try {
    const { error } = await supabase
      .from('google_calendar_integrations')
      .update({
        sync_token: syncData.sync_token,
        last_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', integrationId);

    if (error) {
      throw error;
    }

    logger.debug('✅ Updated integration sync data', { integrationId });
    return true;
  } catch (error) {
    logger.error('❌ Erro ao atualizar dados de sincronização:', error);
    return false;
  }
}

/**
 * Atualizar tokens OAuth de uma integração
 */
async function updateIntegrationTokens(integrationId, tokens) {
  try {
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    const { error } = await supabase
      .from('google_calendar_integrations')
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || undefined,
        token_expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', integrationId);

    if (error) {
      throw error;
    }

    logger.debug('✅ Updated integration tokens', { integrationId });
    return true;
  } catch (error) {
    logger.error('❌ Erro ao atualizar tokens:', error);
    return false;
  }
}

/**
 * Marcar integração como erro
 */
async function markIntegrationAsError(integrationId, errorMessage) {
  try {
    const { error } = await supabase
      .from('google_calendar_integrations')
      .update({
        status: 'error',
        updated_at: new Date().toISOString()
      })
      .eq('id', integrationId);

    if (error) {
      throw error;
    }

    logger.warn('⚠️ Marked integration as error', { integrationId, errorMessage });
    return true;
  } catch (error) {
    logger.error('❌ Erro ao marcar integração como erro:', error);
    return false;
  }
}

/**
 * Criar appointment no banco de dados
 */
async function createAppointment(appointmentData) {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .insert(appointmentData)
      .select('*')
      .single();

    if (error) {
      throw error;
    }

    logger.debug('✅ Created appointment', { appointmentId: data.id });
    return data;
  } catch (error) {
    logger.error('❌ Erro ao criar appointment:', error);
    throw error;
  }
}

/**
 * Atualizar appointment existente
 */
async function updateAppointment(appointmentId, updates) {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', appointmentId)
      .select('*')
      .single();

    if (error) {
      throw error;
    }

    logger.debug('✅ Updated appointment', { appointmentId });
    return data;
  } catch (error) {
    logger.error('❌ Erro ao atualizar appointment:', error);
    throw error;
  }
}

/**
 * Buscar appointment por google_event_id
 */
async function getAppointmentByGoogleEventId(companyId, googleEventId) {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .eq('company_id', companyId)
      .eq('google_event_id', googleEventId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data;
  } catch (error) {
    logger.error('❌ Erro ao buscar appointment por google_event_id:', error);
    return null;
  }
}

/**
 * Cancelar appointment
 */
async function cancelAppointment(appointmentId) {
  try {
    const { error } = await supabase
      .from('appointments')
      .update({
        status: 'cancelled',
        updated_at: new Date().toISOString()
      })
      .eq('id', appointmentId);

    if (error) {
      throw error;
    }

    logger.debug('✅ Cancelled appointment', { appointmentId });
    return true;
  } catch (error) {
    logger.error('❌ Erro ao cancelar appointment:', error);
    return false;
  }
}

// ===================================
// 🔄 TESTE DE CONEXÃO
// ===================================

/**
 * Testar conexão com Supabase
 */
async function testConnection() {
  try {
    const { data, error } = await supabase
      .from('google_calendar_integrations')
      .select('count')
      .limit(1);

    if (error) {
      throw error;
    }

    logger.info('✅ Conexão com Supabase: OK');
    return true;
  } catch (error) {
    logger.error('❌ Erro na conexão com Supabase:', error);
    return false;
  }
}

module.exports = {
  supabase,
  getActiveGoogleCalendarIntegrations,
  updateIntegrationSyncData,
  updateIntegrationTokens,
  markIntegrationAsError,
  createAppointment,
  updateAppointment,
  getAppointmentByGoogleEventId,
  cancelAppointment,
  testConnection
}; 
