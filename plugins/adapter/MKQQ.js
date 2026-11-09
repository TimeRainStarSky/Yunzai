/**
 * 萌卡 NT（MengKa）适配器
 * 官方文档：https://mengka.net/nt/reference/protocol.html
 *
 * 连接方式：反向 WebSocket（框架连到 Yunzai）
 *   ws://<Yunzai 地址>:2536/MKQQ
 *   如需额外地址，在 config/config/mkqq.yaml 的 paths 里追加，例如 [MKQQ2]
 *
 * 鉴权：插件端 token / Authorization: Bearer <token> 与本文件配置里的 token 全等即可
 *   注意 cfg.server.auth 是全局鉴权，若这里也配置了，两处必须完全一致
 *
 * 接口覆盖：文档（https://mengka.net/nt/api/）中的 273 个 action 全部接入，不做可用性筛选
 *   连文档标注“已移除”的（upload_group_file、send_group_temp_msg、join_group、qmate_*、
 *   qqpet_* 等）也照样暴露：本地直接照发，被服务端拒绝时把 error 原样抛给调用方。
 *   bot.getGroupList()                 // 已封装的语义化方法
 *   bot.getVersionInfo(params)         // 自动生成：action 名驼峰化，参数原样透传
 *   bot.api("get_group_signed_list", { group_id })   // 任意 action 直接调
 *   group.sendGroupRedPacket(params)   // 自动注入 group_id
 *   friend.setFriendRemark(params)     // 自动注入 user_id
 *   member.setGroupMute(params)        // 自动注入 group_id + user_id
 *   生成方法签名统一为 (params = {}) => 原始响应 { ok, data, error }，参数名以官方文档为准
 */
import cfg from "../../lib/config/config.js"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import { ulid } from "ulid"

const TAG = "萌卡NT"
/** 取第一份真正有内容的配置：cfg 对缺失键返回 {}（真值），直接 || 串会被它截断 */
function conf() {
  for (const key of ["mkqq", "MKQQ", "mengka"]) {
    const item = cfg[key]
    if (item && typeof item === "object" && Object.keys(item).length) return item
  }
  return {}
}
const toId = v => (Number.isSafeInteger(Number(v)) ? Number(v) : v)
const CHUNK_SIZE = 1024 * 1024

/**
 * 文档索引页（https://mengka.net/nt/api/）中仍在维护的全部 action。
 * 生成规则：get_group_files -> getGroupFiles，调用时参数按 { ...注入的 id, ...params } 原样透传，
 * 不做参数名猜测，所以任何未单独封装字段的接口也能直接调用。
 * 已移除的不列入：upload_group_file、upload_private_file、send_group_temp_msg、
 * send_friend_request、send_group_join_request、join_group，以及 qmate_* / qqpet_*（qqpet_operation 除外）。
 */
