module.exports = {
  apps: [
    {
      name: 'kelola-agent',
      script: 'src/index.js',
      interpreter: 'node',
      node_args: '--experimental-vm-modules',
      instances: 1,          // Jangan lebih dari 1 — WA session tidak bisa cluster
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      },
      // Log settings
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
    }
  ]
}
