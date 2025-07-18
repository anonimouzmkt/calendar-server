/**
 * ===============================================
 * ZIONIC FOLLOW-UP SERVER
 * ===============================================
 * Servidor automático para reativação de leads inativos
 * 
 * Funcionalidades:
 * - Busca follow-ups pendentes do banco
 * - Verifica contexto da conversa
 * - Gera mensagens personalizadas com IA
 * - Envia via WhatsApp (Evolution API)
 * - Registra logs e métricas
 * ✅ CONTROLE AUTOMÁTICO DE CRÉDITOS
 * ✅ SINCRONIZAÇÃO DE ÓRFÃOS
 * 
 * ENV VARS necessárias:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY  
 * - EVOLUTION_API_URL
 * - EVOLUTION_API_KEY
 * - ZIONIC_OPENAI_KEY (ou OPENAI_API_KEY) - para Zionic Credits
 * 
 * Deploy: Render.com
 * Frequência: A cada 1 minuto
 * 
 * @author Zionic Team
 * @version 1.5.0
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cron = require('node-cron');

// ===============================================
// CONFIGURAÇÕES E INICIALIZAÇÃO
// ===============================================

console.log('🚀 === ZIONIC FOLLOW-UP SERVER INICIANDO ===');
console.log('📅 Timestamp:', new Date().toISOString());
console.log('🌍 Environment:', process.env.NODE_ENV || 'development');

// Configurar Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ✅ NOVO: Configurar Evolution API (mesmo que conversation.js)
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'https://evowise.anonimouz.com';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'GfwncPVPb2ou4i1DMI9IEAVVR3p0fI7W';

// Validar variáveis obrigatórias
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ ERRO: Variáveis de ambiente do Supabase não configuradas');
  console.error('Necessário: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

console.log('🔧 Evolution API configurada:', {
  url: EVOLUTION_API_URL,
  keyConfigured: !!EVOLUTION_API_KEY
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Configurações globais
const CONFIG = {
  maxFollowUpsPerExecution: 50,
  executionIntervalMinutes: 1, // ✅ ATUALIZADO: 1 minuto para maior precisão
  openaiMaxRetries: 3,
  whatsappMaxRetries: 2,
  defaultResponseTimeoutMs: 30000,
  businessHours: {
    start: 8,  // 8h
    end: 18,   // 18h
    timezone: 'America/Sao_Paulo'
  },
  // ✅ NOVO: Configurações de créditos
  credits: {
    estimatedTokensPerFollowUp: 200, // Estimativa de tokens por follow-up
    minimumBalanceThreshold: 1000,   // Mínimo de créditos para funcionar
    tokensToCreditsRatio: 1          // 1 token = 1 crédito
  }
};

// Estatísticas de execução
let stats = {
  totalExecutions: 0,
  totalFollowUpsSent: 0,
  totalOrphansCreated: 0, // ✅ NOVO: Contador de órfãos criados
  totalErrors: 0,
  lastExecution: null,
  serverStartTime: new Date(),
  successRate: 0
};

// ===============================================
// FUNÇÕES UTILITÁRIAS
// ===============================================

/**
 * Log estruturado com timestamp
 */
function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...data
  };
  
  const emoji = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '❌',
    debug: '🔍'
  };
  
  console.log(`${emoji[level] || '📝'} [${timestamp}] ${message}`, 
    Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : '');
}

/**
 * Verifica se está dentro do horário comercial
 */
function isBusinessHours() {
  const now = new Date();
  const hour = now.getHours();
  return hour >= CONFIG.businessHours.start && hour < CONFIG.businessHours.end;
}

/**
 * Formatar duração em formato legível
 */
function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) return `${hours}h ${minutes % 60}min`;
  if (minutes > 0) return `${minutes}min ${seconds % 60}s`;
  return `${seconds}s`;
}

// ===============================================
// CORE: BUSCAR FOLLOW-UPS PENDENTES
// ===============================================

/**
 * ✅ OTIMIZADO: Busca follow-ups prontos para execução com validações extras
 */
async function getPendingFollowUps() {
  try {
    log('info', 'Buscando follow-ups pendentes...');
    
    const { data: followUps, error } = await supabase.rpc('get_pending_follow_ups_optimized', {
      p_limit: CONFIG.maxFollowUpsPerExecution
    });
    
    if (error) {
      log('error', 'Erro ao buscar follow-ups pendentes', { error: error.message });
      return [];
    }
    
    const totalPending = followUps?.length || 0;
    const overdueCount = followUps?.filter(f => f.minutes_overdue > 0).length || 0;
    
    log('success', `${totalPending} follow-ups prontos para execução`, {
      total: totalPending,
      overdue: overdueCount,
      onTime: totalPending - overdueCount,
      method: 'sql_optimized'
    });
    
    return followUps || [];
    
  } catch (error) {
    log('error', 'Erro ao buscar follow-ups', { error: error.message });
    return [];
  }
}

// ===============================================
// CORE: CONTEXTO DA CONVERSA
// ===============================================

/**
 * Busca contexto detalhado da conversa
 */
async function getConversationContext(conversationId) {
  try {
    log('debug', 'Buscando contexto da conversa', { conversationId });
    
    // Buscar dados da conversa (simplificado - sem integration)
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select(`
        *,
        contact:contacts(*)
      `)
      .eq('id', conversationId)
      .single();
      
    if (convError) {
      log('error', 'Erro ao buscar conversa', { error: convError.message, conversationId });
      return null;
    }
    
    // Buscar últimas mensagens (últimas 10)
    const { data: messages, error: msgError } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: false })
      .limit(10);
      
    if (msgError) {
      log('warning', 'Erro ao buscar mensagens', { error: msgError.message });
    }
    
    const context = {
      conversation,
      contact: conversation.contact,
      recentMessages: (messages || []).reverse(), // Ordem cronológica
      lastMessage: messages?.[0] || null,
      messageCount: messages?.length || 0,
      hasContactMessages: messages?.some(m => !m.sent_by_ai) || false
    };
    
    log('debug', 'Contexto carregado', {
      conversationId,
      contactName: context.contact?.first_name,
      messageCount: context.messageCount,
      hasContactMessages: context.hasContactMessages,
      lastMessageTime: context.lastMessage?.sent_at,
      companyId: conversation.company_id
    });
    
    return context;
    
  } catch (error) {
    log('error', 'Erro ao buscar contexto', { error: error.message, conversationId });
    return null;
  }
}

