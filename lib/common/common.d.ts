import { Yunzai, Utils, Group, Friend, BufferOptions } from "@kaguyajs/trss-yunzai-types";

declare namespace _default {
    export { relpyPrivate };
    export { sleep };
    export { downFile };
    export { mkdirs };
    export { makeForwardMsg };
}
export default _default;
/**
 * 发送私聊消息
 * @param user_id 账号
 * @param msg 消息
 * @param bot_id 机器人账号
 */
declare function relpyPrivate(user_id: number | string, msg: any[], bot_id?: number | string): ReturnType<Yunzai["sendFriendMsg"]>;
/**
 * 休眠函数
 * @param ms 毫秒
 */
declare function sleep(...args: Parameters<Utils["sleep"]>): ReturnType<Utils["sleep"]>;
/**
 * 下载保存文件
 * @param url 下载地址
 * @param file 保存路径
 * @param opts 下载参数
 */
declare function downFile(url: string, file: string, opts: BufferOptions): Promise<ReturnType<Utils["download"]> | false>;
/**
 * 归递创建文件夹
 * @param dirname 文件夹路径
 */
declare function mkdirs(dirname: string): true;
/**
 * 制作转发消息
 * @param e 消息事件
 * @param msg 消息数组
 * @param dec 转发描述
 */
declare function makeForwardMsg(e: any, msg: any[], dec?: string): ReturnType<Group['makeForwardMsg'] | Friend["makeForwardMsg"]> | { type: "node", data: any[] };
