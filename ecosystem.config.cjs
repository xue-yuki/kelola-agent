module.exports = {
  apps: [
    {
      name: 'kelola-agent',
      script: 'src/index.js',
      interpreter: 'node',
      node_args: '--experimental-vm-modules',
      instances: 1,
      exec_mode: 'fork',        // WAJIB fork — WA session tidak bisa cluster
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      min_uptime: '10s',        // Jangan restart kalau hidup kurang dari 10 detik
      max_restarts: 10,         // Max 10 restart sebelum PM2 nyerah
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
    }
  ]
}
