switch (process.env.app_type || process.argv[2]) {
  case "stop": {
    const cfg = (await import("./lib/config/config.js")).default
    await fetch(`http://localhost:${cfg.server.port}/exit`, {
      headers: cfg.server.auth || undefined,
    }).catch(() => {})
    process.exit()
  }
  case "daemon": {
    console.log("守护进程正在启动主进程")
    const { spawnSync } = await import("node:child_process")
    while (
      spawnSync(process.argv[0], [process.argv[1], "start", ...process.argv.slice(2)], {
        stdio: "inherit",
      }).status !== 255
    )
      console.log("守护进程正在重启主进程")
    console.log("守护进程已停止")
    process.exit()
  }
  case "pm2":
    global.start_type = "pm2"
    break
  case "start":
    global.start_type = "external"
    break
  default:
    global.start_type = "internal"
}
global.Bot = new (await import("./lib/bot.js")).default()
Bot.run()
