import plugin from '../../lib/plugins/plugin.js'
import cfg from '../../lib/config/config.js'

import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { exec } = require('child_process')

export class Restart extends plugin {
  constructor (e = '') {
    super({
      name: '重启',
      dsc: '#重启',
      event: 'message',
      priority: 10,
      rule: [{
        reg: '^#重启$',
        fnc: 'restart',
        permission: 'master'
      }, {
        reg: '^#(停机|关机)$',
        fnc: 'stop',
        permission: 'master'
      }, {
        reg: /^#设置重启CD\s?[0-9]{0,}$/,
        fnc: 'setInterval',
        permission: 'master'
      }]
    })

    if (e) this.e = e

    this.key = 'Yz:restart'
  }

  async init () {
    let restart = await redis.get(this.key)
    if (restart) {
      restart = JSON.parse(restart)
      let time = restart.time || new Date().getTime()
      time = (new Date().getTime() - time) / 1000

      let msg = `重启成功：耗时${time.toFixed(2)}秒`

      if (restart.isGroup)
        Bot.sendGroupMsg(restart.bot_id, restart.id, msg)
      else
        Bot.sendFriendMsg(restart.bot_id, restart.id, msg)

    }
  }

  async restart() {
    const restart = JSON.parse(await redis.get(this.key) ?? '{}')
    if (restart?.time) {
      const restartTime = restart.time + cfg.bot.restart_interval
      const time = new Date().getTime()
      if (time < restartTime) {
        await this.e.reply(`重启CD冷却中（${((restartTime - time) / 1000).toFixed(2)}秒)`)
        logger.mark(`重启CD冷却中（${((restartTime - time) / 1000).toFixed(2)}秒)`)
        return
      }
    }

    redis.del(this.key)

    await this.e.reply('开始执行重启，请稍等...')
    logger.mark(`${this.e.logFnc} 开始执行重启，请稍等...`)

    let data = JSON.stringify({
      isGroup: !!this.e.isGroup,
      id: this.e.isGroup ? this.e.group_id : this.e.user_id,
      bot_id: this.e.self_id,
      time: new Date().getTime()
    })

    let npm = await this.checkPnpm()

    try {
      await redis.set(this.key, data, { EX: 120 })
      let cm = `${npm} start`
      if (process.argv[1].includes('pm2')) {
        cm = `${npm} run restart`
      }

      exec(cm, { windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          redis.del(this.key)
          this.e.reply(`操作失败！\n${error.stack}`)
          logger.error(`重启失败\n${error.stack}`)
        } else if (stdout) {
          logger.mark('重启成功，运行已由前台转为后台')
          logger.mark(`查看日志请用命令：${npm} run log`)
          logger.mark(`停止后台运行命令：${npm} stop`)
          process.exit()
        }
      })
    } catch (error) {
      redis.del(this.key)
      let e = error.stack ?? error
      this.e.reply(`操作失败！\n${e}`)
    }

    return true
  }

  async checkPnpm () {
    let npm = 'npm'
    let ret = await this.execSync('pnpm -v')
    if (ret.stdout) npm = 'pnpm'
    return npm
  }

  async execSync (cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr })
      })
    })
  }

  async stop () {
    if (!process.argv[1].includes('pm2')) {
      logger.mark('关机成功，已停止运行')
      await this.e.reply('关机成功，已停止运行')
      process.exit()
    }

    logger.mark('关机成功，已停止运行')
    await this.e.reply('关机成功，已停止运行')

    let npm = await this.checkPnpm()
    exec(`${npm} stop`, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        this.e.reply(`操作失败！\n${error.stack}`)
        logger.error(`关机失败\n${error.stack}`)
      }
    })
  }

  async setInterval() {
    const time = this.e.msg.match(/\d+/ig)[0]
    if (time) {
      if (Number(time) < 1000) {
        await this.e.reply('重启CD最小设置为1000（1秒）')
      } else {
        cfg.bot.restart_interval = Number(time)
        await this.e.reply(`重启CD已设置为${time / 1000}秒`)
        logger.mark(`重启CD已设置为${time / 1000}秒`)
      }
    } else {
      await this.e.reply('请输入#设置重启CD + 时间')
    }
  }
}
