module.exports = {
  apps: [{
    name: 'blockheads-bot',
    script: 'npm',
    args: 'run mac',
    cwd: __dirname + '/bot',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    restart_delay: 5000,
    max_restarts: 100,
    env: {
      NODE_ENV: 'production'
    }
  }]
}