// ===============================================
// CORE: GERAÇÃO DE MENSAGEM COM IA
// ===============================================

/**
 * Busca configurações da OpenAI da empresa
 * ✅ Verifica se OpenAI está habilitado E se tem chave configurada
 */
async function getCompanyOpenAIConfig(companyId) {
  try {
    log('debug', 'Verificando configuração OpenAI da empresa', { companyId });
    
    const { data: settings, error } = await supabase
      .from('company_settings')
      .select('api_integrations')
      .eq('company_id', companyId)
      .single();
      
    if (error || !settings?.api_integrations) {
      log('debug', 'Empresa sem configurações de API', { companyId, error: error?.message });
      return null;
    }
    
    const apiConfig = typeof settings.api_integrations === 'string'
      ? JSON.parse(settings.api_integrations)
      : settings.api_integrations;
    
    const openaiConfig = apiConfig?.openai;
    
    // ✅ Verificar se OpenAI está habilitado E tem chave configurada
    const isEnabled = openaiConfig?.enabled === true;
    const hasApiKey = openaiConfig?.api_key && openaiConfig.api_key.trim().length > 0;
    
    log('debug', 'Status da configuração OpenAI', {
      companyId,
      isEnabled,
      hasApiKey: !!hasApiKey,
      model: openaiConfig?.model || 'não configurado'
    });
    
    if (isEnabled && hasApiKey) {
      log('info', 'Empresa tem OpenAI próprio configurado e habilitado', { 
        companyId,
        model: openaiConfig.model || 'gpt-4o-mini'
      });
      return openaiConfig;
    }
    
    log('info', 'Empresa não tem OpenAI próprio válido', { 
      companyId,
      reason: !isEnabled ? 'não habilitado' : 'sem chave configurada'
    });
    return null;
      
  } catch (error) {
    log('error', 'Erro ao buscar config OpenAI', { error: error.message, companyId });
    return null;
  }
}

// ===============================================
// ✅ NOVO: SISTEMA DE CRÉDITOS
// ===============================================

/**
 * Verifica se empresa tem créditos suficientes
 */
async function checkCreditsBalance(companyId, estimatedTokens = CONFIG.credits.estimatedTokensPerFollowUp) {
  try {
    // ✅ VALIDAÇÃO DE ENTRADA
    if (!companyId || companyId === 'undefined' || companyId === null) {
      log('error', 'CompanyId inválido para verificação de créditos', { 
        companyId, 
        type: typeof companyId,
        estimatedTokens 
      });
      return { hasEnough: false, currentBalance: 0, required: estimatedTokens, error: 'CompanyId inválido' };
    }
    
    log('debug', 'Verificando saldo de créditos', { 
      companyId: companyId.toString(), 
      estimatedTokens,
      companyIdType: typeof companyId
    });
    
    const { data, error } = await supabase
      .from('company_credits')
      .select('balance')
      .eq('company_id', companyId)
      .single();
    
    if (error) {
      log('error', 'Erro ao verificar créditos', { 
        error: error.message, 
        companyId: companyId.toString(),
        errorCode: error.code
      });
      return { hasEnough: false, currentBalance: 0, required: estimatedTokens, error: error.message };
    }
    
    const currentBalance = data?.balance || 0;
    const hasEnough = currentBalance >= estimatedTokens;
    
    log('debug', 'Saldo verificado', { 
      companyId: companyId.toString(), 
      currentBalance, 
      required: estimatedTokens, 
      hasEnough 
    });
    
    return {
      hasEnough,
      currentBalance,
      required: estimatedTokens
    };
    
  } catch (error) {
    log('error', 'Erro ao verificar créditos', { 
      error: error.message, 
      companyId: companyId ? companyId.toString() : 'null/undefined',
      stack: error.stack
    });
    return { hasEnough: false, currentBalance: 0, required: estimatedTokens, error: error.message };
  }
}

/**
 * Processa consumo de créditos da OpenAI
 */
