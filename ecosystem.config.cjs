module.exports = {
  apps: [{
    name: 'mail-hub',
    script: 'dist/index.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3100,
    },
    max_memory_restart: '200M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
