// pm2 process config for the always-on local agent. Run from the repo root:
//   npm i -g pm2
//   pm2 start ecosystem.config.cjs
//   pm2 save          # persist the process list
//   pm2 startup       # print the command to run the agent on boot
module.exports = {
  apps: [
    {
      name: "lucy-agent",
      script: "npx",
      args: "tsx --env-file=.env.agent agent/index.ts",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
    },
  ],
};