const ACTIONS = {
  /**
   * 文档索引（https://mengka.net/nt/api/）里的全部 273 个 action，一个不落。
   * 标记为“已移除”的也在这里：本地可先调用，是否被服务端拒绝由服务端答复（会原样抛出 error）。
   * 生成方法名 = action 驼峰化（get_skey -> getSkey），参数原样透传，不做改名与猜测。
   */
  bot: [
    // 账号管理（14）
    "get_bot_list", "get_bot_info", "add_account", "update_account",
    "delete_account", "set_qq_avatar", "get_protocol_list", "get_device_profile_list",
    "create_device_profile", "get_account_settings", "get_account_recent_logs",
    "get_account_management_context", "get_social_lock_status", "offline_account",
    // 登录（35）
    "login_account", "check_cache", "cache_login", "clear_account_cache",
    "submit_slider", "get_security_verify_methods", "get_sms", "check_sms",
    "scan_qr", "auth_qr", "retry_account_identity_verify",
    "open_account_security_access", "retry_account_security_verify",
    "captcha_heartbeat", "confirm_identity_sms", "get_login_qr",
    "get_security_verify_qr", "login_captcha", "ntlogin_check_sms",
    "ntlogin_get_security_verify_methods", "ntlogin_get_security_verify_qr",
    "ntlogin_get_sms", "ntlogin_login_account",
    "ntlogin_query_security_verify_qr", "ntlogin_submit_slider", "query_login_qr",
    "query_security_verify_qr", "register_captcha", "submit_identity_captcha",
    "submit_identity_phone", "wtlogin_check_sms",
    "wtlogin_get_security_verify_methods", "wtlogin_get_sms",
    "wtlogin_login_account", "wtlogin_submit_slider",
    // 凭据（5）
    "get_skey", "get_rkey", "get_user_agent", "get_ps_key", "get_client_key",
    // 任务（3）
    "get_level_tasks", "execute_level_tasks", "level_task_management",
    // 好友消息（3）
    "send_friend_msg", "get_friend_msg_history", "recall_friend_msg",
    // 好友媒体（7）
    "upload_friend_image", "upload_private_file", "get_friend_video_url",
    "get_friend_voice_url", "upload_friend_forward_msg", "upload_friend_video",
    "upload_friend_voice",
    // 好友功能（16）
    "get_friend_list", "get_unidirectional_friend_list", "send_friend_request",
    "delete_friend", "set_friend_remark", "get_recent_contact",
    "set_input_status", "approve_filtered_friend_apply", "approve_friend_apply",
    "delete_filtered_friend_notification", "get_filtered_friend_notifications",
    "get_friend_requests", "get_friend_status", "get_friend_system_notifications",
    "reject_friend_apply", "set_friend_request",
    // 群消息（6）
    "send_group_msg", "send_group_temp_msg", "get_group_msg_history",
    "get_group_history_messages", "get_group_forward_msg", "recall_group_msg",
    // 群媒体（6）
    "upload_group_image", "upload_group_voice", "upload_group_video",
    "get_group_video_url", "get_group_voice_url", "upload_group_forward_msg",
    // 红包（6）
    "send_group_red_packet", "get_red_packet_info", "grab_red_packet",
    "get_group_red_packets", "grab_group_voice_red_packet", "upload_red_packet_voice",
    // 群功能（32）
    "get_group_list", "get_group_member_list", "get_group_system_notifications",
    "approve_group_apply", "reject_group_apply", "approve_group_invite",
    "set_group_admin", "set_group_mute", "set_group_mute_all",
    "set_group_special_title", "kick_group_member", "get_group_at_all_remain",
    "get_group_honor_info", "get_group_signed_list", "create_group",
    "set_group_member_invite_policy", "set_group_member_permissions",
    "set_group_new_member_history_visibility", "set_group_add_option",
    "set_group_search", "set_group_robot_add_option", "set_group_card",
    "send_group_join_request", "leave_group", "set_group_name",
    "set_group_portrait", "get_group_join_info", "get_group_share_link",
    "get_group_share_messages", "invite_group_members", "join_group", "sign_group",
    // 文件管理（8）
    "get_group_file_system_info", "create_group_file_folder",
    "delete_group_folder", "upload_group_file", "delete_group_file",
    "rename_group_file", "move_group_file", "get_group_files",
    // 相册管理（6）
    "get_qun_album_list", "get_group_album_media_list", "upload_image_to_qun_album",
    "do_group_album_comment", "set_group_album_media_like", "del_group_album_media",
    // 公告与精华（5）
    "get_group_notice", "send_group_notice", "set_group_essence",
    "get_essence_msg_list", "delete_group_notice",
    // QQ 空间（6）
    "get_qzone_friend_feeds", "publish_qzone_feed", "like_qzone_feed",
    "unlike_qzone_feed", "comment_qzone_feed", "delete_qzone_feed",
    // QQ 搭子（13）
    "qmate_accept_invite", "qmate_claim_task_reward", "qmate_confirm_invite",
    "qmate_dissolve", "qmate_get_adoption_info", "qmate_get_info",
    "qmate_get_inventory", "qmate_get_invite_ark", "qmate_get_tasks",
    "qmate_hatch", "qmate_report_incubation_combo", "qmate_report_task_action",
    "qmate_use_item",
    // QQ 宠物：资料与属性（9）
    "qqpet_adopt_pet", "qqpet_get_candidate_pets", "qqpet_get_display_value",
    "qqpet_get_numeric_metrics", "qqpet_get_profile",
    "qqpet_get_upgrade_config", "qqpet_get_user_pet", "qqpet_set_device_info",
    "qqpet_update_profile",
    // QQ 宠物：喂食与洗护（14）
    "qqpet_buy_food", "qqpet_claim_daily_food", "qqpet_do_care",
    "qqpet_feeding", "qqpet_get_bath_catalog", "qqpet_get_bath_inventory",
    "qqpet_get_care_config", "qqpet_get_care_supply_info",
    "qqpet_get_feed_red_dot", "qqpet_get_feed_times_info", "qqpet_push_feed_msg",
    "qqpet_report_feed_red_dot", "qqpet_set_care_config", "qqpet_use_bath_item",
    // QQ 宠物：活动与疲劳（10）
    "qqpet_do_after_story_info", "qqpet_encourage_story", "qqpet_encourage_pet",
    "qqpet_get_activity_options", "qqpet_get_activity_overview",
    "qqpet_get_interaction_history", "qqpet_get_pet_story_status",
    "qqpet_get_story_info", "qqpet_get_story_process", "qqpet_start_story",
    // QQ 宠物：好友与 PK（12）
    "qqpet_delete_interaction_record", "qqpet_get_c2c_pet_info",
    "qqpet_get_interaction_messages", "qqpet_get_other_pet_status_info",
    "qqpet_get_other_user_pet", "qqpet_get_pk_power",
    "qqpet_get_relation_list", "qqpet_like", "qqpet_poke_friend_pet",
    "qqpet_query_like_count", "qqpet_set_c2c_pet_info",
    "qqpet_set_c2c_pet_switch",
    // QQ 宠物：形象与装扮（13）
    "qqpet_equip_career", "qqpet_equip_medal", "qqpet_get_career_tree",
    "qqpet_get_clothing", "qqpet_get_clothing_red_dot",
    "qqpet_get_medal_detail", "qqpet_get_medal_gallery", "qqpet_get_my_suits",
    "qqpet_remove_one_suit", "qqpet_report_clothing_red_dot",
    "qqpet_save_avatar", "qqpet_save_one_suit", "qqpet_unequip_medal",
    // QQ 宠物：钱袋与商店（4）
    "qqpet_get_coin_bag_detail", "qqpet_get_food_shop", "qqpet_place_order",
    "qqpet_snatch_coin_bag",
    // QQ 宠物：其他接口（14）
    "qqpet_check_user_in_gray", "qqpet_get_event_rule",
    "qqpet_get_home_resource", "qqpet_get_incr_resource",
    "qqpet_get_page_rules", "qqpet_get_reaction", "qqpet_get_resource",
    "qqpet_get_resource_detail", "qqpet_get_sequence", "qqpet_heart_beat",
    "qqpet_operation", "qqpet_report_action", "qqpet_report_event",
    "qqpet_report_guide",
    // QQ 农场（1）
    "get_qq_classic_farm_code",
    // 消息工具（5）
    "get_msg", "mark_msg_as_read", "get_emoji_likes", "set_msg_emoji_like",
    "send_poke",
    // 媒体工具（6）
    "get_flash_image", "get_music_ark", "get_mini_app_ark", "get_ai_characters",
    "fetch_ptt_text", "generate_ai_voice",
    // 辅助工具（12）
    "check_url_safely", "translate_en2zh", "send_packet", "file_transfer",
    "get_contact_ark", "get_received_profile_likes", "get_sent_profile_likes",
    "get_user_profile", "like_user_profile", "profile_operation",
    "recall_message", "sdk_auth_api",
    // 框架管理（2）
    "get_plugin_context", "get_version_info",
  ],
  // 会话目标为群：自动注入 group_id
  group: [
    "send_group_msg", "send_group_temp_msg", "get_group_msg_history",
    "get_group_history_messages", "get_group_forward_msg", "recall_group_msg",
    "upload_group_image", "upload_group_voice", "upload_group_video",
    "get_group_video_url", "get_group_voice_url", "upload_group_forward_msg",
    "send_group_red_packet", "get_red_packet_info", "grab_red_packet",
    "get_group_red_packets", "grab_group_voice_red_packet", "upload_red_packet_voice",
    "get_group_member_list", "get_group_system_notifications",
    "approve_group_apply", "reject_group_apply", "approve_group_invite",
    "set_group_admin", "set_group_mute", "set_group_mute_all",
    "set_group_special_title", "kick_group_member", "get_group_at_all_remain",
    "get_group_honor_info", "get_group_signed_list",
    "set_group_member_invite_policy", "set_group_member_permissions",
    "set_group_new_member_history_visibility", "set_group_add_option",
    "set_group_search", "set_group_robot_add_option", "set_group_card",
    "send_group_join_request", "leave_group", "set_group_name",
    "set_group_portrait", "get_group_join_info", "get_group_share_link",
    "get_group_share_messages", "invite_group_members", "join_group", "sign_group",
    "get_group_file_system_info", "create_group_file_folder",
    "delete_group_folder", "upload_group_file", "delete_group_file",
    "rename_group_file", "move_group_file", "get_group_files",
    "get_qun_album_list", "get_group_album_media_list", "upload_image_to_qun_album",
    "do_group_album_comment", "set_group_album_media_like", "del_group_album_media",
    "get_group_notice", "send_group_notice", "set_group_essence",
    "get_essence_msg_list", "delete_group_notice",
  ],
  // 会话目标为好友：自动注入 user_id
  friend: [
    "send_friend_msg", "get_friend_msg_history", "recall_friend_msg",
    "upload_friend_image", "upload_private_file", "get_friend_video_url",
    "get_friend_voice_url", "upload_friend_forward_msg", "upload_friend_video",
    "upload_friend_voice", "delete_friend", "set_friend_remark",
    "set_input_status", "approve_friend_apply", "reject_friend_apply",
    "approve_filtered_friend_apply", "get_friend_status", "send_poke",
    "get_user_profile", "like_user_profile",
  ],
  // 会话目标为群成员：自动注入 group_id + user_id
  member: [
    "set_group_card", "set_group_mute", "set_group_special_title",
    "kick_group_member", "set_group_admin", "send_poke", "send_group_temp_msg",
  ],
}

const API_METHODS = {}
for (const scope in ACTIONS)
  API_METHODS[scope] = ACTIONS[scope].map(action => [
    action.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase()),
    action,
  ])
const API_ALL = [...new Set(Object.values(ACTIONS).flat())]

