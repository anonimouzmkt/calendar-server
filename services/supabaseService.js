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
 * Buscar usuário admin/owner da empresa para usar como created_by
 */
async function getCompanyAdminUser(companyId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .eq('company_id', companyId)
      .or('is_owner.eq.true,is_admin.eq.true')
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data?.id || null;
  } catch (error) {
    logger.error('❌ Erro ao buscar admin da empresa:', error);
    return null;
  }
}

/**
 * Criar appointment no banco de dados (com upsert)
 */
async function createAppointment(appointmentData) {
  try {
    // Se não tem created_by, buscar admin da empresa
    if (!appointmentData.created_by) {
      const adminUserId = await getCompanyAdminUser(appointmentData.company_id);
      if (adminUserId) {
        appointmentData.created_by = adminUserId;
      } else {
        // Se não encontrar admin, criar um usuário sistema temporário
        appointmentData.created_by = '00000000-0000-0000-0000-000000000000'; // UUID nulo
        logger.warn('⚠️ No admin found, using system user', { 
          companyId: appointmentData.company_id 
        });
      }
    }

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
 * Fazer upsert de appointment (criar ou atualizar)
 */
async function upsertAppointment(appointmentData) {
  try {
    // Se não tem created_by, buscar admin da empresa
    if (!appointmentData.created_by) {
      const adminUserId = await getCompanyAdminUser(appointmentData.company_id);
      if (adminUserId) {
        appointmentData.created_by = adminUserId;
      } else {
        appointmentData.created_by = '00000000-0000-0000-0000-000000000000';
        logger.warn('⚠️ No admin found, using system user', { 
          companyId: appointmentData.company_id 
        });
      }
    }

    // Tentar fazer upsert baseado na constraint única
    const { data, error } = await supabase
      .from('appointments')
      .upsert(appointmentData, {
        onConflict: 'company_id,google_event_id',
        ignoreDuplicates: false
      })
      .select('*')
      .single();

    if (error) {
      throw error;
    }

    logger.debug('✅ Upserted appointment', { appointmentId: data.id });
    return data;
  } catch (error) {
    logger.error('❌ Erro ao fazer upsert do appointment:', error);
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

/**
 * ✅ NOVO: Buscar appointments locais não sincronizados (sem google_event_id)
 * Estes precisam ser criados no Google Calendar
 */
async function getUnsyncedLocalAppointments(companyId, googleCalendarId) {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .eq('company_id', companyId)
      .eq('google_calendar_id', googleCalendarId)
      .is('google_event_id', null)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  } catch (error) {
    logger.error('❌ Erro ao buscar appointments não sincronizados:', error);
    throw error;
  }
}

/**
 * ✅ NOVO: Atualizar appointment com google_event_id
 */
async function updateAppointmentWithGoogleEventId(appointmentId, googleEventId, googleMeetLink = null) {
  try {
    const updateData = {
      google_event_id: googleEventId,
      updated_at: new Date().toISOString()
    };

    if (googleMeetLink) {
      updateData.google_meet_link = googleMeetLink;
    }

    const { error } = await supabase
      .from('appointments')
      .update(updateData)
      .eq('id', appointmentId);

    if (error) throw error;
    
    logger.debug('✅ Appointment atualizado com google_event_id', { 
      appointmentId, 
      googleEventId 
    });
  } catch (error) {
    logger.error('❌ Erro ao atualizar appointment com google_event_id:', error);
    throw error;
  }
}

/**
 * ✅ NOVO: Buscar appointments sincronizados (com google_event_id)
 * Estes podem estar órfãos se o evento foi deletado no Google Calendar
 * Busca TODOS os appointments da empresa com google_event_id, independente da agenda
 */
async function getSyncedAppointments(companyId, googleCalendarId = null) {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('id, title, google_event_id, google_calendar_id, created_at')
      .eq('company_id', companyId)
      .not('google_event_id', 'is', null)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false })
      .limit(100); // Limitar a 100 para não sobrecarregar

    if (error) throw error;
    
    logger.debug(`🔍 Encontrados ${data?.length || 0} appointments com google_event_id para verificar órfãos`, {
      companyId,
      foundAppointments: data?.length || 0,
      explanation: 'Busca TODOS os appointments da empresa com google_event_id (independente da agenda)'
    });
    
    return data || [];
  } catch (error) {
    logger.error('❌ Erro ao buscar appointments sincronizados:', error);
    throw error;
  }
}

module.exports = {
  supabase,
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
  testConnection,
  getUnsyncedLocalAppointments,
  updateAppointmentWithGoogleEventId,
  getSyncedAppointments
}; 