async function processOpenAICreditsUsage(companyId, totalTokens, conversationId, agentId, description) {
  try {
    log('debug', 'Processando consumo de créditos OpenAI', { 
      companyId, 
      totalTokens, 
      conversationId 
    });
    
    // ✅ NOVO: Verificar saldo antes do consumo
    const { data: creditsBefore, error: balanceError } = await supabase
      .from('company_credits')
      .select('balance')
      .eq('company_id', companyId)
      .single();
    
    if (balanceError) {
      log('error', 'Erro ao verificar saldo antes do consumo', { error: balanceError.message, companyId });
    } else {
      log('debug', 'Saldo ANTES do consumo', { 
        companyId, 
        saldoAntes: creditsBefore?.balance || 0 
      });
    }
    
    const { data, error } = await supabase.rpc('consume_credits', {
      p_company_id: companyId,
      credits_to_consume: totalTokens, // 1:1 ratio
      service_type: 'openai_followup',
      feature: 'Follow-up Automático',
      description: description,
      user_id: null, // Sistema automático
      tokens_used: totalTokens,
      model_used: 'gpt-4o-mini',
      request_id: conversationId
    });
    
    // ✅ NOVO: Log detalhado da resposta da função
    log('debug', 'Resposta da função consume_credits', { 
      data, 
      error: error?.message,
      functionResult: data
    });
    
    if (error) {
      log('error', 'Erro ao consumir créditos', { 
        error: error.message, 
        companyId,
        errorCode: error.code,
        errorDetails: error.details,
        errorHint: error.hint
      });
      return false;
    }
    
    // ✅ NOVO: Verificar saldo depois do consumo
    const { data: creditsAfter, error: balanceAfterError } = await supabase
      .from('company_credits')
      .select('balance')
      .eq('company_id', companyId)
      .single();
    
    if (balanceAfterError) {
      log('error', 'Erro ao verificar saldo depois do consumo', { error: balanceAfterError.message, companyId });
    } else {
      const saldoAntes = creditsBefore?.balance || 0;
      const saldoDepois = creditsAfter?.balance || 0;
      const diferencaEsperada = totalTokens;
      const diferencaReal = saldoAntes - saldoDepois;
      
      log('success', 'Comparação de saldos', { 
        companyId, 
        tokensUsed: totalTokens,
        saldoAntes,
        saldoDepois,
        diferencaEsperada,
        diferencaReal,
        funcionouCorreto: diferencaReal === diferencaEsperada
      });
      
      if (diferencaReal !== diferencaEsperada) {
        log('error', '❌ PROBLEMA: Saldo não foi atualizado corretamente!', {
          companyId,
          esperado: diferencaEsperada,
          real: diferencaReal,
          funcionResult: data
        });
      }
    }
    
    log('success', 'Créditos consumidos com sucesso', { 
      companyId, 
      tokensUsed: totalTokens,
      creditsConsumed: totalTokens,
      functionReturnedTrue: data === true
    });
    
    return data === true;
    
  } catch (error) {
    log('error', 'Erro ao processar créditos', { 
      error: error.message, 
      companyId,
      stack: error.stack
    });
    return false;
  }
}

/**
 * Estima tokens baseado no texto
 */
function estimateTokensFromText(text) {
  // Aproximação: 4 caracteres = 1 token
  const charCount = text.length;
  const estimatedTokens = Math.ceil(charCount * 0.25);
  
  // Margem de segurança de 20%
  return Math.ceil(estimatedTokens * 1.2);
}

// ===============================================
// CORE: GERAÇÃO DE MENSAGEM COM IA (ATUALIZADA)
// ===============================================

/**
 * ✅ NOVO: Gera mensagem usando Zionic Credits (sem chave própria)
 */