Bot.adapter.push(
  new (class MengKaAdapter {
    id = "QQ"
    name = "萌卡NT"
    version = "1.0.0"
    echo = new Map()

    /** 反向 WS 路径 */
    get path() {
      return String(conf().path || "MKQQ")
    }

    get timeout() {
      return Number(conf().timeout) || 30000
    }

    get token() {
      return String(conf().token ?? "")
    }

    load() {
      // token 必须显式配置：留空等于任何能连上该端口的人都能伪造任意账号（含主人）的事件
      if (!this.token)
        return Bot.makeLog(
          "error",
          `萌卡未配置 token，适配器未启动：在 config/config/mkqq.yaml 填写 token 后重启`,
          TAG,
          true,
        )
      const paths = new Set([this.path])
      for (const i of conf().paths || []) if (i) paths.add(String(i))
      for (const path of paths) {
        if (!Array.isArray(Bot.wsf[path])) Bot.wsf[path] = []
        Bot.wsf[path].push((ws, req) => this.onConnection(ws, req))
      }
      Bot.makeLog(
        "mark",
        `萌卡适配器已加载：${[...paths].map(i => `/${i}`).join("、")}`,
        TAG,
      )
    }

    /* ---------------------------------- 连接 ---------------------------------- */

    onConnection(ws, req) {
      if (!this.checkAuth(req)) {
        // headers 里可能带 authorization / token，日志脱敏后再打
        const headers = { ...req.headers }
        for (const key of ["authorization", "token", "access_token", "x-meng-ka-token"])
          if (headers[key]) headers[key] = "***"
        Bot.makeLog(
          "error",
          ["萌卡鉴权失败", { headers, query: { ...req.query } }],
          `${req.sid} <≠ ${req.rid}`,
          true,
        )
        try {
          ws.close(1008, "auth failed")
        } catch {}
        return
      }
      ws.on("message", raw => this.message(raw, ws))
    }

    checkAuth(req) {
      const service = conf().service
      if (service && req.headers["x-meng-ka-service"] !== service) return false
      const token = this.token
      if (!token) return true
      const candidates = []
      const authorization = req.headers.authorization
      if (authorization) {
        candidates.push(authorization)
        const match = /^Bearer\s+(.+)$/i.exec(authorization)
        if (match) candidates.push(match[1].trim())
      }
      if (req.headers["x-meng-ka-token"])
        candidates.push(String(req.headers["x-meng-ka-token"]))
      for (const key of ["token", "access_token"])
        if (req.query?.[key]) candidates.push(String(req.query[key]))
      return candidates.includes(token)
    }

    /** 发送一帧 */
    frame(ws, obj) {
      try {
        ws.sendMsg(JSON.stringify(obj))
      } catch (err) {
        Bot.makeLog("debug", ["萌卡发送失败", err?.message], TAG)
      }
    }

    /** 调用接口，返回原始响应 { ok, data, error } */
    action(ws, action, params = {}, timeout = this.timeout) {
      if (!ws) return Promise.reject(Error("萌卡连接已断开"))
      const id = ulid()
      const { promise, resolve, reject } = Promise.withResolvers()
      const timer = setTimeout(() => {
        this.echo.delete(id)
        reject(Object.assign(Error(`萌卡接口 ${action} 响应超时`), { action, params }))
      }, Number(timeout) || this.timeout)
      this.echo.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
      })
      try {
        this.frame(ws, { type: "action", id, action, params })
      } catch (err) {
        clearTimeout(timer)
        this.echo.delete(id)
        reject(err)
      }
      const startedAt = Date.now()
      return promise.then(
        res => {
          const cost = Date.now() - startedAt
          if (cost > 800) Bot.makeLog("warn", [`萌卡慢请求 ${action} 耗时 ${cost}ms`], TAG)
          return res
        },
        err => {
          throw err
        },
      )
    }

    /** Bot 级接口调用，自动补 self_id / protocol_id */
    sendApi(bot, action, params = {}) {
      const data = {
        self_id: Number(bot.uin),
        protocol_id: Number(bot.protocol_id ?? 0),
        ...params,
      }
      for (const key in data) if (data[key] === undefined) delete data[key]
      return this.action(bot.ws, action, data)
    }

    /** 从账号对象里取 protocol_id（萌卡是 protocol.id，不是顶层 protocol_id） */
    protoIdOf(raw) {
      if (!raw) return 0
      const id =
        raw.protocol?.id ??
        raw.protocol_id ??
        raw.protocolId ??
        raw.protocol?.protocol_id
      const n = Number(id)
      return Number.isFinite(n) ? n : 0
    }

    /** 统一错误检查（萌卡的 error 可能是字符串，也可能是对象） */
    checkApi(res, name, action) {
      if (!res?.ok) {
        const e = res?.error
        const msg =
          typeof e === "string"
            ? e
            : e?.error || e?.message || e?.code || "未知错误"
        const err = Object.assign(Error(`${name}失败：${msg}`), { res, action })
        throw err
      }
      return {
        ...res.data,
        ok: true,
        data: res.data,
        message_id: res.data?.message_id,
      }
    }

    /* ---------------------------------- 消息帧 ---------------------------------- */

    message(raw, ws) {
      let frame
      try {
        frame = JSON.parse(String(raw))
      } catch (err) {
        return Bot.makeLog("error", ["萌卡数据解析失败", String(raw)], TAG)
      }
      switch (frame.type) {
        case "ready":
          return this.onReady(frame, ws)
        case "heartbeat":
          return this.onHeartbeat(frame, ws)
        case "event":
          return this.onEvent(frame.data, ws)
        case "action_result":
          return this.onActionResult(frame)
        case "auth_ok":
        case "plugin_info_ok":
          return Bot.makeLog("mark", ["萌卡握手确认", frame.type], TAG)
        case "error":
          return Bot.makeLog("error", ["萌卡返回错误", frame.error ?? frame.data], TAG)
        default:
          return Bot.makeLog("debug", ["萌卡未知帧", frame], TAG)
      }
    }

    onActionResult(frame) {
      const cache = this.echo.get(frame.id)
      if (!cache) return Bot.makeLog("debug", ["萌卡未知响应", frame], TAG)
      this.echo.delete(frame.id)
      cache.resolve({ ...frame, ok: frame.ok !== false })
    }

    async onReady(frame, ws) {
      this.frame(ws, {
        type: "plugin_info",
        name: String(cfg.package?.name || "Yunzai"),
        version: String(cfg.package?.version || "1.0.0"),
        author: String(cfg.package?.author || "Yunzai"),
        permissions: {
          group_message: true,
          friend_message: true,
          group_event: true,
          friend_event: true,
          bot_online: true,
          bot_offline: true,
        },
      })
      const bots = frame.data?.bots ?? frame.bots
      if (Array.isArray(bots))
        for (const i of bots) if (i.online !== false) await this.registerBot(ws, i)
      const res = await this.action(ws, "get_bot_list", {})
      if (!res.ok) return Bot.makeLog("error", ["萌卡获取账号列表失败", res.error], TAG)
      for (const i of res.data?.bots ?? res.data ?? [])
        if (i.online !== false) await this.registerBot(ws, i)
    }

    onHeartbeat(frame, ws) {
      const bot = Bot[Number(frame.data?.self_id)]
      if (bot && bot.adapter === this) {
        if (bot.ws !== ws) bot.ws = ws
        if (frame.data?.stat) Object.assign(bot.stat.stat, frame.data.stat)
      }
      return Bot.makeLog("debug", ["萌卡心跳", frame.data?.time], TAG)
    }

    /* ---------------------------------- 账号 ---------------------------------- */

    async registerBot(ws, info) {
      const raw = info?.bot ?? info ?? {}
      const self_id = Number(raw.user_id ?? raw.self_id ?? raw.uin ?? raw.qq)
      if (!self_id) return
      const protocol_id = this.protoIdOf(raw)
      const key = String(self_id)
      const exists = Bot[key]
      if (exists && exists.adapter !== this) {
        return Bot.makeLog(
          "warn",
          `QQ ${self_id} 已被其他适配器占用，萌卡账号跳过`,
          TAG,
        )
      }
      const bot = {
        adapter: this,
        ws,
        protocol_id,
        stat: { start_time: Date.now() / 1000, stat: {} },
        model: "TRSS Yunzai",
        info: {
          ...raw,
          user_id: self_id,
          nickname: raw.nickname ?? raw.remark ?? `QQ${self_id}`,
        },
        fl: new Map(),
        gl: new Map(),
        gml: new Map(),
        request_list: [],
        cookies: {},
        version: {
          id: this.id,
          name: this.name,
          app_name: "萌卡NT",
          app_version: this.version,
          get version() {
            return `萌卡NT v${this.app_version}`
          },
        },
      }
      Object.defineProperties(bot, {
        uin: { get: () => self_id },
        nickname: { get: () => bot.info.nickname },
        avatar: {
          get: () => `https://q.qlogo.cn/g?b=qq&s=0&nk=${self_id}`,
        },
      })
      for (const [name, fn] of Object.entries({
        sendApi: (action, params) => this.sendApi(bot, action, params),
        getFriendMap: () => this.getFriendMap(bot),
        getFriendList: () => [...bot.fl.keys()],
        getFriendArray: () => [...bot.fl.values()],
        getGroupMap: () => this.getGroupMap(bot),
        getGroupList: () => [...bot.gl.keys()],
        getGroupArray: () => [...bot.gl.values()],
        getGroupMemberMap: () => this.getGroupMemberMap(bot),
        pickFriend: user_id => this.pickFriend(bot, user_id),
        pickGroup: group_id => this.pickGroup(bot, group_id),
        pickMember: (group_id, user_id) => this.pickMember(bot, group_id, user_id),
        getSystemMsg: () => bot.request_list,
        setFriendAddRequest: (...args) => this.setFriendAddRequest(bot, ...args),
        setGroupAddRequest: (...args) => this.setGroupAddRequest(bot, ...args),
        setEssenceMessage: (group_id, message_id) =>
          this.setEssence(bot, group_id, message_id, true),
        removeEssenceMessage: (group_id, message_id) =>
          this.setEssence(bot, group_id, message_id, false),
        getCookies: () => undefined,
        getCsrfToken: () => undefined,
      }))
        bot[name] = fn
      Object.defineProperty(bot, "pickUser", {
        configurable: true,
        get: () => bot.pickFriend,
      })
      bot.api = (action, params = {}) => bot.sendApi(action, params)
      bot.callApi = bot.api
      bot.apiActions = API_ALL
      this.installApi(bot, bot, "bot")

      Bot[key] = bot
      if (!Bot.uin.includes(self_id)) Bot.uin.push(self_id)
      await Promise.allSettled([bot.getFriendMap(), bot.getGroupMap()])
      const infoRes = await bot.sendApi("get_bot_info").catch(err => err)
      if (infoRes?.ok && infoRes.data)
        bot.info = { ...bot.info, ...infoRes.data, user_id: self_id }
      const protoVer = bot.info?.protocol?.version ?? "?"
      Bot.makeLog(
        "mark",
        `萌卡账号 ${self_id}(${protocol_id}) ${bot.info.nickname} 已连接 · 协议版本 ${protoVer}`,
        self_id,
      )
      Bot.em(`connect.${self_id}`, { self_id, bot })
    }

    /* ---------------------------------- 事件 ---------------------------------- */

    async onEvent(event, ws) {
      if (!event || typeof event !== "object") return
      const self_id = Number(event.self_id)
      if (!self_id)
        return Bot.makeLog("warn", ["萌卡事件缺少 self_id", event], TAG)
      let bot = Bot[self_id]
      if (!bot || bot.adapter !== this) {
        await this.registerBot(ws, {
          user_id: self_id,
          protocol: event.protocol,
          protocol_id: event.protocol_id,
        }).catch(err => Bot.makeLog("error", ["萌卡注册账号失败", err], TAG))
        bot = Bot[self_id]
      }
      if (!bot || bot.adapter !== this) return
      if (bot.ws !== ws) bot.ws = ws
      switch (event.post_type) {
        case "system_event":
          return this.makeMeta(bot, event)
        case "bot_online":
          return this.registerBot(ws, {
            user_id: self_id,
            protocol: event.protocol,
            protocol_id: event.protocol_id,
          }).catch(err => Bot.makeLog("error", ["萌卡账号上线失败", err], TAG))
        case "bot_offline": {
          // 萌卡的下线事件不一定带原因：依次尝试常见字段，全都没有时打「未提供原因」
          // 并把原始事件整段输出，待抓到一次真实事件后即可精确对字段
          const reason = [
            event.reason,
            event.message,
            event.detail,
            event.cause,
            event.sub_type,
          ].find(v => v !== undefined && v !== null && v !== "") ?? ""
          if (!reason) Bot.makeLog("warn", ["萌卡账号下线（事件未带原因）", event], self_id)
          const reasonText = reason || "未提供原因"
          Bot.makeLog("info", `账号下线：${reasonText}`, self_id)
          Bot.sendMasterMsg(`[${self_id}] 萌卡账号下线：${reasonText}`).catch(() => {})
          const data = {
            ...event,
            post_type: "notice",
            notice_type: "bot_offline",
            sub_type: "",
            self_id,
            time: Math.floor(Date.now() / 1000),
          }
          return Bot.em("notice.bot_offline.", data)
        }
        case "group_message":
        case "friend_message":
        case "group_temp_message":
          return this.makeMessage(bot, event)
        case "message_sent":
          if (conf().report_message_sent) return this.makeMessage(bot, event)
          return
        case "group_notice":
        case "friend_notice":
          return this.makeNotice(bot, event)
        default:
          return Bot.makeLog("debug", ["萌卡未知事件", event.post_type], self_id)
      }
    }

    makeMeta(bot, event) {
      switch (event.meta_event_type) {
        case "lifecycle":
          return this.registerBot(bot.ws, {
            user_id: bot.uin,
            protocol_id: bot.protocol_id,
          }).catch(err => Bot.makeLog("error", ["萌卡生命周期重连失败", err], TAG))
        case "heartbeat":
          return this.onHeartbeat({ data: event }, bot.ws)
        default:
          return Bot.makeLog("debug", ["萌卡未知元事件", event], bot.uin)
      }
    }

    parseMsg(message = []) {
      const out = []
      for (const seg of Array.isArray(message) ? message : [message]) {
        if (!seg || typeof seg !== "object" || !seg.type) continue
        const data = seg.data && typeof seg.data === "object" ? seg.data : seg
        switch (seg.type) {
          case "text":
            out.push({
              type: "text",
              text: String(data.text ?? data.content ?? data.msg ?? ""),
            })
            break
          case "at":
            out.push({
              type: "at",
              qq: data.user_id ?? data.qq ?? "",
              name: data.name ?? "",
            })
            break
          case "image":
            out.push({
              type: "image",
              file: data.file_id ?? data.url ?? "",
              url: data.url ?? "",
              file_id: data.file_id ?? "",
            })
            break
          case "voice":
            out.push({
              type: "record",
              file: data.file_id ?? data.url ?? "",
              url: data.url ?? "",
            })
            break
          case "reply":
            out.push({ type: "reply", id: data.message_id ?? data.id })
            break
          case "face":
            out.push({ type: "face", id: data.face_id ?? data.id })
            break
          case "file":
            out.push({
              type: "file",
              id: data.file_id ?? "",
              name: data.file_name ?? data.name ?? "",
              size: data.file_size ?? data.size ?? 0,
            })
            break
          default:
            out.push({ type: seg.type, ...data })
        }
      }
      return out
    }

    /** 纯文本版消息（Yunzai 的 e.msg） */
    toText(message) {
      let text = ""
      for (const i of message) if (i.type === "text") text += i.text ?? ""
      return text.trim()
    }

    toRawMessage(message) {
      let text = ""
      for (const i of message) {
        if (i.type === "text") text += i.text ?? ""
        else if (i.type === "at")
          text += `@${i.qq === "all" ? "全体成员" : i.qq} `
        else if (["image", "record", "video", "face", "file"].includes(i.type))
          text += `[${i.type}]`
      }
      return text
    }

    makeMessage(bot, event) {
      const data = {
        ...event,
        post_type: "message",
        self_id: Number(event.self_id),
        time: Number(
          event.time ?? event.msg?.time ?? Math.floor(Date.now() / 1000),
        ),
        message_id: toId(event.message_id),
        message: this.parseMsg(event.message),
      }
      const sender = { ...(event.sender || {}) }
      sender.user_id = Number(sender.user_id ?? event.user_id ?? 0)
      data.sender = sender
      if (event.post_type === "group_message") {
        data.message_type = "group"
        data.sub_type = "normal"
        data.group_id = Number(event.group_id)
        data.user_id = sender.user_id
      } else {
        data.message_type = "private"
        data.sub_type = event.post_type === "group_temp_message" ? "group" : "friend"
        data.user_id =
          sender.user_id === data.self_id
            ? Number(event.receiver?.user_id ?? event.target_id ?? 0)
            : sender.user_id
        if (!data.user_id) data.user_id = Number(event.user_id)
        if (event.post_type === "group_temp_message")
          data.group_id = Number(event.group_id)
      }
      sender.nickname ??= bot.fl.get(data.user_id)?.nickname ?? String(data.user_id)
      if (data.message_type === "group") {
        const member = bot.gml.get(data.group_id)?.get(data.user_id)
        sender.card ??= member?.card ?? ""
        sender.role ??= member?.role ?? "member"
        data.group_name ??= bot.gl.get(data.group_id)?.group_name
      }
      data.raw_message = this.toRawMessage(data.message)
      // 萌卡自带的 msg 是对象，必须丢掉：Yunzai 的 dealEvent 会遍历 message 段
      // 把文本累加到 e.msg 上，我们若再预设一份字符串就会拼成「测试测试」这种重复文本
      delete data.msg
      const name = sender.card || sender.nickname
      Bot.makeLog(
        "info",
        `${data.message_type === "group" ? "群" : "好友"}消息：${
          name
            ? `[${data.group_name ? `${data.group_name}, ` : ""}${name}] `
            : ""
        }${data.raw_message}`,
        data.message_type === "group"
          ? `${data.self_id} <= ${data.group_id}, ${data.user_id}`
          : `${data.self_id} <= ${data.user_id}`,
        true,
      )
      const lagSec = Math.floor(Date.now() / 1000) - Number(data.time)
      if (lagSec >= 2)
        Bot.makeLog(
          "warn",
          [`萌卡消息到达延迟 ${lagSec}s`],
          data.message_type === "group"
            ? `${data.self_id} <= ${data.group_id}`
            : `${data.self_id} <= ${data.user_id}`,
        )
      Bot.em(`message.${data.message_type}.${data.sub_type}`, data)
    }

    makeNotice(bot, event) {
      const body = event.body || {}
      const self_id = Number(event.self_id)
      const isGroup = event.post_type === "group_notice"
      const notice_type = event.notice_type ?? event.type ?? event.sub_type
      const group_id = Number(event.group_id ?? 0)
      const operator_id = Number(
        event.operator_id ?? body.operator_id ?? body.invitor_id ?? 0,
      )
      const target_id = Number(
        event.target_id ?? body.user_id ?? event.user_id ?? 0,
      )
      const message_id = toId(
        body.original?.message_id ?? body.msg_seq ?? event.message_id,
      )
      const data = {
        ...event,
        post_type: "notice",
        self_id,
        notice_type,
        sub_type: "",
        time: Number(event.time ?? Math.floor(Date.now() / 1000)),
        message_id,
        user_id: target_id,
        operator_id,
        sender_id: target_id,
      }
      if (isGroup) data.group_id = group_id
      switch (notice_type) {
        case "recall":
          data.notice_type = isGroup ? "group_recall" : "friend_recall"
          if (!isGroup) data.user_id = Number(event.user_id ?? target_id)
          Bot.makeLog(
            "info",
            `${isGroup ? "群" : "好友"}消息撤回：${data.operator_id} => ${data.user_id} ${message_id}`,
            isGroup
              ? `${self_id} <= ${group_id}`
              : `${self_id} <= ${data.user_id}`,
            true,
          )
          break
        case "increase":
          if (isGroup) {
            data.notice_type = "group_increase"
            data.sub_type = body.invitor_id ? "invite" : "approve"
            data.operator_id = Number(body.invitor_id ?? operator_id ?? 0)
            Bot.makeLog(
              "info",
              `群成员增加：${data.operator_id} => ${target_id} ${data.sub_type}`,
              `${self_id} <= ${group_id}`,
              true,
            )
            this.getMemberMap(bot, group_id).catch(() => {})
          } else {
            data.notice_type = "friend_add"
            Bot.makeLog("info", "好友添加", `${self_id} <= ${target_id}`, true)
            this.getFriendInfo(bot, target_id).catch(() => {})
          }
          break
        case "decrease":
          if (isGroup) {
            data.notice_type = "group_decrease"
            data.sub_type = ["kicked", "kick"].includes(body.reason)
              ? "kick"
              : "leave"
            Bot.makeLog(
              "info",
              `群成员减少：${operator_id} => ${target_id} ${data.sub_type}`,
              `${self_id} <= ${group_id}`,
              true,
            )
            if (target_id === self_id) {
              bot.gl.delete(group_id)
              bot.gml.delete(group_id)
            } else bot.gml.get(group_id)?.delete(target_id)
          } else {
            data.notice_type = "friend_decrease"
            Bot.makeLog(
              "info",
              `好友减少：${target_id}`,
              `${self_id} <= ${target_id}`,
              true,
            )
            bot.fl.delete(target_id)
          }
          break
        case "mute":
          data.notice_type = "group_ban"
          data.sub_type = body.status === false ? "lift_ban" : "ban"
          data.duration = Number(body.duration ?? body.duration_sec ?? 0)
          data.user_id = Number(body.user_id ?? target_id)
          Bot.makeLog(
            "info",
            `群禁言：${operator_id} => ${data.user_id} ${data.sub_type} ${data.duration}秒`,
            `${self_id} <= ${group_id}`,
            true,
          )
          break
        case "admin":
          data.notice_type = "group_admin"
          data.sub_type = (body.set_admin ?? body.admin) ? "set" : "unset"
          Bot.makeLog(
            "info",
            `群管理员变动：${data.sub_type}`,
            `${self_id} <= ${group_id}, ${target_id}`,
            true,
          )
          break
        case "card":
          data.notice_type = "group_card"
          data.card_new = body.card ?? body.card_new ?? ""
          data.card_old = body.card_old ?? ""
          Bot.makeLog(
            "info",
            `群名片更新：${data.card_old} => ${data.card_new}`,
            `${self_id} <= ${group_id}, ${target_id}`,
            true,
          )
          break
        case "name":
          data.notice_type = "notify"
          data.sub_type = "group_name"
          data.name_new = body.group_name ?? event.group_name ?? ""
          Bot.makeLog(
            "info",
            `群名更改：${data.name_new}`,
            `${self_id} <= ${group_id}`,
            true,
          )
          break
        case "title":
          data.notice_type = "notify"
          data.sub_type = "title"
          data.title = body.title ?? ""
          Bot.makeLog(
            "info",
            `群头衔：${data.title}`,
            `${self_id} <= ${group_id}, ${target_id}`,
            true,
          )
          break
        case "essence":
          data.notice_type = "group_essence"
          data.sub_type =
            (body.operation ?? body.sub_type) === "remove" ? "delete" : "add"
          Bot.makeLog(
            "info",
            `群精华消息：${operator_id} => ${target_id} ${data.sub_type} ${message_id}`,
            `${self_id} <= ${group_id}`,
            true,
          )
          break
        case "file_uploaded": {
          const file = {
            id: body.file_id ?? "",
            name: body.file_name ?? "",
            size: Number(body.file_size ?? 0),
            busid: body.busid,
          }
          data.notice_type = "group_upload"
          Bot.makeLog(
            "info",
            `群文件上传：${file.name}`,
            `${self_id} <= ${group_id}, ${target_id}`,
            true,
          )
          Bot.em("message.group.normal", {
            ...data,
            post_type: "message",
            message_type: "group",
            sub_type: "normal",
            message: [{ type: "file", ...file }],
            raw_message: `[文件：${file.name}]`,
          })
          break
        }
        case "poke":
          data.notice_type = "notify"
          data.sub_type = "poke"
          data.operator_id = Number(event.operator_id ?? body.operator_id ?? 0)
          data.target_id = target_id
          Bot.makeLog(
            "info",
            `${isGroup ? "群" : "好友"}戳一戳：${data.operator_id} => ${target_id}`,
            isGroup ? `${self_id} <= ${group_id}` : `${self_id} <= ${target_id}`,
            true,
          )
          break
        case "reaction":
          data.notice_type = "group_msg_emoji_like"
          data.likes = body.likes ?? []
          Bot.makeLog(
            "info",
            [`群消息回应：${message_id}`, data.likes],
            `${self_id} <= ${group_id}, ${target_id}`,
            true,
          )
          break
        case "like":
          data.notice_type = "notify"
          data.sub_type = "profile_like"
          data.times = Number(body.count ?? body.times ?? 1)
          Bot.makeLog(
            "info",
            `资料卡点赞：${data.times}次`,
            `${self_id} <= ${data.operator_id || target_id}`,
            true,
          )
          break
        case "typing":
          return Bot.makeLog("debug", ["萌卡对方输入中", target_id], self_id)
        case "apply":
          return this.makeRequest(bot, event)
        case "system_tip":
          return Bot.makeLog(
            "info",
            [`系统提示：${body.tip ?? body.content ?? ""}`],
            `${self_id}${group_id ? ` <= ${group_id}` : ""}`,
            true,
          )
        default:
          return Bot.makeLog(
            "warn",
            [
              "萌卡未知通知",
              notice_type,
              JSON.stringify(event).slice(0, 400),
            ],
            self_id,
          )
      }
      Bot.em(`notice.${data.notice_type}.${data.sub_type}`, data)
    }

    makeRequest(bot, event) {
      const body = event.body || {}
      const isGroup = event.post_type === "group_notice"
      const data = {
        ...event,
        post_type: "request",
        self_id: Number(event.self_id),
        time: Number(event.time ?? Math.floor(Date.now() / 1000)),
        flag: String(body.request_id ?? event.request_id ?? event.event_id ?? ""),
        comment: String(body.message ?? body.comment ?? body.tip ?? ""),
      }
      if (isGroup) {
        data.request_type = "group"
        data.group_id = Number(event.group_id ?? 0)
        data.user_id = Number(body.user_id ?? body.invitor_id ?? 0)
        data.sub_type = body.invitor_id ? "invite" : "add"
      } else {
        data.request_type = "friend"
        data.sub_type = "add"
        data.user_id = Number(body.user_id ?? event.user_id ?? 0)
      }
      data.approve = (approve, reason) => {
        if (isGroup)
          return this.setGroupAddRequest(bot, data, approve, reason, data.sub_type)
        return this.setFriendAddRequest(bot, data, approve, reason)
      }
      Bot.makeLog(
        "info",
        `${isGroup ? "加群" : "加好友"}请求：${data.sub_type} ${data.comment}`,
        isGroup
          ? `${data.self_id} <= ${data.group_id}, ${data.user_id}`
          : `${data.self_id} <= ${data.user_id}`,
        true,
      )
      bot.request_list.push(data)
      if (bot.request_list.length > 100) bot.request_list.shift()
      Bot.em(`request.${data.request_type}.${data.sub_type}`, data)
    }

    /* -------------------------------- 好友 / 群 / 成员 -------------------------------- */

    async getFriendMap(bot) {
      const res = await bot
        .sendApi("get_friend_list")
        .catch(err => ({ ok: false, error: err }))
      if (!res?.ok)
        return Bot.makeLog("warn", ["萌卡获取好友列表失败", res?.error], bot.uin)
      const list = res.data?.friends ?? res.data ?? []
      bot.fl.clear()
      for (const i of list) {
        const user_id = Number(i.user_id ?? i.uin)
        if (!user_id) continue
        bot.fl.set(user_id, {
          ...i,
          user_id,
          nickname: i.nickname ?? i.remark ?? "",
          remark: i.remark ?? "",
        })
      }
      return bot.fl
    }

    async getGroupMap(bot) {
      const res = await bot
        .sendApi("get_group_list")
        .catch(err => ({ ok: false, error: err }))
      if (!res?.ok)
        return Bot.makeLog("warn", ["萌卡获取群列表失败", res?.error], bot.uin)
      const list = res.data?.groups ?? res.data ?? []
      bot.gl.clear()
      for (const i of list) {
        const group_id = Number(i.group_id ?? i.groupId)
        if (!group_id) continue
        bot.gl.set(group_id, {
          ...i,
          group_id,
          group_name: i.group_name ?? i.groupName ?? i.name ?? "",
          member_count: Number(i.member_count ?? 0),
          max_member_count: Number(i.max_member_count ?? 0),
        })
      }
      return bot.gl
    }

    async getMemberMap(bot, group_id) {
      const groupId = Number(group_id)
      const res = await bot
        .sendApi("get_group_member_list", { group_id: groupId })
        .catch(err => ({ ok: false, error: err }))
      if (!res?.ok) {
        Bot.makeLog("warn", ["萌卡获取群成员失败", groupId, res?.error], bot.uin)
        return bot.gml.get(groupId) ?? new Map()
      }
      const list = res.data?.members ?? res.data ?? []
      const map = new Map()
      for (const i of list) {
        const user_id = Number(i.user_id ?? i.uin)
        if (!user_id) continue
        map.set(user_id, {
          ...i,
          user_id,
          group_id: groupId,
          nickname: i.nickname ?? "",
          card: i.card ?? "",
          role: i.role ?? "member",
        })
      }
      bot.gml.set(groupId, map)
      return map
    }

    async getGroupMemberMap(bot) {
      for (const group_id of bot.gl.keys())
        await this.getMemberMap(bot, group_id).catch(() => {})
      return bot.gml
    }

    async getFriendInfo(bot, user_id) {
      const uid = Number(user_id)
      const res = await bot
        .sendApi("get_user_profile", { user_id: uid })
        .catch(err => ({ ok: false, error: err }))
      if (!res?.ok) return bot.fl.get(uid) ?? { user_id: uid }
      const friend = {
        ...(bot.fl.get(uid) ?? {}),
        ...res.data,
        user_id: uid,
        nickname: res.data?.nickname ?? res.data?.contact_name ?? "",
      }
      bot.fl.set(uid, friend)
      return friend
    }

    async getMemberInfo(bot, group_id, user_id) {
      const map = bot.gml.get(Number(group_id)) ?? (await this.getMemberMap(bot, group_id))
      return map.get(Number(user_id)) ?? { group_id: Number(group_id), user_id }
    }

    /* ---------------------------------- 好友 ---------------------------------- */

    /** 给 Bot / Group / Friend / Member 安装通用 action 方法（已存在的同名方法不覆盖） */
    installApi(bot, target, scope, inject = {}) {
      for (const [name, action] of API_METHODS[scope]) {
        if (name in target) continue
        target[name] = params => this.sendApi(bot, action, { ...inject, ...params })
      }
      if (!("api" in target))
        target.api = (action, params = {}) =>
          this.sendApi(bot, action, { ...inject, ...params })
    }

    pickFriend(bot, user_id) {
      const uid = Number(user_id)
      const cache = (bot.friendCache ??= new Map())
      const cached = cache.get(uid)
      if (cached) return cached
      const read = () => bot.fl.get(uid) ?? { user_id: uid }
      const friend = {
        self_id: bot.uin,
        bot,
        user_id: uid,
        get info() {
          return read()
        },
        get name() {
          return read().remark || read().nickname
        },
        get nickname() {
          return read().nickname
        },
        get remark() {
          return read().remark
        },
        get avatar() {
          return `https://q.qlogo.cn/g?b=qq&s=0&nk=${uid}`
        },
        get is_friend() {
          return bot.fl.has(uid)
        },
        sendMsg: msg => this.sendFriendMsg(bot, uid, msg),
        recallMsg: message_id =>
          this.recallMessage(bot, { user_id: uid }, message_id),
        getMsg: message_id => this.getMsg(bot, { user_id: uid }, message_id),
        getChatHistory: (count = 20) =>
          this.getFriendMsgHistory(bot, uid, count),
        sendForwardMsg: msg => this.sendFriendForwardMsg(bot, uid, msg),
        getInfo: async (useCache = true) =>
          useCache ? read() : this.getFriendInfo(bot, uid),
        thumbUp: (times = 1) =>
          bot.sendApi("like_user_profile", { user_id: uid, like_count: times }),
        poke: () => bot.sendApi("send_poke", { user_id: uid }),
        delete: () => bot.sendApi("delete_friend", { user_id: uid }),
      }
      this.installApi(bot, friend, "friend", { user_id: uid })
      cache.set(uid, friend)
      return friend
    }

    async sendFriendMsg(bot, user_id, msg) {
      const message = Array.isArray(msg) ? msg : [msg]
      if (message.length === 1 && message[0]?.type === "node")
        return this.sendFriendForwardMsg(bot, user_id, message[0])
      const segments = await this.toSegments(
        bot,
        { type: "friend", user_id: Number(user_id) },
        message,
      )
      const res = await bot.sendApi("send_friend_msg", {
        user_id: Number(user_id),
        message: segments,
      })
      return this.checkApi(res, "发送好友消息", "send_friend_msg")
    }

    async sendFriendForwardMsg(bot, user_id, seg) {
      const nodes = seg?.data ?? seg?.message ?? seg
      if (!Array.isArray(nodes) || !nodes.length)
        throw Error("合并转发内容为空")
      const messages = []
      for (const node of nodes) {
        const message = Array.isArray(node?.message)
          ? node.message
          : [node?.message ?? { type: "text", text: String(node ?? "") }]
        messages.push({
          user_id: Number(node?.user_id ?? bot.uin),
          nickname: node?.nickname ?? bot.nickname,
          time: Number(node?.time ?? Math.floor(Date.now() / 1000)),
          message: await this.toSegments(
            bot,
            { type: "friend", user_id: Number(user_id) },
            message,
          ),
        })
      }
      const res = await bot.sendApi("upload_friend_forward_msg", {
        user_id: Number(user_id),
        send: true,
        messages,
      })
      return this.checkApi(res, "发送好友合并转发", "upload_friend_forward_msg")
    }

    async getFriendMsgHistory(bot, user_id, count = 20) {
      const res = await bot.sendApi("get_friend_msg_history", {
        user_id: Number(user_id),
        count: Number(count),
      })
      return this.checkApi(res, "获取好友历史消息", "get_friend_msg_history")
    }

    /* ---------------------------------- 群聊 ---------------------------------- */

    pickGroup(bot, group_id) {
      const gid = Number(group_id)
      const cache = (bot.groupCache ??= new Map())
      const cached = cache.get(gid)
      if (cached) return cached
      const read = () => bot.gl.get(gid) ?? { group_id: gid }
      const group = {
        self_id: bot.uin,
        bot,
        group_id: gid,
        get info() {
          return read()
        },
        get name() {
          return read().group_name
        },
        get group_name() {
          return read().group_name
        },
        get member_count() {
          return read().member_count
        },
        get is_owner() {
          return bot.gml.get(gid)?.get(bot.uin)?.role === "owner"
        },
        get is_admin() {
          const role = bot.gml.get(gid)?.get(bot.uin)?.role
          return role === "owner" || role === "admin"
        },
        sendMsg: msg => this.sendGroupMsg(bot, gid, msg),
        recallMsg: message_id =>
          this.recallMessage(bot, { group_id: gid }, message_id),
        getMsg: message_id => this.getMsg(bot, { group_id: gid }, message_id),
        getChatHistory: (count = 20) =>
          this.getGroupMsgHistory(bot, gid, count),
        sendForwardMsg: msg => this.sendGroupForwardMsg(bot, gid, msg),
        getInfo: async (useCache = true) => {
          if (!useCache) await this.getGroupMap(bot).catch(() => {})
          return read()
        },
        getMemberMap: () => this.getMemberMap(bot, gid),
        getMemberList: () => [...(bot.gml.get(gid) ?? new Map()).keys()],
        getMemberArray: () => [...(bot.gml.get(gid) ?? new Map()).values()],
        pickMember: user_id => this.pickMember(bot, gid, user_id),
        pokeMember: user_id =>
          bot.sendApi("send_poke", { group_id: gid, user_id: Number(user_id) }),
        setName: group_name =>
          bot.sendApi("set_group_name", { group_id: gid, group_name }),
        setAdmin: (user_id, set_admin = true) =>
          bot.sendApi("set_group_admin", {
            group_id: gid,
            user_id: Number(user_id),
            set_admin: !!set_admin,
          }),
        setCard: (user_id, card) =>
          bot.sendApi("set_group_card", {
            group_id: gid,
            user_id: Number(user_id),
            card,
          }),
        setTitle: (user_id, title) =>
          bot.sendApi("set_group_special_title", {
            group_id: gid,
            user_id: Number(user_id),
            title,
          }),
        muteMember: (user_id, duration_sec = 1800) =>
          bot.sendApi("set_group_mute", {
            group_id: gid,
            user_id: Number(user_id),
            duration_sec: Number(duration_sec),
          }),
        muteAll: (mute = true) =>
          bot.sendApi("set_group_mute_all", { group_id: gid, mute: !!mute }),
        kickMember: (user_id, reject_add_request = false) =>
          bot.sendApi("kick_group_member", {
            group_id: gid,
            user_id: Number(user_id),
            user_ids: [Number(user_id)],
            reject_add_request: !!reject_add_request,
          }),
        quit: () => bot.sendApi("leave_group", { group_id: gid }),
        sign: () => bot.sendApi("sign_group", { group_id: gid }),
        sendNotice: (content, image) =>
          bot.sendApi("send_group_notice", { group_id: gid, content, image }),
        getNotice: () => bot.sendApi("get_group_notice", { group_id: gid }),
        setEssence: message_id => this.setEssence(bot, gid, message_id, true),
        removeEssence: message_id =>
          this.setEssence(bot, gid, message_id, false),
        getEssence: () => bot.sendApi("get_essence_msg_list", { group_id: gid }),
        getHonorInfo: type =>
          bot.sendApi("get_group_honor_info", { group_id: gid, type }),
        getAtAllRemain: () =>
          bot.sendApi("get_group_at_all_remain", { group_id: gid }),
        getFiles: folder_id =>
          bot.sendApi("get_group_files", { group_id: gid, folder_id }),
        get announce() {
          return this.sendNotice
        },
      }
      this.installApi(bot, group, "group", { group_id: gid })
      cache.set(gid, group)
      return group
    }

    async sendGroupMsg(bot, group_id, msg) {
      const message = Array.isArray(msg) ? msg : [msg]
      if (message.length === 1 && message[0]?.type === "node")
        return this.sendGroupForwardMsg(bot, group_id, message[0])
      const segments = await this.toSegments(
        bot,
        { type: "group", group_id: Number(group_id) },
        message,
      )
      const res = await bot.sendApi("send_group_msg", {
        group_id: Number(group_id),
        message: segments,
      })
      return this.checkApi(res, "发送群消息", "send_group_msg")
    }

    async sendGroupForwardMsg(bot, group_id, seg) {
      const nodes = seg?.data ?? seg?.message ?? seg
      if (!Array.isArray(nodes) || !nodes.length)
        throw Error("合并转发内容为空")
      const messages = []
      for (const node of nodes) {
        const message = Array.isArray(node?.message)
          ? node.message
          : [node?.message ?? { type: "text", text: String(node ?? "") }]
        messages.push({
          user_id: Number(node?.user_id ?? bot.uin),
          nickname: node?.nickname ?? bot.nickname,
          time: Number(node?.time ?? Math.floor(Date.now() / 1000)),
          message: await this.toSegments(
            bot,
            { type: "group", group_id: Number(group_id) },
            message,
          ),
        })
      }
      const res = await bot.sendApi("upload_group_forward_msg", {
        group_id: Number(group_id),
        send: true,
        messages,
      })
      return this.checkApi(res, "发送合并转发", "upload_group_forward_msg")
    }

    async getGroupMsgHistory(bot, group_id, count = 20) {
      const res = await bot.sendApi("get_group_msg_history", {
        group_id: Number(group_id),
        count: Number(count),
      })
      return this.checkApi(res, "获取群历史消息", "get_group_msg_history")
    }

    /* --------------------------------- 群成员 --------------------------------- */

    pickMember(bot, group_id, user_id) {
      const gid = Number(group_id)
      const uid = Number(user_id)
      const cache = (bot.memberCache ??= new Map())
      const cacheKey = `${gid}:${uid}`
      const cached = cache.get(cacheKey)
      if (cached) return cached
      const read = () =>
        bot.gml.get(gid)?.get(uid) ?? { group_id: gid, user_id: uid }
      const member = {
        self_id: bot.uin,
        bot,
        group_id: gid,
        user_id: uid,
        get info() {
          return read()
        },
        get name() {
          return read().card || read().nickname
        },
        get nickname() {
          return read().nickname
        },
        get card() {
          return read().card
        },
        get role() {
          return read().role ?? "member"
        },
        get is_owner() {
          return this.role === "owner"
        },
        get is_admin() {
          return this.role === "owner" || this.role === "admin"
        },
        get group() {
          return bot.pickGroup(gid)
        },
        get avatar() {
          return `https://q.qlogo.cn/g?b=qq&s=0&nk=${uid}`
        },
        sendMsg: msg => this.sendMemberMsg(bot, gid, uid, msg),
        poke: () => bot.sendApi("send_poke", { group_id: gid, user_id: uid }),
        getInfo: async (useCache = true) =>
          useCache ? read() : this.getMemberInfo(bot, gid, uid),
        setCard: card => bot.pickGroup(gid).setCard(uid, card),
        setAdmin: (set_admin = true) =>
          bot.pickGroup(gid).setAdmin(uid, set_admin),
        setTitle: title => bot.pickGroup(gid).setTitle(uid, title),
        mute: (duration_sec = 1800) =>
          bot.pickGroup(gid).muteMember(uid, duration_sec),
        kick: (reject_add_request = false) =>
          bot.pickGroup(gid).kickMember(uid, reject_add_request),
      }
      this.installApi(bot, member, "member", { group_id: gid, user_id: uid })
      cache.set(cacheKey, member)
      return member
    }

    async sendMemberMsg(bot, group_id, user_id, msg) {
      const message = [{ type: "at", qq: String(user_id) }, { type: "text", text: " " }]
      for (const i of Array.isArray(msg) ? msg : [msg]) message.push(i)
      return this.sendGroupMsg(bot, group_id, message)
    }

    /* --------------------------------- 消息段 --------------------------------- */

    async toSegments(bot, target, message) {
      const segments = []
      for (const seg of Array.isArray(message) ? message : [message]) {
        if (!seg) continue
        // 字符串 / 数字：Yunzai 里 e.reply("文本") 传的就是裸字符串，
        // 旧逻辑把它当成非对象直接跳过，导致任何纯文本回复都报「发送内容为空」
        if (typeof seg !== "object") {
          const text = String(seg)
          if (text) segments.push({ type: "text", data: { text } })
          continue
        }
        switch (seg.type) {
          case "text": {
            const text = String(seg.text ?? "")
            if (text) segments.push({ type: "text", data: { text } })
            break
          }
          case "at": {
            const qq = String(seg.qq ?? seg.user_id ?? "")
            segments.push({
              type: "at",
              data: {
                user_id:
                  qq === "all" || qq === "全体" ? "all" : toId(qq),
              },
            })
            break
          }
          case "face":
            segments.push({
              type: "face",
              data: { face_id: Number(seg.id ?? seg.face_id ?? 0) },
            })
            break
          case "reply":
            segments.push({
              type: "reply",
              data: { message_id: toId(seg.id ?? seg.message_id) },
            })
            break
          case "image":
          case "record":
          case "video":
            segments.push(await this.uploadMedia(bot, target, seg))
            break
          case "node":
            throw Error("合并转发请使用 sendForwardMsg")
          case "file": {
            const file_path = await this.resolveMedia(bot, seg, "file")
            const isGroup = target.type === "group"
            const action = isGroup ? "upload_group_file" : "upload_private_file"
            const params = { file_path, name: seg.name ?? seg.file_name }
            if (isGroup) params.group_id = Number(target.group_id)
            else params.user_id = Number(target.user_id)
            const res = await bot.sendApi(action, params)
            this.checkApi(res, `上传文件 ${seg.name ?? seg.file_name ?? ""}`, action)
            const raw = res.data || {}
            segments.push(
              raw.type && raw.data
                ? { type: raw.type, data: raw.data }
                : {
                    type: "file",
                    data: {
                      file_id: raw.file_id ?? raw.id,
                      file_name: raw.file_name ?? seg.name ?? seg.file_name,
                      file_size: raw.file_size ?? seg.file_size ?? seg.size,
                    },
                  },
            )
            break
          }
          default:
            Bot.makeLog("debug", ["萌卡忽略不支持的消息段", seg.type], TAG)
        }
      }
      if (!segments.length) throw Error("发送内容为空")
      return segments
    }

    async uploadMedia(bot, target, seg) {
      const kind = seg.type === "record" ? "voice" : seg.type
      const file_path = await this.resolveMedia(bot, seg, kind)
      const action =
        target.type === "group"
          ? `upload_group_${kind}`
          : `upload_friend_${kind}`
      const params = { file_path }
      if (target.group_id) params.group_id = Number(target.group_id)
      if (target.user_id) params.user_id = Number(target.user_id)
      const res = await bot.sendApi(action, params)
      this.checkApi(res, `上传${seg.type}`, action)
      const raw = res.data || {}
      if (raw.type && raw.data) return { type: raw.type, data: raw.data }
      return { type: kind, data: { file_id: raw.file_id ?? raw.id } }
    }

    async resolveMedia(bot, seg, kind) {
      const file = seg.file ?? seg.url ?? seg.path
      if (Buffer.isBuffer(file))
        return this.transferFile(bot, file, seg, kind)
      if (file && typeof file === "object" && Buffer.isBuffer(file.buffer))
        return this.transferFile(bot, file.buffer, seg, kind)
      if (typeof file !== "string")
        throw Error(`萌卡不支持的媒体来源：${typeof file}`)
      if (/^transfer:\/\//i.test(file)) return file
      if (/^https?:\/\//i.test(file)) return file
      if (/^file:\/\//i.test(file)) return file
      if (/^base64:\/\//i.test(file))
        return this.transferFile(
          bot,
          Buffer.from(file.slice(9), "base64"),
          seg,
          kind,
        )
      try {
        return this.transferFile(bot, await fs.readFile(file), seg, kind)
      } catch {
        Bot.makeLog(
          "warn",
          ["萌卡无法读取本地媒体，按允许目录路径直接传递", file],
          bot.uin,
        )
        return file
      }
    }

    /** base64 / Buffer -> file_transfer -> transfer:// 引用 */
    async transferFile(bot, buffer, seg, kind) {
      if (!buffer?.length) throw Error("萌卡媒体内容为空")
      const ext = this.extName(kind, seg)
      const filename =
        seg.name || seg.file_name || `media-${Date.now()}${ext}`
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex")
      const start = await bot.sendApi("file_transfer", {
        operation: "start_upload",
        filename,
        size: buffer.length,
        sha256,
      })
      if (!start?.ok)
        throw Object.assign(Error("萌卡创建文件传输失败"), { res: start })
      const token = start.data?.token
      if (!token) throw Error("萌卡文件传输未返回 token")
      for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
        const data = buffer
          .subarray(offset, offset + CHUNK_SIZE)
          .toString("base64")
        const res = await bot.sendApi("file_transfer", {
          operation: "write",
          token,
          offset,
          data,
        })
        if (!res?.ok)
          throw Object.assign(Error("萌卡写入文件传输失败"), { res })
      }
      const finish = await bot.sendApi("file_transfer", {
        operation: "finish",
        token,
      })
      if (!finish?.ok)
        throw Object.assign(Error("萌卡完成文件传输失败"), { res: finish })
      const ref = finish.data?.file ?? finish.data?.path
      if (!ref) throw Error("萌卡文件传输未返回引用")
      return ref
    }

    extName(kind, seg) {
      const name = seg.name || seg.file_name
      if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return ""
      switch (kind) {
        case "image":
          return ".png"
        case "voice":
          return ".mp3"
        case "video":
          return ".mp4"
        default:
          return ".bin"
      }
    }

    /* --------------------------------- 消息操作 -------------------------------- */

    recallMessage(bot, target, message_id) {
      const params = { message_id: toId(message_id) }
      if (target.group_id) params.group_id = Number(target.group_id)
      else params.user_id = Number(target.user_id)
      return bot
        .sendApi("recall_message", params)
        .then(res => this.checkApi(res, "撤回消息", "recall_message"))
    }

    getMsg(bot, target, message_id) {
      const params = { message_id: toId(message_id) }
      if (target.group_id) params.group_id = Number(target.group_id)
      else params.user_id = Number(target.user_id)
      return bot
        .sendApi("get_msg", params)
        .then(res => this.checkApi(res, "获取消息", "get_msg"))
    }

    setEssence(bot, group_id, message_id, enabled) {
      return bot
        .sendApi("set_group_essence", {
          group_id: Number(group_id),
          message_id: toId(message_id),
          enabled: !!enabled,
        })
        .then(res => this.checkApi(res, "设置精华消息", "set_group_essence"))
    }

    /* --------------------------------- 请求处理 -------------------------------- */

    setFriendAddRequest(bot, data, approve, remark) {
      const body = data.body || {}
      const action = approve ? "approve_friend_apply" : "reject_friend_apply"
      return bot
        .sendApi(action, {
          user_id: Number(data.user_id),
          request_id: String(body.request_id ?? data.flag ?? ""),
          msg_type: body.msg_type,
          request_type: body.request_type ?? body.type,
          source_id: body.source_id,
          sub_source_id: body.sub_source_id,
          group_msg_type: body.group_msg_type,
          action_info: body.action_info,
          remark,
        })
        .then(res => this.checkApi(res, action, action))
    }

    setGroupAddRequest(bot, data, approve, reason, sub_type = "add") {
      const body = data.body || {}
      const invite = sub_type === "invite"
      const action = approve
        ? invite
          ? "approve_group_invite"
          : "approve_group_apply"
        : invite
          ? "reject_group_invite"
          : "reject_group_apply"
      return bot
        .sendApi(action, {
          group_id: Number(data.group_id),
          request_id: toId(body.request_id ?? data.flag),
          request_type: body.request_type,
          request_extra: body.request_extra,
          reason,
        })
        .then(res => this.checkApi(res, action, action))
    }
  })(),
)
