import fs from "node:fs/promises"

/**
 * 加载监听事件
 */
class ListenerLoader {
  /**
   * 监听事件加载
   */
  async load() {
    Bot.makeLog("info", "-----------", "Listener")
    Bot.makeLog("info", "加载监听事件中...", "Listener")
    const eventPromise = (await fs.readdir("./lib/events"))
      .filter(file => file.endsWith(".js"))
      .map(this.loadEvent)
    await Promise.allSettled(eventPromise)
    Bot.makeLog("info", `加载监听事件[${eventPromise.length}个]`, "Listener")

    Bot.makeLog("info", "-----------", "Adapter")
    Bot.makeLog("info", "加载适配器中...", "Adapter")
    const adapterPromise = Bot.adapter.map(this.loadAdapter)
    await Promise.allSettled(adapterPromise)
    Bot.makeLog("info", `加载适配器[${adapterPromise.length}个]`, "Adapter")
  }

  async loadEvent(file) {
    Bot.makeLog("debug", [`加载监听事件 ${file}`], "Listener")
    try {
      let listener = await import(`../events/${file}`)
      if (!listener.default) return
      listener = new listener.default()
      const on = listener.once ? "once" : "on"

      for (const type of Array.isArray(listener.event) ? listener.event : [listener.event]) {
        const e = listener[type] ? type : "execute"
        Bot[on](listener.prefix + type, listener[e].bind(listener))
      }
    } catch (err) {
      Bot.makeLog("error", [`监听事件加载错误 ${file}`, err], "Listener")
    }
  }

  async loadAdapter(adapter) {
    Bot.makeLog("debug", [`加载适配器 ${adapter.name}(${adapter.id})`], "Adapter")
    try {
      await adapter.load()
    } catch (err) {
      Bot.makeLog("error", [`适配器加载错误 ${adapter.name}(${adapter.id})`, err], "Adapter")
    }
  }
}

export default new ListenerLoader()
