// PM2 config to run all four batches of worker.js, each watching 10 groups.
//
// Setup:
//   npm install -g pm2
//
// Start all batches:
//   pm2 start ecosystem.config.js
//
// Useful commands:
//   pm2 status              // see all 4 processes and their state
//   pm2 logs fb-batch-1      // tail logs for one batch
//   pm2 restart fb-batch-2   // restart just one batch
//   pm2 stop all             // stop everything
//   pm2 save && pm2 startup  // persist across reboots
//
// Each app passes its batch number as an argv to worker.js, which derives
// the correct FACEBOOK_GROUP* range, USER_DATA_DIR_*, and seen-posts-*.json
// from that number.

module.exports = {
  apps: [1, 2, 3, 4].map((batchId) => ({
    name: `fb-batch-${batchId}`,
    script: "worker.js",
    args: `${batchId}`,
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 20,
    // Guards against a slow memory leak in a long-running headless browser;
    // PM2 will restart the process if it exceeds this.
    max_memory_restart: "1G",
    out_file: `./logs/batch-${batchId}-out.log`,
    error_file: `./logs/batch-${batchId}-error.log`,
    time: true,
  })),
};
