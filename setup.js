#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('🔧 Calendar Sync Server Setup');
console.log('================================\n');

async function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function setup() {
  try {
    console.log('This script will help you configure the Calendar Sync Server.\n');

    // Coletar configurações
    const supabaseUrl = await prompt('📡 Supabase URL: ');
    const supabaseServiceKey = await prompt('🔑 Supabase Service Role Key: ');
    const pollingInterval = await prompt('⏰ Polling interval in minutes (default: 1): ') || '1';
    const enableHealthCheck = await prompt('🏥 Enable health check server? (y/n, default: y): ') || 'y';
    const healthCheckPort = await prompt('🔌 Health check port (default: 3003): ') || '3003';
    const logLevel = await prompt('📋 Log level (debug/info/warn/error, default: info): ') || 'info';

    // Validar configurações
    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('❌ Supabase URL and Service Role Key are required!');
      process.exit(1);
    }

    if (parseInt(pollingInterval) < 1 || parseInt(pollingInterval) > 60) {
      console.error('❌ Polling interval must be between 1 and 60 minutes!');
      process.exit(1);
    }

    // Criar arquivo .env
    const envContent = `# =====================================
# CONFIGURAÇÃO DO SERVIDOR DE POLLING
# =====================================

# Supabase
SUPABASE_URL=${supabaseUrl}
SUPABASE_SERVICE_ROLE_KEY=${supabaseServiceKey}

# Configuração do Polling
POLLING_INTERVAL_MINUTES=${pollingInterval}
MAX_COMPANIES_PER_BATCH=50
SYNC_TIMEOUT_SECONDS=30

# Configuração de Logs
LOG_LEVEL=${logLevel}
LOG_FILE_PATH=./logs/calendar-sync.log

# Configuração de Rate Limiting
GOOGLE_API_RATE_LIMIT_PER_MINUTE=300
RETRY_ATTEMPTS=3
RETRY_DELAY_MS=1000

# Ambiente
NODE_ENV=production
PORT=3002

# Configuração de Monitoramento
ENABLE_HEALTH_CHECK=${enableHealthCheck === 'y' ? 'true' : 'false'}
HEALTH_CHECK_PORT=${healthCheckPort}

# Configuração adicional
RUN_INITIAL_SYNC=true
`;

    fs.writeFileSync('.env', envContent);
    console.log('✅ Created .env file');

    // Criar diretório de logs
    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
      console.log('✅ Created logs directory');
    }

    // Criar arquivo PM2 ecosystem
    const pm2Config = {
      apps: [{
        name: 'calendar-sync-server',
        script: './server.js',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '500M',
        env: {
          NODE_ENV: 'production'
        },
        error_file: './logs/pm2-error.log',
        out_file: './logs/pm2-out.log',
        log_file: './logs/pm2-combined.log',
        time: true
      }]
    };

    fs.writeFileSync('ecosystem.config.js', `module.exports = ${JSON.stringify(pm2Config, null, 2)};`);
    console.log('✅ Created PM2 ecosystem config');

    // Criar script de start/stop
    const startScript = `#!/bin/bash
# Start Calendar Sync Server

echo "🚀 Starting Calendar Sync Server..."

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "Installing PM2..."
    npm install -g pm2
fi

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup

echo "✅ Calendar Sync Server started!"
echo "📊 Monitor: pm2 monit"
echo "📋 Logs: pm2 logs calendar-sync-server"
echo "🏥 Health: http://localhost:${healthCheckPort}/health"
`;

    fs.writeFileSync('start.sh', startScript);
    fs.chmodSync('start.sh', '755');
    console.log('✅ Created start script');

    const stopScript = `#!/bin/bash
# Stop Calendar Sync Server

echo "🛑 Stopping Calendar Sync Server..."
pm2 stop calendar-sync-server
pm2 delete calendar-sync-server
echo "✅ Calendar Sync Server stopped!"
`;

    fs.writeFileSync('stop.sh', stopScript);
    fs.chmodSync('stop.sh', '755');
    console.log('✅ Created stop script');

    console.log('\n🎉 Setup completed successfully!');
    console.log('\nNext steps:');
    console.log('1. Install dependencies: npm install');
    console.log('2. Start the server: ./start.sh');
    console.log('3. Check status: pm2 status');
    console.log(`4. Health check: http://localhost:${healthCheckPort}/health`);
    console.log('\nFor more information, check the README.md file.\n');

  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
  }

  rl.close();
}

setup(); 