async function generatePersonalizedMessageWithZionicCredits(template, context, agent, companyId) {
  try {
    log('info', 'Gerando mensagem com Zionic Credits (fallback inteligente)', { companyId });
    
    const contactName = context.contact?.first_name || 'usuário';
    const lastMessages = context.recentMessages
      .slice(-5) // Últimas 5 mensagens
      .map(m => `${m.sent_by_ai ? 'Agente' : contactName}: ${m.content}`)
      .join('\n');
    
    const prompt = `
Você é um assistente de follow-up inteligente. Sua tarefa é reescrever uma mensagem template para reativar uma conversa, baseado no contexto específico da conversa.

AGENTE: ${agent.name}
TOM: ${agent.tone || 'profissional'}
IDIOMA: ${agent.language || 'pt-BR'}

TEMPLATE ORIGINAL:
${template}

CONTEXTO DA CONVERSA:
- Nome do contato: ${contactName}
- Última mensagem enviada: ${formatDuration(Date.now() - new Date(context.lastMessage?.sent_at || Date.now()).getTime())} atrás
- Total de mensagens: ${context.messageCount}
- Conversa prévia (últimas mensagens):
${lastMessages}

INSTRUÇÕES:
1. Reescreva o template para ser mais específico e contextual
2. Mencione algo específico da conversa anterior se relevante
3. Mantenha o tom ${agent.tone || 'profissional'} e ${agent.language || 'português brasileiro'}
4. Seja natural, não robótico
5. Máximo 200 caracteres
6. Não use emojis excessivos

Retorne APENAS a mensagem reescrita, sem explicações.`;

    // Estimar tokens necessários
    const estimatedTokens = estimateTokensFromText(prompt) + 100; // +100 para resposta
    
    // Verificar créditos Zionic suficientes
    const creditsCheck = await checkCreditsBalance(companyId, estimatedTokens);
    if (!creditsCheck.hasEnough) {
      log('warning', 'Créditos Zionic insuficientes para gerar mensagem IA', {
        companyId,
        currentBalance: creditsCheck.currentBalance,
        required: creditsCheck.required
      });
      
      // ✅ NOVO: Criar notificação de créditos insuficientes
      await notifyZionicCreditsInsufficient(companyId, creditsCheck.currentBalance, creditsCheck.required);
      
      // Último fallback: usar template simples
      return template.replace('{nome}', contactName);
    }

    log('debug', 'Fazendo chamada para OpenAI usando Zionic Credits', {
      estimatedTokens,
      currentBalance: creditsCheck.currentBalance,
      companyId
    });

    // ✅ USAR CHAVE ZIONIC OPENAI (do sistema)
    const ZIONIC_OPENAI_KEY = process.env.ZIONIC_OPENAI_KEY || process.env.OPENAI_API_KEY;
    
    if (!ZIONIC_OPENAI_KEY) {
      log('error', 'Chave OpenAI do sistema Zionic não configurada');
      return template.replace('{nome}', contactName);
    }

    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini', // Modelo padrão Zionic
      messages: [
        { role: 'system', content: 'Você é um especialista em follow-up de vendas. Seja direto e eficaz.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 150,
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${ZIONIC_OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: CONFIG.defaultResponseTimeoutMs
    });
    
    const generatedMessage = response.data.choices[0]?.message?.content?.trim();
    
    if (!generatedMessage) {
      log('warning', 'IA Zionic não gerou resposta, usando template original');
      return template.replace('{nome}', contactName);
    }
    
    // Processar consumo de créditos Zionic
    const actualTokensUsed = response.data.usage?.total_tokens || estimatedTokens;
    const creditSuccess = await processOpenAICreditsUsage(
      companyId,
      actualTokensUsed,
      context.conversation.id,
      agent.id,
      `Follow-up Zionic "${agent.name}" - ${actualTokensUsed} tokens`
    );
    
    if (!creditSuccess) {
      log('warning', 'Falha ao registrar consumo de créditos Zionic (mensagem já gerada)');
    }
    
    log('success', 'Mensagem gerada com Zionic Credits', { 
      originalLength: template.length,
      generatedLength: generatedMessage.length,
      tokensUsed: actualTokensUsed,
      creditsProcessed: creditSuccess,
      mode: 'zionic_credits'
    });
    
    return generatedMessage;
    
  } catch (error) {
    log('error', 'Erro ao gerar mensagem com Zionic Credits', { error: error.message, companyId });
    
    // ✅ NOVO: Criar notificação de erro no sistema Zionic
    await notifyOpenAIError(companyId, { 
      status: error.response?.status,
      message: error.message 
    }, 'zionic_credits');
    
    // Fallback para template original
    const fallbackMessage = template.replace('{nome}', context.contact?.first_name || 'usuário');
    log('info', 'Usando template fallback após erro Zionic Credits', { fallbackMessage });
    return fallbackMessage;
  }
}

/**
 * Gera mensagem personalizada usando OpenAI com controle de créditos
 */
async function generatePersonalizedMessage(template, context, agent, openaiConfig, companyId) {
  try {
    log('debug', 'Gerando mensagem personalizada com chave própria da empresa');
    
    const contactName = context.contact?.first_name || 'usuário';
    const lastMessages = context.recentMessages
      .slice(-5) // Últimas 5 mensagens
      .map(m => `${m.sent_by_ai ? 'Agente' : contactName}: ${m.content}`)
      .join('\n');
    
    const prompt = `
Você é um assistente de follow-up inteligente. Sua tarefa é reescrever uma mensagem template para reativar uma conversa, baseado no contexto específico da conversa.

AGENTE: ${agent.name}
TOM: ${agent.tone || 'profissional'}
IDIOMA: ${agent.language || 'pt-BR'}

TEMPLATE ORIGINAL:
${template}

CONTEXTO DA CONVERSA:
- Nome do contato: ${contactName}
- Última mensagem enviada: ${formatDuration(Date.now() - new Date(context.lastMessage?.sent_at || Date.now()).getTime())} atrás
- Total de mensagens: ${context.messageCount}
- Conversa prévia (últimas mensagens):
${lastMessages}

INSTRUÇÕES:
1. Reescreva o template para ser mais específico e contextual
2. Mencione algo específico da conversa anterior se relevante
3. Mantenha o tom ${agent.tone || 'profissional'} e ${agent.language || 'português brasileiro'}
4. Seja natural, não robótico
5. Máximo 200 caracteres
6. Não use emojis excessivos

Retorne APENAS a mensagem reescrita, sem explicações.`;

    log('debug', 'Fazendo chamada para OpenAI com chave própria da empresa', {
      companyId,
      model: openaiConfig.model || 'gpt-4o-mini'
    });

    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: openaiConfig.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é um especialista em follow-up de vendas. Seja direto e eficaz.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 150,
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${openaiConfig.api_key}`,
        'Content-Type': 'application/json'
      },
      timeout: CONFIG.defaultResponseTimeoutMs
    });
    
    const generatedMessage = response.data.choices[0]?.message?.content?.trim();
    
    if (!generatedMessage) {
      log('warning', 'IA não gerou resposta com chave própria, tentando Zionic Credits');
      
      // ✅ NOVO: Notificar sobre problema com chave própria
      await notifyOpenAIError(companyId, { message: 'Resposta vazia da API' }, 'company_key');
      
      // ✅ FALLBACK: Tentar Zionic Credits
      return await generatePersonalizedMessageWithZionicCredits(template, context, agent, companyId);
    }
    
    log('success', 'Mensagem gerada com chave própria da empresa', { 
      originalLength: template.length,
      generatedLength: generatedMessage.length,
      mode: 'company_key',
      model: openaiConfig.model || 'gpt-4o-mini'
    });
    
    return generatedMessage;
    
  } catch (error) {
    log('warning', 'Erro com chave própria da empresa, tentando Zionic Credits', { 
      error: error.message,
      errorCode: error.response?.status
    });
    
    // ✅ FALLBACK INTELIGENTE: Se chave própria falha (limite atingido, erro 429, etc), usar Zionic Credits
    if (error.response?.status === 429 || error.message.includes('quota') || error.message.includes('limit')) {
      log('info', 'Limite da chave própria atingido - usando Zionic Credits automaticamente', { companyId });
      
      // ✅ NOVO: Criar notificação específica para quota exceeded
      await notifyOpenAIQuotaExceeded(companyId, { 
        status: error.response?.status,
        message: error.message 
      });
      
      const fallbackResult = await generatePersonalizedMessageWithZionicCredits(template, context, agent, companyId);
      
      // ✅ NOVO: Notificar sucesso do fallback se funcionou
      if (fallbackResult && fallbackResult !== template.replace('{nome}', context.contact?.first_name || 'usuário')) {
        await notifySuccessfulFallback(companyId, 'company_key', 'zionic_credits');
      }
      
      return fallbackResult;
    }
    
    // ✅ NOVO: Para outros erros, notificar antes do fallback
    await notifyOpenAIError(companyId, { 
      status: error.response?.status,
      message: error.message 
    }, 'company_key');
    
    // Para outros erros, também tentar Zionic Credits
    return await generatePersonalizedMessageWithZionicCredits(template, context, agent, companyId);
  }
}

// ===============================================
// CORE: ENVIO VIA WHATSAPP
// ===============================================

/**
 * ✅ NOVO: Buscar configuração Evolution via ENV VARS (igual conversation.js)
 */
function getEvolutionConfig() {
  return {
    server_url: EVOLUTION_API_URL,
    api_key: EVOLUTION_API_KEY
  };
}

/**
 * Envia mensagem via WhatsApp usando ENV VARS da Evolution
 */
async function sendWhatsAppMessage(instanceName, recipientNumber, message) {
  try {
    // ✅ USAR ENV VARS diretamente (igual conversation.js)
    const evolutionConfig = getEvolutionConfig();
    
    log('debug', 'Enviando mensagem WhatsApp via ENV VARS', { 
      instanceName, 
      recipientNumber: recipientNumber.substring(0, 8) + '...',
      messageLength: message.length,
      serverUrl: evolutionConfig.server_url
    });
    
    const response = await axios.post(`${evolutionConfig.server_url}/message/sendText/${instanceName}`, {
      number: recipientNumber,
      text: message,
      options: {
        delay: 1000,
        presence: 'composing'
      }
    }, {
      headers: {
        'apikey': evolutionConfig.api_key,
        'Content-Type': 'application/json'
      },
      timeout: CONFIG.defaultResponseTimeoutMs
    });
    
    if (response.data.error) {
      throw new Error(response.data.message || 'Erro no envio WhatsApp');
    }
    
    log('success', 'Mensagem WhatsApp enviada via Evolution ENV', {
      instanceName,
      recipientNumber: recipientNumber.substring(0, 8) + '...',
      messageId: response.data.key?.id,
      serverUsed: evolutionConfig.server_url
    });
    
    return { success: true, messageId: response.data.key?.id };
    
  } catch (error) {
    log('error', 'Erro ao enviar WhatsApp via Evolution', { 
      error: error.message,
      instanceName,
      recipientNumber: recipientNumber.substring(0, 8) + '...'
    });
    return { success: false, error: error.message };
  }
}

// ===============================================
// CORE: PROCESSAR FOLLOW-UP
// ===============================================

/**
 * Processa um único follow-up
 */
async function processFollowUp(followUp) {
  const startTime = Date.now();
  let executionLog = {
    follow_up_queue_id: followUp.id,
    agent_id: followUp.agent_id,
    conversation_id: followUp.conversation_id,
    contact_id: followUp.contact_id,
    company_id: followUp.company_id,
    rule_name: followUp.rule_name,
    success: false,
    error_message: null,
    response_time_ms: 0,
    message_sent: '',
    conversation_reactivated: false
  };
  
  try {
    log('info', `Processando follow-up: ${followUp.rule_name}`, { 
      followUpId: followUp.id,
      companyId: followUp.company_id,
      agentId: followUp.agent_id,
      conversationId: followUp.conversation_id
    });
    
    // ✅ VERIFICAÇÃO DE SEGURANÇA: Garantir que company_id existe
    if (!followUp.company_id) {
      log('error', 'Follow-up sem company_id - buscando do agente', { followUpId: followUp.id });
      
      // Buscar company_id do agente como fallback
      const { data: agent, error: agentError } = await supabase
        .from('ai_agents')
        .select('company_id')
        .eq('id', followUp.agent_id)
        .single();
        
      if (agentError || !agent?.company_id) {
        throw new Error(`Não foi possível determinar company_id para o follow-up ${followUp.id}`);
      }
      
      followUp.company_id = agent.company_id;
      log('info', 'Company_id recuperado do agente', { companyId: followUp.company_id });
    }
    
    // ✅ NOVO: Verificar créditos mínimos da empresa
    const creditsCheck = await checkCreditsBalance(followUp.company_id, CONFIG.credits.minimumBalanceThreshold);
    if (!creditsCheck.hasEnough) {
      // ✅ CORREÇÃO: Marcar como failed quando créditos insuficientes
      await supabase
        .from('follow_up_queue')
        .update({ 
          status: 'failed',
          attempts: followUp.attempts + 1,
          execution_error: `Créditos insuficientes (${creditsCheck.currentBalance}/${CONFIG.credits.minimumBalanceThreshold})`
        })
        .eq('id', followUp.id);
        
      throw new Error(`Créditos insuficientes (${creditsCheck.currentBalance}/${CONFIG.credits.minimumBalanceThreshold})`);
    }
    
    // 1. Buscar contexto da conversa
    const context = await getConversationContext(followUp.conversation_id);
    if (!context) {
      throw new Error('Não foi possível carregar contexto da conversa');
    }
    
    // 2. Buscar dados do agente
    const { data: agent, error: agentError } = await supabase
      .from('ai_agents')
      .select('*')
      .eq('id', followUp.agent_id)
      .single();
      
    if (agentError || !agent) {
      throw new Error(`Agente não encontrado: ${agentError?.message}`);
    }
    
    // 3. Verificar se deve executar (horário comercial se configurado)
    const followUpRules = agent.follow_up_rules || [];
    const rule = followUpRules.find(r => r.id === followUp.rule_id);
    
    if (rule?.conditions?.exclude_business_hours && !isBusinessHours()) {
      log('info', 'Follow-up adiado - fora do horário comercial', { followUpId: followUp.id });
      
      // Reagendar para próximo horário comercial
      const nextBusinessHour = new Date();
      nextBusinessHour.setHours(CONFIG.businessHours.start, 0, 0, 0);
      if (nextBusinessHour <= new Date()) {
        nextBusinessHour.setDate(nextBusinessHour.getDate() + 1);
      }
      
      await supabase
        .from('follow_up_queue')
        .update({ scheduled_at: nextBusinessHour.toISOString() })
        .eq('id', followUp.id);
        
      return { success: true, deferred: true };
    }
    
    // 4. Buscar configuração OpenAI da empresa
    const openaiConfig = await getCompanyOpenAIConfig(followUp.company_id);
    
    // 5. ✅ SISTEMA DE FALLBACK INTELIGENTE
    let finalMessage = followUp.message_template;
    
    if (openaiConfig) {
      // Empresa tem chave própria configurada - tentar usar primeiro
      log('info', 'Empresa tem chave OpenAI própria - modo premium', { 
        companyId: followUp.company_id,
        model: openaiConfig.model 
      });
      
      finalMessage = await generatePersonalizedMessage(
        followUp.message_template,
        context,
        agent,
        openaiConfig,
        followUp.company_id
      );
    } else {
      // ✅ FALLBACK INTELIGENTE: Empresa não tem chave própria - usar Zionic Credits
      log('info', 'Empresa sem chave OpenAI própria - usando Zionic Credits', { 
        companyId: followUp.company_id 
      });
      
      finalMessage = await generatePersonalizedMessageWithZionicCredits(
        followUp.message_template,
        context,
        agent,
        followUp.company_id
      );
      
      // ✅ NOVO: Se gerou mensagem IA com sucesso (não é só replace), informar que modo básico está funcionando
      if (finalMessage && finalMessage !== followUp.message_template.replace('{nome}', context.contact?.first_name || 'usuário')) {
        log('debug', 'Follow-up gerado com sucesso via Zionic Credits (modo básico)');
        // Não criar notificação aqui para não poluir, apenas log para debug
      }
    }
    
    executionLog.message_sent = finalMessage;
    
    // 6. Buscar nome da instância WhatsApp (simplificado)
    const { data: instance, error: instanceError } = await supabase
      .from('whatsapp_instances')
      .select('name')
      .eq('company_id', followUp.company_id)
      .eq('status', 'connected')
      .single();
    
    if (instanceError || !instance?.name) {
      throw new Error('Instância WhatsApp ativa não encontrada');
    }
    
    // 7. Enviar mensagem via Evolution ENV VARS
    const sendResult = await sendWhatsAppMessage(
      instance.name,
      context.contact.phone,
      finalMessage
    );
    
    if (!sendResult.success) {
      throw new Error(sendResult.error);
    }
    
    // 8. Marcar como enviado
    await supabase
      .from('follow_up_queue')
      .update({ 
        status: 'sent',
        attempts: followUp.attempts + 1,
        executed_at: new Date().toISOString(),
        ai_generated_message: finalMessage
      })
      .eq('id', followUp.id);
    
    // 9. Registrar mensagem no sistema
    await supabase
      .from('messages')
      .insert({
        conversation_id: followUp.conversation_id,
        contact_id: followUp.contact_id,
        direction: 'outbound',
        message_type: 'text',
        content: finalMessage,
        sent_at: new Date().toISOString(),
        sent_by_ai: true,
        ai_agent_id: followUp.agent_id,
        metadata: {
          follow_up_id: followUp.id,
          rule_name: followUp.rule_name,
          is_follow_up: true
        }
      });
    
    executionLog.success = true;
    executionLog.response_time_ms = Date.now() - startTime;
    
    log('success', `Follow-up enviado com sucesso`, {
      followUpId: followUp.id,
      ruleName: followUp.rule_name,
      contactName: context.contact?.first_name,
      responseTime: formatDuration(executionLog.response_time_ms)
    });
    
    return { success: true, messageId: sendResult.messageId };
    
  } catch (error) {
    executionLog.error_message = error.message;
    executionLog.response_time_ms = Date.now() - startTime;
    
    // Atualizar tentativas
    const newAttempts = followUp.attempts + 1;
    const status = newAttempts >= followUp.max_attempts ? 'failed' : 'pending';
    
    await supabase
      .from('follow_up_queue')
      .update({ 
        attempts: newAttempts,
        status: status,
        execution_error: error.message
      })
      .eq('id', followUp.id);
    
    log('error', `Erro ao processar follow-up`, {
      followUpId: followUp.id,
      error: error.message,
      attempts: newAttempts,
      maxAttempts: followUp.max_attempts,
      finalStatus: status
    });
    
    return { success: false, error: error.message };
    
  } finally {
    // Registrar log de execução
    try {
      await supabase.from('follow_up_logs').insert(executionLog);
    } catch (logError) {
      log('warning', 'Erro ao registrar log de execução', { error: logError.message });
    }
  }
}

// ===============================================
// ✅ NOVO: SINCRONIZAÇÃO DE FOLLOW-UPS ÓRFÃOS
// ===============================================

/**
 * ✅ OTIMIZADO: Limpa follow-ups antigos usando função SQL
 */
async function cleanupOldFailedFollowUps() {
  try {
    log('debug', 'Executando limpeza automática de follow-ups antigos...');
    
    const { data: cleanedCount, error } = await supabase.rpc('cleanup_old_follow_ups', {
      p_hours_old: 6
    });
    
    if (error) {
      log('warning', 'Erro ao limpar follow-ups antigos', { error: error.message });
      return;
    }
    
    if (cleanedCount && cleanedCount > 0) {
      log('info', `🧹 Limpeza automática: ${cleanedCount} follow-ups antigos marcados como failed`, {
        olderThan: '6 horas',
        method: 'sql_function'
      });
    }
    
  } catch (error) {
    log('error', 'Erro na limpeza de follow-ups antigos', { error: error.message });
  }
}

/**
 * ✅ OTIMIZADO: Detecta e cria follow-ups órfãos usando função SQL eficiente
 */
async function findAndCreateOrphanedFollowUps() {
  try {
    log('info', '🔍 Detectando follow-ups órfãos com SQL otimizado...');
    
    // ✅ Limpeza automática antes da detecção
    await cleanupOldFailedFollowUps();
    
    // ✅ NOVA ABORDAGEM: Usar função SQL otimizada
    const { data: orphanedFollowUps, error } = await supabase.rpc('create_orphaned_follow_ups', {
      p_limit: 1000,  // Até 1000 follow-ups órfãos por execução
      p_days_back: 7   // Últimos 7 dias
    });

    if (error) {
      log('error', 'Erro na detecção SQL de órfãos', { error: error.message });
      return [];
    }

    if (!orphanedFollowUps || orphanedFollowUps.length === 0) {
      log('info', 'Nenhum follow-up órfão encontrado');
      return [];
    }

    log('success', `✅ Detecção SQL concluída: ${orphanedFollowUps.length} follow-ups órfãos criados`, {
      method: 'sql_optimized',
      orphansCreated: orphanedFollowUps.length,
      averageLateness: orphanedFollowUps.reduce((acc, f) => acc + (f.minutes_late || 0), 0) / orphanedFollowUps.length
    });

    // Log dos órfãos criados para debug
    if (orphanedFollowUps.length <= 10) {
      orphanedFollowUps.forEach(followUp => {
        log('debug', 'Follow-up órfão criado', {
          conversationId: followUp.conversation_id,
          ruleName: followUp.rule_name,
          minutesLate: followUp.minutes_late,
          scheduledAt: followUp.scheduled_at
        });
      });
    }

    return orphanedFollowUps;

  } catch (error) {
    log('error', 'Erro na detecção otimizada de órfãos', { error: error.message });
    return [];
  }
}

// ===============================================
// CORE: EXECUÇÃO PRINCIPAL (ATUALIZADA)
// ===============================================

/**
 * Execução principal do processamento de follow-ups
 */
async function executeFollowUps() {
  const executionStart = Date.now();
  stats.totalExecutions++;
  
  log('info', '🔄 === INICIANDO EXECUÇÃO DE FOLLOW-UPS ===', {
    execution: stats.totalExecutions,
    timestamp: new Date().toISOString()
  });
  
  try {
    // 1. Buscar follow-ups pendentes existentes
    const pendingFollowUps = await getPendingFollowUps();
    
    // ✅ 2. NOVO: Buscar e criar follow-ups órfãos
    const orphanedFollowUps = await findAndCreateOrphanedFollowUps();
    
    // 3. Combinar ambos os tipos
    const allFollowUps = [...pendingFollowUps, ...orphanedFollowUps];
    
    if (allFollowUps.length === 0) {
      log('info', 'Nenhum follow-up para processar');
      return;
    }
    
    log('info', `Processando ${allFollowUps.length} follow-ups (${pendingFollowUps.length} pendentes + ${orphanedFollowUps.length} órfãos)...`);
    
    // 4. Processar cada follow-up
    const results = [];
    for (const followUp of allFollowUps) {
      const result = await processFollowUp(followUp);
      results.push(result);
      
      // Pausa entre execuções para não sobrecarregar
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // 5. Calcular estatísticas
    const successful = results.filter(r => r.success && !r.deferred).length;
    const deferred = results.filter(r => r.deferred).length;
    const failed = results.filter(r => !r.success).length;
    
    stats.totalFollowUpsSent += successful;
    stats.totalOrphansCreated += orphanedFollowUps.length; // ✅ NOVO: Contar órfãos criados
    stats.successRate = stats.totalFollowUpsSent / (stats.totalFollowUpsSent + stats.totalErrors) * 100;
    stats.lastExecution = new Date();
    
    if (failed > 0) {
      stats.totalErrors += failed;
    }
    
    const executionTime = Date.now() - executionStart;
    
    log('success', '✅ === EXECUÇÃO CONCLUÍDA ===', {
      totalProcessed: allFollowUps.length,
      pendingProcessed: pendingFollowUps.length,
      orphansCreated: orphanedFollowUps.length,
      successful,
      deferred,
      failed,
      executionTime: formatDuration(executionTime),
      successRate: `${stats.successRate.toFixed(1)}%`
    });
    
  } catch (error) {
    stats.totalErrors++;
    log('error', 'Erro na execução principal', { error: error.message });
  }
}

// ===============================================
// API DE STATUS
// ===============================================

/**
 * Endpoint simples para status do servidor
 */
function startStatusEndpoint() {
  const express = require('express');
  const app = express();
  const PORT = process.env.PORT || 3000;
  
  app.get('/', (req, res) => {
    res.json({
      status: 'running',
      service: 'Zionic Follow-up Server',
      version: '1.5.0', // ✅ OTIMIZAÇÃO: Detecção SQL eficiente de órfãos
      uptime: formatDuration(Date.now() - stats.serverStartTime),
      stats: {
        ...stats,
        nextExecution: 'A cada 1 minuto (máxima precisão)'
      },
      features: {
        orphanSync: true,
        creditsControl: true,
        intelligentFallback: true, // ✅ NOVO: Fallback inteligente OpenAI
        systemNotifications: true, // ✅ NOVO: Notificações automáticas
        intervalMinutes: CONFIG.executionIntervalMinutes
      },
      timestamp: new Date().toISOString()
    });
  });
  
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'healthy',
      timestamp: new Date().toISOString(),
      lastExecution: stats.lastExecution
    });
  });
  
  app.listen(PORT, () => {
    log('success', `API de status rodando na porta ${PORT}`);
  });
}

// ===============================================
// INICIALIZAÇÃO
// ===============================================

async function initialize() {
  try {
    log('info', 'Testando conexão com Supabase...');
    
    const { data, error } = await supabase.from('ai_agents').select('id').limit(1);
    if (error) {
      throw new Error(`Erro na conexão com Supabase: ${error.message}`);
    }
    
    log('success', 'Conexão com Supabase estabelecida');
    
    // ✅ ATUALIZADO: Configurar cron job para executar a cada 1 minuto (maior precisão)
    cron.schedule('*/1 * * * *', () => {
      executeFollowUps().catch(error => {
        log('error', 'Erro no cron job', { error: error.message });
      });
    });
    
    log('success', 'Cron job configurado (a cada 1 minuto para máxima precisão)');
    
    // Iniciar API de status
    startStatusEndpoint();
    
    // Executar imediatamente uma vez
    await executeFollowUps();
    
    log('success', '🎉 Servidor de follow-up inicializado com sucesso!');
    
  } catch (error) {
    log('error', 'Falha na inicialização', { error: error.message });
    process.exit(1);
  }
}

// Tratar sinais de encerramento
process.on('SIGTERM', () => {
  log('info', 'Servidor recebeu SIGTERM, encerrando...');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'Servidor recebeu SIGINT, encerrando...');
  process.exit(0);
});

// Inicializar servidor
initialize();

module.exports = {
  executeFollowUps,
  processFollowUp,
  stats
}; 

// ===============================================
// ✅ NOVO: SISTEMA DE NOTIFICAÇÕES
// ===============================================

/**
 * Cria uma notificação no sistema para avisar sobre problemas
 */
async function createSystemNotification(companyId, type, title, message, severity = 'medium', metadata = {}) {
  try {
    if (!companyId || companyId === 'undefined' || companyId === null) {
      log('error', 'CompanyId inválido para criar notificação', { companyId, type });
      return;
    }

    log('debug', 'Criando notificação no sistema', { 
      companyId: companyId.toString(), 
      type, 
      title, 
      severity 
    });

    const { data, error } = await supabase
      .from('system_notifications')
      .insert({
        company_id: companyId,
        type: type,
        title: title,
        message: message,
        severity: severity,
        metadata: metadata,
        is_read: false
      })
      .select('id')
      .single();

    if (error) {
      log('error', 'Erro ao criar notificação', { 
        error: error.message, 
        companyId: companyId.toString(),
        type 
      });
      return;
    }

    log('success', 'Notificação criada com sucesso', { 
      companyId: companyId.toString(), 
      notificationId: data.id,
      type,
      severity 
    });

    return data.id;

  } catch (error) {
    log('error', 'Erro ao criar notificação do sistema', { 
      error: error.message, 
      companyId: companyId ? companyId.toString() : 'null',
      type 
    });
  }
}

/**
 * Cria notificação quando chave própria da empresa falha por quota
 */
async function notifyOpenAIQuotaExceeded(companyId, errorDetails = {}) {
  const title = '🚨 Limite OpenAI Atingido';
  const message = 'Sua chave OpenAI atingiu o limite de quota. Os follow-ups estão sendo processados automaticamente usando Zionic Credits para garantir continuidade.';
  
  const metadata = {
    help_url: 'https://platform.openai.com/account/billing',
    fallback_active: true,
    error_code: errorDetails.status || 429,
    timestamp: new Date().toISOString(),
    solution: 'automatic_fallback_to_zionic_credits'
  };

  await createSystemNotification(
    companyId,
    'openai_quota_exceeded',
    title,
    message,
    'high',
    metadata
  );
}

/**
 * Cria notificação quando Zionic Credits estão insuficientes
 */
async function notifyZionicCreditsInsufficient(companyId, currentBalance, required) {
  const title = '💰 Zionic Credits Insuficientes';
  const message = `Seus Zionic Credits estão baixos (${currentBalance} disponíveis, ${required} necessários). Compre mais créditos para manter os follow-ups funcionando com IA.`;
  
  const metadata = {
    current_balance: currentBalance,
    required_credits: required,
    purchase_url: '/settings?subtab=integracoes#credits',
    timestamp: new Date().toISOString(),
    fallback_to_template: true
  };

  await createSystemNotification(
    companyId,
    'zionic_credits_insufficient',
    title,
    message,
    'medium',
    metadata
  );
}

/**
 * Cria notificação quando há erro crítico com OpenAI
 */
async function notifyOpenAIError(companyId, errorDetails, mode = 'company_key') {
  const isCompanyKey = mode === 'company_key';
  const title = isCompanyKey ? '⚠️ Erro na Chave OpenAI' : '⚠️ Erro no Sistema IA';
  
  const message = isCompanyKey 
    ? 'Erro na sua chave OpenAI. Follow-ups continuam funcionando via Zionic Credits.'
    : 'Erro no sistema de IA. Follow-ups usarão templates simples temporariamente.';
  
  const metadata = {
    error_message: errorDetails.message || 'Erro desconhecido',
    error_code: errorDetails.status || 500,
    mode: mode,
    timestamp: new Date().toISOString(),
    help_url: isCompanyKey ? 'https://platform.openai.com/account/api-keys' : null,
    fallback_active: true
  };

  const severity = isCompanyKey ? 'medium' : 'high';

  await createSystemNotification(
    companyId,
    'openai_error',
    title,
    message,
    severity,
    metadata
  );
}

/**
 * Cria notificação de sucesso quando fallback funciona perfeitamente
 */
async function notifySuccessfulFallback(companyId, fromMode, toMode) {
  const title = '✅ Sistema de Backup Ativado';
  const message = `Transição automática de ${fromMode === 'company_key' ? 'chave própria' : 'sistema'} para ${toMode === 'zionic_credits' ? 'Zionic Credits' : 'template'} concluída com sucesso.`;
  
  const metadata = {
    from_mode: fromMode,
    to_mode: toMode,
    timestamp: new Date().toISOString(),
    auto_fallback: true
  };

  await createSystemNotification(
    companyId,
    'fallback_success',
    title,
    message,
    'info',
    metadata
  );
} 
