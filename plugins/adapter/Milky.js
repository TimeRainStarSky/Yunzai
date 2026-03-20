import cfg from "../../lib/config/config.js"
import util from "../../lib/util.js"
import fetch from "node-fetch"
import { WebSocket } from "ws"
import fs from "node:fs"
import YAML from "yaml"

Bot.adapter.push(
  new (class MilkyAdapter {
    id = "Milky"
    name = "Milky"
    version = "1.0.0"
    path = this.name

    constructor() {
      this.init()
    }

    async init() {
      const configFile = "config/milky.yaml"
      if (!fs.existsSync(configFile)) {
        const defaultConfig = `
# Milky 协议设置
# 适配 Lagrange.Milky

# 是否启用
enable: false

# Milky 服务器地址
host: 127.0.0.1
# Milky 服务器端口
port: 3000
# URL 前缀 (应与 Milky协议端 配置一致)
prefix: ""
# 鉴权 Token (应与 Milky协议端 配置一致)
access_token: ""

# 事件接收方式: ws (WebSocket) 或 webhook
connection: ws

# Webhook 设置 (仅当 connection 为 webhook 时有效)
webhook:
  # Webhook 路径 (应与 Milky协议端 配置一致)
  path: /milky

# WebSocket 设置 (仅当 connection 为 ws 时有效)
ws:
  # 心跳间隔 (单位：秒)
  heartbeat: 30
  # 断线重连间隔 (单位：秒)
  reconnect_interval: 10
`
        fs.writeFileSync(configFile, defaultConfig.trim())
        Bot.makeLog("mark", "[Milky] 已自动创建 config/milky.yaml，配置默认值已填入")
      }

      let config
      try {
        config = YAML.parse(fs.readFileSync(configFile, "utf8"))
      } catch (err) {
        Bot.makeLog("error", `[Milky] 读取配置文件 ${configFile} 错误: ${err.message}`)
        return
      }
      if (!config.enable) return

      const { host, port, prefix, access_token, connection } = config
      const baseUrl = `http://${host}:${port}${prefix}`
      const apiBaseUrl = `${baseUrl}/api`

      if (connection === "ws") {
        setTimeout(() => this.connectWs(config, apiBaseUrl), 12000)
      } else if (connection === "webhook") {
        setTimeout(() => this.setupWebhook(config, apiBaseUrl), 12000)
      }
    }

    async connectWs(config, apiBaseUrl) {
      const { host, port, prefix, access_token } = config
      const wsUrl = `ws://${host}:${port}${prefix}/event${access_token ? `?access_token=${access_token}` : ""}`

      const heartbeatInterval = (config.ws?.heartbeat || 30) * 1000
      const reconnectInterval = (config.ws?.reconnect_interval || 10) * 1000

      const connect = () => {
        const ws = new WebSocket(wsUrl)
        let heartbeat

        ws.on("open", () => {
          Bot.makeLog("debug", `[Milky] WebSocket 已连接: ${wsUrl}`)
          this.onConnect(config, ws, apiBaseUrl)

          heartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.ping()
            }
          }, heartbeatInterval)
        })

        ws.on("message", data => {
          this.handleEvent(JSON.parse(data), ws, apiBaseUrl)
        })

        ws.on("close", () => {
          if (heartbeat) clearInterval(heartbeat)
          Bot.makeLog("warn", `[Milky] WebSocket 已断开，${reconnectInterval / 1000}秒后重连...`)
          setTimeout(connect, reconnectInterval)
        })

        ws.on("error", err => {
          Bot.makeLog("error", `[Milky] WebSocket 错误: ${err.message}`)
        })
      }
      connect()
    }

    setupWebhook(config, apiBaseUrl) {
      const { webhook } = config
      const path = webhook.path || "/milky"

      Bot.express.post(path, (req, res) => {
        this.handleEvent(req.body, null, apiBaseUrl)
        res.sendStatus(200)
      })

      Bot.makeLog("mark", `[Milky] Webhook 已设置在路径: ${path}`)
      // For webhook, we might need to manually trigger onConnect to initialize bot info
      this.onConnect(config, null, apiBaseUrl)
    }

    async onConnect(config, ws, apiBaseUrl) {
      Bot.makeLog("debug", "[Milky] 正在初始化 Bot 信息...")
      try {
        const loginInfo = await this.callApi(apiBaseUrl, config.access_token, "get_login_info")
        if (loginInfo.retcode !== 0) {
          Bot.makeLog("error", `[Milky] 获取登录信息失败: ${loginInfo.error}`)
          return
        }

        const self_id = String(loginInfo.data.uin || loginInfo.data.user_id)
        if (!Bot[self_id]) {
          Bot[self_id] = {
            adapter: this,
            ws: ws,
            sendApi: (action, params) => this.callApi(apiBaseUrl, config.access_token, action, params),
            info: loginInfo.data,
            get uin() { return this.info.uin || this.info.user_id },
            get nickname() { return this.info.nickname },
            fl: new Map(),
            gl: new Map(),
            gml: new Map(),
            send_private_msg: (user_id, msg) => this.sendPrivateMsg({ self_id, bot: Bot[self_id], user_id }, msg),
            send_group_msg: (group_id, msg) => this.sendGroupMsg({ self_id, bot: Bot[self_id], group_id }, msg),
            send_private_forward_msg: (user_id, msg) => this.sendPrivateForwardMsg({ self_id, bot: Bot[self_id], user_id }, msg),
            sendFriendForwardMsg: (user_id, msg) => this.sendPrivateForwardMsg({ self_id, bot: Bot[self_id], user_id }, msg),
            send_group_forward_msg: (group_id, msg) => this.sendGroupForwardMsg({ self_id, bot: Bot[self_id], group_id }, msg),
            sendGroupForwardMsg: (group_id, msg) => this.sendGroupForwardMsg({ self_id, bot: Bot[self_id], group_id }, msg),
            pickFriend: user_id => this.pickFriend({ self_id, bot: Bot[self_id] }, user_id),
            get pickUser() { return this.pickFriend },
            pickGroup: group_id => this.pickGroup({ self_id, bot: Bot[self_id] }, group_id),
            pickMember: (group_id, user_id) => this.pickMember({ self_id, bot: Bot[self_id] }, group_id, user_id),
            getFriendMap: () => this.getFriendMap({ self_id, bot: Bot[self_id] }),
            getGroupMap: () => this.getGroupMap({ self_id, bot: Bot[self_id] }),
            get_friend_list: () => this.getFriendList({ self_id, bot: Bot[self_id] }),
            get_friend_info: (user_id) => this.getFriendInfo({ self_id, bot: Bot[self_id], user_id }),
            get_group_list: () => this.getGroupList({ self_id, bot: Bot[self_id] }),
            get_group_info: (group_id) => this.getGroupInfo({ self_id, bot: Bot[self_id], group_id }),
            get_group_member_list: (group_id) => this.getMemberList({ self_id, bot: Bot[self_id], group_id }),
            get_group_member_info: (group_id, user_id) => this.getMemberInfo({ self_id, bot: Bot[self_id], group_id, user_id }),
            get_impl_info: () => this.callApi(apiBaseUrl, config.access_token, "get_impl_info"),
            get_user_profile: (user_id) => this.getProfile({ self_id, bot: Bot[self_id], user_id }),
            set_bio: (new_bio) => this.setBio({ self_id, bot: Bot[self_id] }, new_bio),
            send_friend_nudge: (user_id) => this.sendFriendNudge({ self_id, bot: Bot[self_id], user_id }),
            send_group_nudge: (group_id, user_id) => this.sendGroupNudge({ self_id, bot: Bot[self_id], group_id, user_id }),
            send_group_message_reaction: (group_id, message_seq, reaction, is_add) => this.sendGroupMessageReaction({ self_id, bot: Bot[self_id], group_id, message_seq }, reaction, is_add),
            set_group_essence_message: (group_id, message_seq, is_set) => this.setGroupEssenceMessage({ self_id, bot: Bot[self_id], group_id, message_seq }, is_set),
            get_group_essence_messages: (group_id, page_index, page_size) => this.getGroupEssenceMessages({ self_id, bot: Bot[self_id], group_id }, page_index, page_size),
            send_group_announcement: (group_id, content, image_uri) => this.sendGroupAnnouncement({ self_id, bot: Bot[self_id], group_id }, content, image_uri),
            get_group_announcements: (group_id) => this.getGroupAnnouncements({ self_id, bot: Bot[self_id], group_id }),
            accept_friend_request: (initiator_uid, is_filtered) => this.acceptFriendRequest({ self_id, bot: Bot[self_id] }, initiator_uid, is_filtered),
            reject_friend_request: (initiator_uid, is_filtered, reason) => this.rejectFriendRequest({ self_id, bot: Bot[self_id] }, initiator_uid, is_filtered, reason),
            accept_group_request: (notification_seq, notification_type, group_id, is_filtered) => this.acceptGroupRequest({ self_id, bot: Bot[self_id] }, notification_seq, notification_type, group_id, is_filtered),
            reject_group_request: (notification_seq, notification_type, group_id, is_filtered, reason) => this.rejectGroupRequest({ self_id, bot: Bot[self_id] }, notification_seq, notification_type, group_id, is_filtered, reason),
            // 消息操作
            recall_group_message: (group_id, message_seq) => this.recallGroupMsg({ self_id, bot: Bot[self_id], group_id }, message_seq),
            recall_private_message: (user_id, message_seq) => this.recallPrivateMsg({ self_id, bot: Bot[self_id], user_id }, message_seq),
            delete_msg: (message_id) => this.deleteMsg({ self_id, bot: Bot[self_id] }, message_id),
            get_msg: (message_scene, peer_id, message_seq) => this.getMsg({ self_id, bot: Bot[self_id], message_scene, peer_id, message_seq }),
            get_history_messages: (message_scene, peer_id, start_message_seq, limit) => this.getHistoryMessages({ self_id, bot: Bot[self_id], message_scene, peer_id, start_message_seq, limit }),
            mark_message_as_read: (message_scene, peer_id, message_seq) => this.markMessageAsRead({ self_id, bot: Bot[self_id] }, message_scene, peer_id, message_seq),
            // 群管理
            set_group_name: (group_id, group_name) => this.setGroupName({ self_id, bot: Bot[self_id], group_id }, group_name),
            set_group_card: (group_id, user_id, card) => this.setGroupCard({ self_id, bot: Bot[self_id], group_id }, user_id, card),
            set_group_admin: (group_id, user_id, enable) => this.setGroupAdmin({ self_id, bot: Bot[self_id], group_id }, user_id, enable),
            set_group_special_title: (group_id, user_id, title) => this.setGroupSpecialTitle({ self_id, bot: Bot[self_id], group_id }, user_id, title),
            set_group_ban: (group_id, user_id, duration) => this.setGroupBan({ self_id, bot: Bot[self_id], group_id }, user_id, duration),
            set_group_whole_ban: (group_id, enable) => this.setGroupWholeBan({ self_id, bot: Bot[self_id], group_id }, enable),
            set_group_kick: (group_id, user_id) => this.setGroupKick({ self_id, bot: Bot[self_id], group_id }, user_id),
            set_group_leave: (group_id) => this.setGroupLeave({ self_id, bot: Bot[self_id], group_id }),
            // 好友操作
            send_like: (user_id, times) => this.sendLike({ self_id, bot: Bot[self_id] }, user_id, times),
            delete_friend: (user_id) => this.deleteFriend({ self_id, bot: Bot[self_id] }, user_id),
            // 文件操作
            upload_group_file: (group_id, file, folder, name) => this.uploadGroupFile({ self_id, bot: Bot[self_id], group_id }, file, folder, name),
            delete_group_file: (group_id, file_id) => this.deleteGroupFile({ self_id, bot: Bot[self_id], group_id }, file_id),
            get_group_files: (group_id, folder_id) => this.getGroupFilesList({ self_id, bot: Bot[self_id], group_id }, folder_id),
            create_group_folder: (group_id, name) => this.createGroupFileFolder({ self_id, bot: Bot[self_id], group_id }, name),
            delete_group_folder: (group_id, folder_id) => this.deleteGroupFileFolder({ self_id, bot: Bot[self_id], group_id }, folder_id),
            getMemberMap: (group_id) => this.getMemberMap({ self_id, bot: Bot[self_id], group_id }),
          }
          if (!Bot.uin.includes(self_id)) Bot.uin.push(self_id)

          // Initial data sync
          Bot[self_id].getFriendMap()
          Bot[self_id].getGroupMap()

          Bot.makeLog("mark", `MilkyAdapter v${this.version} ${Bot[self_id].nickname}(${self_id}) 已连接`, self_id)
          Bot.em(`connect.${self_id}`, { self_id, bot: Bot[self_id] })
        } else {
          Bot.makeLog("mark", `MilkyAdapter v${this.version} ${Bot[self_id].nickname}(${self_id}) 已连接`, self_id)
          Bot[self_id].ws = ws
          Bot[self_id].sendApi = (action, params) => this.callApi(apiBaseUrl, config.access_token, action, params)
          Bot[self_id].send_private_msg = (user_id, msg) => this.sendPrivateMsg({ self_id, bot: Bot[self_id], user_id }, msg)
          Bot[self_id].send_group_msg = (group_id, msg) => this.sendGroupMsg({ self_id, bot: Bot[self_id], group_id }, msg)
          Bot[self_id].send_private_forward_msg = (user_id, msg) => this.sendPrivateForwardMsg({ self_id, bot: Bot[self_id], user_id }, msg)
          Bot[self_id].sendFriendForwardMsg = (user_id, msg) => this.sendPrivateForwardMsg({ self_id, bot: Bot[self_id], user_id }, msg)
          Bot[self_id].send_group_forward_msg = (group_id, msg) => this.sendGroupForwardMsg({ self_id, bot: Bot[self_id], group_id }, msg)
          Bot[self_id].sendGroupForwardMsg = (group_id, msg) => this.sendGroupForwardMsg({ self_id, bot: Bot[self_id], group_id }, msg)
          Bot[self_id].getFriendMap = () => this.getFriendMap({ self_id, bot: Bot[self_id] })
          Bot[self_id].getGroupMap = () => this.getGroupMap({ self_id, bot: Bot[self_id] })
          Bot[self_id].get_friend_list = () => this.getFriendList({ self_id, bot: Bot[self_id] })
          Bot[self_id].get_friend_info = (user_id) => this.getFriendInfo({ self_id, bot: Bot[self_id], user_id })
          Bot[self_id].get_group_list = () => this.getGroupList({ self_id, bot: Bot[self_id] })
          Bot[self_id].get_group_info = (group_id) => this.getGroupInfo({ self_id, bot: Bot[self_id], group_id })
          Bot[self_id].get_group_member_list = (group_id) => this.getMemberList({ self_id, bot: Bot[self_id], group_id })
          Bot[self_id].get_group_member_info = (group_id, user_id) => this.getMemberInfo({ self_id, bot: Bot[self_id], group_id, user_id })
          Bot[self_id].get_impl_info = () => this.callApi(apiBaseUrl, config.access_token, "get_impl_info")
          Bot[self_id].get_user_profile = (user_id) => this.getProfile({ self_id, bot: Bot[self_id], user_id })
          Bot[self_id].set_bio = (new_bio) => this.setBio({ self_id, bot: Bot[self_id] }, new_bio)
          Bot[self_id].send_friend_nudge = (user_id) => this.sendFriendNudge({ self_id, bot: Bot[self_id], user_id })
          Bot[self_id].send_group_nudge = (group_id, user_id) => this.sendGroupNudge({ self_id, bot: Bot[self_id], group_id, user_id })
          Bot[self_id].send_group_message_reaction = (group_id, message_seq, reaction, is_add) => this.sendGroupMessageReaction({ self_id, bot: Bot[self_id], group_id, message_seq }, reaction, is_add)
          Bot[self_id].set_group_essence_message = (group_id, message_seq, is_set) => this.setGroupEssenceMessage({ self_id, bot: Bot[self_id], group_id, message_seq }, is_set)
          Bot[self_id].get_group_essence_messages = (group_id, page_index, page_size) => this.getGroupEssenceMessages({ self_id, bot: Bot[self_id], group_id }, page_index, page_size)
          Bot[self_id].send_group_announcement = (group_id, content, image_uri) => this.sendGroupAnnouncement({ self_id, bot: Bot[self_id], group_id }, content, image_uri)
          Bot[self_id].get_group_announcements = (group_id) => this.getGroupAnnouncements({ self_id, bot: Bot[self_id], group_id })
          Bot[self_id].accept_friend_request = (initiator_uid, is_filtered) => this.acceptFriendRequest({ self_id, bot: Bot[self_id] }, initiator_uid, is_filtered)
          Bot[self_id].reject_friend_request = (initiator_uid, is_filtered, reason) => this.rejectFriendRequest({ self_id, bot: Bot[self_id] }, initiator_uid, is_filtered, reason)
          Bot[self_id].accept_group_request = (notification_seq, notification_type, group_id, is_filtered) => this.acceptGroupRequest({ self_id, bot: Bot[self_id] }, notification_seq, notification_type, group_id, is_filtered)
          Bot[self_id].reject_group_request = (notification_seq, notification_type, group_id, is_filtered, reason) => this.rejectGroupRequest({ self_id, bot: Bot[self_id] }, notification_seq, notification_type, group_id, is_filtered, reason)
          Bot[self_id].recall_group_message = (group_id, message_seq) => this.recallGroupMsg({ self_id, bot: Bot[self_id], group_id }, message_seq)
          Bot[self_id].recall_private_message = (user_id, message_seq) => this.recallPrivateMsg({ self_id, bot: Bot[self_id], user_id }, message_seq)
          Bot[self_id].delete_msg = (message_id) => this.deleteMsg({ self_id, bot: Bot[self_id] }, message_id)
          Bot[self_id].get_msg = (message_scene, peer_id, message_seq) => this.getMsg({ self_id, bot: Bot[self_id], message_scene, peer_id, message_seq })
          Bot[self_id].get_history_messages = (message_scene, peer_id, start_message_seq, limit) => this.getHistoryMessages({ self_id, bot: Bot[self_id], message_scene, peer_id, start_message_seq, limit })
          Bot[self_id].mark_message_as_read = (message_scene, peer_id, message_seq) => this.markMessageAsRead({ self_id, bot: Bot[self_id] }, message_scene, peer_id, message_seq)
          Bot[self_id].set_group_name = (group_id, group_name) => this.setGroupName({ self_id, bot: Bot[self_id], group_id }, group_name)
          Bot[self_id].set_group_card = (group_id, user_id, card) => this.setGroupCard({ self_id, bot: Bot[self_id], group_id }, user_id, card)
          Bot[self_id].set_group_admin = (group_id, user_id, enable) => this.setGroupAdmin({ self_id, bot: Bot[self_id], group_id }, user_id, enable)
          Bot[self_id].set_group_special_title = (group_id, user_id, title) => this.setGroupSpecialTitle({ self_id, bot: Bot[self_id], group_id }, user_id, title)
          Bot[self_id].set_group_ban = (group_id, user_id, duration) => this.setGroupBan({ self_id, bot: Bot[self_id], group_id }, user_id, duration)
          Bot[self_id].set_group_whole_ban = (group_id, enable) => this.setGroupWholeBan({ self_id, bot: Bot[self_id], group_id }, enable)
          Bot[self_id].set_group_kick = (group_id, user_id) => this.setGroupKick({ self_id, bot: Bot[self_id], group_id }, user_id)
          Bot[self_id].set_group_leave = (group_id) => this.setGroupLeave({ self_id, bot: Bot[self_id], group_id })
          Bot[self_id].send_like = (user_id, times) => this.sendLike({ self_id, bot: Bot[self_id] }, user_id, times)
          Bot[self_id].delete_friend = (user_id) => this.deleteFriend({ self_id, bot: Bot[self_id] }, user_id)
          Bot[self_id].upload_group_file = (group_id, file, folder, name) => this.uploadGroupFile({ self_id, bot: Bot[self_id], group_id }, file, folder, name)
          Bot[self_id].delete_group_file = (group_id, file_id) => this.deleteGroupFile({ self_id, bot: Bot[self_id], group_id }, file_id)
          Bot[self_id].get_group_files = (group_id, folder_id) => this.getGroupFilesList({ self_id, bot: Bot[self_id], group_id }, folder_id)
          Bot[self_id].create_group_folder = (group_id, name) => this.createGroupFileFolder({ self_id, bot: Bot[self_id], group_id }, name)
          Bot[self_id].delete_group_folder = (group_id, folder_id) => this.deleteGroupFileFolder({ self_id, bot: Bot[self_id], group_id }, folder_id)
          Bot[self_id].getMemberMap = (group_id) => this.getMemberMap({ self_id, bot: Bot[self_id], group_id })
          if (!Bot[self_id].pickUser) {
            Object.defineProperty(Bot[self_id], "pickUser", {
              get() { return this.pickFriend }
            })
          }
        }
      } catch (err) {
        Bot.makeLog("error", `MilkyAdapter v${this.version} 初始化失败: ${err.stack}`)
      }
    }

    async callApi(apiBaseUrl, token, action, params = {}) {
      const url = `${apiBaseUrl}/${action}`
      const headers = { "Content-Type": "application/json" }
      if (token) headers["Authorization"] = `Bearer ${token}`

      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(params),
        })
        const data = await res.json()
        return data
      } catch (err) {
        return { retcode: -1, error: err.message }
      }
    }

    handleEvent(data, ws, apiBaseUrl) {
      if (!data.event_type) {
        Bot.makeLog("debug", `[Milky] 收到未知数据: ${JSON.stringify(data)}`)
        return
      }
      Bot.makeLog("debug", `[Milky] 收到事件: ${data.event_type}`)

      const event = { ...data.data, event_type: data.event_type, raw: data }
      event.self_id = String(data.self_id || Bot.uin[0])
      event.bot = Bot[event.self_id]

      switch (data.event_type) {
        case "message_receive":
          this.makeMessage(event)
          break
        case "message_recall":
        case "friend_nudge":
        case "group_nudge":
        case "group_admin_change":
        case "group_member_increase":
        case "group_member_decrease":
        case "group_name_change":
        case "group_message_reaction":
        case "group_mute":
        case "group_whole_mute":
          this.makeNotice(event)
          break
        case "friend_request":
        case "group_join_request":
          this.makeRequest(event)
          break
      }
    }

    makeMessage(data) {
      data.post_type = "message"
      data.message_type = data.message_scene === "group" ? "group" : "private"
      data.user_id = String(data.sender_id)
      if (data.message_type === "group") data.group_id = String(data.peer_id)
      data.message_id = String(data.message_seq)

      // 避免与云仔内部的对象冲突
      delete data.group
      delete data.group_member
      delete data.friend

      data.message = this.parseMsg(data.segments)
      data.raw_message = data.message.map(m => m.type === "text" ? m.text : `[${m.type}]`).join("")

      const group_name = data.group_id ? data.bot.gl.get(data.group_id)?.group_name : null
      let user_name = data.bot.fl.get(data.user_id)?.nickname

      data.sender = {
        user_id: Number(data.user_id),
        nickname: user_name || "",
        sub_type: data.message_type,
      }

      if (data.message_type === "group") {
        const member = data.bot.gml.get(data.group_id)?.get(data.user_id)
        if (member) {
          Object.assign(data.sender, {
            ...member,
            user_id: Number(member.user_id),
          })
        }
      }

      const logMsg = data.raw_message.replace(/base64:\/\/([^"]+)/g, "base64://...")
      if (data.message_type === "group") {
        const logUin = `${data.self_id} <= ${data.group_id}, ${data.user_id}`
        Bot.makeLog("info", `群消息：[${group_name || data.group_id}, ${user_name || data.user_id}] ${logMsg}`, logUin)
      } else {
        const logUin = `${data.self_id} <= ${data.user_id}`
        Bot.makeLog("info", `好友消息：[${user_name || data.user_id}] ${logMsg}`, logUin)
      }

      Bot.em(`${data.post_type}.${data.message_type}.normal`, data)
    }

    makeNotice(data) {
      data.post_type = "notice"
      switch (data.event_type) {
        case "message_recall":
          data.notice_type = data.message_scene === "group" ? "group_recall" : "friend_recall"
          data.group_id = data.message_scene === "group" ? String(data.peer_id) : undefined
          data.operator_id = String(data.operator_id)
          data.user_id = String(data.sender_id)
          data.message_id = String(data.message_seq)
          break
        case "friend_nudge":
          data.notice_type = "notify"
          data.sub_type = "poke"
          data.user_id = String(data.user_id)
          data.operator_id = data.is_self_send ? data.self_id : data.user_id
          data.target_id = data.is_self_receive ? data.self_id : data.user_id
          Bot.makeLog("info", `好友戳一戳：[${data.operator_id} => ${data.target_id}]`, data.self_id)
          break
        case "group_nudge":
          data.notice_type = "notify"
          data.sub_type = "poke"
          data.group_id = String(data.group_id)
          data.operator_id = String(data.sender_id)
          data.target_id = String(data.receiver_id)
          data.user_id = data.operator_id
          Bot.makeLog("info", `群戳一戳：[${data.group_id}: ${data.operator_id} => ${data.target_id}]`, data.self_id)
          break
        case "group_admin_change":
          data.notice_type = "group_admin"
          data.sub_type = data.is_set ? "set" : "unset"
          data.group_id = String(data.group_id)
          data.user_id = String(data.user_id)
          break
        case "group_member_increase":
          data.notice_type = "group_increase"
          data.sub_type = data.invitor_id ? "invite" : "approve"
          data.group_id = String(data.group_id)
          data.user_id = String(data.user_id)
          data.operator_id = String(data.operator_id || data.invitor_id)
          break
        case "group_member_decrease":
          data.notice_type = "group_decrease"
          data.sub_type = data.operator_id ? (data.operator_id == data.user_id ? "leave" : "kick") : "leave"
          data.group_id = String(data.group_id)
          data.user_id = String(data.user_id)
          data.operator_id = String(data.operator_id || data.user_id)
          break
        case "group_mute":
          data.notice_type = "group_ban"
          data.sub_type = data.duration > 0 ? "ban" : "lift_ban"
          data.group_id = String(data.group_id)
          data.user_id = String(data.user_id)
          data.operator_id = String(data.operator_id)
          break
        default:
          data.notice_type = data.event_type
          break
      }
      Bot.em(`${data.post_type}.${data.notice_type}`, data)
    }

    makeRequest(data) {
      data.post_type = "request"
      if (data.event_type === "friend_request") {
        data.request_type = "friend"
        data.user_id = String(data.initiator_id)
        data.comment = data.comment
        data.flag = data.initiator_uid
      } else {
        data.request_type = "group"
        data.sub_type = "add"
        data.group_id = String(data.group_id)
        data.user_id = String(data.initiator_id)
        data.comment = data.comment
        data.flag = String(data.notification_seq)
      }
      Bot.em(`${data.post_type}.${data.request_type}`, data)
    }

    parseMsg(message) {
      if (!Array.isArray(message)) return []
      return message.map(m => {
        const type = m.type.toLowerCase()
        const d = m.data || {}
        switch (type) {
          case "text": return { type: "text", text: d.text }
          case "face_incoming":
          case "face": return { type: "face", id: d.face_id }
          case "image": return { type: "image", url: d.temp_url || d.url || d.file_path }
          case "record":
          case "audio": return { type: "record", url: d.temp_url || d.url }
          case "video": return { type: "video", url: d.temp_url || d.url }
          case "mention": return { type: "at", qq: String(d.user_id) }
          case "mention_all": return { type: "at", qq: "all" }
          case "reply": return { type: "reply", id: String(d.message_seq) }
          case "forward": return { type: "forward", id: d.forward_id }
          case "file": return { type: "file", file: d.file_id, name: d.file_name, size: d.file_size }
          case "market_face": return { type: "face", id: d.emoji_id, name: d.summary }
          case "light_app": return { type: "json", data: d.json_payload }
          case "xml": return { type: "xml", data: d.xml_payload }
          default: return { type: "text", text: `[${m.type}]` }
        }
      })
    }

    async makeMsg(msg) {
      if (!Array.isArray(msg)) msg = [msg]
      const message = []
      const forward = []
      const fixUri = (uri) => {
        if (!uri) return uri
        if (Buffer.isBuffer(uri)) return `base64://${uri.toString("base64")}`
        if (typeof uri === "object" && uri.type === "Buffer" && Array.isArray(uri.data)) {
          return `base64://${Buffer.from(uri.data).toString("base64")}`
        }
        if (typeof uri !== "string") return uri
        if (uri.startsWith("base64:///")) return uri.replace("base64:///", "base64://")
        if (/^[a-zA-Z]:(\\|\/)/.test(uri) || (uri.startsWith("/") && !uri.startsWith("//"))) {
          return `file://${uri}`
        }
        return uri
      }

      for (let i of msg) {
        if (typeof i !== "object") i = { type: "text", text: i }
        const type = i.type
        switch (type) {
          case "text":
            message.push({ type: "text", data: { text: i.text } })
            break
          case "at":
            if (i.qq === "all") message.push({ type: "mention_all", data: {} })
            else message.push({ type: "mention", data: { user_id: Number(i.qq) } })
            break
          case "face":
            message.push({ type: "face", data: { face_id: String(i.id) } })
            break
          case "image":
            message.push({ type: "image", data: { uri: fixUri(i.file || i.url), sub_type: "normal" } })
            break
          case "record":
          case "audio":
            message.push({ type: "record", data: { uri: fixUri(i.file || i.url) } })
            break
          case "video":
            message.push({ type: "video", data: { uri: fixUri(i.file || i.url), thumb_uri: fixUri(i.thumb) } })
            break
          case "reply":
            message.push({ type: "reply", data: { message_seq: Number(i.id) } })
            break
          case "node":
            forward.push(...(Array.isArray(i.data) ? i.data : [i.data || i]))
            break
          case "file":
            message.push({ type: "file", data: { file_id: i.file } })
            break
          case "market_face":
            message.push({ type: "market_face", data: { emoji_id: i.id, emoji_package_id: i.package_id || 0, key: i.key, summary: i.name } })
            break
          case "light_app":
            message.push({ type: "light_app", data: { app_name: i.app_name || "Yunzai", json_payload: i.data } })
            break
          case "xml":
            message.push({ type: "xml", data: { service_id: i.service_id || 1, xml_payload: i.data } })
            break
        }
      }
      return [message, forward]
    }

    pickFriend(data, user_id) {
      const i = { ...data, user_id: String(user_id) }
      return {
        ...i,
        sendMsg: msg => this.sendPrivateMsg(i, msg),
        sendForwardMsg: msg => this.sendPrivateForwardMsg(i, msg),
        recallMsg: (message_id) => this.recallPrivateMsg(i, message_id),
        getInfo: () => this.getFriendInfo(i),
        poke: () => this.sendFriendNudge(i),
        thumbUp: (times) => this.sendLike(i, user_id, times),
        delete: () => this.deleteFriend(i, user_id),
        getMsg: (message_seq) => this.getMsg({ ...i, message_scene: "private", peer_id: Number(user_id), message_seq }),
        getHistory: (start_message_seq, limit = 20) => this.getHistoryMessages({ ...i, message_scene: "private", peer_id: Number(user_id), start_message_seq, limit }),
        getAvatarUrl: () => `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`
      }
    }

    pickGroup(data, group_id) {
      const i = { ...data, group_id: String(group_id) }
      return {
        ...i,
        sendMsg: msg => this.sendGroupMsg(i, msg),
        sendForwardMsg: msg => this.sendGroupForwardMsg(i, msg),
        recallMsg: (message_id) => this.recallGroupMsg(i, message_id),
        pickMember: user_id => this.pickMember(i, group_id, user_id),
        getInfo: () => this.getGroupInfo(i),
        getMemberMap: () => this.getMemberMap(i),
        getMemberList: () => this.getMemberList(i),
        poke: (user_id) => this.sendGroupNudge({ ...i, user_id }),
        pokeMember: (user_id) => this.sendGroupNudge({ ...i, user_id }),
        addEssence: (message_seq) => this.setGroupEssenceMessage({ ...i, message_seq }, true),
        removeEssence: (message_seq) => this.setGroupEssenceMessage({ ...i, message_seq }, false),
        getEssence: (page = 0, size = 50) => this.getGroupEssenceMessages(i, page, size),
        getMsg: (message_seq) => this.getMsg({ ...i, message_scene: "group", peer_id: Number(group_id), message_seq }),
        getHistory: (start_message_seq, limit = 20) => this.getHistoryMessages({ ...i, message_scene: "group", peer_id: Number(group_id), start_message_seq, limit }),
        setName: (name) => this.setGroupName(i, name),
        muteMember: (user_id, duration) => this.setGroupBan(i, user_id, duration),
        kickMember: (user_id) => this.setGroupKick(i, user_id),
        setWholeBan: (enable) => this.setGroupWholeBan(i, enable),
        quit: () => this.setGroupLeave(i),
        sendFile: (file, name) => this.uploadGroupFile(i, file, "/", name),
        fs: {
          upload: (file, folder = "/", name) => this.uploadGroupFile(i, file, folder, name),
          rm: (file_id) => this.deleteGroupFile(i, file_id),
          ls: (folder_id = "/") => this.getGroupFilesList(i, folder_id),
          mkdir: (name) => this.createGroupFileFolder(i, name),
          rmdir: (folder_id) => this.deleteGroupFileFolder(i, folder_id)
        },
        getAvatarUrl: () => `https://p.qlogo.cn/gh/${group_id}/${group_id}/0`
      }
    }

    pickMember(data, group_id, user_id) {
      const i = { ...data, group_id: String(group_id), user_id: String(user_id) }
      return {
        ...i,
        ...this.pickFriend(data, user_id),
        group_id: String(group_id),
        getInfo: () => this.getMemberInfo(i),
        poke: () => this.sendGroupNudge(i),
        mute: (duration) => this.setGroupBan(i, user_id, duration),
        kick: () => this.setGroupKick(i, user_id),
        setCard: (card) => this.setGroupCard(i, user_id, card),
        setAdmin: (enable) => this.setGroupAdmin(i, user_id, enable),
        setTitle: (title) => this.setGroupSpecialTitle(i, user_id, title),
        getAvatarUrl: () => `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`,
        get is_friend() { return data.bot.fl.has(String(user_id)) },
        get is_owner() { return this.role === "owner" },
        get is_admin() { return this.role === "admin" || this.is_owner },
      }
    }

    async sendPrivateMsg(data, msg) {
      const [message, forward] = await this.makeMsg(msg)
      let res
      if (forward.length) res = await this.sendPrivateForwardMsg(data, forward)
      if (!message.length) return res

      const logMsg = Bot.String(msg).replace(/base64:\/\/([^"]+)/g, "base64://...")
      const user_name = data.bot.fl.get(data.user_id)?.nickname
      const logUin = `${data.self_id} => ${data.user_id}`
      Bot.makeLog("info", `发送好友消息：[${user_name || data.user_id}] ${logMsg}`, logUin, true)

      const ret = await data.bot.sendApi("send_private_message", {
        user_id: Number(data.user_id),
        message,
      })
      if (ret.retcode !== 0) {
        Bot.makeLog("error", `[Milky] 发送好友消息失败: ${JSON.stringify(ret)}`, data.self_id)
      }
      return ret
    }

    async sendGroupMsg(data, msg) {
      const [message, forward] = await this.makeMsg(msg)
      let res
      if (forward.length) res = await this.sendGroupForwardMsg(data, forward)
      if (!message.length) return res

      const logMsg = Bot.String(msg).replace(/base64:\/\/([^"]+)/g, "base64://...")
      const group_name = data.bot.gl.get(data.group_id)?.group_name
      const logUin = `${data.self_id} => ${data.group_id}`
      Bot.makeLog("info", `发送群消息：[${group_name || data.group_id}] ${logMsg}`, logUin, true)

      const ret = await data.bot.sendApi("send_group_message", {
        group_id: Number(data.group_id),
        message,
      })
      if (ret.retcode !== 0) {
        Bot.makeLog("error", `[Milky] 发送群消息失败: ${JSON.stringify(ret)}`, data.self_id)
      }
      return ret
    }

    async makeForwardMsg(msg) {
      const messages = []
      for (const item of msg) {
        const [segments, forward] = await this.makeMsg(item.message || item)
        if (forward.length) {
          const nested = await this.makeForwardMsg(forward)
          messages.push(...nested[0].data.messages)
        }
        if (segments.length) {
          messages.push({
            user_id: Number(item.user_id || Bot.uin[0]),
            sender_name: item.nickname || item.sender_name || "Bot",
            segments
          })
        }
      }
      return [{
        type: "forward",
        data: { messages }
      }]
    }

    async sendPrivateForwardMsg(data, msg) {
      const message = await this.makeForwardMsg(msg)
      const user_name = data.bot.fl.get(data.user_id)?.nickname
      const logUin = `${data.self_id} => ${data.user_id}`
      Bot.makeLog("info", `发送好友合并转发消息：[${user_name || data.user_id}]`, logUin, true)
      return data.bot.sendApi("send_private_message", {
        user_id: Number(data.user_id),
        message,
      })
    }

    async sendGroupForwardMsg(data, msg) {
      const message = await this.makeForwardMsg(msg)
      const group_name = data.bot.gl.get(data.group_id)?.group_name
      const logUin = `${data.self_id} => ${data.group_id}`
      Bot.makeLog("info", `发送群合并转发消息：[${group_name || data.group_id}]`, logUin, true)
      return data.bot.sendApi("send_group_message", {
        group_id: Number(data.group_id),
        message,
      })
    }

    async recallGroupMsg(data, message_id) {
      Bot.makeLog("info", `撤回群消息：[${data.group_id}] ${message_id}`, data.self_id, true)
      return data.bot.sendApi("recall_group_message", {
        group_id: Number(data.group_id),
        message_seq: Number(message_id)
      })
    }

    async recallPrivateMsg(data, message_id) {
      Bot.makeLog("info", `撤回好友消息：${message_id}`, `${data.self_id} => ${data.user_id}`, true)
      return data.bot.sendApi("recall_private_message", {
        user_id: Number(data.user_id),
        message_seq: Number(message_id)
      })
    }

    async deleteMsg(data, message_id) {
      // OneBot v11 兼容：尝试通过 message_id 撤回（需要上下文判断群/私聊）
      Bot.makeLog("info", `撤回消息：${message_id}`, data.self_id, true)
      return data.bot.sendApi("recall_group_message", { message_seq: Number(message_id) })
    }

    async markMessageAsRead(data, message_scene, peer_id, message_seq) {
      return data.bot.sendApi("mark_message_as_read", {
        message_scene,
        peer_id: Number(peer_id),
        message_seq: Number(message_seq)
      })
    }

    async setGroupName(data, group_name) {
      Bot.makeLog("info", `设置群名：${group_name}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_name", {
        group_id: Number(data.group_id),
        new_group_name: group_name
      })
    }

    async setGroupCard(data, user_id, card) {
      Bot.makeLog("info", `设置群名片：${card}`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
      return data.bot.sendApi("set_group_member_card", {
        group_id: Number(data.group_id),
        user_id: Number(user_id),
        card
      })
    }

    async setGroupAdmin(data, user_id, enable = true) {
      Bot.makeLog("info", `${enable ? "设置" : "取消"}群管理员`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
      return data.bot.sendApi("set_group_member_admin", {
        group_id: Number(data.group_id),
        user_id: Number(user_id),
        is_set: enable
      })
    }

    async setGroupSpecialTitle(data, user_id, title) {
      Bot.makeLog("info", `设置群头衔：${title}`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
      return data.bot.sendApi("set_group_member_special_title", {
        group_id: Number(data.group_id),
        user_id: Number(user_id),
        special_title: title
      })
    }

    async setGroupBan(data, user_id, duration = 1800) {
      Bot.makeLog("info", `禁言群成员：${duration}秒`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
      return data.bot.sendApi("set_group_member_mute", {
        group_id: Number(data.group_id),
        user_id: Number(user_id),
        duration: Number(duration)
      })
    }

    async setGroupWholeBan(data, enable = true) {
      Bot.makeLog("info", `${enable ? "开启" : "关闭"}全员禁言`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_whole_mute", {
        group_id: Number(data.group_id),
        is_mute: enable
      })
    }

    async setGroupKick(data, user_id) {
      Bot.makeLog("info", `踢出群成员`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
      return data.bot.sendApi("kick_group_member", {
        group_id: Number(data.group_id),
        user_id: Number(user_id)
      })
    }

    async setGroupLeave(data) {
      Bot.makeLog("info", `退群`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("leave_group", {
        group_id: Number(data.group_id)
      })
    }

    async sendLike(data, user_id, times = 1) {
      Bot.makeLog("info", `点赞：${times}次`, `${data.self_id} => ${user_id}`, true)
      return data.bot.sendApi("send_profile_like", {
        user_id: Number(user_id),
        count: times
      })
    }

    async deleteFriend(data, user_id) {
      Bot.makeLog("info", `删除好友`, `${data.self_id} => ${user_id}`, true)
      return data.bot.sendApi("delete_friend", {
        user_id: Number(user_id)
      })
    }

    async sendFriendNudge(data) {
      Bot.makeLog("info", `发送好友戳一戳`, `${data.self_id} => ${data.user_id}`, true)
      return data.bot.sendApi("send_friend_nudge", { user_id: Number(data.user_id) })
    }

    async sendGroupNudge(data) {
      Bot.makeLog("info", `发送群戳一戳`, `${data.self_id} => ${data.group_id}, ${data.user_id}`, true)
      return data.bot.sendApi("send_group_nudge", { group_id: Number(data.group_id), user_id: Number(data.user_id) })
    }

    async sendGroupMessageReaction(data, reaction, is_add = true) {
      Bot.makeLog("info", `${is_add ? "添加" : "删除"}消息回应：${reaction}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("send_group_message_reaction", {
        group_id: Number(data.group_id),
        message_seq: Number(data.message_seq),
        reaction,
        is_add
      })
    }

    async setGroupEssenceMessage(data, is_set = true) {
      Bot.makeLog("info", `${is_set ? "设置" : "取消"}群精华消息：${data.message_seq}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_essence_message", {
        group_id: Number(data.group_id),
        message_seq: Number(data.message_seq),
        is_set
      })
    }

    async getGroupEssenceMessages(data, page_index = 0, page_size = 50) {
      return data.bot.sendApi("get_group_essence_messages", {
        group_id: Number(data.group_id),
        page_index,
        page_size
      })
    }

    async sendGroupAnnouncement(data, content, image_uri) {
      Bot.makeLog("info", `发送群公告：${content.substring(0, 20)}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("send_group_announcement", {
        group_id: Number(data.group_id),
        content,
        image_uri
      })
    }

    async getGroupAnnouncements(data) {
      return data.bot.sendApi("get_group_announcements", {
        group_id: Number(data.group_id)
      })
    }

    async acceptFriendRequest(data, initiator_uid, is_filtered = false) {
      return data.bot.sendApi("accept_friend_request", { initiator_uid, is_filtered })
    }

    async rejectFriendRequest(data, initiator_uid, is_filtered = false, reason) {
      return data.bot.sendApi("reject_friend_request", { initiator_uid, is_filtered, reason })
    }

    async acceptGroupRequest(data, notification_seq, notification_type, group_id, is_filtered = false) {
      return data.bot.sendApi("accept_group_request", { notification_seq, notification_type, group_id: Number(group_id), is_filtered })
    }

    async rejectGroupRequest(data, notification_seq, notification_type, group_id, is_filtered = false, reason) {
      return data.bot.sendApi("reject_group_request", { notification_seq, notification_type, group_id: Number(group_id), is_filtered, reason })
    }

    async getMsg(data) {
      return data.bot.sendApi("get_message", {
        message_scene: data.message_scene,
        peer_id: data.peer_id,
        message_seq: data.message_seq
      })
    }

    async getHistoryMessages(data) {
      return data.bot.sendApi("get_history_messages", {
        message_scene: data.message_scene,
        peer_id: data.peer_id,
        start_message_seq: data.start_message_seq,
        limit: data.limit
      })
    }

    async uploadGroupFile(data, file, folder = "/", name) {
      return data.bot.sendApi("upload_group_file", {
        group_id: Number(data.group_id),
        file: fixUri(file),
        folder,
        name
      })
    }

    async deleteGroupFile(data, file_id) {
      return data.bot.sendApi("delete_group_file", {
        group_id: Number(data.group_id),
        file_id
      })
    }

    async getGroupFilesList(data, folder_id = "/") {
      return data.bot.sendApi("get_group_files_list", {
        group_id: Number(data.group_id),
        folder_id
      })
    }

    async createGroupFileFolder(data, name) {
      return data.bot.sendApi("create_group_file_folder", {
        group_id: Number(data.group_id),
        name
      })
    }

    async deleteGroupFileFolder(data, folder_id) {
      return data.bot.sendApi("delete_group_file_folder", {
        group_id: Number(data.group_id),
        folder_id
      })
    }

    async getProfile(data) {
      return data.bot.sendApi("get_user_profile", { user_id: Number(data.user_id) })
    }

    async setBio(data, new_bio) {
      return data.bot.sendApi("set_bio", { new_bio })
    }

    async getFriendMap(data) {
      const res = await data.bot.sendApi("get_friend_list")
      if (res.retcode === 0 && res.data.friends) {
        for (const f of res.data.friends) data.bot.fl.set(String(f.user_id), f)
      }
      return data.bot.fl
    }

    async getGroupMap(data) {
      const res = await data.bot.sendApi("get_group_list")
      if (res.retcode === 0 && res.data.groups) {
        for (const g of res.data.groups) data.bot.gl.set(String(g.group_id), g)
      }
      return data.bot.gl
    }

    async getMemberMap(data) {
      const res = await data.bot.sendApi("get_group_member_list", { group_id: Number(data.group_id) })
      if (res.retcode === 0 && res.data.members) {
        const map = new Map()
        for (const m of res.data.members) map.set(String(m.user_id), m)
        data.bot.gml.set(data.group_id, map)
        return map
      }
      return new Map()
    }

    async getFriendInfo(data) {
      const res = await data.bot.sendApi("get_friend_info", { user_id: Number(data.user_id) })
      const friend = res.data?.friend || res.data
      if (friend) {
        return {
          ...friend,
          user_id: Number(friend.user_id),
          nickname: friend.nickname || "",
          remark: friend.remark || "",
          sex: friend.sex || "unknown",
        }
      }
      return friend
    }

    async getFriendList(data) {
      const res = await data.bot.sendApi("get_friend_list")
      if (res.retcode === 0 && res.data.friends) {
        return res.data.friends.map(f => ({
          ...f,
          user_id: Number(f.user_id),
          nickname: f.nickname || "",
          remark: f.remark || "",
          sex: f.sex || "unknown",
        }))
      }
      return []
    }

    async getGroupInfo(data) {
      const res = await data.bot.sendApi("get_group_info", { group_id: Number(data.group_id) })
      const group = res.data?.group || res.data
      if (group) {
        return {
          ...group,
          group_id: Number(group.group_id),
          group_name: group.group_name || "",
          member_count: group.member_count || 0,
          max_member_count: group.max_member_count || 2000,
        }
      }
      return group
    }

    async getGroupList(data) {
      const res = await data.bot.sendApi("get_group_list")
      if (res.retcode === 0 && res.data.groups) {
        return res.data.groups.map(g => ({
          ...g,
          group_id: Number(g.group_id),
          group_name: g.group_name || "",
          member_count: g.member_count || 0,
          max_member_count: g.max_member_count || 2000,
        }))
      }
      return []
    }

    async getMemberInfo(data) {
      const res = await data.bot.sendApi("get_group_member_info", { group_id: Number(data.group_id), user_id: Number(data.user_id) })
      const member = res.data?.member || res.data
      if (member) {
        return {
          ...member,
          group_id: Number(member.group_id),
          user_id: Number(member.user_id),
          nickname: member.nickname || "",
          card: member.card || "",
          sex: member.sex || "unknown",
          age: 0,
          area: "",
          join_time: member.join_time || 0,
          last_sent_time: member.last_sent_time || 0,
          level: String(member.level || 1),
          role: member.role || "member",
          unfriendly: false,
          title: member.title || "",
          title_expire_time: 0,
          card_changeable: true
        }
      }
      return member
    }

    async getMemberList(data) {
      const res = await data.bot.sendApi("get_group_member_list", { group_id: Number(data.group_id) })
      if (res.retcode === 0 && res.data.members) {
        return res.data.members.map(m => ({
          ...m,
          group_id: Number(m.group_id),
          user_id: Number(m.user_id),
          nickname: m.nickname || "",
          card: m.card || "",
          sex: m.sex || "unknown",
          age: 0,
          area: "",
          join_time: m.join_time || 0,
          last_sent_time: m.last_sent_time || 0,
          level: String(m.level || 1),
          role: m.role || "member",
          unfriendly: false,
          title: m.title || "",
          title_expire_time: 0,
          card_changeable: true
        }))
      }
      return []
    }

    load() {
      // Nothing special for load yet
    }
  })(),
)
