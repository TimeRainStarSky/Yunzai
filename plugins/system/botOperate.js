export class botOperate extends plugin {
  constructor() {
    super({
      name: "botOperate",
      dsc: "Bot 操作",
      event: "message",
      priority: -Infinity,
      rule: [
        {
          reg: "^#(Bot|机器人)验证.+:.+$",
          fnc: "Verify",
          permission: "master",
        },
        {
          reg: "^#(Bot|机器人)(上|下)线.+$",
          fnc: "Operate",
          permission: "master",
        },
      ],
    })
  }

  Verify() {
    const data = {
      msg: this.e.msg
        .replace(/^#(Bot|机器人)验证/, "")
        .trim()
        .split(":"),
      reply: msg => this.reply(msg, true),
    }
    data.self_id = data.msg.shift()
    data.msg = data.msg.join(":")
    Bot.em(`verify.${data.self_id}`, data)
  }

  async Operate() {
    const bot = Bot[this.e.msg.replace(/^#(Bot|机器人)(上|下)线/, "").trim()]
    if (typeof bot != "object") {
      await this.reply("Bot 不存在", true)
      return false
    }
    if (this.e.msg.includes("上线") && typeof bot.login == "function") {
      await this.reply("已发送上线操作", true)
      await bot.login()
    } else if (this.e.msg.includes("下线") && typeof bot.logout == "function") {
      await this.reply("已发送下线操作", true)
      await bot.logout()
    } else {
      await this.reply("暂不支持此操作", true)
    }
  }
}
