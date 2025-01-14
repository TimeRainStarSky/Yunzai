switch (process.env.app_type || process.argv[2]) {
  case "pm2":
  case "start": {
    global.Bot = new (await import("./lib/bot.js")).default
    Bot.run()
    break
  } case "stop": {
    const cfg = (await import("./lib/config/config.js")).default
    const fetch = (await import("node-fetch")).default
    try {
      await fetch(`http://localhost:${cfg.server.port}/exit`, { headers: cfg.server.auth || undefined })
    } catch {}
    process.exit()
  } default: {
    const { spawnSync } = await import("node:child_process")
    const otherArgv = [...process.argv].splice(2)
    while (!spawnSync(process.argv[0],
      [process.argv[1], "start", ...otherArgv],
      { stdio: "inherit" },
    ).status) {}
    process.exit()
  }
}